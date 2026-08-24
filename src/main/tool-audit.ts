// App-owned inline extension that records every tool execution (duration,
// error flag, argument summary) into an append-only JSONL file under the
// agent session root. Best-effort: write failures surface as warn logs and
// never break the agent turn. Raw tool output is not persisted — only the
// truncated argument summary needed to reconstruct what was called.

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const AUDIT_FILE_NAME = "tool-audit.jsonl";
export const AUDIT_ARGS_MAX_LENGTH = 2_048;

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
          queue = queue
            .then(async () => {
              await mkdir(dir, { recursive: true });
              await appendFile(file, `${formatAuditEntry(entry)}\n`, "utf8");
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
