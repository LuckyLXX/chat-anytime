import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./pi-runtime.ts", import.meta.url), "utf8").replace(/\r\n/gu, "\n");

/**
 * session_end 是 app 自造事件（Pi 的 session_shutdown 在 PiDesktop 的 dispose 路径不触发），
 * 因此接线正确性只能钉在 pi-runtime 源码上：唯一触发点在 disposeRecord 里、且在
 * record.session.dispose() 之前——park（切会话/切助手）不走这条路。
 */
describe("session_end wiring", () => {
  it("fires session_end hooks exactly once, before the record is disposed", () => {
    const start = source.indexOf("function disposeRecord(record: SessionRuntimeRecord");
    expect(start).toBeGreaterThanOrEqual(0);
    const end = source.indexOf("\nfunction ", start + 10);
    const body = source.slice(start, end);
    const fire = body.indexOf("runtimeHooks.fireSessionEndHooks(");
    const dispose = body.indexOf("record.session.dispose()");
    expect(fire).toBeGreaterThanOrEqual(0);
    expect(dispose).toBeGreaterThan(fire);
    expect(source.split("runtimeHooks.fireSessionEndHooks(").length - 1).toBe(1);
  });

  it("builds the hook context from the disposed record instead of the active session", () => {
    const start = source.indexOf("function disposeRecord(record: SessionRuntimeRecord");
    const end = source.indexOf("\nfunction ", start + 10);
    const body = source.slice(start, end);
    expect(body).toContain("workspace: () => record.workspace");
    expect(body).toContain("agentName: () => record.agent.name");
    expect(body).toContain("sessionId: () => record.session.sessionId");
  });

  it("shares one deps factory between session creation and session_end", () => {
    // 同一个 hooksDepsFor 装配：会话创建的内联扩展与 session_end 走同一套信任门/总闸。
    expect(source.split("hooksDepsFor({").length - 1).toBe(2);
    expect(source).toContain("runtimeHooks.createHooksExtension(hooksDepsFor({");
  });
});
