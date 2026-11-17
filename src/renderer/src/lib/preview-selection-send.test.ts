import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi, RuntimeCommand, RuntimeMessage } from "../../../shared/protocol";
import { sendPreviewSelectionToSession } from "./preview-selection-send";

function fakeApi(): { api: Pick<DesktopApi, "send" | "onRuntimeMessage">; send: ReturnType<typeof vi.fn>; emit(message: RuntimeMessage): void; listeners: Set<(message: RuntimeMessage) => void> } {
  const listeners = new Set<(message: RuntimeMessage) => void>();
  const send = vi.fn(async (_command: RuntimeCommand) => undefined);
  return { api: { send, onRuntimeMessage: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } }, send, emit: (message) => { for (const listener of listeners) listener(message); }, listeners };
}
afterEach(() => vi.useRealTimers());

describe("选区消息发送回执", () => {
  it("用独立文本向指定会话提交，等匹配的 utility 回执后完成", async () => {
    const { api, send, emit, listeners } = fakeApi();
    const pending = sendPreviewSelectionToSession(api, "session-a", "完整选区与意见");
    const command = send.mock.calls[0]![0] as unknown as { type: string; requestId: string; sessionId: string; text: string };
    expect(command).toMatchObject({ type: "session.queue.add", sessionId: "session-a", text: "完整选区与意见" });
    expect(command).not.toHaveProperty("attachments");
    emit({ type: "session.queue-result", requestId: command.requestId, sessionId: "other", ok: true });
    expect(listeners.size).toBe(1);
    emit({ type: "session.queue-result", requestId: command.requestId, sessionId: "session-a", ok: true });
    await expect(pending).resolves.toBeUndefined();
    expect(listeners.size).toBe(0);
  });

  it("失败与超时返回可读提示且清理订阅", async () => {
    vi.useFakeTimers();
    const { api, send, emit, listeners } = fakeApi();
    const failed = sendPreviewSelectionToSession(api, "s1", "正文");
    const command = send.mock.calls[0]![0] as unknown as { requestId: string };
    emit({ type: "session.queue-result", requestId: command.requestId, sessionId: "s1", ok: false, error: "工作区只读" });
    await expect(failed).rejects.toThrow("工作区只读");
    const timeout = sendPreviewSelectionToSession(api, "s1", "正文", 1000);
    const assertion = expect(timeout).rejects.toThrow("状态未确认，请先检查聊天或队列再重试");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(listeners.size).toBe(0);
  });

  it("空错误信息仍视为失败，不会误报发送成功", async () => {
    const { api, send, emit } = fakeApi();
    const pending = sendPreviewSelectionToSession(api, "s1", "正文");
    const command = send.mock.calls[0]![0] as unknown as { requestId: string };
    emit({ type: "session.queue-result", requestId: command.requestId, sessionId: "s1", ok: false, error: "" });
    await expect(pending).rejects.toThrow("发送失败，请重试");
  });

  it("主进程转发失败时立即回报", async () => {
    const { api, send, listeners } = fakeApi();
    send.mockRejectedValueOnce(new Error("运行时不可用"));
    await expect(sendPreviewSelectionToSession(api, "s1", "正文")).rejects.toThrow("运行时不可用");
    expect(listeners.size).toBe(0);
  });
});
