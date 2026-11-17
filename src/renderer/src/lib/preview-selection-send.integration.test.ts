import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoApi } from "../demo-api";
import { sendPreviewSelectionToSession } from "./preview-selection-send";

afterEach(() => vi.useRealTimers());

describe("选区消息发送到会话", () => {
  it("空闲立即发出，忙时排队并在本轮结束后发送", async () => {
    vi.useFakeTimers();
    const api = createDemoApi();
    await api.send({ type: "session.new", requestId: "preview-test" });
    const id = (await api.bootstrap()).runtime!.sessionId!;
    await sendPreviewSelectionToSession(api, id, "第一条选区请求");
    let state = (await api.bootstrap()).runtime!;
    expect(state.busy).toBe(true);
    expect(state.messages.at(-1)?.blocks).toEqual([{ type: "text", text: "第一条选区请求" }]);
    await sendPreviewSelectionToSession(api, id, "第二条选区请求");
    state = (await api.bootstrap()).runtime!;
    expect(state.queuedMessages.map((item) => item.text)).toContain("第二条选区请求");
    await vi.runAllTimersAsync();
    state = (await api.bootstrap()).runtime!;
    expect(state.busy).toBe(false);
    expect(state.queuedMessages).toHaveLength(0);
    expect(state.messages.some((message) => message.role === "user" && message.blocks.some((block) => block.type === "text" && block.text === "第二条选区请求"))).toBe(true);
  });
});
