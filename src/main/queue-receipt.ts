import type { RuntimeCommand, RuntimeMessage } from "../shared/protocol.js";

/** 带 requestId 的队列消息在 utility 真正接收后才回执；其余命令错误仍走原有通路。 */
export async function dispatchWithQueueReceipt(
  command: RuntimeCommand,
  execute: (command: RuntimeCommand) => Promise<void>,
  publish: (message: RuntimeMessage) => void,
  describeError: (error: unknown) => string
): Promise<void> {
  try {
    await execute(command);
  } catch (error) {
    if (command.type !== "session.queue.add" || !command.requestId) throw error;
    publish({ type: "session.queue-result", requestId: command.requestId, sessionId: command.sessionId, ok: false, error: describeError(error) });
    return;
  }
  if (command.type === "session.queue.add" && command.requestId) {
    publish({ type: "session.queue-result", requestId: command.requestId, sessionId: command.sessionId, ok: true });
  }
}
