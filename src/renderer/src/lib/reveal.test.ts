import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../shared/protocol";
import { findRevealMessage, findRevealTurnKey } from "./reveal";

function message(timestamp: number, role: ChatMessage["role"], id = `${role}-${timestamp}`): ChatMessage {
  return { id, uuid: id, role, timestamp, blocks: [] };
}

const messages = [
  message(1_000, "user"),
  message(2_000, "assistant"),
  message(2_000, "user")
];

describe("findRevealMessage", () => {
  it("matches by timestamp and role", () => {
    expect(findRevealMessage(messages, { timestamp: 2_000, role: "assistant" })?.id).toBe("assistant-2000");
    expect(findRevealMessage(messages, { timestamp: 2_000, role: "user" })?.id).toBe("user-2000");
  });

  it("returns undefined for a missing target or a zero timestamp", () => {
    expect(findRevealMessage(messages, { timestamp: 9_999, role: "user" })).toBeUndefined();
    expect(findRevealMessage(messages, { timestamp: 0, role: "user" })).toBeUndefined();
  });

  it("returns the first match when timestamps collide", () => {
    const duplicate = [message(5, "user", "first"), message(5, "user", "second")];
    expect(findRevealMessage(duplicate, { timestamp: 5, role: "user" })?.id).toBe("first");
  });
});

describe("findRevealTurnKey", () => {
  const isTurnStart = (item: ChatMessage): boolean => item.role === "user";

  it("walks back to the turn-start user message for an assistant hit", () => {
    const first = message(1, "user", "first");
    const reply = message(2, "assistant", "reply");
    const second = message(3, "user", "second");
    const reply2 = message(4, "assistant", "reply2");
    const list = [first, reply, second, reply2];

    expect(findRevealTurnKey(list, reply, isTurnStart)).toBe("first");
    expect(findRevealTurnKey(list, reply2, isTurnStart)).toBe("second");
    expect(findRevealTurnKey(list, second, isTurnStart)).toBe("second");
  });

  it("returns undefined when the target is missing or no turn start precedes it", () => {
    expect(findRevealTurnKey(messages, message(99, "assistant"), isTurnStart)).toBeUndefined();
    const loneReply = message(2, "assistant");
    expect(findRevealTurnKey([loneReply], loneReply, isTurnStart)).toBeUndefined();
  });
});
