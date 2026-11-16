import type { RuntimeCommand, RuntimeMessage } from "../../../shared/protocol";

/** Acknowledgement must come from the utility process, not from runtime:send's IPC receipt. */
export function requestGallerySession(
  options: {
    workspace: string;
    agentId?: string;
    requestId: string;
    signal: AbortSignal;
    timeoutMs: number;
    send: (command: RuntimeCommand) => Promise<unknown>;
    subscribe: (listener: (message: RuntimeMessage) => void) => () => void;
  }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal.aborted) { reject(new DOMException("操作已取消", "AbortError")); return; }
    let settled = false;
    let unsubscribe = (): void => {};
    const finish = (error?: Error, sessionId?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      if (error) reject(error);
      else resolve(sessionId!);
    };
    const cancel = (): void => {
      // runtime:send 只是 IPC 收件回执；取消必须显式发给 utility，且不排在新建请求后面。
      try { void options.send({ type: "session.cancel-new", requestId: options.requestId }).catch(() => undefined); } catch { /* 运行时不可用时仍要清理本地等待 */ }
    };
    const onAbort = (): void => { cancel(); finish(new DOMException("操作已取消", "AbortError")); };
    const timer = setTimeout(() => {
      cancel();
      finish(new Error("等待新话题创建超时；如果话题已经创建，请先检查话题列表再重试"));
    }, options.timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    unsubscribe = options.subscribe((message) => {
      if (message.type !== "session.new-result" || message.requestId !== options.requestId) return;
      if (!message.ok) finish(new Error(message.error));
      else finish(undefined, message.sessionId);
    });
    try {
      void options.send({
        type: "session.new", workspace: options.workspace, agentId: options.agentId, requestId: options.requestId
      }).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Wait for the requested session's composer, without ever redirecting text to another session. */
export function insertGalleryDevelopmentText(options: {
  sessionId: string;
  text: string;
  signal: AbortSignal;
  timeoutMs: number;
  retryMs: number;
  getComposer: (id: string) => { insertText: (text: string) => void } | undefined;
  isReady?: (id: string) => boolean;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + options.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = (): void => finish(new DOMException("操作已取消", "AbortError"));
    const check = (): void => {
      if (options.signal.aborted) { onAbort(); return; }
      try {
        const composer = options.getComposer(options.sessionId);
        if (composer && (options.isReady?.(options.sessionId) ?? true)) {
          composer.insertText(options.text);
          finish();
          return;
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { finish(new Error("等待目标话题的输入框超时，请重试")); return; }
      timer = setTimeout(check, Math.min(options.retryMs, remaining));
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    check();
  });
}
