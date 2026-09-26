// App-owned inline extension that records every tool execution (duration,
// error flag, argument summary) into an append-only JSONL file under the
// agent session root. Best-effort: write failures surface as warn logs and
// never break the agent turn. Raw tool output is not persisted — only the
// truncated argument summary needed to reconstruct what was called.

import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const AUDIT_FILE_NAME = "tool-audit.jsonl";
export const AUDIT_ARGS_MAX_LENGTH = 2_048;

/**
 * 轮转口径（2026-09-26）：审计日志是**只追加、从不回读**的旁路数据，但工具调用
 * 密度高——实测本机一个助手的 `tool-audit.jsonl` 已 14.2 MB 且仍在增长，没有上限。
 * 所以按**文件体积**触发压缩（stat 一次，比逐次统计行数便宜）：超过
 * `AUDIT_MAX_BYTES` 时读全文件 → 丢弃过期条目 + 只留最新的 `AUDIT_KEEP_LINES` 行
 * → 原子重写。任何一步失败只 warn，绝不影响工具执行（审计是 best-effort）。
 */
export const AUDIT_MAX_BYTES = 4 * 1024 * 1024;
export const AUDIT_KEEP_LINES = 2000;
/** 压缩时顺带丢弃超过这么多天的条目（不是独立保证：文件不大就不压缩）。 */
export const AUDIT_RETAIN_DAYS = 14;

export interface ToolAuditEntry {
  ts: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  /** Elapsed milliseconds; omitted when the matching start event was missed. */
  durationMs?: number;
  isError: boolean;
  /** JSON-serialized tool arguments, truncated; omitted when start was missed (end carries no args). */
  args?: string;
}

/** Serialize tool arguments for the audit log; never throws. */
export function serializeAuditArgs(args: unknown, maxLength: number = AUDIT_ARGS_MAX_LENGTH): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {}) ?? "<unserializable>";
  } catch {
    return "<unserializable>";
  }
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…<截断 ${text.length - maxLength} 字符>`;
}

export function formatAuditEntry(entry: ToolAuditEntry): string {
  return JSON.stringify(entry);
}

export interface ToolAuditDeps {
  /** Directory for the audit file; returning undefined disables audit writes. */
  auditDir: () => string | undefined;
  sessionId: () => string;
  warn: (message: string) => void;
  /**
   * Optional observer fired on every tool_execution_start (before the tool
   * runs). Used by the todo pace tracker to count calls between todo_write s;
   * observer failures must never affect auditing, so it is wrapped defensively.
   */
  onToolStart?: (toolName: string) => void;
  /** 轮转阈值（字节）；测试注入小值验证压缩路径。 */
  auditMaxBytes?: number;
  /** 压缩后保留的最新行数。 */
  auditKeepLines?: number;
}

/**
 * 超阈值时压缩审计日志（在串行队列内调用，不会与追加交错）。
 * 只保留最新 `keepLines` 行，并顺带丢弃 `retainDays` 之前的条目。
 */
async function compactAuditFile(file: string, options: { maxBytes: number; keepLines: number; now?: number }): Promise<void> {
  const info = await stat(file);
  if (info.size <= options.maxBytes) return;
  const text = await readFile(file, "utf8");
  const lines = text.split("\n").filter((line) => line.trim());
  const cutoff = (options.now ?? Date.now()) - AUDIT_RETAIN_DAYS * 24 * 60 * 60 * 1000;
  const fresh = lines.filter((line) => {
    try {
      const parsed = JSON.parse(line) as { ts?: unknown };
      const ts = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : Number.NaN;
      return Number.isNaN(ts) || ts >= cutoff;
    } catch {
      return false; // 坏行直接丢（日志不是数据源）
    }
  });
  const kept = fresh.length > options.keepLines ? fresh.slice(fresh.length - options.keepLines) : fresh;
  const tempPath = `${file}.${process.pid}.tmp`;
  await writeFile(tempPath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  await rename(tempPath, file);
}

export interface ToolAuditController {
  extension: InlineExtension;
  /** Resolves once all queued audit lines have been written (or failed). */
  drain: () => Promise<void>;
}

export function createToolAudit(deps: ToolAuditDeps): ToolAuditController {
  const inFlight = new Map<string, { startedAt: number; args: unknown }>();
  let queue: Promise<void> = Promise.resolve();
  const drain = (): Promise<void> => queue;

  return {
    extension: {
      name: "chat-anytime-tool-audit",
      hidden: true,
      factory(pi) {
        pi.on("tool_execution_start", (event) => {
          if (inFlight.size > 1_000) inFlight.clear();
          inFlight.set(event.toolCallId, { startedAt: Date.now(), args: event.args });
          if (deps.onToolStart) {
            try { deps.onToolStart(event.toolName); } catch { /* observer must never break the turn */ }
          }
        });
        pi.on("tool_execution_end", (event) => {
          const started = inFlight.get(event.toolCallId);
          inFlight.delete(event.toolCallId);
          const dir = deps.auditDir();
          if (!dir) return;
          const entry: ToolAuditEntry = {
            ts: new Date().toISOString(),
            sessionId: deps.sessionId(),
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            ...(started ? { durationMs: Date.now() - started.startedAt, args: serializeAuditArgs(started.args) } : {})
          };
          const file = join(dir, AUDIT_FILE_NAME);
          // Serialised appends keep JSONL lines intact; failures are logged once and dropped.
          // 追加后顺带检查体积：超阈值就在同一队列内压缩（不会与追加交错）。
          const maxBytes = deps.auditMaxBytes ?? AUDIT_MAX_BYTES;
          const keepLines = deps.auditKeepLines ?? AUDIT_KEEP_LINES;
          queue = queue
            .then(async () => {
              await mkdir(dir, { recursive: true });
              await appendFile(file, `${formatAuditEntry(entry)}\n`, "utf8");
              await compactAuditFile(file, { maxBytes, keepLines });
            })
            .catch((error: unknown) => {
              deps.warn(`工具审计日志写入失败：${error instanceof Error ? error.message : String(error)}`);
            });
        });
      }
    },
    drain
  };
}
