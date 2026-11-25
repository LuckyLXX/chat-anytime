import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../shared/protocol.js";
import { diffChatMessages } from "../shared/snapshot-patch.js";
import { createSessionDisplay } from "./session-display.js";
import { PI_DESKTOP_CONTROL_ENTRY_TYPE, restoreToolExecutions, type PersistedSessionMessage } from "./session-history.js";

function visibleText(messages: ChatMessage[]): string[] {
  return messages.flatMap((message) => message.blocks.flatMap((block) => block.type === "text" ? [block.text] : []));
}

function appendPair(manager: SessionManager, number: number, timestamp = number * 10) {
  const user = manager.appendMessage({ role: "user", content: `question ${number}`, timestamp });
  const assistant = manager.appendMessage(fauxAssistantMessage(`answer ${number}`, { timestamp: timestamp + 1 }));
  return { user, assistant };
}

describe("conversation display history", () => {
  it("keeps original messages, attachments and display flags when a compaction replaces model context", () => {
    const manager = SessionManager.inMemory();
    const image = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" } as const;
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "with image" }, image], timestamp: 1 });
    manager.appendMessage(fauxAssistantMessage("seen", { timestamp: 2 }));
    manager.appendCustomMessageEntry("internal", "hidden custom", false);
    manager.appendCustomMessageEntry("notice", "visible custom", true);
    const tail = appendPair(manager, 2);
    const display = createSessionDisplay(manager);
    const before = display.timeline();
    const beforeRaw = display.committedMessages();
    manager.appendCompaction("model-only summary", tail.user, 2_000);

    expect(manager.buildSessionContext().messages.map((message) => message.role)).toEqual(["compactionSummary", "user", "assistant"]);
    expect(display.timeline()).toBe(before);
    expect(display.committedMessages()).toBe(beforeRaw);
    expect(visibleText(before)).toEqual(["with image", "seen", "visible custom", "question 2", "answer 2"]);
    expect(before[0]?.blocks[1]).toEqual(image);
    expect(diffChatMessages(before, display.timeline())).toBeUndefined();
  });

  it("keeps manual compaction controls in place through streaming and updates when the branch changes", () => {
    const manager = SessionManager.inMemory();
    const now = Date.now();
    const earlier = appendPair(manager, 1, now - 100);
    const recent = appendPair(manager, 2, now - 90);
    manager.appendCustomEntry(PI_DESKTOP_CONTROL_ENTRY_TYPE, { kind: "compact-command", text: "/compact" });
    manager.appendCompaction("summary", recent.user, 2_000);
    const oldLeaf = manager.appendCustomEntry(PI_DESKTOP_CONTROL_ENTRY_TYPE, { kind: "compact-result", text: "compacted" });
    const display = createSessionDisplay(manager);
    const original = display.timeline();
    expect(visibleText(original)).toEqual(["question 1", "answer 1", "question 2", "answer 2", "/compact", "compacted"]);
    expect(original.slice(-2).map((message) => message.control)).toEqual(["compact", "compact"]);

    const streaming = display.timeline(fauxAssistantMessage("part", { timestamp: Date.now() + 100 }));
    expect(streaming.slice(0, -1).every((message, index) => message === original[index])).toBe(true);
    const storedCount = manager.getEntryCount();
    manager.branch(earlier.assistant);
    expect(manager.getEntryCount()).toBe(storedCount);
    expect(visibleText(display.timeline())).toEqual(["question 1", "answer 1"]);
    appendPair(manager, 3, now + 200);
    expect(visibleText(display.timeline())).toEqual(["question 1", "answer 1", "question 3", "answer 3"]);
    manager.branch(oldLeaf);
    expect(visibleText(display.timeline())).toEqual(visibleText(original));
    manager.resetLeaf();
    expect(display.timeline()).toEqual([]);
  });

  it("preserves explicit context edits and ignores edits from a discarded branch", () => {
    const manager = SessionManager.inMemory();
    const first = appendPair(manager, 1);
    const second = appendPair(manager, 2);
    manager.appendContextEdit(first.assistant, null);
    manager.appendContextEdit(second.user, { content: "edited question" });
    manager.appendContextEdit(second.assistant, { content: "edited answer" });
    manager.appendCompaction("summary", second.user, 2_000);
    const display = createSessionDisplay(manager);
    expect(visibleText(display.timeline())).toEqual(["question 1", "edited question", "edited answer"]);
    manager.branch(second.assistant);
    expect(visibleText(display.timeline())).toEqual(["question 1", "answer 1", "question 2", "answer 2"]);
  });

  it("does not walk a long history per stream frame and finalizes using the original streaming UUID", () => {
    const manager = SessionManager.inMemory();
    for (let number = 1; number <= 500; number++) appendPair(manager, number);
    const kept = appendPair(manager, 501);
    const readBranch = vi.spyOn(manager, "getBranch");
    const display = createSessionDisplay(manager);
    const initial = display.timeline();
    const partial = display.timeline(fauxAssistantMessage("grow", { timestamp: 6_000 }));
    for (let frame = 0; frame < 20; frame++) {
      const next = display.timeline(fauxAssistantMessage(`grow ${frame}`, { timestamp: 6_000 }));
      expect(diffChatMessages(partial, next)).toHaveProperty("replaceFrom");
      expect(next[0]).toBe(initial[0]);
      expect(next.at(-1)?.uuid).toBe(partial.at(-1)?.uuid);
    }
    expect(readBranch).toHaveBeenCalledTimes(1);
    manager.appendMessage(fauxAssistantMessage("final", { timestamp: 6_000 }));
    const complete = display.timeline();
    expect(complete).toHaveLength(initial.length + 1);
    expect(complete.at(-1)).toMatchObject({ uuid: partial.at(-1)?.uuid, streaming: false });
    manager.appendCompaction("summary", kept.user, 60_000);
    expect(display.timeline()).toBe(complete);
  });

  it("keeps other turns readable when a pre-compaction entry is missing its message body", () => {
    const manager = SessionManager.inMemory();
    const damaged = manager.appendMessage({ role: "user", content: "unreadable", timestamp: 1 });
    const kept = appendPair(manager, 1);
    manager.appendCompaction("summary", kept.user, 2_000);
    const readBranch = manager.getBranch.bind(manager);
    vi.spyOn(manager, "getBranch").mockImplementation(() => readBranch().map((entry) => entry.id === damaged && entry.type === "message"
      ? { ...entry, message: undefined as unknown as typeof entry.message }
      : entry));
    expect(visibleText(createSessionDisplay(manager).timeline())).toEqual(["question 1", "answer 1"]);
  });

  it("reopens original turns and their tool output from a compressed JSONL", () => {
    const root = mkdtempSync(join(tmpdir(), "pidesktop-display-history-"));
    try {
      const manager = SessionManager.create(root, root);
      manager.appendMessage({ role: "user", content: "first question", timestamp: 1 });
      manager.appendMessage(fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }, { id: "old-call" }), { timestamp: 2, stopReason: "toolUse" }));
      manager.appendMessage({ role: "toolResult", toolCallId: "old-call", toolName: "read", content: [{ type: "text", text: "original tool output" }], isError: false, timestamp: 3 });
      manager.appendMessage(fauxAssistantMessage("first answer", { timestamp: 4 }));
      const tail = appendPair(manager, 2);
      const before = createSessionDisplay(manager).timeline();
      manager.appendCompaction("summary", tail.user, 2_000);
      const reopened = SessionManager.open(manager.getSessionFile()!, root);
      const display = createSessionDisplay(reopened);
      expect(display.timeline()).toEqual(before);
      expect(restoreToolExecutions(display.committedMessages() as readonly PersistedSessionMessage[], root)).toMatchObject([
        { id: "old-call", status: "completed", output: "original tool output" }
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
