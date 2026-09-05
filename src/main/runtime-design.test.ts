import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesignDoc } from "../shared/design-schema.js";
import { buildDesignTools, type DesignToolDeps } from "./runtime-design.js";
import { designFilePath, writeDesign } from "./design-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-runtime-design-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Run a tool with the Pi 5-arg execute signature; our closures never read the trailing context args. */
interface ToolOutput {
  content: { type: string; text: string }[];
  details?: Record<string, unknown>;
}
const execute = async (tool: { execute: (id: string, params: never, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }, params: unknown): Promise<ToolOutput> =>
  (await tool.execute("test-call", params as never, undefined, undefined, undefined as unknown as ExtensionContext)) as ToolOutput;

/** 内存态 deps + 真实临时工作区（写盘路径走真实 design-store）。 */
async function harness(options: { enabled?: boolean } = {}) {
  const workspace = await tempWorkspace();
  let doc: DesignDoc | undefined;
  let fileName: string | undefined;
  const pushes: DesignDoc[] = [];
  const deps: DesignToolDeps = {
    enabled: () => options.enabled ?? true,
    workspace: () => workspace,
    getDoc: () => doc,
    getDocFileName: () => fileName,
    bindDoc: (next, file) => {
      doc = next;
      fileName = file;
    },
    persistDoc: (next, previous) => {
      pushes.push(next);
      doc = next;
      const written = writeDesign(workspace, next, previous);
      fileName = written;
      return written;
    }
  };
  const tools = buildDesignTools(deps);
  const tool = (name: string) => {
    const found = tools.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`missing tool ${name}`);
    return found;
  };
  return { workspace, deps, tools, tool, current: () => doc, fileName: () => fileName, pushes };
}

describe("buildDesignTools", () => {
  it("注册 6 个工具", async () => {
    const { tools } = await harness();
    expect(tools.map((tool) => tool.name)).toEqual(["design_list", "design_create", "design_open", "design_read", "design_update", "design_export"]);
  });

  it("总开关关闭时所有工具拒绝且不触碰状态", async () => {
    const { tool, current } = await harness({ enabled: false });
    await expect(execute(tool("design_list"), {})).rejects.toThrow("停用");
    await expect(execute(tool("design_update"), { ops: [{ op: "replace", nodes: [] }] })).rejects.toThrow("停用");
    expect(current()).toBeUndefined();
  });

  it("无工作区时给可读错误", async () => {
    const workspace = await tempWorkspace();
    const deps: DesignToolDeps = {
      enabled: () => true,
      workspace: () => undefined,
      getDoc: () => undefined,
      getDocFileName: () => undefined,
      bindDoc: () => undefined,
      persistDoc: () => ""
    };
    const list = buildDesignTools(deps).find((candidate) => candidate.name === "design_list")!;
    await expect(execute(list, {})).rejects.toThrow("工作区");
  });

  it("design_create 新建并绑定 + 写盘；同名再建直接打开", async () => {
    const { tool, current, fileName, workspace } = await harness();
    const result = await execute(tool("design_create"), { name: "登录页", width: 800, height: 600 });
    expect(result.details).toMatchObject({ existed: false, name: "登录页" });
    expect(current()!.canvas).toEqual({ width: 800, height: 600 });
    expect(existsSync(designFilePath(workspace, "登录页"))).toBe(true);
    expect(fileName()).toBe("登录页.design.json");
    const again = await execute(tool("design_create"), { name: "登录页" });
    expect(again.details).toMatchObject({ existed: true });
    expect(again.content[0]!.text).toContain("已存在");
  });

  it("design_list 列出文档并提示当前绑定", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "首页" });
    const result = await execute(tool("design_list"), {});
    expect(result.content[0]!.text).toContain("首页");
    expect(result.content[0]!.text).toContain("当前会话已打开");
  });

  it("design_open 按 name / docId 打开并返回整树；未绑定 read 给自纠提示", async () => {
    const { tool, current } = await harness();
    await execute(tool("design_create"), { name: "详情页" });
    const docId = current()!.id;
    const reopened = await execute(tool("design_open"), { docId });
    expect(reopened.content[0]!.text).toContain('"nodes"');
    expect(reopened.content[0]!.text).toContain("详情页");
    const byName = await execute(tool("design_open"), { name: "详情页" });
    expect(byName.content[0]!.text).toContain('"canvas"');
    await expect(execute(tool("design_open"), { name: "不存在" })).rejects.toThrow("找不到");
    const empty = await harness();
    await expect(execute(empty.tool("design_read"), {})).rejects.toThrow("design_list");
  });

  it("design_update 应用 ops：revision+1、写盘推送、create 无 id 时回执映射", async () => {
    const { tool, current, pushes, workspace } = await harness();
    await execute(tool("design_create"), { name: "落地页" });
    const result = await execute(tool("design_update"), {
      ops: [
        { op: "create", node: { type: "frame", name: "卡片", x: 0, y: 0, w: 200, h: 100 } },
        { op: "create", node: { type: "text", id: "title", name: "标题", text: "你好", x: 10, y: 10, w: 100, h: 30 } }
      ]
    });
    const details = result.details as { applied: number; revision: number; newIds: { name: string; id: string }[] };
    expect(details.applied).toBe(2);
    expect(details.revision).toBe(2);
    expect(details.newIds).toHaveLength(1);
    expect(details.newIds[0]!.name).toBe("卡片");
    expect(current()!.nodes).toHaveLength(2);
    expect(current()!.nodes[0]!.id).toBe(details.newIds[0]!.id);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]!.revision).toBe(2);
    expect(existsSync(designFilePath(workspace, "落地页"))).toBe(true);
    // 回执文本包含映射，模型可用新 id 继续 update。
    expect(result.content[0]!.text).toContain(`卡片→${details.newIds[0]!.id}`);
  });

  it("design_update 原子拒绝：失败时文档与磁盘不变", async () => {
    const { tool, current, pushes } = await harness();
    await execute(tool("design_create"), { name: "原子" });
    await expect(execute(tool("design_update"), {
      ops: [
        { op: "create", node: { type: "rect", id: "a", x: 0, y: 0, w: 10, h: 10 } },
        { op: "delete", id: "ghost" }
      ]
    })).rejects.toThrow("整批未应用");
    expect(current()!.nodes).toHaveLength(0);
    expect(current()!.revision).toBe(1);
    expect(pushes).toHaveLength(1); // 仅 design_create 的那次，update 失败未推送
  });

  it("design_update 禁止 patch 改 children/id/type", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "守卫" });
    await execute(tool("design_update"), { ops: [{ op: "create", node: { type: "rect", id: "r", x: 0, y: 0, w: 5, h: 5 } }] });
    await expect(execute(tool("design_update"), { ops: [{ op: "update", id: "r", patch: { children: [] } }] })).rejects.toThrow("不允许修改");
  });

  it("design_read 支持子树读取", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "子树" });
    await execute(tool("design_update"), { ops: [{ op: "create", node: { type: "text", id: "leaf", name: "叶子", text: "x", x: 0, y: 0, w: 9, h: 9 } }] });
    const result = await execute(tool("design_read"), { nodeId: "leaf" });
    expect(result.content[0]!.text).toContain('"leaf"');
    expect(result.content[0]!.text).not.toContain('"canvas"');
  });

  it("design_export 默认写 exports/，自定义 path 支持且拒绝越界", async () => {
    const { tool, workspace } = await harness();
    await execute(tool("design_create"), { name: "海报" });
    const result = await execute(tool("design_export"), {});
    const details = result.details as { relativePath: string };
    expect(details.relativePath).toBe(join("designs", "exports", "海报.html"));
    expect(existsSync(join(workspace, details.relativePath))).toBe(true);
    const custom = await execute(tool("design_export"), { path: "dist/投稿页.html" });
    expect((custom.details as { relativePath: string }).relativePath).toBe("dist/投稿页.html");
    expect(existsSync(join(workspace, "dist", "投稿页.html"))).toBe(true);
    await expect(execute(tool("design_export"), { path: "../outside.html" })).rejects.toThrow("相对路径");
    await expect(execute(tool("design_export"), { path: "C:/tmp/x.html" })).rejects.toThrow("相对路径");
  });
});
