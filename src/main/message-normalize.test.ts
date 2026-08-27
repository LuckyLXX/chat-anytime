import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeMessages, resetNormalizeCacheForTest } from "./message-normalize.js";

function user(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: text, timestamp } as unknown as AgentMessage;
}

function assistant(text: string, timestamp: number): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp } as unknown as AgentMessage;
}

describe("normalizeMessages 身份缓存", () => {
  beforeEach(() => {
    resetNormalizeCacheForTest();
  });

  it("同一消息对象二次归一化复用 ChatMessage 引用（快照热路径不再重复解析）", () => {
    const committed = [user("你好", 1), assistant("在", 2)];
    const first = normalizeMessages(committed);
    const second = normalizeMessages(committed);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("流式消息对象不缓存：每帧重算（内容在增长）", () => {
    const committed = user("问", 1);
    const streaming = assistant("正在输出", 3);
    const first = normalizeMessages([committed], streaming);
    const second = normalizeMessages([committed], streaming);
    expect(second[0]).toBe(first[0]); // committed 部分命中
    expect(second[1]).not.toBe(first[1]); // streaming 部分重算
    expect(second[1]?.streaming).toBe(true);
  });

  it("regenerate 截断/压缩重排导致 index 位移时，幸存消息重算（uuid 跟随 index）", () => {
    const early = user("第一条", 1);
    const late = assistant("第二条", 2);
    const before = normalizeMessages([early, late]);
    // 压缩移除了 early，late 的 index 从 1 变 0。
    const after = normalizeMessages([late]);
    expect(after[0]).not.toBe(before[1]);
    expect(after[0]?.uuid).toBe(`${2}-assistant-0`);
  });

  it("visible 序列中 role/display 过滤参与 index 计算（custom 非 display 不占位）", () => {
    const hiddenCustom = { role: "custom", customType: "audit", content: "x", display: false, timestamp: 5 } as unknown as AgentMessage;
    const visibleCustom = { role: "custom", customType: "progress", content: "y", display: true, timestamp: 6 } as unknown as AgentMessage;
    const result = normalizeMessages([user("问", 1), hiddenCustom, visibleCustom]);
    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("extension");
    expect(result[1]?.uuid).toBe(`${6}-custom-1`); // hidden custom 不占 index
  });

  it("归一化行为回归：文本块、streaming 标志、错误透出", () => {
    const failing = { role: "assistant", content: [{ type: "text", text: "半截" }], timestamp: 9, errorMessage: "超时" } as unknown as AgentMessage;
    const result = normalizeMessages([failing]);
    expect(result[0]?.blocks).toEqual([{ type: "text", text: "半截" }]);
    expect(result[0]?.error).toBe("超时");
    expect(result[0]?.streaming).toBe(false);
  });
});
