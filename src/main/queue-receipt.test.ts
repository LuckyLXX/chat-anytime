import { describe, expect, it, vi } from "vitest";
import type { RuntimeCommand } from "../shared/protocol.js";
import { dispatchWithQueueReceipt } from "./queue-receipt.js";

const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error);
describe("队列提交回执", () => {
  it("成功接收后才回传请求和会话 ID", async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    const execute = vi.fn(() => work);
    const publish = vi.fn();
    const command: RuntimeCommand = { type: "session.queue.add", text: "内容", sessionId: "pane-a", requestId: "r1" };
    const pending = dispatchWithQueueReceipt(command, execute, publish, describeError);
    expect(publish).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(publish).toHaveBeenCalledWith({ type: "session.queue-result", requestId: "r1", sessionId: "pane-a", ok: true });
  });
  it("拒绝时回传错误，普通消息仍走原有异常通路", async () => {
    const publish = vi.fn();
    const execute = vi.fn(async () => { throw new Error("工作区只读"); });
    await dispatchWithQueueReceipt({ type: "session.queue.add", text: "内容", sessionId: "pane-a", requestId: "r2" }, execute, publish, describeError);
    expect(publish).toHaveBeenCalledWith({ type: "session.queue-result", requestId: "r2", sessionId: "pane-a", ok: false, error: "工作区只读" });
    await expect(dispatchWithQueueReceipt({ type: "session.queue.add", text: "旧调用" }, execute, publish, describeError)).rejects.toThrow("工作区只读");
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
