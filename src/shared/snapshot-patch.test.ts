import { describe, expect, it } from "vitest";
import type { ChatMessage, RuntimeSnapshot, ToolExecution } from "./protocol";
import {
  applyChatMessagesPatch,
  applyRuntimeStatePatch,
  applyToolExecutionsPatch,
  diffChatMessages,
  diffToolExecutions
} from "./snapshot-patch";

function message(id: string, text = id): ChatMessage {
  return { id, uuid: id, role: "assistant", timestamp: 1, blocks: [{ type: "text", text }] };
}

function execution(id: string, output = ""): ToolExecution {
  return { id, name: "bash", args: {}, status: "running", startedAt: 1, output };
}

function snapshot(messages: ChatMessage[], executions: ToolExecution[]): RuntimeSnapshot {
  return {
    revision: 1,
    agentId: "default",
    agentName: "默认助手",
    thinkingLevel: "medium",
    busy: false,
    status: "就绪",
    messages,
    executions,
    backgroundProcesses: [],
    sessions: [],
    recentWorkspaces: [],
    queuedMessages: []
  };
}

describe("diffChatMessages", () => {
  it("returns undefined when every item keeps its identity", () => {
    const items = [message("a"), message("b")];
    expect(diffChatMessages(items, [...items])).toBeUndefined();
  });

  it("appends new tail messages without resending history", () => {
    const items = [message("a"), message("b")];
    const patch = diffChatMessages(items, [...items, message("c")]);
    expect(patch).toEqual({ append: [expect.objectContaining({ id: "c" })] });
  });

  it("replaces only the growing streaming tail", () => {
    const items = [message("a"), message("b"), message("c")];
    const patch = diffChatMessages(items, [items[0]!, items[1]!, message("c", "more")]);
    expect(patch?.replaceFrom).toBe(2);
    expect(patch?.items).toHaveLength(1);
  });

  it("truncates without resending the kept prefix", () => {
    const items = [message("a"), message("b"), message("c")];
    expect(diffChatMessages(items, items.slice(0, 2))).toEqual({ truncateTo: 2 });
  });

  it("replaces from the first changed item when lengths match", () => {
    const items = [message("a"), message("b"), message("c")];
    const patch = diffChatMessages(items, [items[0]!, message("x"), items[2]!]);
    expect(patch?.replaceFrom).toBe(1);
    expect(patch?.items?.map((item) => item.id)).toEqual(["x", "c"]);
  });

  it("falls back to reset when the tail was rewritten at a different length", () => {
    const items = [message("a"), message("b"), message("c")];
    const patch = diffChatMessages(items, [message("a"), message("x"), message("y"), message("z")]);
    expect(patch?.reset).toHaveLength(4);
  });
});

describe("applyChatMessagesPatch", () => {
  it("applies append / replace / truncate", () => {
    const items = [message("a"), message("b")];
    expect(applyChatMessagesPatch(items, { append: [message("c")] })?.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(applyChatMessagesPatch(items, { replaceFrom: 1, items: [message("x")] })?.map((item) => item.id)).toEqual(["a", "x"]);
    expect(applyChatMessagesPatch(items, { truncateTo: 1 })?.map((item) => item.id)).toEqual(["a"]);
  });

  it("rejects out-of-range patches instead of corrupting the timeline", () => {
    expect(applyChatMessagesPatch([message("a")], { replaceFrom: 3, items: [] })).toBeUndefined();
    expect(applyChatMessagesPatch([message("a")], { truncateTo: 3 })).toBeUndefined();
  });
});

describe("diffToolExecutions", () => {
  it("only upserts the changed execution and preserves unchanged snapshots", () => {
    const done = execution("done", "ok");
    done.status = "completed";
    const running = execution("running", "partial");
    const previous = diffToolExecutions(undefined, [done, running]);
    const nextRunning = { ...running, output: "partial more" };
    const result = diffToolExecutions(previous.snapshots, [done, nextRunning]);
    expect(result.patch?.upsert?.map((item) => item.id)).toEqual(["running"]);
    expect(result.snapshots[0]).toBe(previous.snapshots[0]);
  });

  it("reports removals and collapses large changes to reset", () => {
    const previous = diffToolExecutions(undefined, [execution("a"), execution("b"), execution("c")]).snapshots;
    expect(diffToolExecutions(previous, [execution("a")]).patch?.remove).toEqual(["b", "c"]);
    const rewritten = [execution("a", "x"), execution("b", "x"), execution("c", "x")];
    expect(diffToolExecutions(previous, rewritten).patch?.upsert).toHaveLength(3);
  });
});

describe("applyRuntimeStatePatch", () => {
  it("merges scalar fields and message patches without touching untouched history", () => {
    const first = message("a");
    const previous = snapshot([first, message("b")], [execution("e")]);
    const merged = applyRuntimeStatePatch(previous, {
      type: "state.patch",
      snapshot: { revision: 2, status: "正在工作" },
      messages: { append: [message("c")] },
      executions: { upsert: [{ ...execution("e"), status: "completed" }] }
    });
    expect(merged?.status).toBe("正在工作");
    expect(merged?.messages.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(merged?.messages[0]).toBe(first);
    expect(merged?.executions[0]?.status).toBe("completed");
  });
});
