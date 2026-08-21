import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageUuid } from "./message-identity.js";

/** 模拟 Pi 流式管线：每个事件 spread 出新对象（引用不同、内容一致）。 */
function frame(role: "user" | "assistant" | "toolResult", timestamp: number | undefined, spreadFrom?: AgentMessage): AgentMessage {
  void spreadFrom;
  return { role, timestamp } as unknown as AgentMessage;
}

describe("messageUuid", () => {
  it("同一条消息的流式各帧（新对象）uuid 恒定", () => {
    const f1 = frame("assistant", 1000);
    const f2 = frame("assistant", 1000);
    const f3 = frame("assistant", 1000);
    expect(messageUuid(f1, 5)).toBe(messageUuid(f2, 5));
    expect(messageUuid(f2, 5)).toBe(messageUuid(f3, 5));
  });

  it("提交帧与流式帧 uuid 一致（partial 与 final 同 identity）", () => {
    const partial = frame("assistant", 1000);
    const final = frame("assistant", 1000);
    expect(messageUuid(partial, 5)).toBe(messageUuid(final, 5));
  });

  it("index 或 role 或 timestamp 不同则 uuid 不同", () => {
    const msg = frame("assistant", 1000);
    expect(messageUuid(msg, 5)).not.toBe(messageUuid(msg, 6));
    expect(messageUuid(frame("assistant", 1000), 5)).not.toBe(messageUuid(frame("user", 1000), 5));
    expect(messageUuid(frame("assistant", 1000), 5)).not.toBe(messageUuid(frame("assistant", 2000), 5));
  });

  it("timestamp 缺失时以 0 兜底且保持稳定", () => {
    const a = frame("assistant", undefined);
    const b = frame("assistant", undefined);
    expect(messageUuid(a, 3)).toBe(messageUuid(b, 3));
    expect(messageUuid(a, 3)).toBe(`0-assistant-3`);
  });
});
