/**
 * Codex 成员的**权限策略**（C 阶段）：逐轮裁决「这一轮能写什么」、把不可证明为授权的
 * App Server 请求明确拒绝、以及启动参数里的配置加固。
 *
 * 三条硬边界（谁都不许绕）：
 * 1. 生效沙箱只能来自这里：`readOnly`（默认）或 `workspaceWrite`（写入根**只有**当前
 *    工作区、排除隐式临时目录、禁网），审批策略固定 `never`——Codex 永远不能拿
 *    PiDesktop 的授权去换更大的沙箱。
 * 2. `workspaceWrite` 还必须同时满足：设置里的访问上限是「当前工作区可写」**且** Lead
 *    会话当前模式允许写。`read-only` 的 Lead 会话永远是只读；`ask` 模式要先拿一次
 *    **本轮**确认（复用成员权限卡，一次批准只覆盖这一轮）。
 * 3. 服务端请求（审批/提问/提权/动态工具）逐个方法给出「协议认识的拒绝」，绝不悬挂、
 *    绝不 fail open；提权请求（`item/permissions/requestApproval`）一律 RPC 错误。
 *
 * 本模块是**纯函数**（无 Node/Electron 依赖），便于把边界钉在单测里。
 */

import type { AccessMode } from "../shared/protocol.js";
import type { CodexCliSettings } from "../shared/codex.js";
import type { CodexSandboxPolicy, CodexTurnPolicy } from "./codex-team-child.js";
import type { CodexServerRequest, CodexServerRequestDecision } from "./codex-app-server.js";

/** 只读沙箱：无写入、无网络。 */
export const CODEX_READ_ONLY_SANDBOX: CodexSandboxPolicy = { type: "readOnly", networkAccess: false };

/**
 * 工作区写入沙箱：可写根**显式**只有当前工作区。
 * `excludeTmpdirEnvVar` / `excludeSlashTmp` 关掉「隐式临时目录也可写」——否则
 * `/tmp`、`$TMPDIR` 会成为工作区之外的侧门。
 */
export function codexWorkspaceWriteSandbox(workspace: string): CodexSandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [workspace],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true
  };
}

/** 一轮实际下发的权限姿态。 */
export type CodexTurnAccess = "read-only" | "workspace-write";

export interface CodexTurnPolicyRequest {
  /** 成员编制里冻结的访问上限（设置里的「只读 / 当前工作区可写」）。 */
  access: CodexCliSettings["access"];
  /** Lead 会话**当前**访问模式（每轮实时读，不缓存）。 */
  leadMode: AccessMode;
  /** 当前工作区（= Codex 的 cwd，也是 workspaceWrite 的唯一写入根）。 */
  workspace: string;
}

export interface CodexTurnPolicyResolution {
  access: CodexTurnAccess;
  policy: CodexTurnPolicy;
  /** `ask` 模式下必须先拿到一次本轮确认；没拿到就不许起回合。 */
  requiresRoundApproval: boolean;
  /** 为什么退成只读（诊断/回执用；只读本身不需要理由时为 undefined）。 */
  note?: string;
}

/**
 * 逐轮策略裁决（纯函数）：
 * - `read-only` 上限 → 永远只读；
 * - Lead 会话是 `read-only` → 即使上限是工作区可写也只读（收紧永远生效）；
 * - Lead 会话是 `ask` → 工作区可写但需要**本轮**确认；
 * - Lead 会话 `workspace` / `full` → 工作区可写（写入根仍只有工作区）。
 */
export function resolveCodexTurnPolicy(input: CodexTurnPolicyRequest): CodexTurnPolicyResolution {
  const readOnly = (note?: string): CodexTurnPolicyResolution => ({
    access: "read-only",
    policy: { cwd: input.workspace, sandboxPolicy: CODEX_READ_ONLY_SANDBOX, approvalPolicy: "never" },
    requiresRoundApproval: false,
    ...(note ? { note } : {})
  });
  if (input.access !== "workspace-write") return readOnly();
  if (input.leadMode === "read-only") return readOnly("Lead 会话是只读模式：Codex 成员本轮也只能只读");
  return {
    access: "workspace-write",
    policy: {
      cwd: input.workspace,
      sandboxPolicy: codexWorkspaceWriteSandbox(input.workspace),
      approvalPolicy: "never"
    },
    requiresRoundApproval: input.leadMode === "ask"
  };
}

/**
 * 发任务前的最后一道闸：确认「将要下发的沙箱」就是「裁决出来的沙箱」。
 *
 * 存在的意义是把侧效边界钉在**协议字段**上：即使上游接线写错（比如把设置里的
 * workspace-write 直接透传、或漏传 writableRoots），这里也会在产生任何副作用之前抛错。
 */
export function assertCodexTurnPolicy(
  policy: CodexTurnPolicy,
  expected: { access: CodexTurnAccess; workspace: string }
): void {
  if (policy.approvalPolicy !== "never") {
    throw new Error(`Codex 回合的审批策略必须是 never（当前 ${policy.approvalPolicy}）：不允许 Codex 自行升级权限`);
  }
  if (policy.cwd !== expected.workspace) {
    throw new Error(`Codex 回合的 cwd 必须是当前工作区（期望 ${expected.workspace}，实际 ${policy.cwd}）`);
  }
  const sandbox = policy.sandboxPolicy;
  if (expected.access === "read-only") {
    if (sandbox.type !== "readOnly") throw new Error(`只读回合的沙箱必须是 readOnly（实际 ${sandbox.type}）`);
    if (sandbox.networkAccess) throw new Error("只读回合不允许开启网络访问");
    return;
  }
  if (sandbox.type !== "workspaceWrite") throw new Error(`工作区写入回合的沙箱必须是 workspaceWrite（实际 ${sandbox.type}）`);
  const roots = sandbox.writableRoots ?? [];
  if (roots.length !== 1 || roots[0] !== expected.workspace) {
    throw new Error(`工作区写入的写入根只能是当前工作区（实际 ${JSON.stringify(roots)}）`);
  }
  if (sandbox.networkAccess) throw new Error("工作区写入回合不允许开启网络访问");
  if (!sandbox.excludeTmpdirEnvVar || !sandbox.excludeSlashTmp) {
    throw new Error("工作区写入必须排除隐式临时目录（$TMPDIR / /tmp）");
  }
}

/**
 * 配置加固：拉起 app-server 时**显式关掉**能另起进程的用户扩展。
 *
 * 为什么必须关：Codex 的钩子、插件、Apps、自定义 MCP 服务器都会在 PiDesktop 的
 * 权限域之外执行用户配置里的任意命令——放它们跑，等于把「Codex 只读」变成一句空话。
 * 模型与登录仍沿用用户本机 Codex 配置（这两项不需要另起进程，也不扩大侧效边界）。
 *
 * 形状按 `codex app-server -c key=value`（TOML 值，点号路径）。真机实测（0.171.0）：
 * `codex doctor --json` 回显 `feature flag overrides: hooks=false, apps=false,
 * plugins=false`；`codex mcp list` 在这三项关闭后少了插件/App 自带的
 * `codex_app` / `cua_repl`。**MCP 的整表覆盖（`mcp_servers={}`）实测无效**（用户
 * config.toml 的表是合并不是替换），所以用户自定义 MCP 服务器走逐名 disable
 * （见 `codexMcpDisableArgs` + runtime-codex 的 `buildCodexLaunchArgs`）。
 */
export const CODEX_HARDENING_CONFIG: readonly string[] = [
  // 用户钩子（shell 脚本，可在回合前后跑任意命令）。
  "features.hooks=false",
  // 插件与插件市场（可携带命令/工具）。
  "features.plugins=false",
  // ChatGPT App / connectors（会以 MCP 形式接进来）。
  "features.apps=false",
  // notify 会在每个回合把事件交给用户配置的外部程序（另起进程）：整表置空。
  "notify=[]"
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 从 config.toml 文本里抽出用户自定义的 MCP 服务器名（表格头 `[mcp_servers.<name>]`）。 */
export function codexMcpServerNamesFromToml(text: string): string[] {
  const names = new Set<string>();
  const pattern = /^\s*\[mcp_servers\.(?:"([^"\n]+)"|([A-Za-z0-9_.\-]+))\]\s*$/gmu;
  for (const match of text.matchAll(pattern)) {
    const name = (match[1] ?? match[2] ?? "").trim();
    // `[mcp_servers.foo.env]` 这类子表也会被上面的正则匹配到：`.` 已被查名字段拒掉，
    // 但 `foo.env` 这种带点形式仍能溜进来，显式过滤。
    if (!name || name.includes(".")) continue;
    names.add(name);
  }
  return [...names];
}

/** 逐个禁用用户 MCP 服务器的 `-c` 条目（真机实测：`enabled=false` 会让它不启动）。 */
export function codexMcpDisableArgs(names: readonly string[]): string[] {
  return names.map((name) => `mcp_servers.${name}.enabled=false`);
}

/** app-server 的启动参数（子命令 + 配置加固）。顺序稳定、不含 shell。 */
export function buildCodexServerArgs(extra: readonly string[] = []): string[] {
  const args = ["app-server"];
  for (const entry of CODEX_HARDENING_CONFIG) args.push("-c", entry);
  for (const entry of extra) args.push("-c", entry);
  return args;
}

/**
 * `windowsSandbox/readiness` 的档位（本机 0.171.0 的 WindowsSandboxReadinessResponse 枚举）。
 * 这个调用**没有参数**（schema 里 `params` 为 null / 可省略），返回 `{ status }`。
 */
export type CodexWindowsSandboxReadiness = "ready" | "notConfigured" | "updateRequired" | "unknown";

export function readCodexWindowsSandboxReadiness(value: unknown): CodexWindowsSandboxReadiness {
  if (!isRecord(value)) return "unknown";
  if (value.status === "ready" || value.status === "notConfigured" || value.status === "updateRequired") return value.status;
  return "unknown";
}

/**
 * 握手回来的平台是不是 Windows。
 *
 * `platformFamily` 是 Codex 自己的族名（`windows` / `unix`），`platformOs` 可能是
 * `windows` 也可能是 Rust 的 `win32`——两种都认，避免在真机上漏判。
 */
export function isCodexWindowsPlatform(platform: { platformFamily?: string; platformOs?: string }): boolean {
  const family = (platform.platformFamily ?? "").toLowerCase();
  const os = (platform.platformOs ?? "").toLowerCase();
  return family === "windows" || os === "windows" || os === "win32" || os.startsWith("windows");
}

export interface CodexReadinessDecision {
  ok: boolean;
  reason?: string;
}

/**
 * Windows 上「沙箱到底能不能建立」的裁决（真机实测口径）：
 *
 * Windows 的只读/工作区写入都依赖 Codex 自己的 Windows 沙箱。`windowsSandbox/readiness`
 * 不是 `ready`（或这个版本根本不支持该调用）时，**两种访问级别都拦下**——只读同样
 * 需要沙箱才拦得住写入，无法证明就不能放行。POSIX 不调用这条闸（Codex 由自身
 * seatbelt/landlock 建立沙箱），因此这里只处理 Windows 的结论。
 */
export function decideCodexWindowsSandboxReadiness(input: {
  readiness?: CodexWindowsSandboxReadiness;
  /** 调用失败的原因（方法不存在 / RPC 错误 / 超时）。 */
  error?: string;
}): CodexReadinessDecision {
  if (input.error) {
    return {
      ok: false,
      reason: `Codex 的 Windows 沙箱就绪检查不可用（windowsSandbox/readiness 调用失败：${input.error}）：无法证明只读与工作区写入真的生效，两种访问级别都被拦下。请升级 Codex CLI（0.171.0 及以上）后重试`
    };
  }
  switch (input.readiness) {
    case "ready":
      return { ok: true };
    case "notConfigured":
      return {
        ok: false,
        reason: "Codex 的 Windows 沙箱尚未配置（windowsSandbox/readiness = notConfigured）：只读与工作区写入都无法被沙箱保证，两种访问级别都被拦下。请先按 Codex 的提示完成 Windows 沙箱安装（通常以管理员身份重新安装 Codex CLI）后重试"
      };
    case "updateRequired":
      return {
        ok: false,
        reason: "Codex 的 Windows 沙箱需要更新（windowsSandbox/readiness = updateRequired）：升级 Codex CLI 后重试（只读与工作区写入都被拦下）"
      };
    default:
      return {
        ok: false,
        reason: "无法确认 Codex 的 Windows 沙箱状态（windowsSandbox/readiness 没有返回已知档位）：只读与工作区写入都被拦下"
      };
  }
}

/** 需要在生效配置里确认**已经关闭**的扩展开关（它们都能在权限域外另起进程）。 */
export const CODEX_REQUIRED_OFF_FEATURES = ["hooks", "apps", "plugins"] as const;

export interface CodexEffectiveConfigInspection {
  ok: boolean;
  reason?: string;
  /** 生效配置里仍然启用（或无法证明已禁用）的 MCP 服务器名。 */
  enabledMcpServers: string[];
}

/**
 * 检查 `config/read` 的**生效**配置（不是启动参数、也不是我们自己的静态 TOML 扫描）：
 *
 * 真机 0.171.0 的返回里带 `config.features{hooks,apps,plugins}`、`config.mcp_servers`
 * 与 `config.notify`（后者不在静态 schema 的 Config 定义里，但运行时确实回显——所以只
 * 靠 `config.toml` 文本扫描会漏）。这里逐项确认：
 * - `features.hooks/apps/plugins` 必须显式为 `false`（缺字段也算证明不了）；
 * - `mcp_servers` 里每个服务器必须 `enabled === false`（我们按静态扫描的名字逐个 disable；
 *   生效配置里还活着一个就说明漏了——包括项目层/托管层带来的）；
 * - `notify` 必须是空数组（`-c notify=[]`），否则每个回合都会另起外部程序。
 *
 * 证明不了就 fail closed：返回可读原因，调用方在**建线程之前**拦下本回合。
 */
export function inspectCodexEffectiveConfig(value: unknown): CodexEffectiveConfigInspection {
  const fail = (reason: string, enabledMcpServers: string[] = []): CodexEffectiveConfigInspection => ({ ok: false, reason, enabledMcpServers });
  if (!isRecord(value)) return fail("config/read 没有返回对象：无法确认生效配置，已拦下本回合");
  const config = isRecord(value.config) ? value.config : undefined;
  if (!config) return fail("config/read 的返回缺少 config：无法确认钩子/插件/Apps/MCP/notify 已关闭，已拦下本回合");
  const features = isRecord(config.features) ? config.features : undefined;
  if (!features) return fail("生效配置里没有 features：无法确认 hooks/apps/plugins 已关闭，已拦下本回合");
  const stillOn = CODEX_REQUIRED_OFF_FEATURES.filter((name) => features[name] !== false);
  if (stillOn.length > 0) {
    return fail(`生效配置里仍有未关闭的 Codex 扩展（${stillOn.join(", ")}）：它们会在 PiDesktop 的权限域之外执行命令，已拦下本回合`);
  }
  const mcp = config.mcp_servers;
  if (mcp !== undefined && mcp !== null) {
    if (!isRecord(mcp)) return fail("生效配置里的 mcp_servers 不是表：无法确认没有启用中的 MCP 服务器，已拦下本回合");
    const enabled = Object.entries(mcp)
      .filter(([, entry]) => !isRecord(entry) || entry.enabled !== false)
      .map(([name]) => name)
      .sort();
    if (enabled.length > 0) {
      return fail(`生效配置里仍有启用中的 MCP 服务器（${enabled.join(", ")}）：它们会在 PiDesktop 的权限域之外执行命令，已拦下本回合`, enabled);
    }
  }
  const notify = config.notify;
  if (notify !== undefined && notify !== null) {
    if (!Array.isArray(notify)) {
      return fail("生效配置里的 notify 不是数组：`-c notify=[]` 没有生效（回合事件会交给外部程序），已拦下本回合");
    }
    if (notify.length > 0) {
      return fail(`生效配置里的 notify 仍指向外部程序（${notify.map((item) => String(item)).slice(0, 3).join(" ")}）：已拦下本回合`);
    }
  }
  return { ok: true, enabledMcpServers: [] };
}

/** 提权/审批类方法的名字（诊断与拒绝文案共用一份）。 */
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "execCommandApproval",
  "applyPatchApproval"
]);

/**
 * 服务端请求的**方法对应**拒绝（绝不悬挂、绝不 fail open）。
 *
 * - 命令/文件审批：Codex 只会在 `approvalPolicy: on-request` 时问；我们固定 `never`，
 *   一旦收到就是「想越过沙箱」——回协议认识的 `decline`/`denied`（回合继续，但操作被拒）。
 * - `item/permissions/requestApproval`：提权（扩大文件/网络权限）——RPC 错误，永不放行。
 * - 交互提问、MCP elicitation、动态工具调用、鉴权令牌刷新、attestation：PiDesktop
 *   都不承接，回方法对应的 RPC 错误让 Codex 立刻落到失败分支，而不是等一个永不到来的响应。
 */
export function decideCodexServerRequest(
  request: CodexServerRequest,
  options: { workspace: string }
): CodexServerRequestDecision {
  const method = request.method;
  if (method === "item/commandExecution/requestApproval") {
    return {
      kind: "result",
      result: { decision: "decline" }
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      kind: "result",
      result: { decision: "decline" }
    };
  }
  // 旧版方法（execCommandApproval / applyPatchApproval）：ReviewDecision 词表是 denied。
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { kind: "result", result: { decision: "denied" } };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      kind: "error",
      code: -32001,
      message: `PiDesktop 拒绝扩大 Codex 的权限（${method}）：本轮授权只限于工作区 ${options.workspace} 内的编辑与命令执行`
    };
  }
  return {
    kind: "error",
    code: -32000,
    message: `PiDesktop 不承接 Codex 的服务端请求 ${method}：已明确拒绝（不会以默认权限放行）`
  };
}

/** 这个方法是否属于「审批类」（测试/诊断用）。 */
export function isCodexApprovalMethod(method: string): boolean {
  return APPROVAL_METHODS.has(method);
}
