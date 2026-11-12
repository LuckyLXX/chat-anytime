import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IM_SEEN_LIMIT } from "../shared/im.js";
import { writeJsonAtomic } from "./settings-store.js";

/**
 * IM 通道的持久化状态（2026-11-12，IM 通道 P1）：`<userData>/pidesktop-im.json`。
 *
 * 为什么不放 agentDir：应用级状态（通道绑定跨助手），放 userData 与
 * settings.json / credentials.json 同目录，省掉再复制一份 agentDir 解析逻辑。
 *
 * 内容两件：
 * - `bindings`：会话键 → 会话文件路径（**只存 sessionPath**，sessionId 是内存态，
 *   重启后按路径冷恢复）；
 * - `seen`：每通道已处理的 `message_id` 列表（500 条 LRU）。官方明确去重用
 *   message_id 而不是 event_id——平台重投是常态。
 *
 * 纪律：坏文件当空处理（绝不让一条坏 JSON 把通道带崩）；原子写（同目录 tmp+rename）；
 * 写失败只告警（绑定丢了最坏结果是「多建一个会话」，不该阻断消息）。
 */

export interface ImBinding {
  /** 会话 JSONL 的绝对路径。 */
  sessionPath: string;
  chatId: string;
  openId: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface ImStoreState {
  version: 1;
  bindings: Record<string, ImBinding>;
  seen: Record<string, string[]>;
}

export function imStorePath(userDataDir: string): string {
  return join(userDataDir, "pidesktop-im.json");
}

function emptyState(): ImStoreState {
  return { version: 1, bindings: {}, seen: {} };
}

function normalizeBinding(value: unknown): ImBinding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const sessionPath = typeof raw.sessionPath === "string" ? raw.sessionPath.trim() : "";
  const chatId = typeof raw.chatId === "string" ? raw.chatId.trim() : "";
  const openId = typeof raw.openId === "string" ? raw.openId.trim() : "";
  if (!sessionPath || !chatId || !openId) return undefined;
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  const lastSeenAt = typeof raw.lastSeenAt === "number" && Number.isFinite(raw.lastSeenAt) ? raw.lastSeenAt : createdAt;
  return { sessionPath, chatId, openId, createdAt, lastSeenAt };
}

export class ImStore {
  private state: ImStoreState | undefined;

  constructor(
    private readonly path: string,
    private readonly warn: (message: string) => void = (message) => console.warn(message),
    private readonly now: () => number = () => Date.now()
  ) {}

  private load(): ImStoreState {
    if (this.state) return this.state;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      // 文件不存在 / 坏 JSON：空状态起步（首次写入即修复）。
      this.state = emptyState();
      return this.state;
    }
    const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const state = emptyState();
    const bindings = source.bindings && typeof source.bindings === "object" ? source.bindings as Record<string, unknown> : {};
    for (const [key, value] of Object.entries(bindings)) {
      const binding = normalizeBinding(value);
      if (binding) state.bindings[key] = binding;
    }
    const seen = source.seen && typeof source.seen === "object" ? source.seen as Record<string, unknown> : {};
    for (const [key, value] of Object.entries(seen)) {
      if (!Array.isArray(value)) continue;
      state.seen[key] = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(-IM_SEEN_LIMIT);
    }
    this.state = state;
    return this.state;
  }

  private persist(): void {
    if (!this.state) return;
    try {
      writeJsonAtomic(this.path, this.state);
    } catch (error) {
      this.warn(`写入 IM 通道状态失败（绑定与去重表可能丢失）：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  binding(key: string): ImBinding | undefined {
    return this.load().bindings[key];
  }

  bind(key: string, binding: Omit<ImBinding, "createdAt" | "lastSeenAt"> & { createdAt?: number }): ImBinding {
    const state = this.load();
    const existing = state.bindings[key];
    const createdAt = existing?.createdAt ?? binding.createdAt ?? this.now();
    const next: ImBinding = { ...binding, createdAt, lastSeenAt: this.now() };
    state.bindings[key] = next;
    this.persist();
    return next;
  }

  /** 记一次活跃（消息到达时刷新 lastSeenAt，不改变绑定）。 */
  touch(key: string): void {
    const state = this.load();
    const existing = state.bindings[key];
    if (!existing) return;
    state.bindings[key] = { ...existing, lastSeenAt: this.now() };
    this.persist();
  }

  unbind(key: string): void {
    const state = this.load();
    if (!state.bindings[key]) return;
    delete state.bindings[key];
    this.persist();
  }

  hasSeen(channelKey: string, messageId: string): boolean {
    return (this.load().seen[channelKey] ?? []).includes(messageId);
  }

  /** 记一条已处理的消息（LRU：超过上限从头掉）。 */
  markSeen(channelKey: string, messageId: string): void {
    const state = this.load();
    const list = state.seen[channelKey] ?? [];
    if (list.includes(messageId)) return;
    list.push(messageId);
    state.seen[channelKey] = list.slice(-IM_SEEN_LIMIT);
    this.persist();
  }

  /** 当前全部状态快照（只读；测试与诊断用）。 */
  snapshot(): ImStoreState {
    return JSON.parse(JSON.stringify(this.load())) as ImStoreState;
  }
}
