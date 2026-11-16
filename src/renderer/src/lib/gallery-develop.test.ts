import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCommand, RuntimeMessage } from "../../../shared/protocol";
import { insertGalleryDevelopmentText, requestGallerySession } from "./gallery-develop";

afterEach(() => vi.useRealTimers());

describe("作品继续开发：会话回执", () => {
  it("先订阅回执，只接受当前请求，并以 utility 的新会话 ID 为准", async () => {
    let listener: (message: RuntimeMessage) => void = () => {};
    const unsubscribe = vi.fn();
    const send = vi.fn(async (_command: RuntimeCommand) => {});
    const result = requestGallerySession({
      workspace: "/work", agentId: "agent", requestId: "op-2", signal: new AbortController().signal,
      timeoutMs: 1000, send, subscribe: (fn) => { listener = fn; return unsubscribe; }
    });
    expect(send).toHaveBeenCalledWith({ type: "session.new", workspace: "/work", agentId: "agent", requestId: "op-2" });
    listener({ type: "session.new-result", requestId: "op-1", ok: true, sessionId: "wrong" });
    expect(unsubscribe).not.toHaveBeenCalled();
    listener({ type: "session.new-result", requestId: "op-2", ok: true, sessionId: "right" });
    await expect(result).resolves.toBe("right");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("失败、超时、取消都结束等待并退订", async () => {
    vi.useFakeTimers();
    let listener: (message: RuntimeMessage) => void = () => {};
    const off = vi.fn();
    const send = vi.fn(async (_command: RuntimeCommand) => {});
    const base = { workspace: "/work", agentId: "a", requestId: "x", timeoutMs: 100,
      send, subscribe: (fn: (message: RuntimeMessage) => void) => { listener = fn; return off; } };
    const failure = requestGallerySession({ ...base, signal: new AbortController().signal });
    listener({ type: "session.new-result", requestId: "x", ok: false, error: "助手已归档" });
    await expect(failure).rejects.toThrow("助手已归档");
    const timeout = requestGallerySession({ ...base, signal: new AbortController().signal });
    const timeoutAssertion = expect(timeout).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100);
    await timeoutAssertion;
    const aborter = new AbortController();
    const canceled = requestGallerySession({ ...base, signal: aborter.signal });
    aborter.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    expect(off).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.filter(([command]) => command.type === "session.cancel-new")).toHaveLength(2);
    expect(send).toHaveBeenCalledWith({ type: "session.cancel-new", requestId: "x" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("作品继续开发：目标输入框", () => {
  it("输入框稍后注册时重试，只向绑定的会话写入一次", async () => {
    vi.useFakeTimers();
    const insertText = vi.fn();
    let ready = false;
    const getComposer = vi.fn((id: string) => id === "new-session" && ready ? { insertText } : undefined);
    const result = insertGalleryDevelopmentText({ sessionId: "new-session", text: "作品上下文", signal: new AbortController().signal,
      timeoutMs: 500, retryMs: 50, getComposer });
    await vi.advanceTimersByTimeAsync(100);
    expect(insertText).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(insertText).toHaveBeenCalledOnce();
    expect(insertText).toHaveBeenCalledWith("作品上下文");
    expect(getComposer.mock.calls.every(([id]) => id === "new-session")).toBe(true);
  });

  it("用户切走、等待超时或新操作取消旧操作时，不会写入错误的会话", async () => {
    vi.useFakeTimers();
    const insertText = vi.fn();
    const controller = new AbortController();
    const old = insertGalleryDevelopmentText({ sessionId: "old", text: "旧", signal: controller.signal,
      timeoutMs: 100, retryMs: 20, getComposer: () => ({ insertText }), isReady: () => false });
    controller.abort();
    await expect(old).rejects.toMatchObject({ name: "AbortError" });
    const late = insertGalleryDevelopmentText({ sessionId: "new", text: "新", signal: new AbortController().signal,
      timeoutMs: 100, retryMs: 20, getComposer: () => ({ insertText }), isReady: () => false });
    const assertion = expect(late).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(insertText).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
