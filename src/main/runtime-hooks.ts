// 钩子运行时：第三个 app-owned inline extension（pidesktop-hooks），模式与
// runtime-permissions.ts（阻断型 tool_call）和 tool-audit.ts（观察型订阅）一致。
// 事件 handler 在触发时动态读取 rules() 缓存，因此规则增删改只需刷新缓存，
// 不需要重建会话。缓存纪律：钩子输出绝不进入系统提示词或对话流——上下文只
// 通过 stdin JSON 与 HOOK_* 环境变量交给命令；通知经 hook-notify 推送由主进程
// 显示。信任模型：命令是用户自写配置，等同终端输入，不经 agent 权限门。

import { spawn } from "node:child_process";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { HookAction, HookRule, RuntimeMessage } from "../shared/protocol.js";
import { HOOK_TIMEOUT_DEFAULT_MS, HOOK_TIMEOUT_MAX_MS, type ConfiguredHook } from "./hooks-config.js";

/** 事件触发时交给钩子动作的上下文（命令经 stdin JSON / HOOK_* env 获取）。 */
export interface HookContext {
  event: string;
  sessionId: string;
  sessionTitle: string;
  agentName: string;
  workspace?: string;
  /** 仅工具事件。 */
  toolName?: string;
  /** 仅工具事件：tool_call 的 input / tool_execution_end 的 args。 */
  toolInput?: unknown;
  /** 仅 tool_execution_end。 */
  isError?: boolean;
  /** 工具执行、单轮调用或整次回复的耗时毫秒。 */
  durationMs?: number;
  /** 仅 turn_end / agent_end：该轮或整次回复的 token 用量与成本（模型/中转站未上报时缺省）；agent_end 时 isError 标记该次回复是否失败。 */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
}

export interface HooksExtensionDeps {
  /** 双作用域合并后的规则缓存（pi-runtime 刷新，触发时读取）。 */
  rules: () => ConfiguredHook[];
  /** settings.hooks 总开关的实时读取。 */
  enabled: () => boolean;
  workspace: () => string | undefined;
  agentName: () => string;
  sessionId: () => string;
  sessionTitle: () => string;
  post: (message: RuntimeMessage) => void;
  /** 分屏/激活可见性：通知动作据此携带 visible，主进程在“用户正盯着看”时免打扰。 */
  isSessionRendered?: (sessionId: string | undefined) => boolean;
}

export interface CommandRunResult {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface HookActionOutcome {
  ok: boolean;
  /** 阻断型评估为拦截（仅 tool_call 语义）。 */
  blocked?: boolean;
  reason?: string;
  /** 面板“测试”展示的输出摘要。 */
  detail: string;
  durationMs: number;
}

const OUTPUT_CAP = 8_192;

function truncateOutput(value: string): string {
  return value.length <= OUTPUT_CAP ? value : `${value.slice(0, OUTPUT_CAP)}…<截断>`;
}

/** 钩子匹配的目标文本：bash 用命令行，其余工具用参数 JSON（覆盖 path/file_path 等）。 */
export function hookMatchText(toolName: string, toolInput: unknown): string {
  if (toolName === "bash") {
    const command = (toolInput as { command?: unknown } | undefined)?.command;
    if (typeof command === "string") return command;
  }
  try {
    return JSON.stringify(toolInput ?? {}) ?? "";
  } catch {
    return "";
  }
}

function toolMatcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher) return true;
  try {
    return new RegExp(matcher, "u").test(toolName);
  } catch {
    return false;
  }
}

function baseContext(deps: HooksExtensionDeps, event: string): HookContext {
  return {
    event,
    sessionId: deps.sessionId(),
    sessionTitle: deps.sessionTitle(),
    agentName: deps.agentName(),
    workspace: deps.workspace()
  };
}

/** notify 标题/正文里的 {sessionId} 等占位符替换。 */
function fillTemplate(text: string, context: HookContext): string {
  const replacements: Record<string, string> = {
    event: context.event,
    sessionId: context.sessionId,
    sessionTitle: context.sessionTitle,
    agentName: context.agentName,
    workspace: context.workspace ?? "",
    toolName: context.toolName ?? "",
    durationMs: context.durationMs !== undefined ? String(context.durationMs) : ""
  };
  return text.replace(/\{(\w+)\}/gu, (whole, key: string) => key in replacements ? replacements[key] ?? "" : whole);
}

function hookTimeoutMs(rule: HookRule): number {
  const value = rule.timeoutMs ?? HOOK_TIMEOUT_DEFAULT_MS;
  return Math.min(HOOK_TIMEOUT_MAX_MS, Math.max(1_000, value));
}

/**
 * 运行一条 command 动作：shell 语义（Windows 下 cmd /c），stdin 收完整上下文
 * JSON，附加 HOOK_* 环境变量；超时强杀（Windows 用 taskkill /T 杀整棵进程树，
 * 避免 cmd 死后子进程残留）。永不 reject——失败信息进结果字段。
 */
export function runHookCommand(rule: HookRule, context: HookContext): Promise<CommandRunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const command = rule.action.kind === "command" ? rule.action.command : "";
    const timeoutMs = hookTimeoutMs(rule);
    let stdoutText = "";
    let stderrText = "";
    let spawnError: string | undefined;
    let timedOut = false;
    let settled = false;
    const child = spawn(command, {
      shell: true,
      cwd: context.workspace || undefined,
      windowsHide: true,
      env: {
        ...process.env,
        HOOK_EVENT: context.event,
        HOOK_SESSION_ID: context.sessionId,
        HOOK_SESSION_TITLE: context.sessionTitle,
        HOOK_AGENT: context.agentName,
        HOOK_WORKSPACE: context.workspace ?? "",
        HOOK_TOOL: context.toolName ?? ""
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutText.length < OUTPUT_CAP) stdoutText += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrText.length < OUTPUT_CAP) stderrText += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        // shell:true 在 Windows 是 cmd 包装进程，kill() 只杀 cmd；taskkill /T 连子进程一起杀。
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    const finish = (exitCode: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: truncateOutput(stdoutText),
        stderr: truncateOutput(spawnError ? `命令启动失败：${spawnError}${stderrText ? `\n${stderrText}` : ""}` : stderrText),
        timedOut,
        durationMs: Date.now() - startedAt
      });
    };
    child.on("error", (error) => {
      spawnError = error.message;
      finish(undefined);
    });
    child.on("close", (exitCode) => finish(exitCode ?? undefined));
    try {
      child.stdin.on("error", () => undefined); // 命令不读 stdin（EPIPE）不算失败
      child.stdin.end(JSON.stringify(context, null, 2), "utf8");
    } catch {
      // stdin 写失败不影响命令本身
    }
  });
}

/** block 动作的纯评估：任一 deny 命中即拦截。 */
export function evaluateBlockAction(rule: HookRule, toolName: string, toolInput: unknown): { blocked: boolean; reason?: string } {
  if (rule.action.kind !== "block") return { blocked: false };
  const text = hookMatchText(toolName, toolInput);
  for (const pattern of rule.action.deny) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "u");
    } catch {
      continue;
    }
    if (regex.test(text)) return { blocked: true, reason: `钩子「${rule.name}」拦截了 ${toolName}：命中规则 ${pattern}` };
  }
  return { blocked: false };
}

/** 阻断型 command 的判定：exit 2，或 stdout 可解析出 {"block":true,"reason"}。 */
function blockingCommandVerdict(result: CommandRunResult): { blocked: boolean; reason?: string } {
  if (result.timedOut) return { blocked: false };
  if (result.exitCode === 2) {
    const reason = (result.stderr.trim() || result.stdout.trim() || "").split(/\r?\n/u)[0];
    return { blocked: true, reason: reason || "阻断型钩子命令以退出码 2 结束" };
  }
  const stdoutText = result.stdout.trim();
  if (stdoutText.startsWith("{")) {
    try {
      const parsed = JSON.parse(stdoutText) as { block?: unknown; reason?: unknown };
      if (parsed.block === true) {
        return { blocked: true, reason: typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : "阻断型钩子命令请求拦截" };
      }
    } catch {
      // 非 JSON 输出按退出码语义处理
    }
  }
  return { blocked: false };
}

/** 执行单条钩子动作（block 除外——它只在 tool_call 路径做纯评估）。 */
export async function executeHookAction(rule: HookRule, context: HookContext, deps: Pick<HooksExtensionDeps, "post" | "isSessionRendered">): Promise<HookActionOutcome> {
  const action = rule.action;
  if (action.kind === "notify") {
    const title = fillTemplate(action.title?.trim() || `PiDesktop：${context.event}`, context);
    const body = fillTemplate(action.body?.trim() || `${context.sessionTitle}${context.toolName ? ` · ${context.toolName}` : ""}`, context);
    // sessionId 让主进程能判断“这条通知是否关于用户正盯着看的会话”，聚焦时免打扰；
    // visible 进一步覆盖分屏：watched 格子里的会话同样算“正盯着看”。
    deps.post({ type: "hook-notify", title, body, sessionId: context.sessionId, visible: deps.isSessionRendered?.(context.sessionId) });
    return { ok: true, detail: `通知：${title}`, durationMs: 0 };
  }
  if (action.kind === "http") {
    const startedAt = Date.now();
    try {
      const response = await fetch(action.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
        signal: AbortSignal.timeout(10_000)
      });
      return { ok: response.ok, detail: `HTTP ${response.status} ${response.statusText}`.trim(), durationMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, detail: `推送失败：${error instanceof Error ? error.message : String(error)}`, durationMs: Date.now() - startedAt };
    }
  }
  if (action.kind === "command") {
    const result = await runHookCommand(rule, context);
    const lines = [result.stdout, result.stderr].map((part) => part.trim()).filter(Boolean);
    const verdict = action.blocking === true && context.event === "tool_call" ? blockingCommandVerdict(result) : { blocked: false };
    return {
      ok: !result.timedOut && result.exitCode === 0,
      blocked: verdict.blocked || undefined,
      reason: verdict.reason,
      detail: [
        result.timedOut ? `命令超时（${hookTimeoutMs(rule) / 1000}s）被终止` : `退出码 ${result.exitCode ?? "未知"}`,
        ...lines
      ].join("\n"),
      durationMs: result.durationMs
    };
  }
  return { ok: false, detail: "未知动作类型", durationMs: 0 };
}

function warn(deps: HooksExtensionDeps, message: string): void {
  deps.post({ type: "log", level: "warn", message });
}

function rulesFor(deps: HooksExtensionDeps, event: HookRule["event"], toolName?: string): ConfiguredHook[] {
  if (!deps.enabled()) return [];
  return deps.rules().filter(({ rule }) => rule.event === event && rule.disabled !== true)
    .filter(({ rule }) => toolName === undefined || toolMatcherMatches(rule.matcher, toolName));
}

/** 观察型事件：逐条 fire-and-forget，失败只记日志，绝不影响回合。 */
function fireObservingHooks(deps: HooksExtensionDeps, event: "session_start" | "tool_execution_end" | "agent_end" | "turn_end", context: HookContext, toolName?: string): void {
  for (const { rule } of rulesFor(deps, event, toolName)) {
    void executeHookAction(rule, context, deps).catch((error: unknown) => {
      warn(deps, `钩子「${rule.name}」执行失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

/**
 * 会话启动钩子被顺序 await（环境准备语义：会话打开即就绪），单条命令受自身
 * 超时约束；失败只记日志，不阻断会话创建。
 */
async function runSessionStartHooks(deps: HooksExtensionDeps): Promise<void> {
  for (const { rule } of rulesFor(deps, "session_start")) {
    try {
      await executeHookAction(rule, baseContext(deps, "session_start"), deps);
    } catch (error) {
      warn(deps, `钩子「${rule.name}」执行失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** 面板“测试”：用样例上下文真实执行一次动作（notify 会真的弹通知）。 */
export async function testHook(rule: HookRule, sample: string | undefined, deps: Pick<HooksExtensionDeps, "agentName" | "workspace" | "post">): Promise<HookActionOutcome> {
  const context: HookContext = {
    event: rule.event,
    sessionId: "test-session",
    sessionTitle: "钩子测试",
    agentName: deps.agentName(),
    workspace: deps.workspace(),
    ...(rule.event === "tool_call" || rule.event === "tool_execution_end"
      ? { toolName: rule.matcher ? `匹配 ${rule.matcher}` : "bash", toolInput: { command: sample ?? "git push --force" } }
      : {}),
    ...(rule.event === "turn_end" || rule.event === "agent_end" ? { usage: { input: 1200, output: 340, cacheRead: 9800, cacheWrite: 400, cost: 0.012 } } : {})
  };
  if (rule.action.kind === "block") {
    const verdict = evaluateBlockAction(rule, context.toolName ?? "bash", context.toolInput);
    return {
      ok: true,
      blocked: verdict.blocked || undefined,
      reason: verdict.reason,
      detail: verdict.blocked ? `样例命中拦截规则` : `样例未命中任何 deny 规则（放行）`,
      durationMs: 0
    };
  }
  return executeHookAction(rule, context, deps);
}

/**
 * 整次回复的累计用量：对 agent_end 给到的消息序列求和（每条 assistant 消息
 * 带各自的 usage），并取末条 assistant 的 errorMessage 作为失败标记——与
 * pi-runtime 侧 runStatus 的失败判定同源。
 */
function runUsageFromMessages(messages: unknown): { usage?: HookContext["usage"]; isError: boolean } {
  let usage: HookContext["usage"] | undefined;
  let isError = false;
  for (const message of Array.isArray(messages) ? messages : []) {
    const entry = message as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } }; errorMessage?: string };
    if (entry.role !== "assistant") continue;
    const next = entry.usage;
    if (next) {
      usage = {
        input: (usage?.input ?? 0) + (next.input ?? 0),
        output: (usage?.output ?? 0) + (next.output ?? 0),
        cacheRead: (usage?.cacheRead ?? 0) + (next.cacheRead ?? 0),
        cacheWrite: (usage?.cacheWrite ?? 0) + (next.cacheWrite ?? 0),
        cost: (usage?.cost ?? 0) + (next.cost?.total ?? 0)
      };
    }
    if (entry.errorMessage) isError = true;
  }
  return { ...(usage ? { usage } : {}), isError };
}

/**
 * 钩子扩展本体。事件接线：
 * - tool_call：block 规则同步评估 + 阻断型命令顺序 await，返回 { block, reason }（与权限门同款语义，两道门叠加生效）；
 * - tool_execution_start/end：记录 args/起始时间，结束时 fire-and-forget（改完即格式化类钩子）；
 * - turn_start/turn_end：记录轮次起点，结束时携带该轮 usage 触发钩子（注意：一次回复含多个小轮，会触发多次）；
 * - agent_start/agent_end：整次回复（用户消息 → 全部工具轮次 → 最终答案）起点与终点；
 *   agent_end 只触发一次，携带整次累计 usage、总耗时与失败标记——跑完通知/用量统计应挂这里；
 * - session_start：顺序 await（bindExtensions 会等待，会话打开即完成环境准备）。
 */
export function createHooksExtension(deps: HooksExtensionDeps): InlineExtension {
  return {
    name: "pidesktop-hooks",
    hidden: true,
    factory(pi: ExtensionAPI) {
      const toolStarts = new Map<string, { startedAt: number; args: unknown }>();
      let turnStartedAt: number | undefined;
      let runStartedAt: number | undefined;

      pi.on("session_start", () => {
        void runSessionStartHooks(deps);
      });

      pi.on("tool_call", async (event) => {
        const toolName = event.toolName;
        const toolInput = event.input;
        for (const { rule } of rulesFor(deps, "tool_call", toolName)) {
          const action: HookAction = rule.action;
          if (action.kind === "block") {
            const verdict = evaluateBlockAction(rule, toolName, toolInput);
            if (verdict.blocked) return { block: true, reason: verdict.reason };
            continue;
          }
          if (action.kind === "command" && action.blocking === true) {
            const context: HookContext = { ...baseContext(deps, "tool_call"), toolName, toolInput };
            const result = await runHookCommand(rule, context);
            const verdict = blockingCommandVerdict(result);
            if (verdict.blocked) return { block: true, reason: verdict.reason };
            if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== 2)) {
              // 非阻断语义的失败（超时/崩溃）默认放行并记日志，避免坏钩子卡死回合。
              warn(deps, `阻断型钩子「${rule.name}」执行异常（${result.timedOut ? "超时" : `退出码 ${result.exitCode ?? "未知"}`}），已放行`);
            }
          }
        }
        return undefined;
      });

      pi.on("tool_execution_start", (event) => {
        if (toolStarts.size > 1_000) toolStarts.clear();
        toolStarts.set(event.toolCallId, { startedAt: Date.now(), args: event.args });
      });

      pi.on("tool_execution_end", (event) => {
        const started = toolStarts.get(event.toolCallId);
        toolStarts.delete(event.toolCallId);
        const context: HookContext = {
          ...baseContext(deps, "tool_execution_end"),
          toolName: event.toolName,
          toolInput: started?.args,
          isError: event.isError,
          ...(started ? { durationMs: Date.now() - started.startedAt } : {})
        };
        fireObservingHooks(deps, "tool_execution_end", context, event.toolName);
      });

      pi.on("turn_start", (event) => {
        turnStartedAt = event.timestamp ?? Date.now();
      });

      pi.on("turn_end", (event) => {
        const usageMessage = event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } } | undefined;
        const usage = usageMessage?.usage;
        const context: HookContext = {
          ...baseContext(deps, "turn_end"),
          ...(turnStartedAt !== undefined ? { durationMs: Date.now() - turnStartedAt } : {}),
          ...(usage ? { usage: { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost: usage.cost?.total ?? 0 } } : {})
        };
        turnStartedAt = undefined;
        fireObservingHooks(deps, "turn_end", context);
      });

      pi.on("agent_start", () => {
        runStartedAt = Date.now();
      });

      pi.on("agent_end", (event) => {
        const { usage, isError } = runUsageFromMessages((event as { messages?: unknown }).messages);
        const context: HookContext = {
          ...baseContext(deps, "agent_end"),
          ...(runStartedAt !== undefined ? { durationMs: Date.now() - runStartedAt } : {}),
          ...(usage ? { usage } : {}),
          isError
        };
        runStartedAt = undefined;
        fireObservingHooks(deps, "agent_end", context);
      });
    }
  };
}
