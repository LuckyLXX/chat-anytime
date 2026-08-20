import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.js";
import type { MemoryStore } from "./memory-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStore(): Promise<{ store: MemoryStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-memory-"));
  temporaryDirectories.push(dir);
  return { store: createMemoryStore(dir, () => {}), dir };
}

describe("memory store", () => {
  it("round-trips a topic and persists across store instances", async () => {
    const { store, dir } = await makeStore();
    const saved = store.save({ title: "用户偏好", description: "语言与风格偏好", content: "- 回复用中文\n- 简洁" });
    expect(saved.id).toBe("用户偏好");
    expect(store.list().map((topic) => topic.title)).toEqual(["用户偏好"]);

    const reopened = createMemoryStore(dir, () => {});
    expect(reopened.read("用户偏好")?.content).toBe("- 回复用中文\n- 简洁");
  });

  it("upserts by title (case-insensitive) keeping id/createdAt and workspace binding", async () => {
    const { store } = await makeStore();
    const first = store.save({ title: "PiDesktop 协作", description: "d1", content: "v1", bindWorkspace: "D:\\Utools插件\\PiDesktop" });
    const second = store.save({ title: "pidesktop 协作", description: "d2", content: "v2" });
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.workspace).toBe("D:\\Utools插件\\PiDesktop"); // bindWorkspace 缺省保留既有绑定
    expect(store.list()).toHaveLength(1);
    expect(store.read("PiDesktop 协作")?.content).toBe("v2");

    const rebound = store.save({ title: "PiDesktop 协作", description: "d3", content: "v3", bindWorkspace: "D:\\别的项目" });
    expect(rebound.workspace).toBe("D:\\别的项目");
  });

  it("sanitizes filenames: separators and traversal never escape the topics dir", async () => {
    const { store, dir } = await makeStore();
    const saved = store.save({ title: "a../../b\\c:*?", description: "危险标题", content: "x" });
    expect(saved.id).toMatch(/^[^\\/]+$/u);
    const files = await readdir(join(dir, "topics"));
    expect(files.every((name) => !name.includes("..") && !name.includes("\\") && !name.includes("/"))).toBe(true);
  });

  it("dedupes slug collisions between distinct titles", async () => {
    const { store } = await makeStore();
    const slash = store.save({ title: "a/b", description: "d", content: "x" });
    const space = store.save({ title: "a b", description: "d", content: "y" });
    expect(slash.id).toBe("a-b");
    expect(space.id).toBe("a-b-2");
    expect(store.list()).toHaveLength(2);
  });

  it("rejects empty title, description, or content", async () => {
    const { store } = await makeStore();
    expect(() => store.save({ title: "  ", description: "d", content: "x" })).toThrow();
    expect(() => store.save({ title: "t", description: "", content: "x" })).toThrow();
    expect(() => store.save({ title: "t", description: "d", content: " \n " })).toThrow();
  });

  it("derives the index with workspace filtering and regenerates MEMORY.md on disk", async () => {
    const { store, dir } = await makeStore();
    store.save({ title: "全局偏好", description: "全局", content: "x" });
    store.save({ title: "项目A约定", description: "A", content: "x", bindWorkspace: "D:\\项目A" });
    store.save({ title: "项目B约定", description: "B", content: "x", bindWorkspace: "D:\\项目B" });

    const inA = store.indexMarkdown("D:\\项目A");
    expect(inA).toContain("全局偏好");
    expect(inA).toContain("项目A约定");
    expect(inA).not.toContain("项目B约定");
    expect(inA).toContain("## 全局");
    expect(inA).toContain("## 工作区：D:\\项目A");

    // 无工作区会话只看得到全局主题。
    expect(store.indexMarkdown()).not.toContain("项目A约定");

    // 磁盘 MEMORY.md 是全量索引（供人浏览），每次变更后再生。
    const indexFile = await readFile(join(dir, "MEMORY.md"), "utf8");
    expect(indexFile).toContain("项目A约定");
    expect(indexFile).toContain("项目B约定");
  });

  it("returns an empty index when nothing is visible", async () => {
    const { store } = await makeStore();
    expect(store.indexMarkdown("D:\\任意")).toBe("");
    expect(store.indexMarkdown()).toBe("");
  });

  it("skips corrupt topic files and keeps the rest of the library readable", async () => {
    const { store, dir } = await makeStore();
    store.save({ title: "完好主题", description: "d", content: "x" });
    await writeFile(join(dir, "topics", "broken.md"), "no frontmatter at all", "utf8");
    expect(store.list().map((topic) => topic.title)).toEqual(["完好主题"]);
    // 写入继续可用，坏文件不阻塞。
    store.save({ title: "新增主题", description: "d", content: "x" });
    expect(store.list()).toHaveLength(2);
  });

  it("removes by title or id and reports misses", async () => {
    const { store } = await makeStore();
    store.save({ title: "待删", description: "d", content: "x" });
    expect(store.remove("不存在的主题")).toBe(false);
    expect(store.remove("待删")).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("searches with title-first ranking, snippets, and workspace visibility", async () => {
    const { store } = await makeStore();
    store.save({ title: "pnpm 工作流", description: "包管理器", content: "全库执行 pnpm install 而不是 npm" });
    store.save({ title: "发布流程", description: "pnpm publish", content: "常规发布步骤" });
    store.save({ title: "隔离主题", description: "别的项目", content: "pnpm 字样也出现", bindWorkspace: "D:\\项目B" });

    const hits = store.search("pnpm", "D:\\项目A");
    expect(hits.map((hit) => hit.topic.title)).toEqual(["pnpm 工作流", "发布流程"]); // 工作区隔离的第三条不可见
    expect(hits[0]!.snippet).toContain("pnpm install");

    expect(store.search("", "D:\\项目A")).toEqual([]);
    expect(store.search("不存在关键词", "D:\\项目A")).toEqual([]);
  });
});
