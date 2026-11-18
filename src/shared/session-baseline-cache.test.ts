import { describe, expect, it } from "vitest";
import { MAX_SESSION_BASELINES, createSessionBaselineCache } from "./session-baseline-cache";

function entry(sessionId: string, revision: number): { sessionId: string; revision: number } {
  return { sessionId, revision };
}

describe("createSessionBaselineCache", () => {
  it("按键命中同一份条目（同引用，不复制基线快照）", () => {
    const cache = createSessionBaselineCache<{ sessionId: string; revision: number }>();
    const first = entry("a", 1);
    cache.set(first);
    expect(cache.get("a")).toBe(first);
    expect(cache.get(undefined)).toBeUndefined();
    expect(cache.get("missing")).toBeUndefined();
  });

  it("超过容量时淘汰**最久未使用**的会话（get 也会刷新使用顺序）", () => {
    const cache = createSessionBaselineCache<{ sessionId: string; revision: number }>(3);
    cache.set(entry("a", 1));
    cache.set(entry("b", 2));
    cache.set(entry("c", 3));
    // 用一次 a：b 变成最久未用。
    expect(cache.get("a")).toBeDefined();
    cache.set(entry("d", 4));
    expect(cache.ids()).toEqual(["c", "a", "d"]);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size).toBe(3);
  });

  it("同名 set 是整体替换且刷新 LRU 位置", () => {
    const cache = createSessionBaselineCache<{ sessionId: string; revision: number }>(2);
    cache.set(entry("a", 1));
    cache.set(entry("b", 2));
    cache.set(entry("a", 9));
    expect(cache.get("a")).toEqual({ sessionId: "a", revision: 9 });
    expect(cache.ids()).toEqual(["b", "a"]);
    cache.set(entry("c", 3));
    // b 成了最久未用，被淘汰。
    expect(cache.get("b")).toBeUndefined();
    expect(cache.ids()).toEqual(["a", "c"]);
  });

  it("delete / clear 释放基线与容量计数", () => {
    const cache = createSessionBaselineCache<{ sessionId: string; revision: number }>(4);
    cache.set(entry("a", 1));
    cache.set(entry("b", 2));
    cache.delete("a");
    cache.delete(undefined);
    expect(cache.ids()).toEqual(["b"]);
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("b")).toBeUndefined();
  });

  it("默认容量是共享常量（三处进程用同一上限）", () => {
    const cache = createSessionBaselineCache<{ sessionId: string; revision: number }>();
    for (let index = 0; index <= MAX_SESSION_BASELINES; index += 1) cache.set(entry(`s${index}`, index));
    expect(cache.size).toBe(MAX_SESSION_BASELINES);
    // 最早写入的 s0 已被淘汰，最后写入的仍在。
    expect(cache.get("s0")).toBeUndefined();
    expect(cache.get(`s${MAX_SESSION_BASELINES}`)).toBeDefined();
  });

  it("容量非正数时退化为 1（绝不出现永淘汰不收敛的循环）", () => {
    const cache = createSessionBaselineCache<{ sessionId: string; revision: number }>(0);
    cache.set(entry("a", 1));
    cache.set(entry("b", 2));
    expect(cache.ids()).toEqual(["b"]);
  });
});
