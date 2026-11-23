/**
 * Codex CLI 接入的共享类型与配置归一化（三端共用，**不含任何 Node/Electron 依赖**）。
 *
 * 为什么放 shared：设置页要渲染这张卡、protocol 要描述 `codex.settings.save` /
 * `codex.connection.test` 的载荷与回执，而渲染端绝不能 import `src/main/runtime-codex.ts`
 * （那里连着 node:fs / child_process / App Server 客户端）。归一化逻辑放在这里，
 * `src/main/runtime-codex.ts` 的 `normalizeCodexCliConfig` 只是转调同一份实现
 * （唯一读入口不能有两份实现，否则「设置页看到的」和「运行时用的」会漂移）。
 */

/** 全局 Codex CLI 配置（首版单个；`settings.codex`）。 */
export interface CodexCliSettings {
  /** 总开关：未启用时团队不会把任务派给 Codex，连接测试也只回「未启用」。 */
  enabled: boolean;
  /** 用户选择的绝对路径；缺省 = 自动探测 PATH 上的官方安装（Windows 含 npm `.cmd` shim）。 */
  executable?: string;
  /**
   * 访问上限：`read-only` 默认。
   * `workspace-write` 只有逐轮权限策略接入后才可用（首版 fail closed：不静默降级成只读）。
   * 凭据（ChatGPT 登录 / API key）由用户已有的 Codex 安装管理，这里**不存任何凭据**。
   */
  access: "read-only" | "workspace-write";
}

export const DEFAULT_CODEX_CLI_SETTINGS: CodexCliSettings = { enabled: false, access: "read-only" };

/**
 * 配置归一化：`undefined` = 没有这份配置（调用方保持缺省），对象 = 合法配置。
 * 未知字段一律丢弃；非法值退回默认（绝不让坏设置阻止应用启动）。
 */
export function normalizeCodexCliSettings(value: unknown): CodexCliSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const enabled = record.enabled === true;
  const access = record.access === "workspace-write" ? "workspace-write" : "read-only";
  const executable = typeof record.executable === "string" && record.executable.trim()
    ? record.executable.trim()
    : undefined;
  return { enabled, access, ...(executable ? { executable } : {}) };
}

/** Codex 的登录状态（只保留 UI 需要的档位与套餐标识，**不带身份字段**）。 */
export type CodexAuthStatus =
  /** ChatGPT 登录（plan 只是套餐标识，不带邮箱等身份信息）。 */
  | { state: "signed-in"; plan?: string }
  /** API key 账号。 */
  | { state: "api-key" }
  /** 需要 OpenAI 登录但当前没登录。 */
  | { state: "signed-out" }
  /** 当前配置不需要 OpenAI 登录（例如自定义 provider）。 */
  | { state: "not-required" }
  | { state: "unknown" };

/** 连接测试的结局档位：每个都对应一条「下一步能做什么」的中文提示。 */
export type CodexConnectionState =
  | "ok"
  | "not-enabled"
  | "missing-cli"
  | "signed-out"
  | "incompatible"
  | "spawn-failed"
  | "handshake-failed";

/** 连接测试回执（只握手 + 读登录状态；**不建线程、不跑模型、不写配置**）。 */
export interface CodexConnectionTestResult {
  ok: boolean;
  state: CodexConnectionState;
  message: string;
  executable?: string;
  version?: string;
  auth?: CodexAuthStatus;
  platformOs?: string;
  access: CodexCliSettings["access"];
}

/** 访问上限的中文标签（设置页与看板共用同一份，避免两处措辞不一致）。 */
export function codexAccessLabel(access: CodexCliSettings["access"]): string {
  return access === "workspace-write" ? "当前工作区可写" : "只读";
}
