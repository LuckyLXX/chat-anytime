import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "./memory-store.js";
import { MEMORY_SNAPSHOT_CORE_CHARS } from "../shared/memory.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-memory-v4-"));
  temporaryDirectories.push(dir);
  return { store: createMemoryStore(dir, () => {}), dir };
}

function topicFile(id: string, body: { title: string; description?: string; layer?: string; summary?: string; triggers?: string; updatedAt?: string; content: string }): string {
  return [
    "---",
    `title: ${body.title}`,
    `description: ${body.description ?? "一句话描述"}`,
    ...(body.layer ? [`layer: ${body.layer}`] : []),
    ...(body.summary ? [`summary: ${body.summary}`] : []),
    ...(body.triggers ? [`triggers: ${body.triggers}`] : []),
    `createdAt: ${body.updatedAt ?? "2026-11-01"}`,
    `updatedAt: ${body.updatedAt ?? "2026-11-01"}`,
    "---",
    "",
    body.content,
    ""
  ].join("\n");
}

describe("memory store v4", () => {
  it("round-trips layer / summary / triggers and defaults missing layer to standard", async () => {
    const { store, dir } = await makeStore();
    store.save({
      title: "用户偏好",
      description: "语言与风格",
      content: "## 偏好\n\n- 中文回复",
      layer: "core",
      summary: "中文回复\n先给结论再展开",
      triggers: ["B站", "  B站 ", "账号"]
    });

    const topic = store.read("用户偏好")!;
    expect(topic.layer).toBe("core");
    expect(topic.summary).toBe("中文回复 · 先给结论再展开");
    expect(topic.triggers).toEqual(["B站", "账号"]);

    const summary = store.summaries().find((item) => item.title === "用户偏好")!;
    expect(summary.layer).toBe("core");
    expect(summary.summaryChars).toBeGreaterThan(0);
    expect(summary.summaryPreview).toContain("中文回复");

    const raw = await import("node:fs/promises").then((module) => module.readFile(join(dir, "topics", `${summary.id}.md`), "utf8"));
    expect(raw).toContain("layer: core");
    expect(raw).toContain("summary: 中文回复 · 先给结论再展开");
    expect(raw).toContain("triggers: B站, 账号");

    store.save({ title: "旧主题", description: "d", content: "正文" });
    expect(store.read("旧主题")!.layer).toBe("standard");
  });

  it("renders a tiered snapshot: core points, standard title + hint, archive count only", async () => {
    const { store } = await makeStore();
    store.save({
      title: "用户偏好",
      description: "语言与风格",
      content: "## 偏好\n\n- 中文回复",
      layer: "core",
      summary: "中文回复 · 先给结论再展开"
    });
    store.save({ title: "PiDesktop 踩坑记录", description: "回归与坑", content: "正文" });
    store.save({ title: "黑鱼河的口味", description: "B站账号与关注词", content: "正文", triggers: ["B站", "账号"] });
    store.save({ title: "PiDesktop 归档记忆", description: "历史细节", content: "正文", layer: "archive" });

    const snapshot = store.snapshotMarkdown(undefined, 2000);
    expect(snapshot).toContain("[核心 · 每会话在场]");
    expect(snapshot).toContain("- 用户偏好 — 中文回复 · 先给结论再展开");
    expect(snapshot).toContain("[项目知识]");
    expect(snapshot).toContain("- 黑鱼河的口味（B站/账号）");
    expect(snapshot).toContain("[归档] 1 个");
    expect(snapshot).not.toContain("PiDesktop 归档记忆");
  });

  it("keeps the core line within budget and degrades huge topics to a title-only line", async () => {
    const { store } = await makeStore();
    store.save({
      title: "核心主题",
      description: "d",
      content: "正文",
      layer: "core",
      summary: "要点".repeat(200)
    });
    store.save({ title: "巨无霸", description: "很长的描述".repeat(20), content: "x".repeat(13_000), layer: "standard" });

    const snapshot = store.snapshotMarkdown(undefined, 2000);
    const coreLine = snapshot.split("\n").find((line) => line.startsWith("- 核心主题"))!;
    expect(coreLine.length).toBeLessThanOrEqual(MEMORY_SNAPSHOT_CORE_CHARS + 20);
    expect(snapshot).toContain("- 巨无霸");
    expect(snapshot.split("\n").find((line) => line.startsWith("- 巨无霸"))!.length).toBeLessThan(30);
  });

  it("exposes the injected index as structured entries (placed / chars / compacted / omitted)", async () => {
    const { store } = await makeStore();
    store.save({ title: "用户偏好", description: "语言", content: "## 偏好\n\n- 中文回复", layer: "core", summary: "中文回复 · 先给结论" });
    store.save({ title: "踩坑记录", description: "回归与坑", content: "正文" });
    store.save({ title: "有触发词", description: "d", content: "正文", triggers: ["B站"] });
    store.save({ title: "归档结论", description: "d", content: "正文", layer: "archive" });

    const snapshot = store.snapshotDetailed(undefined, 2000);
    // 文本与结构化投影同源：markdown 必须与 snapshotMarkdown 逐字节一致。
    expect(snapshot.markdown).toBe(store.snapshotMarkdown(undefined, 2000));
    expect(snapshot.characters).toBe(snapshot.markdown.length);
    const entries = new Map(snapshot.entries.map((entry) => [entry.title, entry]));
    expect(entries.get("用户偏好")).toMatchObject({ layer: "core", placed: true, omitted: false });
    expect(entries.get("用户偏好")!.chars).toBeGreaterThan(0);
    expect(entries.get("踩坑记录")).toMatchObject({ layer: "standard", placed: true, compacted: false });
    expect(entries.get("有触发词")).toMatchObject({ placed: true });
    expect(entries.get("归档结论")).toMatchObject({ layer: "archive", placed: false, omitted: false });
    const sum = snapshot.entries.reduce((total, entry) => total + entry.chars, 0);
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThan(snapshot.characters);
  });

  it("marks standard topics omitted when the budget is tight and core topics compacted", async () => {
    const { store } = await makeStore();
    for (let index = 0; index < 12; index += 1) {
      store.save({ title: `主题${index}`, description: "描述".repeat(8), content: "正文" });
    }
    store.save({ title: "核心", description: "d", content: "正文", layer: "core", summary: "要点".repeat(100) });

    const snapshot = store.snapshotDetailed(undefined, 200);
    expect(snapshot.compacted).toBe(true);
    expect(snapshot.omitted).toBeGreaterThan(0);
    const omitted = snapshot.entries.filter((entry) => entry.omitted);
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every((entry) => entry.layer === "standard" && !entry.placed && entry.chars === 0)).toBe(true);
    expect(snapshot.entries.find((entry) => entry.title === "核心")).toMatchObject({ placed: true, compacted: true });
  });

  it("updates meta fields without rewriting the body", async () => {
    const { store } = await makeStore();
    store.save({ title: "主题", description: "d", content: "## 节\n\n正文" });
    const updated = store.update("主题", { layer: "archive", summary: "要点 A" });
    expect(updated.layer).toBe("archive");
    expect(updated.summary).toBe("要点 A");
    expect(updated.content).toBe("## 节\n\n正文");
    expect(() => store.update("不存在", { layer: "core" })).toThrow(/未找到记忆主题/);
  });

  it("finds topics by trigger words", async () => {
    const { store } = await makeStore();
    store.save({
      title: "黑鱼河的口味",
      description: "账号与关注词",
      content: "## 设置\n\n关注 AI 生图。",
      triggers: ["B站"]
    });

    const byTrigger = store.search("B站");
    expect(byTrigger[0]?.topic.title).toBe("黑鱼河的口味");
  });

  it("prefers recently updated topics when relevance is equal", async () => {
    const { store, dir } = await makeStore();
    await mkdir(join(dir, "topics"), { recursive: true });
    // 直接落盘构造「旧主题」：save 总是把 updatedAt 写成今天，验证不了新近度。
    await writeFile(join(dir, "topics", "old.md"), topicFile("old", {
      title: "旧主题",
      description: "无关键词",
      updatedAt: "2026-06-01",
      content: "## 节\n\n容忍秒数 60 秒。"
    }), "utf8");
    store.save({ title: "新主题", description: "无关键词", content: "## 节\n\n容忍秒数 60 秒。" });

    const hits = store.search("容忍秒数");
    expect(hits.length).toBeGreaterThan(1);
    expect(hits[0]!.topic.title).toBe("新主题");
  });

  it("still finds archived topics through search", async () => {
    const { store } = await makeStore();
    store.save({ title: "归档主题", description: "历史结论", content: "## 结论\n\n当时选了方案 B。", layer: "archive" });
    const hits = store.search("方案 B");
    expect(hits.some((hit) => hit.topic.title === "归档主题")).toBe(true);
  });
});
