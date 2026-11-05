import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMemorySystemPromptBlock, buildMemoryTools } from "./runtime-memory-tools.js";
import { createMemoryStore, type MemoryStore } from "./memory-store.js";
import {
  MEMORY_READ_DEFAULT_MAX_CHARS,
  MEMORY_READ_FULL_CAP_CHARS,
  MEMORY_SEARCH_TOTAL_MAX_CHARS,
  MEMORY_SUMMARY_MAX_CHARS
} from "../shared/memory.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Harness {
  store: MemoryStore;
  run: (name: string, params: unknown) => Promise<string>;
}

async function makeHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-memory-tool-v4-"));
  temporaryDirectories.push(directory);
  const store = createMemoryStore(directory, () => {});
  const tools = buildMemoryTools({ store, workspace: "D:\\项目A", enabled: () => true });
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

function sectionedBody(charsPerSection = 900): string {
  const filler = "这一节记录了一条稳定结论，用来模拟真实的项目记忆正文。";
  const block = filler.repeat(Math.ceil(charsPerSection / filler.length));
  return ["## 一、总则", block, "", "## 二、超时口径", "无数据进展的容忍秒数默认 60 秒，不是总时长。", "", "## 三、恢复策略", "超时后先核对远端文件大小。"].join("\n");
}

describe("memory tools v4", () => {
  it("returns full text for a small topic and points+outline for a large one", async () => {
    const harness = await makeHarness();
    await harness.run("memory_write", { topic: "小主题", description: "d", content: "- 中文回复\n- 简洁" });
    const small = await harness.run("memory_read", { topic: "小主题" });
    expect(small).toContain("- 中文回复");

    await harness.run("memory_write", {
      topic: "大主题",
      description: "分节测试",
      content: sectionedBody(2200),
      summary: "总则先读；超时口径 60 秒；恢复先核对大小"
    });
    const large = await harness.run("memory_read", { topic: "大主题" });
    expect(large).toContain("要点：总则先读");
    expect(large).toContain("目录：");
    expect(large).toContain("[2] 二、超时口径");
    expect(large).toContain("按节读取");
    expect(large.length).toBeLessThanOrEqual(MEMORY_READ_DEFAULT_MAX_CHARS);
  });

  it("caps section reads and section=\"*\" with an explicit truncation path", async () => {
    const harness = await makeHarness();
    const huge = ["## 一、总则", "正文".repeat(8000), "", "## 二、尾节", "结尾结论。"].join("\n");
    await harness.run("memory_write", { topic: "巨型主题", description: "d", content: huge });

    const full = await harness.run("memory_read", { topic: "巨型主题", section: "*" });
    expect(full).toContain(`仅返回前 ${MEMORY_READ_FULL_CAP_CHARS.toLocaleString("en-US")} 字`);
    expect(full).toContain("其余用 memory_read(topic, section) 按节读");
    expect(full.length).toBeLessThan(MEMORY_READ_FULL_CAP_CHARS + 500);

    const single = await harness.run("memory_read", { topic: "巨型主题", section: "二" });
    expect(single).toContain("§二、尾节");
    expect(single).toContain("结尾结论");
  });

  it("returns a one-line notice for a repeated read until refresh or content change", async () => {
    const harness = await makeHarness();
    await harness.run("memory_write", { topic: "重复主题", description: "d", content: sectionedBody() });

    await harness.run("memory_read", { topic: "重复主题", section: "二、超时口径" });
    const again = await harness.run("memory_read", { topic: "重复主题", section: "二、超时口径" });
    expect(again).toContain("本会话已读过");
    expect(again).not.toContain("容忍秒数默认 60 秒");

    const refreshed = await harness.run("memory_read", { topic: "重复主题", section: "二、超时口径", refresh: true });
    expect(refreshed).toContain("容忍秒数默认 60 秒");

    await harness.run("memory_append", { topic: "重复主题", section: "二、超时口径", content: "- 新增一条口径" });
    const afterChange = await harness.run("memory_read", { topic: "重复主题", section: "二、超时口径" });
    expect(afterChange).toContain("新增一条口径");
  });

  it("caps search output and reports omitted hits", async () => {
    const harness = await makeHarness();
    for (let index = 0; index < 8; index += 1) {
      await harness.run("memory_write", {
        topic: `检索主题 ${index}`,
        description: "同一关键词",
        content: `## 节\n\n关键词命中 ${index}。`.repeat(40)
      });
    }
    const result = await harness.run("memory_search", { query: "关键词", limit: 10 });
    expect(result.length).toBeLessThanOrEqual(MEMORY_SEARCH_TOTAL_MAX_CHARS + 200);
    expect(result).toContain("另有");
  });

  it("validates layer and normalizes summary/triggers on write", async () => {
    const harness = await makeHarness();
    await expect(harness.run("memory_write", { topic: "坏层", description: "d", content: "x", layer: "nope" })).rejects.toThrow(/layer/);

    const longSummary = "结论".repeat(MEMORY_SUMMARY_MAX_CHARS);
    const written = await harness.run("memory_write", {
      topic: "长要点",
      description: "d",
      content: "正文",
      summary: longSummary,
      triggers: ["一", "二", "三", "四"]
    });
    expect(written).toContain("summary");
    const topic = harness.store.read("长要点")!;
    expect(topic.summary!.length).toBeLessThanOrEqual(MEMORY_SUMMARY_MAX_CHARS);
    expect(topic.triggers).toHaveLength(3);
  });

  it("marks archived topics on read and keeps them searchable", async () => {
    const harness = await makeHarness();
    await harness.run("memory_write", { topic: "历史结论", description: "已解", content: "## 结论\n\n当时选了方案 B。", layer: "archive" });
    const read = await harness.run("memory_read", { topic: "历史结论" });
    expect(read).toContain("已归档");
    const found = await harness.run("memory_search", { query: "方案 B" });
    expect(found).toContain("历史结论");
  });

  it("shows layer labels in list and governance block stays bounded", async () => {
    const harness = await makeHarness();
    await harness.run("memory_write", { topic: "核心主题", description: "d", content: "正文", layer: "core", summary: "要点" });
    await harness.run("memory_write", { topic: "标准主题", description: "d", content: "正文" });
    const list = await harness.run("memory_list", {});
    expect(list).toContain("核心 1 / 标准 1 / 归档 0");
    expect(list).toContain("[核心] 核心主题");

    const block = buildMemorySystemPromptBlock();
    expect(block).toContain("存在性索引");
    expect(block).toContain("无行动不记忆");
    expect(block).toContain("8000");
  });
});
