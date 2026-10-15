// MCP capability cluster extracted from pi-runtime.ts. After the 2026-10-15
// migration to Pi's built-in MCP extension this module owns the pure half:
// config path resolution, draft→entry validation, the dialect translation
// from our `.mcp.json` entries to Pi's `McpServerConfig`, the `/mcp` status
// board parser, and the McpServerSummary projection. Connections, OAuth and
// tool registration live in Pi's built-in MCP extension (`createMcpExtension`)
// driven by `mcp-bridge.ts`; nothing here touches the network.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { McpServerSummary, McpServerConfigDraft, McpOAuthAdvanced } from "../shared/protocol.js";
import { readConfiguredMcpServers, readMcpServerEntry, hasAuthorizationHeader, type McpServerConfigEntry, type ConfiguredMcpServer } from "./mcp-config.js";

export function mcpConfigPathsFor(workspace: string | undefined, agentDir: string): { project: string; global: string } {
  return {
    project: workspace ? resolve(workspace, ".mcp.json") : join(agentDir, ".mcp.json"),
    global: join(agentDir, "mcp.json")
  };
}

/** Validate an MCP server draft from the UI and convert it to a config entry. */
/** RFC 7230 token：header 名允许的字符集（比环境变量名宽，含 `-` `.` `_`）。 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export function mcpConfigEntry(server: McpServerConfigDraft): McpServerConfigEntry {
  const timeout = normalizeMcpTimeout(server.timeout);
  if (server.transport === "stdio") {
    const command = server.command?.trim();
    if (!command) throw new Error("stdio MCP Server 需要填写启动命令");
    return {
      command,
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      ...(timeout !== undefined ? { timeout } : {})
    };
  }
  const url = server.url?.trim();
  if (!url || !/^https?:\/\//iu.test(url)) throw new Error("HTTP MCP Server 需要填写 http:// 或 https:// 地址");
  // Bearer 环境变量：填的是**变量名**不是令牌本身。名字必须符合 Pi 解析器的口径
  // （[A-Za-z_][A-Za-z0-9_]*）——直接粘令牌会写成 `Bearer ${sk-xxx}`，而 `sk-xxx`
  // 不是合法变量名 ⇒ Pi 按字面量处理，客户端带着 `${sk-xxx}` 去请求、401 失败且没有任何
  // 提示（2026-10-15 用户问「这个字段填啥」时发现）。这里硬拦并说清区别。
  const bearerTokenEnv = server.bearerTokenEnv?.trim();
  if (bearerTokenEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(bearerTokenEnv)) {
      throw new Error(`Bearer 环境变量名不合法：${bearerTokenEnv}（只能含字母、数字、下划线且不以数字开头；这里填变量名，不是令牌本身）`);
    }
  }
  if (server.auth === "bearer-env" && !bearerTokenEnv) throw new Error("Bearer 认证需要填写环境变量名");
  const headers = normalizeMcpHeaders(server.headers);
  const oauth = normalizeMcpOAuth(server.oauth);
  return {
    url,
    ...(server.auth === "oauth" ? { auth: "oauth" as const } : {}),
    ...(server.auth === "bearer-env" && bearerTokenEnv ? { bearerTokenEnv } : {}),
    ...(headers ? { headers } : {}),
    ...(oauth ? { oauth } : {}),
    ...(timeout !== undefined ? { timeout } : {})
  };
}

/**
 * 校验并归一化 OAuth 高级选项（预注册客户端等）：空值丢弃，非法值报错
 * ——不做静默丢弃，否则用户以为配置生效但实际走了 DCR。
 * 与 Pi 的口径对齐：回调地址必须是回环（localhost / 127.0.0.1 / [::1]），
 * 元数据地址必须 https（回环除外）；端口 1–65535。
 */
export function normalizeMcpOAuth(oauth: McpOAuthAdvanced | undefined): McpOAuthAdvanced | undefined {
  if (!oauth) return undefined;
  const result: McpOAuthAdvanced = {};
  const text = (value: unknown, label: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const clientId = text(oauth.clientId, "OAuth 客户端 ID");
  const clientSecret = text(oauth.clientSecret, "OAuth 客户端密钥");
  const scope = text(oauth.scope, "OAuth 授权范围");
  const clientName = text(oauth.clientName, "OAuth 客户端名");
  const callbackUrl = text(oauth.callbackUrl, "OAuth 回调地址");
  const metadataUrl = text(oauth.authServerMetadataUrl, "授权服务器元数据地址");
  if (callbackUrl) {
    let parsed: URL;
    try {
      parsed = new URL(callbackUrl);
    } catch {
      throw new Error(`OAuth 回调地址无法解析：${callbackUrl}`);
    }
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
    if (parsed.protocol !== "http:" || !loopback) throw new Error("OAuth 回调地址必须是 http 且指向 localhost / 127.0.0.1 / [::1]");
    result.callbackUrl = callbackUrl;
  }
  if (oauth.callbackPort !== undefined) {
    const port = typeof oauth.callbackPort === "number" ? oauth.callbackPort : Number(oauth.callbackPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OAuth 回调端口必须是 1–65535 的整数");
    result.callbackPort = port;
  }
  if (oauth.clientRegistration !== undefined) {
    if (oauth.clientRegistration !== "dcr" && oauth.clientRegistration !== "cimd") throw new Error("OAuth 客户端注册方式只能是 dcr 或 cimd");
    result.clientRegistration = oauth.clientRegistration;
  }
  if (metadataUrl) {
    let parsed: URL;
    try {
      parsed = new URL(metadataUrl);
    } catch {
      throw new Error(`授权服务器元数据地址无法解析：${metadataUrl}`);
    }
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "::1";
    if (parsed.protocol !== "https:" && !loopback) throw new Error("授权服务器元数据地址必须是 https（回环除外）");
    result.authServerMetadataUrl = metadataUrl;
  }
  if (clientId) result.clientId = clientId;
  if (clientSecret) result.clientSecret = clientSecret;
  if (scope) result.scope = scope;
  if (clientName) result.clientName = clientName;
  return Object.keys(result).length > 0 ? result : undefined;
}

/** 每请求超时（秒）：1–3600 的正整数；空＝未配置（运行时按 120 缺省）。 */
export function normalizeMcpTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const seconds = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("MCP 超时必须是 1–3600 秒的整数");
  return seconds;
}

/**
 * 校验并归一化设置页的请求头输入（名称按 RFC 7230 token，值不得含换行）。
 * 空集合返回 undefined，这样条目里不会多出一个空 `headers: {}`。
 */
export function normalizeMcpHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  const entries = Object.entries(headers ?? {});
  if (entries.length === 0) return undefined;
  const normalized: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    if (!HEADER_NAME_PATTERN.test(name)) throw new Error(`请求头名称无效：${rawName}`);
    if (typeof rawValue !== "string") throw new Error(`请求头 ${name} 的值必须是字符串`);
    // CRLF 注入：值里的换行会把一个头拆成两个，等于放行任意头。
    if (/[\r\n]/u.test(rawValue)) throw new Error(`请求头 ${name} 的值不能包含换行`);
    normalized[name] = rawValue.trim();
  }
  return normalized;
}

/** 一次保存的落地计划：目标文件 + 合并停用态后的条目 + 需要先删的原条目。 */
export interface McpServerSavePlan {
  targetPath: string;
  entry: McpServerConfigEntry;
  remove?: { path: string; name: string };
}

/**
 * Plan an MCP server save from the settings form. `original` is the entry's
 * position before editing (name/scope): a scope switch moves the entry to the
 * other config file instead of leaving a duplicate behind (project wins on a
 * name clash, so a stale copy would silently shadow the edit), and the disabled
 * flag travels with the entry so editing never re-enables a paused server.
 */
export function planMcpServerSave(
  paths: { project: string; global: string },
  draft: McpServerConfigDraft,
  original?: { name: string; scope: "project" | "global" }
): McpServerSavePlan {
  const name = draft.name.trim();
  const targetPath = draft.scope === "project" ? paths.project : paths.global;
  const previousName = original?.name.trim();
  const previousPath = original ? (original.scope === "project" ? paths.project : paths.global) : undefined;
  const moving = Boolean(previousName && previousPath && (previousPath !== targetPath || previousName !== name));
  const previous = readMcpServerEntry(targetPath, name) ?? (moving ? readMcpServerEntry(previousPath!, previousName!) : undefined);
  const entry = mcpConfigEntry({ ...draft, name });
  return {
    targetPath,
    entry: previous?.disabled ? { ...entry, disabled: true } : entry,
    ...(moving ? { remove: { path: previousPath!, name: previousName! } } : {})
  };
}

// ---------------------------------------------------------------------------------------
// 方言翻译：我们的 .mcp.json 条目 → Pi 的 McpServerConfig
// ---------------------------------------------------------------------------------------

/**
 * Pi 侧的每请求超时（秒，进度通知会重置）。沿用迁移前 McpClientManager 的
 * MCP_CALL_TIMEOUT_MS = 120s，保持单次工具调用的预算不变。
 */
export const PI_MCP_CALL_TIMEOUT_SECONDS = 120;

/** 翻译后的注册载荷：`pi.registerMcpServer(name, config)` 的入参形状。 */
export type PiMcpRegistration = {
  name: string;
  config:
    | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; exposure: "direct" | "hidden"; timeout: number }
    | { type: "http"; url: string; headers?: Record<string, string>; oauth?: McpOAuthAdvanced; exposure: "direct" | "hidden"; timeout: number };
};

/**
 * 把一条配置条目翻译成 Pi 的 `McpServerConfig`。字段方言对照：
 * - `bearerTokenEnv: NAME` → `headers.Authorization = "Bearer ${NAME}"`
 *   （Pi 的 header 值原生支持 `${ENV}` 展开，语义与旧的运行时读取一致）；
 * - `auth: "oauth"` → 无需显式配置：Pi 对「无 Authorization 头的 HTTP 服务器」
 *   自动挂 OAuth provider，401 后进入 needs-auth，登录经 `/mcp login`；
 * - `disabled` 的服务器**不进这里**（不注册即不连接，目录里仍以配置投影显示）；
 * - exposure 一律 `direct`（工具直接声明给模型，与迁移前行为一致）；
 *   角色级 `mcp:<server>` overlay 禁用的服务器由调用方传 `hidden`。
 */
export function piMcpConfigFor(server: ConfiguredMcpServer, exposure: "direct" | "hidden"): PiMcpRegistration["config"] {
  const entry = server.entry;
  const timeout = entry.timeout ?? PI_MCP_CALL_TIMEOUT_SECONDS;
  if (entry.command) {
    return {
      type: "stdio",
      command: entry.command,
      ...(entry.args && entry.args.length > 0 ? { args: [...entry.args] } : {}),
      ...(entry.env && Object.keys(entry.env).length > 0 ? { env: { ...entry.env } } : {}),
      exposure,
      timeout
    };
  }
  if (!entry.url) throw new Error(`MCP 服务器 ${server.name} 既没有 command 也没有 url，无法连接`);
  const headers: Record<string, string> = { ...(entry.headers ?? {}) };
  if (entry.bearerTokenEnv) {
    // Bearer 环境变量优先级最高：覆盖同名头（与旧 httpRequestHeaders 的合并规则一致）。
    headers.Authorization = `Bearer \${${entry.bearerTokenEnv}}`;
  }
  return {
    type: "http",
    url: entry.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    // OAuth 高级选项（预注册客户端/回调/范围/元数据地址）原样透传：字段名与 Pi
    // 的 McpOAuthConfig 一致（存盘方言已在 mcpConfigEntry 校验过）；clientSecret
    // 里的 ${ENV}/!cmd 由 Pi 展开。
    ...(entry.oauth ? { oauth: { ...entry.oauth } } : {}),
    exposure,
    timeout
  };
}

/** 该服务器是否具备 OAuth 资格（与迁移前 mcpOAuth.supports 的判定一致）：HTTP、无 bearer env、未手写 Authorization。 */
export function mcpOauthEligible(server: ConfiguredMcpServer): boolean {
  const entry = server.entry;
  return !entry.command && !entry.bearerTokenEnv && !hasAuthorizationHeader(entry.headers);
}

// ---------------------------------------------------------------------------------------
// /mcp 状态板解析
// ---------------------------------------------------------------------------------------

/** `/mcp` 状态板里一行服务器的解析结果。 */
export interface ParsedMcpServerState {
  name: string;
  /** connected / connecting / disconnected / failed / needs-auth / disabled / starting */
  state: string;
  toolCount?: number;
  /** 缩进行里的错误详情（首行之后的 4 空格缩进行合并回该服务器）。 */
  error?: string;
}

const STATUS_LINE_PATTERN = /^([\w.-]+): (.+?)(?:, (\d+) tools)? \((direct|codemode|deferred|hidden)\)$/u;

/**
 * 解析 `/mcp` 无参命令经 `uiContext.notify` 输出的状态板文本。格式来自 Pi 1.2.0
 * `extensions/mcp/index.js` 的 `formatStatus`：
 *   `name: state, N tools (exposure)` + 可选 `\n    error…` 缩进续行
 *   `name: needs sign-in, run /mcp login name (exposure)`
 *   `config error: …` / `overridden: …`（非服务器行，跳过）
 * 该格式没有 API 稳定保证，解析失败只影响面板刷新（面板显示配置投影的保守态），
 * 不会影响连接与工具调用。
 */
export function parseMcpStatusText(text: string): Map<string, ParsedMcpServerState> {
  const result = new Map<string, ParsedMcpServerState>();
  let current: ParsedMcpServerState | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) { current = undefined; continue; }
    // 4 空格缩进 = 上一行的错误详情续行
    if (/^ {4}/u.test(rawLine)) {
      if (current) current.error = current.error ? `${current.error}\n${line.trim()}` : line.trim();
      continue;
    }
    current = undefined;
    const match = STATUS_LINE_PATTERN.exec(line);
    if (!match) continue; // "config error: …" / "overridden: …" / 其他
    const name = match[1]!;
    const rest = match[2]!;
    let state = rest;
    let count: number | undefined;
    const toolSuffix = /, (\d+) tools$/u.exec(rest);
    if (toolSuffix) {
      state = rest.slice(0, toolSuffix.index);
      count = Number(toolSuffix[1]);
    } else if (match[3]) {
      count = Number(match[3]);
    }
    let mapped = "starting";
    if (state.startsWith("needs sign-in")) mapped = "needs-auth";
    else if (state.startsWith("connected")) mapped = "connected";
    else if (state.startsWith("connecting")) mapped = "connecting";
    else if (state.startsWith("disconnected")) mapped = "disconnected";
    else if (state.startsWith("failed")) mapped = "failed";
    else if (state.startsWith("disabled")) mapped = "disabled";
    // error 行里的失败原因（`failed: xxx` 形态）
    const failedError = state.startsWith("failed") ? state.slice("failed:".length).trim() : undefined;
    result.set(name, {
      name,
      state: mapped,
      ...(count !== undefined ? { toolCount: count } : {}),
      ...(failedError ? { error: failedError } : {})
    });
    current = result.get(name);
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// McpServerSummary 投影
// ---------------------------------------------------------------------------------------

/**
 * 合成资源目录里的 MCP 服务器摘要：配置投影（编辑表单回填用，来自我们自己的
 * 配置文件读取）+ `/mcp` 状态板解析出的连接态与工具数。未注册（停用）的服务器
 * 只有配置投影，状态为 `disabled`；解析不到连接态的按 `not-connected` 显示
 * （连接在会话启动后异步进行，面板会在后续刷新中跟上）。
 */
export function buildMcpSummaries(params: {
  configured: ConfiguredMcpServer[];
  parsed: Map<string, ParsedMcpServerState>;
  authPending: ReadonlySet<string>;
  /** 「真的授权过」的服务器名集合（见 authorizedMcpServers）：只有它才让面板显示「清除凭据」。 */
  authorized: ReadonlySet<string>;
}): McpServerSummary[] {
  const { configured, parsed, authPending, authorized } = params;
  return configured.map((server): McpServerSummary => {
    const entry = server.entry;
    const transport = entry.command ? "stdio" : "http";
    const base: McpServerSummary = {
      name: server.name,
      scope: server.scope,
      transport,
      ...(entry.command ? { command: entry.command } : {}),
      ...(entry.args && entry.args.length > 0 ? { args: [...entry.args] } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      ...(transport === "http" ? { auth: entry.bearerTokenEnv ? ("bearer-env" as const) : entry.auth === "oauth" ? ("oauth" as const) : ("none" as const) } : {}),
      ...(entry.bearerTokenEnv ? { bearerTokenEnv: entry.bearerTokenEnv } : {}),
      ...(entry.env && Object.keys(entry.env).length > 0 ? { env: { ...entry.env } } : {}),
      ...(transport === "http" && entry.headers && Object.keys(entry.headers).length > 0 ? { headers: { ...entry.headers } } : {}),
      ...(entry.oauth ? { oauth: { ...entry.oauth } } : {}),
      ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
      status: "not-connected",
      toolCount: 0,
      disabled: Boolean(entry.disabled),
      ...(mcpOauthEligible(server) ? { authState: "idle" as const } : {})
    };
    if (entry.disabled) {
      base.status = "disabled";
      return base;
    }
    const state = parsed.get(server.name);
    if (!state) return base;
    base.status = state.state === "connected" ? "connected" : state.state === "needs-auth" ? "needs-auth" : state.state === "failed" ? "failed" : state.state === "connecting" ? "not-connected" : state.state === "disconnected" ? "failed" : "not-connected";
    if (state.toolCount !== undefined) base.toolCount = state.toolCount;
    if (state.error) base.error = state.error;
    if (base.authState) {
      // 语义与迁移前一致：authorized = 真存有凭据（不是「连上了」）；pending = 正在登录；
      // failed = 服务器要求登录（needs-auth）。普通连接失败不赋 auth 态（那是连接问题）。
      if (authPending.has(server.name)) base.authState = "pending";
      else if (authorized.has(server.name)) base.authState = "authorized";
      else if (state.state === "needs-auth") base.authState = "failed";
      else base.authState = "idle";
    }
    return base;
  });
}

/**
 * Pi 的 mcp-auth.json 里某服务器的存储键（与 Pi `storeKeys` 同口径）：
 * `mcp__<服务器名（连字符→下划线）>|<归一化 URL>`，外加只有 URL 的旧键。
 */
export function mcpCredentialKeysFor(serverName: string, url: string): { key?: string; legacyKey?: string } {
  try {
    const legacyKey = String(new URL(url));
    return { key: `mcp__${serverName.replace(/-/gu, "_")}|${legacyKey}`, legacyKey };
  } catch {
    return {};
  }
}

/** 读取 Pi 凭据文件的原始文本（只读、容错：不存在/不可读都返回 undefined）。 */
export function readMcpAuthFile(agentDir: string): string | undefined {
  try {
    const path = join(agentDir, "mcp-auth.json");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 「真的授权过」的服务器名集合：`mcp-auth.json` 里该服务器键下**存有 tokens** 才算。
 * 只看键存在不够——Pi 在 401 后做动态客户端注册会把 `clientInformation` 落盘，
 * 未完成登录的服务器会留下这种无 tokens 的残留（2026-10-15 用户机上 exa 实测），
 * 把它当「已授权」会让面板对一台从未 OAuth 过的服务器显示「清除凭据」。
 * 解析失败（文件损坏/格式漂移）一律当作没有凭据：UI 退化为不显示凭据类按钮，
 * 不会给错状态。
 */
export function authorizedMcpServers(content: string | undefined, configured: readonly ConfiguredMcpServer[]): Set<string> {
  const authorized = new Set<string>();
  if (!content) return authorized;
  let states: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return authorized;
    states = parsed as Record<string, unknown>;
  } catch {
    return authorized;
  }
  for (const server of configured) {
    if (!server.entry.url) continue;
    const { key, legacyKey } = mcpCredentialKeysFor(server.name, server.entry.url);
    const state = (key ? states[key] : undefined) ?? (legacyKey ? states[legacyKey] : undefined);
    if (state && typeof state === "object" && (state as { tokens?: unknown }).tokens) authorized.add(server.name);
  }
  return authorized;
}

/** 双作用域读取（供会话装配与目录刷新共用）。全局损坏不阻断项目（readConfiguredMcpServers 已容错）。 */
export function readWorkspaceMcpServers(projectConfigPath: string, globalConfigPath: string): ConfiguredMcpServer[] {
  return readConfiguredMcpServers(projectConfigPath, globalConfigPath);
}
