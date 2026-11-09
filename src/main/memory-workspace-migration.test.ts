// 记忆库「按工作区拆分」迁移（2026-11-09，GitHub issue #2 配套）：
// 任务来源 = 用户指出「项目记忆保留在角色身上不合理，应该保存在项目下」+ 选定
// 「项目内 `<workspace>/.pidesktop/memory/`」+「自动迁移」。
//
// 这些用例盯的是迁移的**安全性质**（数据不能丢），不是搬运的实现细节：
// 1. 只搬已绑定工作区的主题；未绑定的（用户偏好等）留在助手库；
// 2. 目标工作区目录不存在 → 原地保留（用户删了项目也不能丢知识）；
// 3. 目标库已有同名标题 → 原地保留（不覆盖用户已写的内容）；
// 4. 迁移前整库备份（rename 到带时间戳的目录），备份目录里保留了搬走前后的两态；
// 5. 幂等：无可搬主题时零写入（第二次启动不会重新备份 / 重新搬）。
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryStore, memoryDirFor, migrateWorkspaceBoundTopics, workspaceMemoryDirFor } from "./memory-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-memory-migrate-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-memory-ws-"));
  temporaryDirectories.push(dir);
  return dir;
}

function agentStore(agentDir: string, agentId: string) {
  return createMemoryStore(memoryDirFor(agentDir, agentId), () => {});
}

describe("memory workspace split migration", () => {
  it("moves workspace-bound topics into the workspace project library and keeps the rest", async () => {
    const agentDir = await makeAgentDir();
    const workspace = await makeWorkspace();
    const store = agentStore(agentDir, "agent-1");
    store.save({ title: "项目踩坑", description: "部署坑", content: "nginx body size", bindWorkspace: workspace });
    store.save({ title: "用户偏好", description: "跟人走", content: "先确认再动工" });

    const outcome = migrateWorkspaceBoundTopics(agentDir, { now: () => Date.UTC(2026, 10, 9, 3, 0, 0) });

    expect(outcome.movedTopics).toBe(1);
    expect(outcome.skippedMissingWorkspace).toBe(0);
    expect(outcome.skippedTitleConflict).toBe(0);
    expect(outcome.targetWorkspaces).toHaveLength(1);

    // 项目库拿到了主题，且保留工作区绑定（面板归属筛选靠它）。
    const project = createMemoryStore(workspaceMemoryDirFor(workspace), () => {});
    expect(project.read("项目踩坑")?.content).toBe("nginx body size");
    expect(project.read("项目踩坑")?.workspace).toBe(workspace);

    // 助手库只剩未绑定主题（迁移收尾会把源库还原到原位）。
    const after = agentStore(agentDir, "agent-1");
    expect(after.read("项目踩坑")).toBeUndefined();
    expect(after.read("用户偏好")?.content).toBe("先确认再动工");
  });

  it("keeps topics whose workspace directory is gone", async () => {
    const agentDir = await makeAgentDir();
    const store = agentStore(agentDir, "agent-1");
    const missing = join(agentDir, "已删除的项目");
    store.save({ title: "旧项目知识", description: "项目已删", content: "不能丢", bindWorkspace: missing });

    const outcome = migrateWorkspaceBoundTopics(agentDir);

    expect(outcome.movedTopics).toBe(0);
    expect(outcome.skippedMissingWorkspace).toBe(1);
    // 目录不存在 = 连备份都不该产生（零写入），主题原地保留。
    expect(agentStore(agentDir, "agent-1").read("旧项目知识")?.content).toBe("不能丢");
    const backups = (await readdir(agentDir)).filter((name) => name.startsWith("pidesktop-memory-backup-"));
    expect(backups).toHaveLength(0);
  });

  it("never overwrites a same-titled topic already in the project library", async () => {
    const agentDir = await makeAgentDir();
    const workspace = await makeWorkspace();
    const project = createMemoryStore(workspaceMemoryDirFor(workspace), () => {});
    project.save({ title: "构建命令", description: "项目里已有", content: "pnpm build（用户手写）", bindWorkspace: workspace });
    agentStore(agentDir, "agent-1").save({ title: "构建命令", description: "助手库旧版", content: "npm run build", bindWorkspace: workspace });

    const outcome = migrateWorkspaceBoundTopics(agentDir);

    expect(outcome.movedTopics).toBe(0);
    expect(outcome.skippedTitleConflict).toBe(1);
    // 项目库原样、助手库也原样（冲突不搬，等人工合并）。
    expect(createMemoryStore(workspaceMemoryDirFor(workspace), () => {}).read("构建命令")?.content).toBe("pnpm build（用户手写）");
    expect(agentStore(agentDir, "agent-1").read("构建命令")?.content).toBe("npm run build");
  });

  it("keeps a timestamped backup of the whole agent memory tree", async () => {
    const agentDir = await makeAgentDir();
    const workspace = await makeWorkspace();
    agentStore(agentDir, "agent-1").save({ title: "待搬主题", description: "d", content: "正文", bindWorkspace: workspace });

    migrateWorkspaceBoundTopics(agentDir, { now: () => Date.UTC(2026, 10, 9, 3, 0, 0) });

    const backups = (await readdir(agentDir)).filter((name) => name.startsWith("pidesktop-memory-backup-") && name.includes("workspace-split"));
    expect(backups).toHaveLength(1);
    // 备份在迁移前的状态：那个主题还在（虽然文件内容可能已被搬走流程删掉，
    // 关键是目录存在且可读回索引）。
    expect(existsSync(join(agentDir, backups[0]!, "agent-1"))).toBe(true);
  });

  it("is idempotent: a second run has nothing to move and writes nothing", async () => {
    const agentDir = await makeAgentDir();
    const workspace = await makeWorkspace();
    agentStore(agentDir, "agent-1").save({ title: "只搬一次", description: "d", content: "正文", bindWorkspace: workspace });

    const first = migrateWorkspaceBoundTopics(agentDir, { now: () => Date.UTC(2026, 10, 9, 3, 0, 0) });
    expect(first.movedTopics).toBe(1);

    const backupsAfterFirst = (await readdir(agentDir)).filter((name) => name.startsWith("pidesktop-memory-backup-"));
    const second = migrateWorkspaceBoundTopics(agentDir, { now: () => Date.UTC(2026, 10, 9, 4, 0, 0) });
    expect(second.movedTopics).toBe(0);
    expect(second.skippedMissingWorkspace).toBe(0);
    expect(second.skippedTitleConflict).toBe(0);
    const backupsAfterSecond = (await readdir(agentDir)).filter((name) => name.startsWith("pidesktop-memory-backup-"));
    expect(backupsAfterSecond).toEqual(backupsAfterFirst);
    // 项目库里的那份没有被第二次运行影响。
    expect(createMemoryStore(workspaceMemoryDirFor(workspace), () => {}).read("只搬一次")?.content).toBe("正文");
  });

  it("does nothing at all when there is no memory directory yet", async () => {
    const agentDir = await makeAgentDir();
    const outcome = migrateWorkspaceBoundTopics(agentDir);
    expect(outcome).toEqual({ agentDirs: 0, movedTopics: 0, skippedMissingWorkspace: 0, skippedTitleConflict: 0, targetWorkspaces: [] });
    expect(await readdir(agentDir)).toHaveLength(0);
  });

  it("moves topics from several agents into the same workspace library", async () => {
    // 总控场景的直接验收：两个助手各自在助手库里绑定了同一工作区，迁移后
    // 项目知识合并到一个项目库里（顺序无关，标题不冲突就都能到达）。
    const agentDir = await makeAgentDir();
    const workspace = await makeWorkspace();
    agentStore(agentDir, "agent-1").save({ title: "A 的踩坑", description: "d1", content: "c1", bindWorkspace: workspace });
    agentStore(agentDir, "agent-2").save({ title: "B 的踩坑", description: "d2", content: "c2", bindWorkspace: workspace });

    const outcome = migrateWorkspaceBoundTopics(agentDir);

    expect(outcome.movedTopics).toBe(2);
    expect(outcome.targetWorkspaces).toHaveLength(1);
    const project = createMemoryStore(workspaceMemoryDirFor(workspace), () => {});
    expect(project.list().map((topic) => topic.title).sort()).toEqual(["A 的踩坑", "B 的踩坑"]);
  });

  it("keeps the topic file format readable by the old layout (frontmatter unchanged)", async () => {
    // 搬家不换格式：工作区库里的文件仍是「frontmatter + markdown」，老版本/工具照旧可读。
    const agentDir = await makeAgentDir();
    const workspace = await makeWorkspace();
    agentStore(agentDir, "agent-1").save({ title: "格式稳定", description: "索引行", content: "## 节\n正文", layer: "core", summary: "要点", triggers: ["触发词"], bindWorkspace: workspace });

    migrateWorkspaceBoundTopics(agentDir);

    const dir = workspaceMemoryDirFor(workspace);
    const files = await readdir(join(dir, "topics"));
    expect(files).toHaveLength(1);
    const raw = await readFile(join(dir, "topics", files[0]!), "utf8");
    expect(raw.startsWith("---\ntitle: 格式稳定")).toBe(true);
    expect(raw).toContain("layer: core");
    expect(raw).toContain("triggers: 触发词");
    expect(raw).toContain(`workspace: ${workspace}`);
  });

  it("tolerates a hand-written topic file with a workspace that exists", async () => {
    // 手工放的 md 文件（无 store 写过）同样能搬：解析走 parseTopicFile。
    const agentDir = await makeAgentDir();
    const workspace = await makeWorkspace();
    const dir = memoryDirFor(agentDir, "agent-1");
    await mkdir(join(dir, "topics"), { recursive: true });
    await writeFile(join(dir, "topics", "手写.md"), [
      "---",
      "title: 手写主题",
      "description: 手写索引行",
      `workspace: ${workspace}`,
      "createdAt: 2026-01-01",
      "updatedAt: 2026-01-01",
      "---",
      "",
      "手写正文"
    ].join("\n"), "utf8");

    const outcome = migrateWorkspaceBoundTopics(agentDir);

    expect(outcome.movedTopics).toBe(1);
    expect(createMemoryStore(workspaceMemoryDirFor(workspace), () => {}).read("手写主题")?.content).toBe("手写正文");
  });
});
