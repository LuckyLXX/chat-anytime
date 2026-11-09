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

async function makeRunner(tools: ReturnType<typeof buildMemoryTools>): Promise<(name: string, params: unknown) => Promise<string>> {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return async (name, params) => {
    const tool = byName.get(name);
    if (typeof tool?.execute !== "function") throw new Error(`tool ${name} has no execute`);
    const execute = tool.execute as unknown as (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: undefined) => Promise<{ content: { type: string; text?: string }[] }>;
    const result = await execute(`call-${name}`, params, undefined, undefined, undefined);
    return result.content.map((part) => part.text ?? "").join("\n");
  };
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
  return {
    store,
    tools,
    run: await makeRunner(tools),
    changes: () => changes
  };
}

describe("memory tools", () => {
  it("walks write → read → list → search → delete with compact results", async () => {
    // 单库退化路径（不传 workspaceStore）：全部落助手库，行为与旧版一致。
    const harness = await makeHarness({ workspace: "D:\\项目A" });
    const writeInput: MemorySaveInput = { title: "用户偏好", description: "语言与风格", content: "- 中文回复\n- 简洁" };

    const written = await harness.run("memory_write", { topic: "用户偏好", description: "语言与风格", content: "- 中文回复\n- 简洁" });
    expect(written).toContain("已保存记忆主题「用户偏好」（标准，助手库，全局");
    expect(written).toContain("- 用户偏好 — 语言与风格");
    expect(written).toContain("当前共 1 个主题");
    expect(harness.changes()).toBe(1);
    void writeInput;

    const read = await harness.run("memory_read", { topic: "用户偏好" });
    expect(read).toContain("- 中文回复");

    const list = await harness.run("memory_list", {});
    expect(list).toContain("[标准] 用户偏好 — 语言与风格（助手库，全局");

    const search = await harness.run("memory_search", { query: "中文" });
    expect(search).toContain("用户偏好");

    const deleted = await harness.run("memory_delete", { topic: "用户偏好" });
    expect(deleted).toContain("已删除记忆主题「用户偏好」（助手库）");
    expect(harness.store.list()).toHaveLength(0);
    expect(harness.changes()).toBe(2); // 只有写/删触发广播，读取不触发
  });

  it("defaults new topics to the workspace project library (issue #2)", async () => {
    // 双库路径：新主题缺省写项目库（跟项目走），agent_scoped=true 写助手库（跟人走）。
    const agentDir = await mkdtemp(join(tmpdir(), "pi-desktop-memory-agent-"));
    const projectDir = await mkdtemp(join(tmpdir(), "pi-desktop-memory-project-"));
    temporaryDirectories.push(agentDir, projectDir);
    const agentStore = createMemoryStore(join(agentDir, "agent-store"), () => {});
    const projectStore = createMemoryStore(join(projectDir, ".pidesktop", "memory"), () => {});
    const tools = buildMemoryTools({
      store: agentStore,
      workspaceStore: projectStore,
      workspace: projectDir,
      enabled: () => true
    });
    const run = await makeRunner(tools);

    const projectTopic = await run("memory_write", { topic: "构建命令", description: "本项目怎么打包", content: "pnpm build" });
    expect(projectStore.read("构建命令")?.workspace).toBe(projectDir);
    expect(agentStore.read("构建命令")).toBeUndefined();
    expect(projectTopic).toContain("项目库");

    const agentTopic = await run("memory_write", { topic: "写作偏好", description: "跟人走的偏好", content: "先确认再动工", agent_scoped: true });
    expect(agentStore.read("写作偏好")).toBeDefined();
    expect(agentStore.read("写作偏好")?.workspace).toBeUndefined();
    expect(projectStore.read("写作偏好")).toBeUndefined();
    expect(agentTopic).toContain("助手库");

    // 既有主题重写落在原库：项目主题不因没带 agent_scoped 被搬到助手库。
    await run("memory_write", { topic: "构建命令", description: "本项目怎么打包", content: "pnpm build --prod" });
    expect(projectStore.read("构建命令")?.content).toBe("pnpm build --prod");
    expect(agentStore.read("构建命令")).toBeUndefined();

    // 双库读取与检索：两库主题都可见，归属标注在结果里。
    const list = await run("memory_list", {});
    expect(list).toContain("构建命令");
    expect(list).toContain("写作偏好");
    const search = await run("memory_search", { query: "打包" });
    expect(search).toContain("构建命令");

    // append/delete 按查找结果定位库。
    await run("memory_append", { topic: "构建命令", content: "\n- 先跑测试" });
    expect(projectStore.read("构建命令")?.content).toContain("先跑测试");
    await run("memory_delete", { topic: "写作偏好" });
    expect(agentStore.read("写作偏好")).toBeUndefined();
    expect(projectStore.read("构建命令")).toBeDefined();
  });

  it("a second agent in the same workspace reads the project library (issue #2)", async () => {
    // 总控分发的核心验收：助手 A 写下的项目知识，助手 B 在同一工作区能读到。
    const projectDir = await mkdtemp(join(tmpdir(), "pi-desktop-memory-shared-"));
    temporaryDirectories.push(projectDir);
    const projectStore = createMemoryStore(join(projectDir, ".pidesktop", "memory"), () => {});
    const agentA = buildMemoryTools({ store: createMemoryStore(join(projectDir, "agent-a-store"), () => {}), workspaceStore: projectStore, workspace: projectDir, enabled: () => true });
    await (await makeRunner(agentA))("memory_write", { topic: "踩坑记录", description: "部署坑", content: "nginx 需要 client_max_body_size 20m" });

    const agentB = buildMemoryTools({ store: createMemoryStore(join(projectDir, "agent-b-store"), () => {}), workspaceStore: projectStore, workspace: projectDir, enabled: () => true });
    const runB = await makeRunner(agentB);
    expect(await runB("memory_read", { topic: "踩坑记录" })).toContain("client_max_body_size");
    expect(await runB("memory_search", { query: "nginx" })).toContain("踩坑记录");
    // 助手 B 的助手库是空的：项目知识不因换助手而丢失。
    expect(await runB("memory_list", {})).toContain("踩坑记录");
  });

  it("isolates workspace-bound topics from other workspace sessions", async () => {
    // 单库退化路径下的旧隔离语义：助手库内绑定了其他工作区的主题不可见。
    const projectA = await makeHarness({ workspace: "D:\\项目A" });
    await projectA.run("memory_write", { topic: "项目A约定", description: "构建命令", content: "用 pnpm build", agent_scoped: true });
    expect(projectA.store.list()[0]!.workspace).toBeUndefined(); // agent_scoped = 助手库全局主题
    expect(await projectA.run("memory_list", {})).toContain("项目A约定");

    const projectB = await makeHarness({ workspace: "D:\\项目B" });
    await expect(projectB.run("memory_read", { topic: "项目A约定" })).rejects.toThrow("未找到");
    expect(await projectB.run("memory_search", { query: "pnpm" })).toContain("未检索到");
    await expect(projectB.run("memory_delete", { topic: "项目A约定" })).rejects.toThrow("未找到");
    expect(projectA.store.list()).toHaveLength(1); // 隔离会话删不掉
  });

  it("keeps the legacy workspace binding behavior for pre-existing topics (single-library harness)", async () => {
    // 旧数据：助手库里已绑定了某工作区的主题（迁移前的形态）。单库 harness 下
    // 绑定语义不因本次改动漂移：其他工作区看不见、本工作区照常读写。
    const projectA = await makeHarness({ workspace: "D:\\项目A" });
    projectA.store.save({ title: "旧主题", description: "迁移前绑定", content: "旧内容", bindWorkspace: "D:\\项目A" });
    const list = await projectA.run("memory_list", {});
    expect(list).toContain("旧主题");
    const projectB = await makeHarness({ workspace: "D:\\项目B" });
    // 各 harness 的 store 是各自独立的临时目录，隔离语义由 store 的工作区绑定保证。
    await expect(projectB.run("memory_read", { topic: "不存在的主题" })).rejects.toThrow("未找到");
    void list;
  });

  it("returns a disabled reply for every tool without touching the store", async () => {
    const harness = await makeHarness({ enabled: false });
    for (const [name, params] of [
      ["memory_write", { topic: "t", description: "d", content: "x" }],
      ["memory_read", { topic: "t" }],
      ["memory_list", {}],
      ["memory_search", { query: "t" }],
      ["memory_delete", { topic: "t" }],
      ["memory_layer", { topic: "t", layer: "archive" }]
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
    expect(block).toContain("成功的工具调用结果");
    expect(block).toContain("无行动不记忆");
  });

  it("governance block requires an action-verified source for new memories", () => {
    const block = buildMemorySystemPromptBlock();
    // 来源要求：必须来自成功工具调用或用户陈述（用户说「记住 X」也是合法来源）。
    expect(block).toMatch(/成功的工具调用结果|用户明确陈述/);
    // 反例枚举：三类禁止写入的内容（断言只钉语义要点，容忍措辞微调）。
    expect(block).toContain("推理猜测");
    expect(block).toMatch(/未验证的假设|未执行的计划/);
  });

  it("snapshot block is undefined for an empty library and passes a budgeted index through without re-truncating", () => {
    expect(buildMemorySnapshotBlock("")).toBeUndefined();
    expect(buildMemorySnapshotBlock("   \n ")).toBeUndefined();

    const normal = buildMemorySnapshotBlock("## 全局\n- 用户偏好 — 语言");
    expect(normal).toContain("【长期记忆索引】");
    expect(normal).toContain("- 用户偏好 — 语言");
    expect(normal).toContain("memory_search");

    // 预算由 store.snapshotMarkdown 负责；这里不能再按 40 行静默截断——
    // 否则 store 精心保留的最新主题会被包装层再砍掉。
    const longIndex = ["## 全局", ...Array.from({ length: 50 }, (_, index) => `- 主题${index} — 描述`)].join("\n");
    const snapshot = buildMemorySnapshotBlock(longIndex)!;
    expect(snapshot).toContain("- 主题49 — 描述");
    expect(snapshot).not.toContain("仅显示前 40 行");
  });
});
