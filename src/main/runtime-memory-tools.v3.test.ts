import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMemorySnapshotBlock, buildMemorySystemPromptBlock, buildMemoryTools } from "./runtime-memory-tools.js";
import { createMemoryStore } from "./memory-store.js";
import type { MemoryStore } from "./memory-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Harness {
  store: MemoryStore;
  run: (name: string, params: unknown) => Promise<string>;
}

async function makeHarness(workspace: string | undefined = "D:\\项目A"): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-memory-tool-v3-"));
  temporaryDirectories.push(directory);
  const store = createMemoryStore(directory, () => {});
  const tools = buildMemoryTools({ store, workspace, enabled: () => true });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    store,
    run: async (name, params) => {
      const tool = byName.get(name);
      if (typeof tool?.execute !== "function") throw new Error(`tool ${name} has no execute`);
      const execute = tool.execute as unknown as (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: undefined) => Promise<{ content: { type: string; text?: string }[] }>;
      const result = await execute(`call-${name}`, params, undefined, undefined, undefined);
      return result.content.map((part) => part.text ?? "").join("\n");
    }
  };
}

function largeTopicBody(): string {
  return [
    "## 一、总则",
    "总则说明。".repeat(1500),
    "",
    "## 二、超时口径",
    "无数据进展的容忍秒数默认 60 秒，不是总时长。",
    "",
    "## 三、恢复策略",
    "超时后先核对远端文件大小。"
  ].join("\n");
}

describe("memory tools v3", () => {
  it("returns an outline for a large topic, a single section on demand, and full text only with *", async () => {
    const harness = await makeHarness();
    await harness.run("memory_write", { topic: "大主题", description: "分节测试", content: largeTopicBody() });

    const outline = await harness.run("memory_read", { topic: "大主题" });
    expect(outline).toContain("按节读取");
    expect(outline).toContain("[1] 一、总则 · 片段 1");
    expect(outline).toContain("[3] 二、超时口径");
    expect(outline).toContain('section="*"');
    expect(outline.length).toBeLessThan(1500);

    const section = await harness.run("memory_read", { topic: "大主题", section: "二" });
    expect(section).toContain("§二、超时口径");
    expect(section).toContain("无数据进展的容忍秒数");
    expect(section).not.toContain("恢复策略");

    const full = await harness.run("memory_read", { topic: "大主题", section: "*" });
    expect(full).toContain("总则说明。总则说明。");
    expect(full).toContain("恢复策略");
  });

  it("appends by section without rewriting the topic and reports the new size", async () => {
    const harness = await makeHarness();
    await harness.run("memory_write", { topic: "追加主题", description: "d", content: largeTopicBody() });

    const appended = await harness.run("memory_append", { topic: "追加主题", section: "二、超时口径", content: "- 新增：idle 预算不是总时长" });
    expect(appended).toContain("已追加到「追加主题」§二、超时口径");
    expect(appended).toContain("+");
    expect(appended).toContain("主题现");

    const section = await harness.run("memory_read", { topic: "追加主题", section: "二、超时口径" });
    expect(section).toContain("idle 预算不是总时长");
    expect(section).toContain("容忍秒数");

    const created = await harness.run("memory_append", { topic: "追加主题", section: "四、新节", content: "新节正文" });
    expect(created).toContain("已新建节并追加到");
    expect(await harness.run("memory_read", { topic: "追加主题", section: "四、新节" })).toContain("新节正文");
  });

  it("searches and returns section labels and snippets", async () => {
    const harness = await makeHarness();
    await harness.run("memory_write", { topic: "检索主题", description: "d", content: largeTopicBody() });
    const result = await harness.run("memory_search", { query: "容忍秒数", limit: 3 });
    expect(result).toContain("§二、超时口径");
    expect(result).toContain("无数据进展");
    expect(result).toContain("memory_read(topic=");
    expect(await harness.run("memory_search", { query: "绝对不存在的词" })).toContain("未检索到");
  });

  it("paginates the list and shows sizes", async () => {
    const harness = await makeHarness();
    for (const title of ["主题 A", "主题 B", "主题 C"]) {
      await harness.run("memory_write", { topic: title, description: "d", content: "正文" });
    }
    const first = await harness.run("memory_list", { limit: 1 });
    expect(first).toContain("可见 3 个主题");
    expect(first).toContain("主题 A");
    expect(first).not.toContain("主题 C");
    expect(first).toContain("字");
    const second = await harness.run("memory_list", { limit: 1, offset: 1 });
    expect(second).toContain("主题 B");
  });

  it("keeps the governance block explicit about append and section reads", () => {
    const block = buildMemorySystemPromptBlock();
    expect(block).toContain("memory_append");
    expect(block).toContain('section="*"');
    expect(block).toContain("6000");
    expect(block).toContain("不需要先读全文");
    expect(buildMemorySnapshotBlock("## 全局\n- 主题 — 描述")).toContain("memory_search");
  });
});
