import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./pi-runtime.ts", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  if (begin < 0 || finish < 0) throw new Error(`Missing runtime section: ${start} → ${end}`);
  return source.slice(begin, finish);
}

describe("display history runtime wiring", () => {
  it("uses the session display in both active and split pane snapshots, including early hydration", () => {
    const pane = section("function paneSnapshotFrom(", "function snapshot(");
    expect(pane).toContain("record.displayHistory.timeline(session.state.streamingMessage)");
    expect(pane).not.toContain("session.state.messages");
    expect(section("function snapshot(", "function emitPaneSnapshot(")).toContain("paneSnapshotFrom(record)");
    expect(section("function emitPaneSnapshot(", "function schedulePaneEmit(")).toContain("paneSnapshotFrom(record)");
    const early = section("const displayHistory = createSessionDisplay(activeSessionManager);", "const record: SessionRuntimeRecord = {");
    expect(early).toContain("messages: displayHistory.timeline(earlySession.state.streamingMessage)");
    expect(early).not.toContain("earlySession.state.messages");
    expect(source).toContain("restoreToolExecutions(record.displayHistory.committedMessages()");
  });

  it("flushes finalized messages after Pi appends them and only for the same live record", () => {
    const event = section("handleImSessionEvent(record, event);", "if (record !== activeRuntime) {");
    expect(event).toMatch(/if \(event\.type === "message_end"\)\s*\{\s*(?:\/\/[^\n]*\s*)*queueMicrotask\(/u);
    expect(event).toContain("if (liveSessions.get(record.session.sessionId) !== record) return;");
    expect(event).toContain("if (record === activeRuntime) scheduleEmit(true);");
    expect(event).toContain("else schedulePaneEmit(record, true);");
  });
});
