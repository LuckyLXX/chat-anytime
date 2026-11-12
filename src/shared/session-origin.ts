import type { SessionOrigin, SessionSummary } from "./protocol.js";

/**
 * 会话来源标记的共享口径（2026-11-02 自动化任务面板 P0；2026-11-12 扩到 IM）。
 *
 * 为什么单独成模块：主进程（摘要缓存、搜索、最近会话）与渲染端（列表过滤）
 * 必须用同一套判定，避免「列表里藏了、搜索里还出来」这类口径漂移。本模块
 * 不依赖 Node/Electron，也不依赖 cron，便于两侧共用。
 */

/**
 * Pi custom entry 的类型名：写入会话 JSONL，不参与 LLM 上下文。
 * 字段名里的 automation 是历史包袱（首版只有自动化一种来源）——现在镜像了
 * 自动化与 IM 两种 kind，新代码请用 {@link SESSION_ORIGIN_CUSTOM_TYPE}。
 */
export const SESSION_ORIGIN_CUSTOM_TYPE = "pidesktop.session.origin";

/** @deprecated 旧名（保留以免改动既有调用点）；新代码用 SESSION_ORIGIN_CUSTOM_TYPE。 */
export const AUTOMATION_SESSION_ORIGIN_CUSTOM_TYPE = SESSION_ORIGIN_CUSTOM_TYPE;

/** 旧数据兜底：2026-11-02 之前创建的自动化会话只有这个标题前缀，没有 origin。 */
export const LEGACY_AUTOMATION_SESSION_TITLE_PREFIX = "自动化 · ";

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * 净化一条 custom entry 的 data。
 *
 * - `kind: "automation"` 要求 taskId 非空；
 * - `kind: "im"` 要求 channelId / sessionKey / peerId 都非空；
 * - 其他/坏数据一律返回 undefined（摘要缓存据此忽略，不让坏记录把整个会话
 *   列表带崩）。
 */
export function normalizeSessionOrigin(value: unknown): SessionOrigin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === "im") {
    const channelId = nonEmptyString(record.channelId);
    const sessionKey = nonEmptyString(record.sessionKey);
    const peerId = nonEmptyString(record.peerId);
    if (!channelId || !sessionKey || !peerId) return undefined;
    const displayName = nonEmptyString(record.displayName);
    return { kind: "im", channelId, sessionKey, peerId, ...(displayName ? { displayName } : {}) };
  }
  if (record.kind !== "automation") return undefined;
  const taskId = nonEmptyString(record.taskId);
  if (!taskId) return undefined;
  const taskName = nonEmptyString(record.taskName);
  const runId = nonEmptyString(record.runId);
  return {
    kind: "automation",
    taskId,
    ...(taskName ? { taskName } : {}),
    ...(runId ? { runId } : {})
  };
}

/**
 * 是否为自动化运行会话。
 *
 * 新会话看 `origin`；升级前的旧会话没有 custom entry，只能用标题前缀兜底。
 * 兜底只用于「列表/搜索隔离」，不写回任何存储，也不会把用户手工改名后的
 * 旧会话强行隐藏（宁可漏藏，不错误隐藏用户会话）。
 *
 * IM 会话**不**在过滤范围内：它是用户自己的对话（只是入口在飞书上），
 * 话题列表默认可见，用户可自行改名。
 */
export function isAutomationSessionSummary(session: Pick<SessionSummary, "origin" | "title">): boolean {
  if (session.origin?.kind === "automation") return true;
  return session.title.startsWith(LEGACY_AUTOMATION_SESSION_TITLE_PREFIX);
}

/** 是否为 IM 通道会话（标题可辨认、绑定表可回查；不参与任何隐藏口径）。 */
export function isImSessionSummary(session: Pick<SessionSummary, "origin">): boolean {
  return session.origin?.kind === "im";
}
