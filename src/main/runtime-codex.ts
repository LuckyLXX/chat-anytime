/**
 * Codex CLI 的能力簇（显式输入的纯构建器）：设置归一化、可执行文件探测、连接测试、
 * 以及把「一条 Codex 成员」接进团队运行时。
 *
 * 分层（与 runtime-browser / runtime-ssh 同款）：
 * - 配置只在这里读一次（`normalizeCodexCliConfig` 是唯一读入口，D 阶段的
 *   settings.ts 复用它），构建器本身不 import Electron、不读全局 settings；
 * - 进程由主进程的受监管通道拉起（`startProcess` 注入），本模块只做语义；
 * - 协议的 JSONL/握手/回合路由在 `codex-app-server.ts` 与 `codex-team-child.ts`。
 *
 * 权限姿态（C 阶段已接入，见 `codex-policy.ts`）：
 * - 逐轮策略：只读是缺省；「当前工作区可写」还要同时满足设置上限 + Lead 会话当前模式
 *   （`read-only` 恒只读、`ask` 先拿**本轮**确认、`workspace`/`full` 直接放行）；
 * - 沙箱是否真的生效由**运行时**证明：Windows 在握手后调真实的 `windowsSandbox/readiness`，
 *   不是 `ready`（或该版本不支持）时**两种访问级别**都拦下并给出具体原因；
 * - App Server 的服务端请求逐个方法明确拒绝，提权请求一律 RPC 错误（绝不 fail open）；
 * - 启动参数固定带配置加固（关钩子/插件/Apps、逐名禁用用户 MCP）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import {
  DEFAULT_CODEX_CLI_SETTINGS,
  normalizeCodexCliSettings,
  type CodexCliSettings,
  type CodexConnectionTestResult
} from "../shared/codex.js";
import type { AccessMode, CodexProcessStartOptions } from "../shared/protocol.js";
import { CodexAppServerClient, type CodexServerRequest, type CodexServerRequestDecision } from "./codex-app-server.js";
import {
  buildCodexServerArgs,
  codexMcpDisableArgs,
  codexMcpServerNamesFromToml,
  decideCodexServerRequest,
  decideCodexWindowsSandboxReadiness,
  inspectCodexEffectiveConfig,
  isCodexWindowsPlatform,
  readCodexWindowsSandboxReadiness,
  resolveCodexTurnPolicy
} from "./codex-policy.js";
import type { CodexProcessHandle } from "./codex-process-client.js";
import { validateCodexExecutable } from "./codex-process.js";
import {
  CodexTeamChild,
  type CodexConnection,
  type CodexTurnPolicy,
  type CodexTurnPolicyInput
} from "./codex-team-child.js";
import type { TeamChildCreated, TeamCodexBackend, TeamCodexBackendAvailability, TeamCodexChildRequest } from "./team-runtime.js";
import {
  codexThreadBindingPath,
  readCodexThreadBinding,
  writeCodexThreadBinding
} from "./team-store.js";

/** 全局 Codex CLI 配置（首版单个；落盘位置是 `settings.codex`）。 */
export type CodexCliConfig = CodexCliSettings;

export const DEFAULT_CODEX_CLI_CONFIG: CodexCliConfig = DEFAULT_CODEX_CLI_SETTINGS;

/**
 * settings 归一化（**唯一读入口**：`settings.ts` 的 migrateSettings 与这里共用同一份实现，
 * 见 `shared/codex.ts`；两份实现会让「设置页显示的」和「运行时实际用的」漂移）。
 * `undefined` = 没有这份配置（调用方保持缺省），对象 = 合法配置；未知字段丢弃、非法值退回默认。
 */
export function normalizeCodexCliConfig(value: unknown): CodexCliConfig | undefined {
  return normalizeCodexCliSettings(value);
}

/** 配置是否可以尝试启动（未启用时连探测都不做）。 */
export function codexConfigUsable(config: CodexCliConfig | undefined): boolean {
  return Boolean(config?.enabled);
}

export interface CodexExecutableSearchDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  readDir?: (path: string) => string[];
}

/**
 * 在 PATH 上探测官方安装：
 * - Windows：每个目录依次看 `codex.exe`、`codex.cmd`、`codex.bat`（原生优先）；
 * - POSIX：`codex`（不带扩展名）。
 *
 * 只返回**存在**的绝对路径；找不到返回 undefined（调用方给出可行动提示）。
 * PATH 条目两端的引号（Windows 常见）会被剥掉。
 */
export function detectCodexExecutable(deps: CodexExecutableSearchDeps = {}): string | undefined {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.fileExists ?? existsSync;
  const pathValue = env.PATH ?? env.Path ?? "";
  const names = platform === "win32" ? ["codex.exe", "codex.cmd", "codex.bat"] : ["codex"];
  // 分隔符按**目标平台**取，不能用宿主机的 node:path.delimiter（单测/跨平台诊断会错）。
  const separator = platform === "win32" ? ";" : ":";
  for (const raw of pathValue.split(separator)) {
    const directory = raw.trim().replace(/^"(.*)"$/u, "$1");
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        if (exists(candidate)) return candidate;
      } catch {
        // 无权限的 PATH 条目：跳过。
      }
    }
  }
  return undefined;
}

/** 解析「用哪个 Codex 可执行文件」：用户指定优先，否则 PATH 探测；解析失败抛出可行动错误。 */
export function resolveCodexExecutable(config: CodexCliConfig, deps: CodexExecutableSearchDeps = {}): string {
  if (config.executable) {
    // 用户选的路径也走同一套校验（只允许 Codex 本地可执行文件）。
    return validateCodexExecutable(config.executable, { platform: deps.platform });
  }
  const detected = detectCodexExecutable(deps);
  if (!detected) {
    throw new Error("找不到 Codex CLI：请安装官方 Codex CLI，或在设置里手动选择 codex 可执行文件");
  }
  return validateCodexExecutable(detected, { platform: deps.platform });
}

/** 读用户 Codex 配置里的 MCP 服务器名（best-effort：读不到就当没有，不阻断启动）。 */
export function readCodexMcpServerNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  try {
    return codexMcpServerNamesFromToml(readFileSync(join(home, "config.toml"), "utf8"));
  } catch {
    return [];
  }
}

/**
 * 真正下发的 app-server 启动参数：配置加固（钩子/插件/Apps）+ 逐个禁用用户 MCP 服务器。
 * 返回稳定顺序（同名集合在启动之间字节一致，方便对照日志）。
 */
export function buildCodexLaunchArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  return buildCodexServerArgs(codexMcpDisableArgs(readCodexMcpServerNames(env)));
}

/** 进程启动器（utility 侧进程桥的 `start`）。 */
export type CodexProcessStarter = (options: CodexProcessStartOptions) => Promise<CodexProcessHandle>;

/**
 * 「当前平台要不要在建线程前额外证明沙箱」的能力判定。
 *
 * 这里**不做平台禁令**（旧实现硬编码「Windows 一律拒绝写入」，那是拿宿主机平台当结论，
 * 而不是拿运行时证据）。真正的闸门在连接之后的 `windowsSandbox/readiness`
 * （见 `decideCodexWindowsSandboxReadiness`）：读数为 ready 才放行，否则连只读都拦下。
 * 保留这个注入点是为了让测试能把「证明不了」的路径覆盖出来。
 */
export interface CodexSandboxCapability {
  workspaceWrite: boolean;
  /** 给人看的一句结论（进可行动的错误/回执文案）。 */
  detail: string;
}

export function defaultCodexSandboxCapability(platform: NodeJS.Platform = process.platform): CodexSandboxCapability {
  return {
    workspaceWrite: true,
    detail: `当前平台（${platform}）由 Codex 自身建立沙箱；Windows 需 windowsSandbox/readiness = ready，否则只读与工作区写入都会被拦下`
  };
}

export interface CodexVersionProbe {
  ok: boolean;
  version?: string;
  error?: string;
}

/** `codex --version` → `codex-cli 0.171.0`；只取第一行、限长，进程必被回收。 */
export async function probeCodexVersion(
  startProcess: CodexProcessStarter,
  executable: string,
  cwd: string,
  timeoutMs = 15_000
): Promise<CodexVersionProbe> {
  let handle: CodexProcessHandle | undefined;
  try {
    handle = await startProcess({ executable, args: ["--version"], cwd });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const current = handle;
  let output = "";
  return await new Promise<CodexVersionProbe>((resolve) => {
    let settled = false;
    const finish = (result: CodexVersionProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      current.stop("版本探测完成");
      resolve(result);
    };
    const unsubscribe = current.onEvent((event) => {
      if (event.kind === "stdout" || event.kind === "stderr") {
        if (output.length < 2_000) output += event.text;
        return;
      }
      if (event.kind === "exit") {
        const line = output.split(/\r?\n/u).map((item) => item.trim()).find(Boolean) ?? "";
        if (event.code === 0 && line) finish({ ok: true, version: line.slice(0, 120) });
        else finish({ ok: false, error: event.error ?? `版本探测失败（退出码 ${event.code ?? "未知"}）` });
      }
    });
    const timer = setTimeout(() => finish({ ok: false, error: "版本探测超时" }), timeoutMs);
    timer.unref?.();
  });
}

// 回执形状（state 档位 + 版本 + 登录状态）定义在 shared/codex.ts：protocol 要用同一份
// 类型描述 `codex-test-result`，渲染端据此渲染可操作状态。
export type { CodexAuthStatus, CodexConnectionState, CodexConnectionTestResult } from "../shared/codex.js";

/**
 * 测试连接：解析可执行文件 → `--version` → 拉起 app-server → initialize/initialized/
 * account/read → 回收进程。任何一步失败都给出「下一步能做什么」的中文原因。
 */
export async function probeCodexConnection(input: {
  config: CodexCliConfig;
  startProcess: CodexProcessStarter;
  cwd: string;
  clientVersion?: string;
  platform?: NodeJS.Platform;
  /** 沙箱能力判定（缺省按当前平台；测试可注入）。 */
  sandboxCapability?: CodexSandboxCapability;
}): Promise<CodexConnectionTestResult> {
  const { config, startProcess, cwd } = input;
  if (!config.enabled) {
    return {
      ok: false,
      state: "not-enabled",
      access: config.access,
      message: "Codex 接入未启用：先在设置里打开「启用 Codex 接入」再测试连接"
    };
  }
  let executable: string;
  try {
    executable = resolveCodexExecutable(config, { platform: input.platform });
  } catch (error) {
    return {
      ok: false,
      state: "missing-cli",
      access: config.access,
      message: error instanceof Error ? error.message : String(error)
    };
  }
  const versionProbe = await probeCodexVersion(startProcess, executable, cwd);
  const capability = input.sandboxCapability ?? defaultCodexSandboxCapability(input.platform);
  // 工作区写入必须先能证明沙箱生效（见 CodexSandboxCapability）；证明不了就不放行。
  const accessNote = config.access === "workspace-write" && !capability.workspaceWrite
    ? `（工作区写入不可用：${capability.detail}）`
    : "";
  let handle: CodexProcessHandle;
  try {
    handle = await startProcess({ executable, args: buildCodexLaunchArgs(), cwd });
  } catch (error) {
    return {
      ok: false,
      state: "spawn-failed",
      access: config.access,
      executable,
      ...(versionProbe.version ? { version: versionProbe.version } : {}),
      message: `无法启动 Codex app-server：${error instanceof Error ? error.message : String(error)}`
    };
  }
  let closedReason = "";
  const client = new CodexAppServerClient({
    write: (frame) => handle.write(frame),
    clientInfo: { name: "pidesktop", title: "PiDesktop", version: input.clientVersion ?? "1" },
    onClose: (reason) => {
      closedReason = reason;
      handle.stop(reason);
    },
    onProtocolError: () => undefined
  });
  handle.onEvent((event) => {
    if (event.kind === "stdout") client.pushStdout(event.text);
    else if (event.kind === "stderr") client.pushStderr(event.text);
    else client.handleExit({ code: event.code, ...(event.signal ? { signal: event.signal } : {}), ...(event.error ? { error: event.error } : {}) });
  });
  try {
    const handshake = await client.handshake();
    const base = {
      access: config.access,
      executable,
      ...(versionProbe.version ? { version: versionProbe.version } : {}),
      platformOs: handshake.platformOs,
      auth: handshake.auth
    };
    if (isCodexWindowsPlatform(handshake)) {
      // 真实握手：Windows 的只读也依赖 Codex 自己的沙箱，readiness 不 ready 时两种访问级别都不可用。
      let readiness: ReturnType<typeof readCodexWindowsSandboxReadiness> | undefined;
      let readinessError: string | undefined;
      try {
        readiness = readCodexWindowsSandboxReadiness(await client.readWindowsSandboxReadiness());
      } catch (readinessFailure) {
        readinessError = readinessFailure instanceof Error ? readinessFailure.message : String(readinessFailure);
      }
      const decision = decideCodexWindowsSandboxReadiness({
        ...(readiness ? { readiness } : {}),
        ...(readinessError ? { error: readinessError } : {})
      });
      if (!decision.ok) {
        return { ok: false, state: "incompatible", ...base, message: decision.reason ?? "Codex 的 Windows 沙箱不可用" };
      }
    }
    if (handshake.auth.state === "signed-out") {
      return {
        ok: false,
        state: "signed-out",
        ...base,
        message: `协议已连通（${versionProbe.version ?? "版本未知"}），但 Codex 还没有登录：在终端运行 codex login 后重试${accessNote}`
      };
    }
    const inspection = inspectCodexEffectiveConfig(await client.readEffectiveConfig(cwd));
    if (!inspection.ok) return { ok: false, state: "incompatible", ...base, message: inspection.reason ?? "无法确认 Codex 的生效配置" };
    const authText = handshake.auth.state === "signed-in"
      ? `已登录${handshake.auth.plan ? `（${handshake.auth.plan}）` : ""}`
      : handshake.auth.state === "api-key"
        ? "使用 API key 账号"
        : handshake.auth.state === "not-required"
          ? "当前配置不需要 OpenAI 登录"
          : "登录状态未知（握手正常）";
    return {
      ok: true,
      state: "ok",
      ...base,
      message: `已连接 Codex${versionProbe.version ? `（${versionProbe.version}）` : ""}：${authText}${accessNote}`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const incompatible = message.includes("不支持 app-server") || message.includes("无法确认兼容性");
    return {
      ok: false,
      state: incompatible ? "incompatible" : "handshake-failed",
      access: config.access,
      executable,
      ...(versionProbe.version ? { version: versionProbe.version } : {}),
      message: incompatible ? message : `Codex 握手失败：${message}${closedReason ? `（${closedReason}）` : ""}`
    };
  } finally {
    client.close("连接测试结束");
  }
}

export interface CodexRoundApprovalRequest {
  memberId: string;
  memberName: string;
  workspace: string;
  /** 本轮的类别（首条任务 / 空闲后续指令）。 */
  turn: "initial" | "message" | "steer";
  /** 写进权限卡的一句话（用户据此判断批准的是什么）。 */
  summary: string;
}

export interface CodexTeamBackendOptions {
  /** 读当前配置（D 阶段接 settings；未配置时返回 undefined）。 */
  readConfig(): CodexCliConfig | undefined;
  /** 进程启动器（utility 的 CodexProcessBridge.start）。 */
  startProcess: CodexProcessStarter;
  /** 探测结果缓存时长（availability 会被 team_list 高频调用）。 */
  availabilityTtlMs?: number;
  now?(): number;
  log?(level: "info" | "warn", message: string): void;
  /**
   * 逐轮策略：Lead 会话**当前**访问模式（每轮实时读，不缓存——用户随时可以收紧）。
   * 缺省按 `ask` 处理（最保守：写入要先拿本轮确认）。
   */
  leadAccessMode?(): AccessMode;
  /**
   * `ask` 模式下的工作区写入确认：复用成员权限卡（PermissionBroker）。
   * 返回 true = 用户批准**本轮**在当前工作区内编辑与执行命令；false = 拒绝/超时/取消。
   * 缺省视为拒绝（没有审批通道就不许写）。
   */
  requestRoundApproval?(input: CodexRoundApprovalRequest): Promise<boolean>;
  /** 沙箱能力判定（缺省按当前平台；Windows 实测拿不到可验证沙箱 → 拒绝工作区写入）。 */
  sandboxCapability?: CodexSandboxCapability;
  /** 诊断：覆写服务端请求的处理（缺省走 codex-policy 的方法对应拒绝）。 */
  handleServerRequest?(request: { id: string | number; method: string; params: unknown }): CodexServerRequestDecision;
  /** 诊断：覆写 app-server 启动参数（缺省 = `buildCodexServerArgs()`，含配置加固）。 */
  buildServerArgs?(config: CodexCliConfig): string[];
  /** 客户端标识版本（诊断/线程 originator 用）。 */
  clientVersion?: string;
}

interface AvailabilityCache {
  at: number;
  key: string;
  value: TeamCodexBackendAvailability;
}

/**
 * Codex 团队后端：可用性投影 + 成员子会话工厂。
 *
 * 一个成员一条进程（进程随成员句柄空闲释放/停止回收）；thread 在成员目录的绑定文件里，
 * 冷恢复走真实的 `thread/resume`——线程失效时抛出具体原因，成员记录与转写都保留。
 */
export class CodexTeamBackend implements TeamCodexBackend {
  private readonly options: CodexTeamBackendOptions;
  private readonly availabilityTtlMs: number;
  private cache?: AvailabilityCache;
  private versionCache: { executable: string; version?: string } | undefined;

  constructor(options: CodexTeamBackendOptions) {
    this.options = options;
    this.availabilityTtlMs = options.availabilityTtlMs ?? 5_000;
  }

  /** 同步可用性（`team_list` / spawn 预检用；不 spawn 进程）。 */
  availability(): TeamCodexBackendAvailability {
    const now = this.now();
    const config = this.options.readConfig();
    const key = JSON.stringify(config ?? null);
    if (this.cache && this.cache.key === key && now - this.cache.at < this.availabilityTtlMs) return this.cache.value;
    const value = this.computeAvailability(config);
    this.cache = { at: now, key, value };
    return value;
  }

  /** 清缓存（设置保存后 D 阶段调用；也可在测试里直接调）。 */
  invalidate(): void {
    this.cache = undefined;
  }

  private computeAvailability(config: CodexCliConfig | undefined): TeamCodexBackendAvailability {
    const access = config?.access ?? "read-only";
    if (!config?.enabled) {
      return { available: false, access, reason: "Codex 接入未启用（设置 → 子智能体 → Codex CLI）" };
    }
    let executable: string;
    try {
      executable = resolveCodexExecutable(config);
    } catch (error) {
      return { available: false, access, reason: error instanceof Error ? error.message : String(error) };
    }
    if (access === "workspace-write") {
      // 沙箱是 Codex 自己的进程：拿不到可验证的沙箱就不放行写入（见 CodexSandboxCapability）。
      const capability = this.options.sandboxCapability ?? defaultCodexSandboxCapability();
      if (!capability.workspaceWrite) {
        return { available: false, access: "read-only", executable, reason: capability.detail };
      }
    }
    const version = this.versionCache?.executable === executable ? this.versionCache.version : undefined;
    return { available: true, access, executable, ...(version ? { version } : {}) };
  }

  /**
   * 为一个成员建 Codex 子会话：读/写 thread 绑定 → 起进程 → 握手 → thread/start|resume。
   * 这一步是 async，可以在返回前顺手把 CLI 版本探测出来填进缓存（`team_list` 就能显示）。
   */
  async createChild(request: TeamCodexChildRequest): Promise<TeamChildCreated> {
    const codex = request.config.codex;
    if (!codex) throw new Error(`成员「${request.memberName}」缺少 Codex 编制信息（记录已损坏？）`);
    // 设置是当前事实源：创建/冷恢复也必须遵守「现在是否启用」，不能拿创建时冻结的
    // 编制继续跑（用户关掉接入后，空闲成员被派活/重建时不得再拉起进程）。
    const current = this.options.readConfig();
    if (!current?.enabled) {
      throw new Error(`成员「${request.memberName}」是 Codex 成员，但设置里已关闭 Codex 接入：重新启用后才能继续派活（线程绑定与转写保留）`);
    }
    const executable = validateCodexExecutable(codex.executable);
    // 成员编制里的访问上限是 workspace-write 时，这里再判一次平台能力（拿不到可验证沙箱
    // 就**在产生任何副作用之前**报错，绝不静默降级成只读跑出越界写入）。
    if (codex.sandbox === "workspace-write") {
      const capability = this.options.sandboxCapability ?? defaultCodexSandboxCapability();
      if (!capability.workspaceWrite) {
        throw new Error(`成员「${request.memberName}」需要「当前工作区可写」，但${capability.detail}`);
      }
    }
    const bindingPath = codexThreadBindingPath(request.memberDir, request.memberId);
    const binding = readCodexThreadBinding(bindingPath, { memberId: request.memberId, workspace: request.workspace });
    const now = (): number => this.now();
    const clientVersion = this.options.clientVersion ?? "1";
    const serverArgs = this.options.buildServerArgs?.(this.options.readConfig() ?? { ...DEFAULT_CODEX_CLI_CONFIG, enabled: true, access: codex.sandbox }) ?? buildCodexLaunchArgs();
    // 本轮确认的一次性 id（一张卡只覆盖一轮；同一成员的多张卡能分辨）。
    let roundSeq = 0;
    const resolveTurnPolicy = async (input: CodexTurnPolicyInput): Promise<CodexTurnPolicy> => {
      // 每轮实时读设置：关闭接入后不再跑任何一轮；访问上限收紧后立刻按只读重算。
      // 冻结在成员编制里的是**上限**，不是当前授权：两者取交集才是本轮能用的权限。
      const config = this.options.readConfig();
      if (!config?.enabled) {
        throw new Error(`Codex 接入已在设置里关闭：成员「${request.memberName}」不再启动新回合（线程绑定与转写保留）`);
      }
      const access = codex.sandbox === "workspace-write" && config.access === "workspace-write"
        ? "workspace-write"
        : "read-only";
      const resolution = resolveCodexTurnPolicy({
        access,
        // 每轮实时读 Lead 模式：用户在会话中途收紧，下一轮立刻按新模式重算。
        leadMode: this.options.leadAccessMode?.() ?? "ask",
        workspace: request.workspace
      });
      const note = codex.sandbox === "workspace-write" && access === "read-only"
        ? "设置里的访问上限是「只读」，本轮按只读执行（成员编制里的工作区可写只是上限）"
        : resolution.note;
      if (note) this.options.log?.("info", `成员「${request.memberName}」：${note}`);
      if (resolution.requiresRoundApproval) {
        roundSeq += 1;
        const requestApproval = this.options.requestRoundApproval;
        if (!requestApproval) {
          // 没有审批通道就不存在「等授权」：直接拒绝本轮，不要先放出 queued 预检。
          throw new Error(
            `Codex 成员「${request.memberName}」本轮没有获得工作区写入授权（没有审批通道）：未启动本回合`
          );
        }
        // 先把「在等授权」告诉适配器：首轮确认可能比 spawn 预检长，不能把成员记成创建失败。
        input.onAwaitingApproval?.();
        const approved = await requestApproval({
          memberId: request.memberId,
          memberName: request.memberName,
          workspace: request.workspace,
          turn: input.turn,
          summary: `Codex 成员「${request.memberName}」请求在 ${request.workspace} 内编辑文件并执行命令（仅本轮，第 ${roundSeq} 次）`
        });
        if (!approved) {
          throw new Error(
            `Codex 成员「${request.memberName}」本轮没有获得工作区写入授权（拒绝/超时/已停止）：未启动本回合`
          );
        }
      }
      return resolution.policy;
    };
    const child = new CodexTeamChild({
      memberId: request.memberId,
      memberName: request.memberName,
      workspace: request.workspace,
      manager: request.manager,
      sandbox: codex.sandbox,
      approvalPolicy: codex.approvalPolicy,
      ...(codex.model ? { model: codex.model } : {}),
      ...(binding ? { threadId: binding.threadId } : {}),
      connect: async (onClosed) => {
        request.signal?.throwIfAborted();
        const handle = await this.options.startProcess({ executable, args: serverArgs, cwd: request.workspace });
        const client = new CodexAppServerClient({
          write: (frame) => handle.write(frame),
          clientInfo: { name: "pidesktop", title: "PiDesktop", version: clientVersion },
          onClose: (reason) => {
            handle.stop(reason);
            onClosed(reason);
          },
          onProtocolError: (message) => this.options.log?.("warn", message),
          onStderr: () => undefined
        }, this.options.handleServerRequest
          // 缺省：方法对应拒绝（提权/审批/提问逐个明确回包，绝不悬挂、绝不 fail open）。
          ?? ((serverRequest) => decideCodexServerRequest(serverRequest, { workspace: request.workspace })));
        handle.onEvent((event) => {
          if (event.kind === "stdout") client.pushStdout(event.text);
          else if (event.kind === "stderr") client.pushStderr(event.text);
          else client.handleExit({ code: event.code, ...(event.signal ? { signal: event.signal } : {}), ...(event.error ? { error: event.error } : {}) });
        });
        return { client, stop: (reason?: string) => handle.stop(reason) } satisfies CodexConnection;
      },
      onThreadId: (threadId) => {
        try {
          writeCodexThreadBinding(bindingPath, {
            memberId: request.memberId,
            memberName: request.memberName,
            workspace: request.workspace,
            threadId,
            cwd: request.workspace,
            sandbox: codex.sandbox,
            updatedAt: now()
          });
        } catch (error) {
          this.options.log?.("warn", `保存 Codex thread 绑定失败：${error instanceof Error ? error.message : String(error)}`);
        }
      },
      resolveTurnPolicy,
      log: (level, message) => this.options.log?.(level, message)
    });
    if (binding) this.options.log?.("info", `成员「${request.memberName}」恢复 Codex 线程 ${binding.threadId}`);
    // 版本探测只是展示用：失败不影响成员启动（CLI 已经能握手就说明它可用）。
    if (this.versionCache?.executable !== executable) {
      const probe = await probeCodexVersion(this.options.startProcess, executable, request.workspace).catch(() => ({ ok: false } as CodexVersionProbe));
      this.versionCache = { executable, ...(probe.ok && probe.version ? { version: probe.version } : {}) };
      this.cache = undefined;
    }
    return {
      handle: child,
      sessionId: request.manager.getSessionId(),
      sessionFile: request.manager.getSessionFile() ?? "",
      dispose: () => child.dispose()
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** 成员 thread 绑定文件的路径（测试/清理用；与 `team-store` 同一实现）。 */
export { codexThreadBindingPath };

/** 判断一条路径是否是「看起来像 Codex 入口」的绝对路径（设置页选择后即时校验）。 */
export function describeCodexExecutable(path: string, platform: NodeJS.Platform = process.platform): string {
  if (!isAbsolute(path)) return "必须是绝对路径";
  try {
    const executable = validateCodexExecutable(path, { platform });
    const info = statSync(executable);
    const name = basename(executable);
    const extension = extname(name).toLowerCase();
    return `${name}（${info.size} 字节${extension === ".cmd" ? "，npm shim" : ""}）`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 探测目录里是否有 codex 入口（设置页「浏览」后的即时提示用；不抛错）。 */
export function listCodexExecutablesIn(directory: string): string[] {
  try {
    return readdirSync(directory)
      .filter((name) => /^codex(\.exe|\.cmd|\.bat)?$/iu.test(name))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
}
