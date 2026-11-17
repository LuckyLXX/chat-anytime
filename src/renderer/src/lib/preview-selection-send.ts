import type { DesktopApi, RuntimeMessage } from "../../../shared/protocol";

/** 等待 utility 的实际接收回执；runtime:send 返回只代表主进程已转发。 */
export function sendPreviewSelectionToSession(api: Pick<DesktopApi, "send" | "onRuntimeMessage">, sessionId: string, text: string, timeoutMs = 15_000): Promise<void> {
  if (!sessionId) return Promise.reject(new Error("请先创建或打开一个会话"));
  const requestId = `preview-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = (): void => {};
    const finish = (error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      if (error) reject(new Error(error));
      else resolve();
    };
    const timer = setTimeout(() => finish("状态未确认，请先检查聊天或队列再重试"), timeoutMs);
    unsubscribe = api.onRuntimeMessage((message: RuntimeMessage) => {
      if (message.type !== "session.queue-result" || message.requestId !== requestId || message.sessionId !== sessionId) return;
      finish(message.ok ? undefined : message.error.trim() || "发送失败，请重试");
    });
    try {
      void api.send({ type: "session.queue.add", sessionId, text, requestId }).catch((error: unknown) => finish(error instanceof Error && error.message.trim() ? error.message : "发送失败，请重试"));
    } catch (error) {
      finish(error instanceof Error && error.message.trim() ? error.message : "发送失败，请重试");
    }
  });
}
