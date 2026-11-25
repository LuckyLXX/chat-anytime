import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  SSH_TRIAGE_CHECK_TIMEOUT_MS,
  SSH_TRIAGE_HOST_CONCURRENCY,
  SSH_TRIAGE_LOG_LIMIT_CHARS,
  SSH_TRIAGE_MAX_HOSTS,
  SSH_TRIAGE_TITLE_LIMIT,
  describeSshTriageCheck,
  sshEndpointKey,
  validateSshTriageCheck
} from "../shared/ssh-triage.js";
import type {
  SshTriageBatchDetail,
  SshTriageBatchSummary,
  SshTriageCardView,
  SshTriageCheckRequest,
  SshTriageCheckResult,
  SshTriageCheckStatus,
  SshTriageCommand,
  SshTriageCommandResult,
  SshTriageFailure,
  SshTriageHostDetail,
  SshTriageHostSnapshot,
  SshTriageHostStatus
} from "../shared/ssh-triage.js";
import type { SshHostStore } from "./ssh-host-store.js";
import {
  batchSummaryOf,
  createSshTriageCardStore,
  createSshTriageStore,
  normalizeCheckRequests,
  type SshTriageCardStore,
  type SshTriageStore,
  type SshTriageStoreLimits,
  type SshTriageStoredBatch,
  type SshTriageStoredHost
} from "./ssh-triage-store.js";
import type { SshBackgroundCommandOptions, SshBackgroundCommandResult } from "./ssh-connections.js";

/**
 * SSH 后台排障（triage）主进程实现：批次调度 + 只读检查项 + 结果解释 + 持久化接线。
 *
 * 关键取舍（都对应计划里的验收口径）：
 *
 * 1. **临时非 PTY 通道**：所有采集都走注入的 `exec`（真实实现是
 *    `SshConnectionManager.runBackgroundCommand`：复用同一主机库凭据、连接参数与已知
 *    指纹，缺凭据/未信任指纹一律 fail closed，绝不 reveal 终端标签）。交互终端那边
 *    一个字节都不写。
 * 2. **采集失败 ≠ 业务异常**：每项检查的 `status` 分成「采到了（pass/warning/fail）」与
 *    「没采到（error + failure）」。日志里读到错误是 `fail` + 证据，不是 SSH 故障；
 *    只有连接/认证/指纹/超时/工具缺失/权限这类才算 `error`。主机级状态再由逐项结果
 *    汇总（见 finalizeHost 的优先级）。
 * 3. **有界**：单批 ≤ 20 台、全局 3 台并发、一台内顺序执行；每项命令 20s 上限；每个
 *    stdout/stderr 各自 16KB；落盘日志只保留尾部 8KB 并标记 truncated。
 * 4. **排队期间改主机不会误连**：批次创建时记录端点快照，实际调度前再比对一次；
 *    不一致就不连并明确告知（`endpoint-changed`），用户可以再发起一次复查。
 * 5. **状态诚实**：用户停止 → stopped；链路中断 → interrupted；应用退出留下的
 *    `running` 记录在下次启动归档为 interrupted（见 store 的 archiveInterrupted）。
 *
 * 纯逻辑 + 注入 exec / hostStore / store，可单测；真实通路见 ssh-triage-e2e.test.ts。
 */

/** 采集通道注入签名（真实实现 = SshConnectionManager.runBackgroundCommand）。 */
export type SshTriageExec = (hostId: string, command: string, options?: SshBackgroundCommandOptions) => Promise<SshBackgroundCommandResult>;

export interface SshTriageManagerDeps {
  hostStore: Pick<SshHostStore, "get" | "list">;
  store: SshTriageStore;
  cards: SshTriageCardStore;
  exec: SshTriageExec;
  now?: () => number;
  /** 全局同时运行的主机数（缺省 SSH_TRIAGE_HOST_CONCURRENCY）。 */
  hostConcurrency?: number;
  /** 单条检查命令的超时（缺省 SSH_TRIAGE_CHECK_TIMEOUT_MS）。 */
  checkTimeoutMs?: number;
  /** 单项日志保留上限（字符，缺省 SSH_TRIAGE_LOG_LIMIT_CHARS）。 */
  logLimitChars?: number;
  /** 状态变化信号（渲染端可选订阅；不订阅就靠短轮询）。 */
  onChange?: () => void;
}

/** 单项检查的解释结果（采集层与业务层在这里定稿）。 */
interface SshTriageCheckOutcome {
  status: SshTriageCheckStatus;
  failure?: SshTriageFailure;
  reason?: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}

interface SshTriageCheckPlan {
  request: SshTriageCheckRequest;
  label: string;
  command: string;
  interpret(result: SshBackgroundCommandResult): SshTriageCheckOutcome;
}

/** 单条命令的可视输出上限（stdout/stderr 各自口径，与 exec 侧一致）。 */
const CHECK_OUTPUT_LIMIT_CHARS = 16 * 1024;

/** 采集命令里拼接的远端路径/单元名统一单引号转义（参数已先过白名单校验）。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * stdout 与 stderr 合成一段证据文本：命令本身通常已经 `2>&1`，但工具缺失/权限被拒
 * 这类失败只出现在 stderr，丢了就没法解释「为什么是采集失败」。
 */
function combineOutput(result: SshBackgroundCommandResult): { text: string; truncated: boolean } {
  const { stdout, stderr } = result;
  let text = stdout;
  if (stderr) {
    if (text && !text.endsWith("\n")) text += "\n";
    text += stderr;
  }
  return { text, truncated: result.truncated === true };
}

function firstLines(text: string, count = 2): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, count).join(" · ").slice(0, 300);
}

function isToolMissing(text: string, tool: string): boolean {
  return new RegExp(`${tool}[^\\n]*(command not found|not found)|(command not found|No such file or directory)[^\\n]*${tool}`, "i").test(text)
    || new RegExp(`PI_TRIAGE_MISSING`, "i").test(text);
}

function isPermissionDenied(text: string): boolean {
  return /permission denied|access denied|not authorized|interactive authentication required|insufficient permissions/i.test(text);
}

/** 连接层的失败：后面的检查没必要继续跑（远端已经不在了）。 */
const CONNECTION_FAILURES: readonly SshTriageFailure[] = [
  "host-missing",
  "endpoint-changed",
  "credentials-missing",
  "fingerprint-unknown",
  "fingerprint-mismatch",
  "auth-failed",
  "connect-failed",
  "timeout",
  "disconnected",
  "channel-failed",
  "stopped"
];

/** 链路层失败（决定主机是「采集中断」还是「采集失败」）。 */
const LINK_FAILURES: readonly SshTriageFailure[] = ["disconnected", "timeout", "channel-failed", "connect-failed"];

function failureOutcome(failure: SshTriageFailure, message: string, result: SshBackgroundCommandResult): SshTriageCheckOutcome {
  const { text, truncated } = combineOutput(result);
  return {
    status: failure === "stopped" ? "skipped" : "error",
    failure,
    reason: message,
    exitCode: result.exitCode,
    output: text,
    truncated
  };
}

/**
 * 服务状态：`systemctl show` 只读属性，输出是稳定的 `Key=Value` 行。
 * 用 `show` 而不是 `status` 是因为 status 的退出码在旧版本 systemd 上对 inactive 也返回 0
 * （按退出码判会把「服务挂了」误判成「通过」），而 ActiveState 是确定值。
 */
function servicePlan(request: Extract<SshTriageCheckRequest, { kind: "service" }>): SshTriageCheckPlan {
  const unit = request.unit.trim();
  return {
    request,
    label: describeSshTriageCheck(request),
    command: `LC_ALL=C systemctl show -p ActiveState -p SubState -p UnitFileState -p LoadState -- ${shellQuote(unit)} 2>&1`,
    interpret(result) {
      if (!result.ok) return failureOutcome(result.failure, result.message, result);
      const { text, truncated } = combineOutput(result);
      if (isToolMissing(text, "systemctl")) return { status: "error", failure: "tool-missing", reason: "远端没有 systemctl（可能不是 systemd 系统）", exitCode: result.exitCode, output: text, truncated };
      if (isPermissionDenied(text)) return { status: "error", failure: "permission", reason: `无权读取服务状态：${firstLines(text)}`, exitCode: result.exitCode, output: text, truncated };
      const props = new Map<string, string>();
      for (const line of text.split(/\r?\n/)) {
        const match = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
        if (match) props.set(match[1]!, match[2]!.trim());
      }
      const activeState = props.get("ActiveState");
      const loadState = props.get("LoadState");
      const subState = props.get("SubState");
      const unitFileState = props.get("UnitFileState");
      if (loadState === "not-found" || /could not be found/i.test(text)) {
        return { status: "fail", reason: `系统里没有这个服务单元（${unit}），可能名称写错或未安装`, exitCode: result.exitCode, output: text, truncated };
      }
      if (!activeState) {
        return { status: "error", failure: "unknown", reason: `无法解析 systemctl 输出：${firstLines(text)}`, exitCode: result.exitCode, output: text, truncated };
      }
      const detail = [`ActiveState=${activeState}`, subState ? `SubState=${subState}` : "", unitFileState ? `UnitFileState=${unitFileState}` : ""].filter(Boolean).join(" · ");
      if (activeState === "active") return { status: "pass", reason: detail, exitCode: result.exitCode, output: text, truncated };
      if (activeState === "activating" || activeState === "reloading" || activeState === "deactivating" || activeState === "refreshing") {
        return { status: "warning", reason: detail, exitCode: result.exitCode, output: text, truncated };
      }
      return { status: "fail", reason: detail, exitCode: result.exitCode, output: text, truncated };
    }
  };
}

/** 端口是否出现在某行的本地地址里（`:8080` / `*:8080` / `[::]:8080`，且不是 80801）。 */
function lineHasPort(line: string, port: number): boolean {
  return new RegExp(`[:.]${port}(?![0-9])`).test(line);
}

/**
 * 预期监听端口：优先 `ss`，退回 `netstat`；两者都没有就是采集失败（tool-missing）。
 * 只列监听态（`-l`），所以按端口匹配地址即可，不必再判 State 列（udp 的 `-lun` 也没有
 * LISTEN 字样）。
 */
function portPlan(request: Extract<SshTriageCheckRequest, { kind: "port" }>): SshTriageCheckPlan {
  const port = Math.round(request.port);
  const protocol = request.protocol ?? "tcp";
  const flag = protocol === "udp" ? "-lun" : "-ltn";
  return {
    request,
    label: describeSshTriageCheck(request),
    command: `if command -v ss >/dev/null 2>&1; then LC_ALL=C ss -H ${flag}; elif command -v netstat >/dev/null 2>&1; then LC_ALL=C netstat ${flag}; else printf 'PI_TRIAGE_MISSING: ss|netstat\\n' >&2; exit 127; fi`,
    interpret(result) {
      if (!result.ok) return failureOutcome(result.failure, result.message, result);
      const { text, truncated } = combineOutput(result);
      if (/PI_TRIAGE_MISSING/i.test(text) || result.exitCode === 127) {
        return { status: "error", failure: "tool-missing", reason: "远端缺少 ss 与 netstat，无法列举监听端口", exitCode: result.exitCode, output: text, truncated };
      }
      if (isPermissionDenied(text)) return { status: "error", failure: "permission", reason: `无权列举监听端口：${firstLines(text)}`, exitCode: result.exitCode, output: text, truncated };
      const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
      const matched = lines.filter((line) => lineHasPort(line, port));
      if (matched.length > 0 && result.exitCode === 0) {
        return { status: "pass", reason: `已监听 :${port}/${protocol}（${matched.length} 条记录）`, exitCode: result.exitCode, output: text, truncated };
      }
      if (result.exitCode !== 0) {
        return { status: "error", failure: "unknown", reason: `列举监听端口失败（退出码 ${result.exitCode}）：${firstLines(text)}`, exitCode: result.exitCode, output: text, truncated };
      }
      if (truncated) return { status: "error", failure: "unknown", reason: "监听列表已截断，无法确认端口是否监听", exitCode: result.exitCode, output: text, truncated };
      return { status: "fail", reason: `未找到 :${port}/${protocol} 的监听记录（本次共 ${lines.length} 个监听项）`, exitCode: result.exitCode, output: text, truncated };
    }
  };
}

/** 磁盘用量：`df -Pk` 的 POSIX 输出（容量列在第 5 字段，末字段是挂载点）。 */
function diskPlan(request: Extract<SshTriageCheckRequest, { kind: "disk" }>): SshTriageCheckPlan {
  const path = request.path.trim();
  const warnPercent = request.warnPercent ?? 85;
  const failPercent = request.failPercent ?? 95;
  return {
    request,
    label: describeSshTriageCheck(request),
    command: `LC_ALL=C df -Pk ${shellQuote(path)} 2>&1`,
    interpret(result) {
      if (!result.ok) return failureOutcome(result.failure, result.message, result);
      const { text, truncated } = combineOutput(result);
      if (isToolMissing(text, "df")) return { status: "error", failure: "tool-missing", reason: "远端没有 df", exitCode: result.exitCode, output: text, truncated };
      if (isPermissionDenied(text)) return { status: "error", failure: "permission", reason: `无权读取文件系统用量：${firstLines(text)}`, exitCode: result.exitCode, output: text, truncated };
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const dataLine = [...lines].reverse().find((line) => /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%/.test(line));
      if (!dataLine) {
        return { status: "error", failure: "unknown", reason: `无法读取用量：${firstLines(text) || "没有输出"}`, exitCode: result.exitCode, output: text, truncated };
      }
      const fields = dataLine.split(/\s+/);
      const mount = fields[fields.length - 1] ?? path;
      const usedPercent = Number.parseInt((fields[4] ?? "").replace("%", ""), 10);
      if (!Number.isFinite(usedPercent)) {
        return { status: "error", failure: "unknown", reason: `无法解析 df 输出：${dataLine.slice(0, 200)}`, exitCode: result.exitCode, output: text, truncated };
      }
      const reason = `已用 ${usedPercent}%（${mount}）`;
      if (usedPercent >= failPercent) return { status: "fail", reason: `${reason}，超过 ${failPercent}% 阈值`, exitCode: result.exitCode, output: text, truncated };
      if (usedPercent >= warnPercent) return { status: "warning", reason: `${reason}，超过 ${warnPercent}% 预警线`, exitCode: result.exitCode, output: text, truncated };
      return { status: "pass", reason, exitCode: result.exitCode, output: text, truncated };
    }
  };
}

/**
 * 近期错误日志：`journalctl -p err --since`（只读）。没有输出 = 该时间段没有错误级日志
 * （pass）；有输出 = 业务异常（fail），证据就是这些行。读不到 journal（权限/未启用）算
 * 采集失败——不能因为「没读到」就说「没问题」。
 */
function journalPlan(request: Extract<SshTriageCheckRequest, { kind: "journal" }>): SshTriageCheckPlan {
  const unit = request.unit?.trim();
  const minutes = request.minutes ?? 15;
  const unitArg = unit ? `--unit=${shellQuote(unit)} ` : "";
  return {
    request,
    label: describeSshTriageCheck(request),
    command: `LC_ALL=C journalctl ${unitArg}--since ${shellQuote(`${minutes} min ago`)} -p err -n 200 --no-pager -o short-iso 2>&1`,
    interpret(result) {
      if (!result.ok) return failureOutcome(result.failure, result.message, result);
      const { text, truncated } = combineOutput(result);
      if (isToolMissing(text, "journalctl")) return { status: "error", failure: "tool-missing", reason: "远端没有 journalctl（可能不是 systemd 系统）", exitCode: result.exitCode, output: text, truncated };
      if (/No journal files were found|not seeing messages from other users|Failed to add match|Specifying boot ID or boot offset has no effect/i.test(text)) {
        return { status: "error", failure: "permission", reason: `无法读取 journal：${firstLines(text)}`, exitCode: result.exitCode, output: text, truncated };
      }
      if (isPermissionDenied(text)) return { status: "error", failure: "permission", reason: `无权读取 journal：${firstLines(text)}`, exitCode: result.exitCode, output: text, truncated };
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (result.exitCode !== 0) return { status: "error", failure: "unknown", reason: firstLines(text) || `journalctl 退出码 ${result.exitCode}`, exitCode: result.exitCode, output: text, truncated };
      const messages = lines.filter((line) => line !== "-- No entries --");
      if (messages.length === 0) {
        return { status: "pass", reason: `最近 ${minutes} 分钟没有可见的错误级日志`, exitCode: result.exitCode, output: text, truncated };
      }
      return {
        status: "fail",
        reason: `最近 ${minutes} 分钟采到了错误级日志（最多采集 200 条）`,
        exitCode: result.exitCode,
        output: text,
        truncated
      };
    }
  };
}

/** 参数化检查 → 可执行的命令 + 解释器（命令构造只在这里发生）。 */
export function buildCheckPlan(request: SshTriageCheckRequest): SshTriageCheckPlan {
  switch (request.kind) {
    case "service":
      return servicePlan(request);
    case "port":
      return portPlan(request);
    case "disk":
      return diskPlan(request);
    case "journal":
      return journalPlan(request);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueHostIds(hostIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of hostIds) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export class SshTriageManager {
  private readonly active = new Map<string, { batchId: string; hostIndex: number; controller: AbortController }>();
  private readonly now: () => number;
  private readonly hostConcurrency: number;
  private readonly checkTimeoutMs: number;
  private readonly logLimitChars: number;
  private storeError: string | undefined;
  private disposed = false;

  constructor(private readonly deps: SshTriageManagerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.hostConcurrency = Math.max(1, Math.round(deps.hostConcurrency ?? SSH_TRIAGE_HOST_CONCURRENCY));
    this.checkTimeoutMs = Math.max(1_000, Math.round(deps.checkTimeoutMs ?? SSH_TRIAGE_CHECK_TIMEOUT_MS));
    this.logLimitChars = Math.max(256, Math.round(deps.logLimitChars ?? SSH_TRIAGE_LOG_LIMIT_CHARS));
  }

  /** 写盘失败上报（面板单列提示；采集与连接照常收尾）。 */
  reportStoreError(message: string): void {
    this.storeError = message;
    this.notify();
  }

  async handle(command: SshTriageCommand): Promise<SshTriageCommandResult> {
    switch (command.type) {
      case "triage.start":
        return this.start(command);
      case "triage.list":
        return { kind: "triage-batches", batches: this.deps.store.list().map((batch) => batchSummaryOf(batch, this.storeError)) };
      case "triage.detail":
        return this.detail(command.batchId, command.hostId);
      case "triage.stop":
        return this.stop(command.batchId);
      case "triage.card.get":
        return this.cardGet(command.hostId);
      case "triage.card.save":
        return this.cardSave(command);
      case "triage.card.adopt":
        return this.cardAdopt(command.hostId, command.fromEndpoint, command.accept);
      default:
        throw new Error(`不支持的排查命令：${(command as { type?: string }).type ?? "?"}`);
    }
  }

  /** 应用退出前收尾：停掉在途采集并 flush（状态留在 running，下次启动归档为中断）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const run of this.active.values()) run.controller.abort();
    this.active.clear();
    this.deps.store.dispose();
    this.deps.cards.flush();
  }

  // ——— 批次 ———

  private start(command: Extract<SshTriageCommand, { type: "triage.start" }>): SshTriageCommandResult {
    const hostIds = uniqueHostIds(command.hostIds ?? []);
    if (hostIds.length === 0) throw new Error("请至少选择一台主机");
    if (hostIds.length > SSH_TRIAGE_MAX_HOSTS) {
      throw new Error(`单批最多 ${SSH_TRIAGE_MAX_HOSTS} 台主机，本次选了 ${hostIds.length} 台，请分批`);
    }
    if (this.deps.store.list().filter((batch) => batch.status === "running").length >= 5) throw new Error("同时最多保留 5 个待执行或进行中的排查批次");
    if (command.checks.length > 4 || new Set(command.checks.map((check) => check?.kind)).size !== command.checks.length) throw new Error("每种检查最多选择一次");
    const checks = normalizeCheckRequests(command.checks ?? []);
    if (checks.length === 0) throw new Error("请至少选择一个有效的检查项");
    for (const check of command.checks ?? []) {
      const problem = validateSshTriageCheck(check);
      if (problem) throw new Error(problem);
    }
    // 主机必须在库里：批次要连的是一台确定身份的主机，不是一段时间后可能被替换的 id。
    const missing: string[] = [];
    const snapshots: SshTriageHostSnapshot[] = [];
    for (const hostId of hostIds) {
      const stored = this.deps.hostStore.get(hostId);
      if (!stored) {
        missing.push(hostId);
        continue;
      }
      snapshots.push({
        hostId: stored.id,
        displayName: stored.name,
        host: stored.host,
        port: stored.port,
        username: stored.username
      });
    }
    if (missing.length > 0) throw new Error(`主机不存在或已删除：${missing.join("、")}`);
    const timestamp = this.now();
    const title = (command.title ?? "").trim().slice(0, SSH_TRIAGE_TITLE_LIMIT) || `${new Date(timestamp).toLocaleString("zh-CN", { hour12: false })} · ${snapshots.length} 台主机排查`;
    const sourceBatchId = typeof command.sourceBatchId === "string" && this.deps.store.get(command.sourceBatchId) ? command.sourceBatchId : undefined;
    const batch: SshTriageStoredBatch = {
      id: `triage-${timestamp.toString(36)}-${randomUUID().slice(0, 6)}`,
      title,
      status: "running",
      createdAt: timestamp,
      checks,
      ...(sourceBatchId ? { sourceBatchId } : {}),
      hosts: snapshots.map((snapshot) => ({
        snapshot,
        status: "queued" as const,
        checksDone: 0,
        checksTotal: checks.length,
        checks: checks.map((request) => ({
          kind: request.kind,
          label: describeSshTriageCheck(request),
          status: "pending" as const,
          exitCode: null,
          outputChars: 0
        }))
      }))
    };
    this.save(batch);
    this.notify();
    // 立即返回 ID：调度在下一个 tick 开始（后台任务不阻塞 IPC 应答）。
    queueMicrotask(() => this.pump());
    return { kind: "triage-batch", batch: batchSummaryOf(batch, this.storeError) };
  }

  private detail(batchId: string, hostId?: string): SshTriageCommandResult {
    const batch = this.requireBatch(batchId);
    const logHostId = hostId && batch.hosts.some((host) => host.snapshot.hostId === hostId) ? hostId : undefined;
    const hosts: SshTriageHostDetail[] = batch.hosts.map((host) => {
      const current = this.deps.hostStore.get(host.snapshot.hostId);
      const includeLog = logHostId !== undefined && host.snapshot.hostId === logHostId;
      const checks: SshTriageCheckResult[] = host.checks.map((check) => {
        const { log, ...rest } = check;
        const output = includeLog && log ? this.deps.store.readLog(batch.id, log) : undefined;
        return { ...rest, ...(output !== undefined ? { output } : {}) };
      });
      const endpoint = sshEndpointKey(host.snapshot);
      return {
        hostId: host.snapshot.hostId,
        displayName: host.snapshot.displayName,
        endpoint,
        status: host.status,
        ...(host.reason !== undefined ? { reason: host.reason } : {}),
        ...(host.startedAt !== undefined ? { startedAt: host.startedAt } : {}),
        ...(host.endedAt !== undefined ? { endedAt: host.endedAt } : {}),
        checksDone: host.checksDone,
        checksTotal: host.checksTotal,
        checks,
        ...(current
          ? {
              current: { name: current.name, endpoint: sshEndpointKey(current) },
              ...(sshEndpointKey(current) !== endpoint ? { endpointChanged: true } : {})
            }
          : { hostMissing: true })
      };
    });
    const detail: SshTriageBatchDetail = {
      summary: batchSummaryOf(batch, this.storeError),
      hosts,
      ...(logHostId ? { logHostId } : {})
    };
    return { kind: "triage-detail", detail };
  }

  private stop(batchId: string): SshTriageCommandResult {
    const batch = this.requireBatch(batchId);
    if (batch.status !== "running") return { kind: "triage-batch", batch: batchSummaryOf(batch, this.storeError) };
    const timestamp = this.now();
    batch.status = "stopped";
    batch.endedAt = timestamp;
    for (const host of batch.hosts) {
      if (host.status !== "queued") continue;
      host.status = "not-run";
      host.reason = "批次已停止，未执行";
      host.endedAt = timestamp;
      for (const check of host.checks) {
        if (check.status === "pending" || check.status === "running") {
          check.status = "skipped";
          check.reason = "批次已停止，未执行";
        }
      }
      host.checksDone = host.checks.filter((check) => check.status !== "pending" && check.status !== "running").length;
    }
    for (const run of this.active.values()) {
      if (run.batchId === batchId) run.controller.abort();
    }
    this.save(batch);
    this.notify();
    return { kind: "triage-batch", batch: batchSummaryOf(batch, this.storeError) };
  }

  /** 调度：全局至多 hostConcurrency 台在跑，一台内按检查项顺序执行；旧批次优先。 */
  private pump(): void {
    if (this.disposed) return;
    while (this.active.size < this.hostConcurrency) {
      const next = this.nextQueuedHost();
      if (!next) return;
      // 先置 running 再异步起跑：同一个 tick 里不会被 pump 再次选中。
      next.host.status = "running";
      void this.runHost(next.batch, next.hostIndex);
    }
  }

  private nextQueuedHost(): { batch: SshTriageStoredBatch; hostIndex: number; host: SshTriageStoredHost } | undefined {
    const batches = [...this.deps.store.list()].sort((a, b) => a.createdAt - b.createdAt);
    for (const batch of batches) {
      if (batch.status !== "running") continue;
      const hostIndex = batch.hosts.findIndex((host) => host.status === "queued");
      if (hostIndex >= 0) return { batch, hostIndex, host: batch.hosts[hostIndex]! };
    }
    return undefined;
  }

  private async runHost(batch: SshTriageStoredBatch, hostIndex: number): Promise<void> {
    const host = batch.hosts[hostIndex]!;
    const key = `${batch.id}:${hostIndex}`;
    const controller = new AbortController();
    this.active.set(key, { batchId: batch.id, hostIndex, controller });
    host.status = "running";
    host.startedAt = this.now();
    delete host.reason;
    this.save(batch);
    this.notify();
    try {
      await this.collect(batch, hostIndex, controller.signal);
    } catch (error) {
      for (const check of host.checks) {
        if (check.status === "pending" || check.status === "running") {
          check.status = "error";
          check.failure = "unknown";
          check.reason = `采集异常：${messageOf(error)}`;
        }
      }
      host.status = "error";
      host.reason = `采集异常：${messageOf(error)}`;
      host.endedAt = this.now();
      this.save(batch);
    } finally {
      this.active.delete(key);
      if (this.disposed) return;
      this.finalizeHost(batch, hostIndex, controller.signal.aborted);
      this.finalizeBatch(batch);
      this.notify();
      this.pump();
    }
  }

  private async collect(batch: SshTriageStoredBatch, hostIndex: number, signal: AbortSignal): Promise<void> {
    const host = batch.hosts[hostIndex]!;
    // 排队期间主机被编辑：端点不一致就不连（快照是唯一事实，绝不连到新地址）。
    const current = this.deps.hostStore.get(host.snapshot.hostId);
    if (!current) {
      this.abortHost(host, "error", "host-missing", "主机已删除，本次未连接");
      return;
    }
    const currentEndpoint = sshEndpointKey(current);
    const snapshotEndpoint = sshEndpointKey(host.snapshot);
    if (currentEndpoint !== snapshotEndpoint) {
      this.abortHost(host, "error", "endpoint-changed", `主机端点已变更（当前 ${currentEndpoint}，创建批次时 ${snapshotEndpoint}），本次未连接；确认后请重新发起复查`);
      return;
    }
    const plans = batch.checks.map((request) => buildCheckPlan(request));
    for (const [checkIndex, plan] of plans.entries()) {
      const check = host.checks[checkIndex]!;
      if (signal.aborted) {
        this.markCheckSkipped(check, "已停止");
        continue;
      }
      const logName = this.deps.store.logName(batch.id, hostIndex, checkIndex);
      check.status = "running";
      check.log = logName;
      this.save(batch);
      this.notify();
      const startedAt = Date.now();
      let result: SshBackgroundCommandResult;
      try {
        result = await this.deps.exec(host.snapshot.hostId, plan.command, {
          timeoutMs: this.checkTimeoutMs,
          signal,
          maxOutputChars: CHECK_OUTPUT_LIMIT_CHARS,
          // 边收边落盘：崩溃/断电时当前项的部分输出还在（启动归档只补状态，不补字节）。
          onChunk: (chunk) => {
            this.deps.store.appendLog(batch.id, logName, chunk);
            this.notify();
          }
        });
      } catch (error) {
        result = { ok: false, failure: "unknown", message: messageOf(error), stdout: "", stderr: "", exitCode: null };
      }
      if (this.disposed) return;
      const outcome = plan.interpret(result);
      check.status = outcome.status;
      check.failure = outcome.failure;
      check.reason = outcome.reason;
      check.exitCode = outcome.exitCode;
      check.durationMs = Date.now() - startedAt;
      check.outputChars = outcome.output.length;
      check.truncated = outcome.truncated || outcome.output.length > this.logLimitChars;
      if (outcome.output) {
        check.log = logName;
        this.deps.store.writeLog(batch.id, logName, outcome.output);
      } else {
        delete check.log;
      }
      host.checksDone = host.checks.filter((item) => item.status !== "pending" && item.status !== "running").length;
      this.save(batch);
      this.notify();
      // 连接层失败：后面的检查没有意义，直接标未执行（用户看得到「卡在哪一步」）。
      if (outcome.failure && CONNECTION_FAILURES.includes(outcome.failure)) {
        for (let rest = checkIndex + 1; rest < plans.length; rest += 1) {
          this.markCheckSkipped(host.checks[rest]!, outcome.failure === "stopped" ? "已停止" : `前置检查未完成（${outcome.reason ?? "采集失败"}）`);
        }
        if (LINK_FAILURES.includes(outcome.failure)) {
          host.reason = "采集过程中连接中断（已保留已采集部分输出）";
        }
        break;
      }
    }
  }

  private markCheckSkipped(check: SshTriageStoredHost["checks"][number], reason: string): void {
    if (check.status === "pass" || check.status === "fail" || check.status === "warning" || check.status === "error") return;
    check.status = "skipped";
    check.reason = reason;
    check.exitCode = check.exitCode ?? null;
  }

  /** 连接层失败：整台主机直接定稿（剩余检查标未执行）。 */
  private abortHost(host: SshTriageStoredHost, status: SshTriageHostStatus, failure: SshTriageFailure, reason: string): void {
    for (const check of host.checks) {
      this.markCheckSkipped(check, reason);
      if (!check.failure) check.failure = failure;
    }
    host.status = status;
    host.reason = reason;
    host.endedAt = this.now();
    host.checksDone = host.checks.filter((check) => check.status !== "pending" && check.status !== "running").length;
  }

  /**
   * 主机级结论的优先级：用户停止 > 链路中断 > 业务异常 > 采集失败 > 提醒 > 通过。
   *
   * 为什么「业务异常」压过「采集失败」：一口气跑了 4 项，其中服务确实没起（fail）、
   * journal 因为权限没读到（error）—— 用户最需要看到的是「服务挂了」，而没读到的那项
   * 在逐项列表里写着 error。只有一项业务结论都没有时，主机才整体算「采集失败」。
   */
  private finalizeHost(batch: SshTriageStoredBatch, hostIndex: number, aborted: boolean): void {
    const host = batch.hosts[hostIndex]!;
    if (host.status === "error" && host.endedAt !== undefined) return; // abortHost / 异常分支已经定稿
    if (host.status !== "running" && host.status !== "queued") return;
    const checks = host.checks;
    host.endedAt = host.endedAt ?? this.now();
    host.checksDone = checks.filter((check) => check.status !== "pending" && check.status !== "running").length;
    const errors = checks.filter((check) => check.status === "error");
    const failed = checks.filter((check) => check.status === "fail");
    const warned = checks.filter((check) => check.status === "warning");
    const labels = (items: SshTriageCheckResult[]) => items.map((check) => check.label).join("、");
    if (aborted) {
      host.status = "stopped";
      host.reason = "已停止采集（保留已采集部分输出）";
      return;
    }
    const disconnected = errors.find((check) => check.failure === "disconnected");
    if (disconnected) {
      host.status = "interrupted";
      host.reason = failed.length ? `采集中断，已确认 ${failed.length} 项异常：${labels(failed)}` : "采集中断，已保留已采集的输出";
      return;
    }
    if (failed.length > 0) {
      host.status = "failed";
      host.reason = `${failed.length} 项异常：${labels(failed)}${errors.length > 0 ? `；另有 ${errors.length} 项采集失败` : ""}`;
      return;
    }
    if (errors.length > 0) {
      const link = errors.find((check) => check.failure && LINK_FAILURES.includes(check.failure));
      if (link) {
        host.status = "interrupted";
        host.reason = host.reason ?? `采集过程中连接中断：${link.reason ?? link.failure ?? ""}`.trim();
        return;
      }
      host.status = "error";
      host.reason = host.reason ?? `${errors.length} 项采集失败：${errors.map((check) => `${check.label}（${check.reason ?? "未知原因"}）`).join("；")}`;
      return;
    }
    if (warned.length > 0) {
      host.status = "warning";
      host.reason = `${warned.length} 项需要留意：${labels(warned)}`;
      return;
    }
    host.status = "passed";
    host.reason = checks.length > 0 ? "全部检查通过" : "没有可执行的检查项";
  }

  private finalizeBatch(batch: SshTriageStoredBatch): void {
    const pending = batch.hosts.some((host) => host.status === "queued" || host.status === "running");
    if (pending) {
      if (batch.status === "running") this.save(batch);
      return;
    }
    if (batch.status === "running") {
      batch.status = "finished";
      batch.endedAt = batch.endedAt ?? this.now();
    }
    batch.endedAt = batch.endedAt ?? this.now();
    this.save(batch);
    // 只在批次收尾时裁剪：活动批次不裁，且不打断正在采集的日志写入。
    this.deps.store.flush();
    this.deps.store.prune();
  }

  private save(batch: SshTriageStoredBatch): void {
    try {
      this.deps.store.put(batch);
    } catch (error) {
      this.storeError = `排查记录写入失败：${messageOf(error)}`;
    }
  }

  private notify(): void {
    try {
      this.deps.onChange?.();
    } catch {
      // 通知失败不影响采集
    }
  }

  private requireBatch(batchId: string): SshTriageStoredBatch {
    const batch = this.deps.store.get(batchId);
    if (!batch) throw new Error("排查批次不存在（可能已被清理）");
    return batch;
  }

  // ——— 主机卡片 ———

  private cardView(hostId: string, view: { card: SshTriageCardView["card"]; stale?: SshTriageCardView["card"] }): SshTriageCardView {
    const current = this.deps.hostStore.get(hostId);
    return {
      card: view.card,
      ...(current ? { host: { name: current.name, host: current.host, port: current.port, username: current.username } } : {}),
      ...(view.stale ? { stale: view.stale } : {})
    };
  }

  private cardGet(hostId: string): SshTriageCommandResult {
    const trimmed = hostId.trim();
    if (!trimmed) throw new Error("缺少主机 id");
    const current = this.deps.hostStore.get(trimmed);
    // 主机已删除时 endpoint 传空串：store 会按 hostId 取最近更新的那张卡（历史可读）。
    const view = this.deps.cards.get(trimmed, current ? sshEndpointKey(current) : "");
    return { kind: "triage-card", view: this.cardView(trimmed, view) };
  }

  private cardSave(command: Extract<SshTriageCommand, { type: "triage.card.save" }>): SshTriageCommandResult {
    const hostId = command.hostId.trim();
    const endpoint = command.endpoint.trim();
    if (!hostId || !endpoint) throw new Error("保存主机卡片缺少主机或端点标识");
    const current = this.deps.hostStore.get(hostId);
    if (current && sshEndpointKey(current) !== endpoint) {
      // 卡片属于「当前这台机器」：端点变了就该先确认转用，绝不把新内容写到旧端点上。
      const view = this.deps.cards.get(hostId, sshEndpointKey(current));
      return { kind: "triage-card-conflict", view: this.cardView(hostId, view), message: `主机端点已变更（当前 ${sshEndpointKey(current)}），请刷新卡片后再保存` };
    }
    const saved = this.deps.cards.save({
      hostId,
      endpoint,
      revision: Math.round(command.revision),
      directories: command.directories ?? [],
      summaries: command.summaries ?? []
    });
    if (!saved.ok) {
      const view = this.deps.cards.get(hostId, endpoint);
      return { kind: "triage-card-conflict", view: this.cardView(hostId, view), message: "卡片已被其他窗口修改，请刷新后重试（已保留对方的内容）" };
    }
    return { kind: "triage-card-saved", view: this.cardView(hostId, this.deps.cards.get(hostId, endpoint)) };
  }

  private cardAdopt(hostId: string, fromEndpoint: string, accept: boolean): SshTriageCommandResult {
    const trimmed = hostId.trim();
    const current = this.deps.hostStore.get(trimmed);
    if (!current) throw new Error("主机不存在或已删除，无法转用卡片资料");
    const toEndpoint = sshEndpointKey(current);
    const previous = fromEndpoint.trim();
    if (this.deps.cards.get(trimmed, toEndpoint).stale?.endpoint !== previous) throw new Error("旧端点资料已变化，请刷新主机卡片");
    const result = this.deps.cards.adopt({ hostId: trimmed, fromEndpoint: previous, toEndpoint, accept });
    return { kind: "triage-card-saved", view: this.cardView(trimmed, result) };
  }
}

export interface SshTriageRuntimeDeps {
  /** 记录目录（`<userData>/pidesktop-ssh-triage`）。 */
  dir: string;
  hostStore: Pick<SshHostStore, "get" | "list">;
  exec: SshTriageExec;
  now?: () => number;
  hostConcurrency?: number;
  checkTimeoutMs?: number;
  limits?: SshTriageStoreLimits;
  onChange?: () => void;
}

/**
 * 装配入口：store（批次 + 日志）与 cards 都落在 `dir` 下，写盘失败经同一通道上报给
 * 面板（`storeError`），不打断采集。
 */
export function createSshTriageManager(deps: SshTriageRuntimeDeps): SshTriageManager {
  let manager: SshTriageManager | undefined;
  const report = (message: string): void => manager?.reportStoreError(message);
  const store = createSshTriageStore({ dir: deps.dir, ...(deps.limits ? { limits: deps.limits } : {}), ...(deps.now ? { now: deps.now } : {}), onError: report });
  const cards = createSshTriageCardStore({ filePath: join(deps.dir, "cards.json"), onError: report, ...(deps.now ? { now: deps.now } : {}) });
  manager = new SshTriageManager({
    hostStore: deps.hostStore,
    store,
    cards,
    exec: deps.exec,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.hostConcurrency !== undefined ? { hostConcurrency: deps.hostConcurrency } : {}),
    ...(deps.checkTimeoutMs !== undefined ? { checkTimeoutMs: deps.checkTimeoutMs } : {}),
    ...(deps.limits?.logLimitChars !== undefined ? { logLimitChars: deps.limits.logLimitChars } : {}),
    ...(deps.onChange ? { onChange: deps.onChange } : {})
  });
  return manager;
}
