import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMemorySnapshotBlock, buildMemorySystemPromptBlock, buildMemoryTools } from "./runtime-memory-tools.js";
import { createMemoryStore } from "./memory-store.js";
import type { MemoryStore, MemorySaveInput } from "./memory-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Harness {
  store: MemoryStore;
  tools: ReturnType<typeof buildMemoryTools>;
  run: (name: string, params: unknown) => Promise<string>;
  changes: () => number;
}

async function makeHarness(options: { workspace?: string; enabled?: boolean } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-memory-tool-"));
  temporaryDirectories.push(directory);
  let changes = 0;
  const store = createMemoryStore(directory, () => { changes += 1; });
  const tools = buildMemoryTools({
    store,
    workspace: options.workspace,
    enabled: () => options.enabled ?? true
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    store,
    tools,
    run: async (name, params) => {
      const tool = byName.get(name);
      if (typeof tool?.execute !== "function") throw new Error(`tool ${name} has no execute`);
      const execute = tool.execute as unknown as (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: undefined) => Promise<{ content: { type: string; text?: string }[] }>;
      const result = await execute(`call-${name}`, params, undefined, undefined, undefined);
      return result.content.map((part) => part.text ?? "").join("\n");
    },
    changes: () => changes
  };
}

describe("memory tools", () => {
  it("walks write → read → list → search → delete with compact results", async () => {
    const harness = await makeHarness({ workspace: "D:\\项目A" });
    const writeInput: MemorySaveInput = { title: "用户偏好", description: "语言与风格", content: "- 中文回复\n- 简洁" };

    const written = await harness.run("memory_write", { topic: "用户偏好", description: "语言与风格", content: "- 中文回复\n- 简洁" });
    expect(written).toContain("已保存记忆主题「用户偏好」（全局）");
    expect(written).toContain("- 用户偏好 — 语言与风格");
    expect(written).toContain("当前共 1 个主题");
    expect(harness.changes()).toBe(1);
    void writeInput;

    const read = await harness.run("memory_read", { topic: "用户偏好" });
    expect(read).toContain("- 中文回复");

    const list = await harness.run("memory_list", {});
    expect(list).toContain("用户偏好 — 语言与风格（全局");

    const search = await harness.run("memory_search", { query: "中文" });
    expect(search).toContain("用户偏好");

    const deleted = await harness.run("memory_delete", { topic: "用户偏好" });
    expect(deleted).toContain("已删除记忆主题「用户偏好」");
    expect(harness.store.list()).toHaveLength(0);
    expect(harness.changes()).toBe(2); // 只有写/删触发广播，读取不触发
  });

  it("isolates workspace-bound topics from other workspace sessions", async () => {
    const projectA = await makeHarness({ workspace: "D:\\项目A" });
    await projectA.run("memory_write", { topic: "项目A约定", description: "构建命令", content: "用 pnpm build", workspace_scoped: true });
    expect(projectA.store.list()[0]!.workspace).toBe("D:\\项目A");
    expect(await projectA.run("memory_list", {})).toContain("项目A约定");

    const projectB = await makeHarness({ workspace: "D:\\项目B" });
    expect(await projectB.run("memory_list", {})).toContain("没有可见的记忆主题");
    await expect(projectB.run("memory_read", { topic: "项目A约定" })).rejects.toThrow("未找到");
    expect(await projectB.run("memory_search", { query: "pnpm" })).toContain("未检索到");
    await expect(projectB.run("memory_delete", { topic: "项目A约定" })).rejects.toThrow("未找到");
    expect(projectA.store.list()).toHaveLength(1); // 隔离会话删不掉
  });

  it("rejects workspace binding when the session has no workspace", async () => {
    const harness = await makeHarness({ workspace: undefined });
    await expect(harness.run("memory_write", { topic: "t", description: "d", content: "x", workspace_scoped: true })).rejects.toThrow("未打开工作区");
  });

  it("returns a disabled reply for every tool without touching the store", async () => {
    const harness = await makeHarness({ enabled: false });
    for (const [name, params] of [
      ["memory_write", { topic: "t", description: "d", content: "x" }],
      ["memory_read", { topic: "t" }],
      ["memory_list", {}],
      ["memory_search", { query: "t" }],
      ["memory_delete", { topic: "t" }]
    ] as const) {
      expect(await harness.run(name, params)).toContain("已停用");
    }
    expect(harness.store.list()).toHaveLength(0);
    expect(harness.changes()).toBe(0);
  });

  it("throws on unknown topics for read and delete", async () => {
    const harness = await makeHarness();
    await expect(harness.run("memory_read", { topic: "不存在" })).rejects.toThrow("未找到");
    await expect(harness.run("memory_delete", { topic: "不存在" })).rejects.toThrow("未找到");
  });
});

describe("memory prompt blocks", () => {
  it("governance block covers what to save, what to skip, and confirmation boundaries", () => {
    const block = buildMemorySystemPromptBlock();
    expect(block).toContain("何时记");
    expect(block).toContain("何时不记");
    expect(block).toContain("todo_write");
    expect(block).toContain("确认边界");
    expect(block).toContain("memory_read");
  });

  it("snapshot block is undefined for an empty library and truncates beyond 40 lines", () => {
    expect(buildMemorySnapshotBlock("")).toBeUndefined();
    expect(buildMemorySnapshotBlock("   \n ")).toBeUndefined();

    const normal = buildMemorySnapshotBlock("## 全局\n- 用户偏好 — 语言");
    expect(normal).toContain("【长期记忆索引】");
    expect(normal).toContain("- 用户偏好 — 语言");

    const longIndex = ["## 全局", ...Array.from({ length: 50 }, (_, index) => `- 主题${index} — 描述`)].join("\n");
    const truncated = buildMemorySnapshotBlock(longIndex)!;
    expect(truncated.split("\n").length).toBeLessThan(longIndex.split("\n").length);
    expect(truncated).toContain("仅显示前 40 行");
    expect(truncated).not.toContain("- 主题45 —");
  });
});
