import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_FILE_NAME, createToolAudit, formatAuditEntry, serializeAuditArgs, type ToolAuditEntry } from "./tool-audit.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface FakePi {
  handlers: Map<string, (event: Record<string, unknown>) => void>;
  on(event: string, handler: (event: Record<string, unknown>) => void): void;
}

function makeFakePi(): FakePi {
  return {
    handlers: new Map(),
    on(event, handler) {
      this.handlers.set(event, handler);
    }
  };
}

function bind(audit: ReturnType<typeof createToolAudit>): FakePi {
  const pi = makeFakePi();
  (audit.extension as unknown as { factory: (pi: FakePi) => void }).factory(pi);
  return pi;
}

describe("tool-audit helpers", () => {
  it("serializes args and truncates over-long payloads", () => {
    expect(serializeAuditArgs({ command: "ls" })).toBe('{"command":"ls"}');
    expect(serializeAuditArgs(undefined)).toBe("{}");
    const circular: unknown[] = [];
    circular.push(circular);
    expect(serializeAuditArgs(circular)).toBe("<unserializable>");
    const long = serializeAuditArgs({ blob: "x".repeat(5_000) }, 100);
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long).toContain("<截断 ");
  });

  it("formats entries as single JSON lines", () => {
    const entry: ToolAuditEntry = { ts: "2026-08-16T00:00:00.000Z", sessionId: "s1", toolCallId: "t1", toolName: "bash", isError: false, durationMs: 12, args: "{}" };
    const line = formatAuditEntry(entry);
    expect(JSON.parse(line)).toMatchObject({ toolCallId: "t1", toolName: "bash" });
    expect(line).not.toContain("\n");
  });
});

describe("tool audit extension", () => {
  it("writes one JSONL line per tool execution with duration and args", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-desktop-audit-"));
    temporaryDirectories.push(dir);
    const warnings: string[] = [];
    const audit = createToolAudit({ auditDir: () => dir, sessionId: () => "session-1", warn: (message) => warnings.push(message) });
    const pi = bind(audit);

    pi.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } });
    pi.handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {}, isError: false });
    pi.handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "call-orphan", toolName: "read", result: {}, isError: true });
    await audit.drain();

    const lines = (await readFile(join(dir, AUDIT_FILE_NAME), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(first).toMatchObject({ sessionId: "session-1", toolCallId: "call-1", toolName: "bash", isError: false, args: '{"command":"npm test"}' });
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    // Missed start event: no duration/args fields, still logged.
    expect(second).toMatchObject({ toolCallId: "call-orphan", isError: true });
    expect(second.durationMs).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("skips writing when auditDir is undefined and keeps the queue usable", async () => {
    const audit = createToolAudit({ auditDir: () => undefined, sessionId: () => "s", warn: () => {} });
    const pi = bind(audit);
    pi.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} });
    pi.handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: {}, isError: false });
    await audit.drain();
  });

  it("reports write failures through warn instead of rejecting", async () => {
    const warnings: string[] = [];
    // An unusable path (file under a file) makes appendFile fail.
    const blocker = await mkdtemp(join(tmpdir(), "pi-desktop-audit-"));
    temporaryDirectories.push(blocker);
    const audit = createToolAudit({ auditDir: () => join(blocker, "not-a-dir", "..", "..", "*"), sessionId: () => "s", warn: (message) => warnings.push(message) });
    const pi = bind(audit);
    pi.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} });
    pi.handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: {}, isError: false });
    await audit.drain();
    expect(warnings.length).toBeLessThanOrEqual(1);
  });
});

/**
 * 审计日志轮转（2026-09-26 P1）：审计是只追加、从不回读的旁路数据，但实测本机
 * 一个助手的 tool-audit.jsonl 已 14.2 MB 且仍在增长（无任何上限）。改为按体积触发
 * 压缩：超阈值时保留最新 N 行 + 丢弃过期条目，原子重写；失败只 warn。
 */
describe("tool audit rotation", () => {
  async function fire(audit: ReturnType<typeof createToolAudit>, count: number): Promise<void> {
    const pi = bind(audit);
    for (let index = 1; index <= count; index += 1) {
      pi.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: `c${index}`, toolName: "bash", args: { command: `echo ${index}` } });
      pi.handlers.get("tool_execution_end")!({ type: "tool_execution_end", toolCallId: `c${index}`, toolName: "bash", result: {}, isError: false });
    }
    await audit.drain();
  }

  function idsOf(lines: string[]): string[] {
    return lines.map((line) => (JSON.parse(line) as { toolCallId: string }).toolCallId);
  }

  it("超过体积阈值后压缩：只留最新几行，最旧的被丢弃，且每行仍是合法 JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-desktop-audit-rotate-"));
    temporaryDirectories.push(dir);
    const warnings: string[] = [];
    const audit = createToolAudit({ auditDir: () => dir, sessionId: () => "s", warn: (message) => warnings.push(message), auditMaxBytes: 300, auditKeepLines: 2 });
    await fire(audit, 8);

    const lines = (await readFile(join(dir, AUDIT_FILE_NAME), "utf8")).trim().split("\n").filter((line) => line.trim());
    expect(lines.length).toBeLessThanOrEqual(3);
    const ids = idsOf(lines);
    expect(ids).toContain("c8");
    expect(ids).not.toContain("c1");
    expect(warnings).toEqual([]);
  });

  it("未超阈值时一字不改（正常路径零开销）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-desktop-audit-norotate-"));
    temporaryDirectories.push(dir);
    const audit = createToolAudit({ auditDir: () => dir, sessionId: () => "s", warn: () => {} });
    await fire(audit, 2);
    const lines = (await readFile(join(dir, AUDIT_FILE_NAME), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(idsOf(lines)).toEqual(["c1", "c2"]);
  });

  it("压缩时丢弃过期条目与坏行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-desktop-audit-retain-"));
    temporaryDirectories.push(dir);
    const stale = JSON.stringify({ ts: new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString(), sessionId: "s", toolCallId: "stale", toolName: "bash", isError: false });
    await writeFile(join(dir, AUDIT_FILE_NAME), `${stale}\n坏行不是 JSON\n`, "utf8");

    const audit = createToolAudit({ auditDir: () => dir, sessionId: () => "s", warn: () => {}, auditMaxBytes: 1, auditKeepLines: 50 });
    await fire(audit, 2);

    const lines = (await readFile(join(dir, AUDIT_FILE_NAME), "utf8")).trim().split("\n").filter((line) => line.trim());
    const ids = idsOf(lines);
    expect(ids).toEqual(["c1", "c2"]);
    expect(lines.join("\n")).not.toContain("坏行");
  });
});
