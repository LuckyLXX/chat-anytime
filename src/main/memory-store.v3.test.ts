import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.js";
import type { MemoryStore } from "./memory-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-memory-v3-"));
  temporaryDirectories.push(dir);
  return { store: createMemoryStore(dir, () => {}), dir };
}

describe("memory store v3", () => {
  it("exposes summaries without content and bumps contentRevision on writes", async () => {
    const { store, dir } = await makeStore();
    const saved = store.save({ title: "摘要主题", description: "d", content: "第一版" });
    const summaries = store.summaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id: saved.id, contentChars: 3, contentRevision: saved.contentRevision });
    expect("content" in summaries[0]!).toBe(false);

    const updated = store.save({ title: "摘要主题", description: "d", content: "第二版更长" });
    expect(updated.contentRevision).not.toBe(saved.contentRevision);
    expect(store.summaries()[0]!.contentChars).toBe(5);
    const raw = await readFile(join(dir, "topics", `${saved.id}.md`), "utf8");
    expect(raw).not.toContain("contentRevision");
    expect(raw).not.toContain("contentChars");
  });

  it("invalidates the parse cache when another store instance writes", async () => {
    const { store, dir } = await makeStore();
    store.save({ title: "缓存主题", description: "d", content: "旧内容" });
    const other = createMemoryStore(dir, () => {});
    other.save({ title: "缓存主题", description: "d", content: "新内容更长一些" });
    expect(store.read("缓存主题")?.content).toBe("新内容更长一些");
    expect(store.summaries()[0]!.contentChars).toBe(7);
  });

  it("appends to a section without rewriting the rest and updates the revision", async () => {
    const { store } = await makeStore();
    store.save({
      title: "追加主题",
      description: "d",
      content: ["## 一、A", "正文 A", "", "## 二、B", "正文 B"].join("\n")
    });
    const before = store.read("追加主题")!;
    const outcome = store.append({ topic: "追加主题", section: "一", content: "- 新增一条" });
    expect(outcome.created).toBe(false);
    expect(outcome.label).toBe("一、A");
    expect(outcome.addedChars).toBeGreaterThan(0);
    expect(outcome.topic.content).toContain("正文 A\n\n- 新增一条\n\n## 二、B");
    expect(outcome.topic.contentRevision).not.toBe(before.contentRevision);
    expect(outcome.topic.title).toBe("追加主题");
    expect(outcome.topic.description).toBe("d");
  });

  it("creates a new section on append when the selector is a new heading", async () => {
    const { store } = await makeStore();
    store.save({ title: "新节主题", description: "d", content: "## 一、A\n正文" });
    const outcome = store.append({ topic: "新节主题", section: "二、B", content: "新节正文" });
    expect(outcome.created).toBe(true);
    expect(outcome.topic.content).toContain("## 二、B\n\n新节正文");
    expect(() => store.append({ topic: "新节主题", section: "9", content: "x" })).toThrow("没有找到");
    expect(() => store.append({ topic: "不存在", content: "x" })).toThrow("未找到");
  });

  it("searches sections with Chinese bigrams, section labels and topic filtering", async () => {
    const { store } = await makeStore();
    store.save({
      title: "SFTP 传输",
      description: "超时口径与丢块",
      content: ["## 一、总则", "普通说明", "", "## 二、无数据进展", "无数据进展的容忍秒数默认 60 秒，不是总时长。"].join("\n")
    });
    store.save({ title: "发布流程", description: "发版", content: ["## 步骤", "先跑测试"].join("\n") });

    const hits = store.search("无数据进展");
    expect(hits[0]!.topic.title).toBe("SFTP 传输");
    expect(hits[0]!.section).toContain("无数据进展");
    expect(hits[0]!.snippet).toContain("容忍秒数");

    const filtered = store.search("流程", undefined, { topic: "发布流程" });
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((hit) => hit.topic.title === "发布流程")).toBe(true);
    expect(store.search("无数据进展", undefined, { limit: 1 })).toHaveLength(1);
    expect(store.search("完全不存在的关键词组合")).toEqual([]);
  });

  it("does not return hits for a long query that only touches common bigrams", async () => {
    const { store } = await makeStore();
    store.save({ title: "常见词", description: "d", content: "这个存在关联的关键说明，存在与关键都在。" });
    expect(store.search("绝对不存在的关键词")).toEqual([]);
  });

  it("keeps the snapshot within a budget and reports omitted topics", async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 40; index += 1) {
      store.save({
        title: `主题 ${String(index).padStart(2, "0")}`,
        description: "这是一个用于预算测试的比较长的索引描述，用来把快照撑大",
        content: `正文 ${index}`
      });
    }
    const snapshot = store.snapshotMarkdown(undefined, 600);
    expect(snapshot.length).toBeLessThanOrEqual(600);
    expect(snapshot).toContain("未列出");
    expect(snapshot).toContain("memory_search");
    expect(snapshot).not.toContain("# 长期记忆索引");
    expect(store.indexMarkdown()).toContain("主题 39");
  });

  it("recovers a stale write lock and removes the lock after a write", async () => {
    const { store, dir } = await makeStore();
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, ".write.lock");
    writeFileSync(lock, "stale", "utf8");
    const old = new Date(Date.now() - 30_000);
    utimesSync(lock, old, old);
    store.save({ title: "锁测试", description: "d", content: "x" });
    expect(existsSync(lock)).toBe(false);
    expect(store.read("锁测试")?.content).toBe("x");
  });
});
