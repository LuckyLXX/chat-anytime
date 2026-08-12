import type { ChatMessage, MessageBlock, ToolExecution } from "../../../shared/protocol";

export type ActionTimelineSegment =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-call"; call: Extract<MessageBlock, { type: "tool-call" }> };

export interface ActionTimelineStats {
  thinkingCount: number;
  toolCount: number;
  failedCount: number;
  active: boolean;
  startedAt?: number;
  completedAt?: number;
}

/** Keep prose runs intact while preserving the model's think -> act order. */
export function actionTimelineSegments(message: ChatMessage, showThinking = true): ActionTimelineSegment[] {
  if (message.role !== "assistant") return [];
  const segments: ActionTimelineSegment[] = [];
  for (const block of message.blocks) {
    if (block.type === "thinking") {
      if (showThinking && block.text) segments.push({ type: "thinking", text: block.text });
      continue;
    }
    if (block.type === "tool-call") {
      segments.push({ type: "tool-call", call: block });
      continue;
    }
    if (block.type !== "text" || !block.text) continue;
    const previous = segments.at(-1);
    if (previous?.type === "text") previous.text += block.text;
    else segments.push({ type: "text", text: block.text });
  }
  return segments;
}

export function actionTimelineStats(segments: ActionTimelineSegment[], executions: ToolExecution[], processActive = false): ActionTimelineStats {
  const calls = segments.filter((segment): segment is Extract<ActionTimelineSegment, { type: "tool-call" }> => segment.type === "tool-call");
  const executionById = new Map(executions.map((execution) => [execution.id, execution]));
  const running = calls.some(({ call }) => executionById.get(call.id)?.status === "running");
  const times = calls
    .map(({ call }) => executionById.get(call.id))
    .filter((execution): execution is ToolExecution => execution !== undefined);
  const starts = times.map((execution) => execution.startedAt);
  const ends = times.map((execution) => execution.completedAt).filter((value): value is number => value !== undefined);
  return {
    thinkingCount: segments.filter((segment) => segment.type === "thinking").length,
    toolCount: calls.length,
    failedCount: times.filter((execution) => execution.status === "error").length,
    active: processActive || running,
    startedAt: starts.length ? Math.min(...starts) : undefined,
    completedAt: ends.length === times.length && ends.length ? Math.max(...ends) : undefined
  };
}

export function formatProcessDuration(startedAt: number, completedAt: number): string {
  const duration = Math.max(0, completedAt - startedAt);
  if (duration < 1000) return `${duration} 毫秒`;
  const seconds = Math.round(duration / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours} 小时 ${minuteRemainder} 分` : `${hours} 小时`;
}
