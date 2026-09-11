import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  details?: Record<string, unknown>;
}
const execute = async (tool: { execute: (id: string, params: never, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }, params: unknown): Promise<ToolOutput> =>
  (await tool.execute("test-call", params as never, undefined, undefined, undefined as unknown as ExtensionContext)) as ToolOutput;

/** 内存态 deps + 真实临时工作区（写盘路径走真实 design-store）。 */
async function harness(options: { enabled?: boolean; renderSnapshot?: DesignToolDeps["renderSnapshot"] } = {}) {
  const workspace = await tempWorkspace();
  let doc: DesignDoc | undefined;
  let fileName: string | undefined;
  const pushes: DesignDoc[] = [];
  const deps: DesignToolDeps = {
    enabled: () => options.enabled ?? true,
    workspace: () => workspace,
    renderSnapshot: options.renderSnapshot,
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
  it("注册 8 个工具", async () => {
    const { tools } = await harness();
    expect(tools.map((tool) => tool.name)).toEqual(["design_list", "design_create", "design_guides", "design_set_guide", "design_open", "design_read", "design_update", "design_export"]);
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

  it("design_create 首次用法要点包含字体栈纪律（尾部注入，不进 description）", async () => {
    const { tool } = await harness();
    const created = await execute(tool("design_create"), { name: "字体纪律" });
    expect(created.content[0]!.text).toContain("fontFamily");
    // 只提示一次：第二次 create 不再带用法要点（省尾部 token）。
    const again = await execute(tool("design_create"), { name: "字体纪律二" });
    expect(again.content[0]!.text).not.toContain("用法要点");
  });

  it("design_update 接受 fontFamily / letterSpacing 并落盘", async () => {
    const { tool, current } = await harness();
    await execute(tool("design_create"), { name: "字体落盘" });
    await execute(tool("design_update"), {
      ops: [{ op: "create", node: { type: "text", id: "t1", text: "标题", x: 0, y: 0, w: 100, h: 30, fontFamily: "Inter, sans-serif", letterSpacing: -0.3 } }]
    });
    const node = current()!.nodes[0]!;
    expect(node.fontFamily).toBe("Inter, sans-serif");
    expect(node.letterSpacing).toBe(-0.3);
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

  it("design_export 附缩略图：成功时回执带 image part、落盘路径与 details.thumbnail", async () => {
    const snapshots: unknown[] = [];
    const { tool } = await harness({
      renderSnapshot: async (request) => {
        snapshots.push(request);
        return { ok: true, data: "aGVsbG8=", width: 1024, height: 640, mimeType: "image/png", savedPath: ".pidesktop/screenshots/design-1.png" };
      }
    });
    await execute(tool("design_create"), { name: "海报" });
    const result = await execute(tool("design_export"), {});
    const image = result.content.find((part) => part.type === "image");
    expect(image).toMatchObject({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    expect(result.content[0]!.text).toContain("design-1.png");
    expect(result.content[0]!.text).toContain("recognize_images");
    expect(result.details).toMatchObject({ thumbnail: { width: 1024, height: 640, relativePath: ".pidesktop/screenshots/design-1.png" } });
    // 请求携带导出文件的绝对路径与内容包围盒（视口适配用）。
    expect(snapshots[0]).toMatchObject({ contentWidth: 1440, contentHeight: 1024 });
  });

  it("design_export 缩略图失败降级：文本提示、无 image part、导出不受影响", async () => {
    const { tool, workspace } = await harness({ renderSnapshot: async () => ({ ok: false, error: "离屏渲染未出帧" }) });
    await execute(tool("design_create"), { name: "海报" });
    const result = await execute(tool("design_export"), {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toContain("缩略图生成失败");
    expect(result.content[0]!.text).toContain("离屏渲染未出帧");
    expect(existsSync(join(workspace, "designs", "exports", "海报.html"))).toBe(true);
  });
  it("design_update 回执带审美标尺诊断与吸附修复（off-scale-radius/off-scale-font-size）", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "标尺页" });
    const result = await execute(tool("design_update"), {
      ops: [
        { op: "create", node: { type: "rect", id: "card", name: "卡", x: 0, y: 0, w: 200, h: 100, radius: 14 } },
        { op: "create", node: { type: "text", id: "title", name: "标题", text: "你好", x: 0, y: 120, w: 200, h: 30, fontSize: 19 } }
      ]
    });
    const text = result.content[0]!.text;
    expect(text).toContain("off-scale-radius");
    expect(text).toContain("off-scale-font-size");
    expect(text).toContain('"radius":12');
    expect(text).toContain('"fontSize":18');
  });

  it("design_create 带 brief 注入设计规格并把指南写进文档（后续质量门用它的标尺）", async () => {
    const { tool, current } = await harness();
    const result = await execute(tool("design_create"), { name: "咖啡首页", brief: "咖啡外卖 App 首页", width: 390, height: 844 });
    const text = result.content[0]!.text;
    expect(text).toContain("设计规格");
    expect(text).toContain("warm-food-mobile-light");
    expect(text).toContain("间距标尺");
    expect(text).toContain("圆角标尺");
    expect(current()!.guide).toBe("warm-food-mobile-light");
    expect(result.details).toMatchObject({ guide: "warm-food-mobile-light" });
  });

  it("design_create 未命中时给索引导航（不内联 63 行全文），并把换风格入口指向 design_set_guide", async () => {
    const { tool, current } = await harness();
    const result = await execute(tool("design_create"), { name: "qwertyuiop" });
    const text = result.content[0]!.text;
    expect(text).toContain("未按需求命中风格指南");
    expect(text).toContain("design_guides");
    // 关键：不能叫模型「重发带 guide 的 create」——同名已存在会走短路分支白跑一趟。
    expect(text).toContain("design_set_guide");
    expect(text).not.toContain("重发带 guide 的调用");
    expect(current()!.guide).toBeUndefined();
  });

  it("design_create 的 guide 参数显式指定（并拒绝不存在的指南名）", async () => {
    const { tool, current } = await harness();
    const result = await execute(tool("design_create"), { name: "指定风格", guide: "ai-product-dark" });
    expect(result.content[0]!.text).toContain("已按 guide 参数载入");
    expect(current()!.guide).toBe("ai-product-dark");
    await expect(execute(tool("design_create"), { name: "错名", guide: "no-such-guide" })).rejects.toThrow("风格指南不存在");
  });

  it("design_create 同名已存在时不改绑定，并指向 design_set_guide 换风格", async () => {
    const { tool, current } = await harness();
    await execute(tool("design_create"), { name: "重开", guide: "ai-product-dark" });
    // 同名再来一次（哪怕带不同 guide）不得重建/换绑定——用户可能已改过稿。
    const again = await execute(tool("design_create"), { name: "重开", guide: "crypto-dark-bold" });
    expect(again.details).toMatchObject({ existed: true, guide: "ai-product-dark" });
    expect(current()!.guide).toBe("ai-product-dark");
    expect(again.content[0]!.text).toContain("已绑定风格指南「ai-product-dark」");
  });

  it("design_create 同名已存在且未绑定时指向 design_set_guide（换风格入口不是重发 create）", async () => {
    const { tool, current } = await harness();
    await execute(tool("design_create"), { name: "无名风格" });
    const again = await execute(tool("design_create"), { name: "无名风格", guide: "ai-product-dark" });
    // 同名短路：仍不改绑定（用户可能已改过稿），但把入口说清楚。
    expect(current()!.guide).toBeUndefined();
    expect(again.content[0]!.text).toContain("design_set_guide");
  });

  it("design_guides 列表/筛选/推荐", async () => {
    const { tool } = await harness();
    const all = await execute(tool("design_guides"), {});
    expect(all.content[0]!.text).toContain("风格指南");
    expect(all.details).toMatchObject({ count: 63 });
    const mobile = await execute(tool("design_guides"), { platform: "mobile" });
    expect(mobile.details).toMatchObject({ count: 15 });
    const dark = await execute(tool("design_guides"), { tags: ["dark-mode", "mobile"] });
    expect((dark.details as { count: number }).count).toBeGreaterThan(0);
    expect((dark.details as { count: number }).count).toBeLessThan(15);
    const recommended = await execute(tool("design_guides"), { brief: "咖啡外卖 App" });
    expect(recommended.content[0]!.text).toContain("★");
    await expect(execute(tool("design_guides"), { tags: ["no-such-tag"] })).rejects.toThrow("没有匹配的指南");
  });

  it("design_set_guide 换风格 / 解除绑定，落盘并推进 revision", async () => {
    const { tool, current, workspace } = await harness();
    await execute(tool("design_create"), { name: "换风格" });
    const set = await execute(tool("design_set_guide"), { name: "dashboard-analytics-dark" });
    expect(set.content[0]!.text).toContain("dashboard-analytics-dark");
    expect(current()!.guide).toBe("dashboard-analytics-dark");
    expect(current()!.revision).toBe(2);
    // 落盘保留 guide（跨会话保持）。
    const onDisk = JSON.parse(await readFile(designFilePath(workspace, "换风格"), "utf8")) as { guide?: string };
    expect(onDisk.guide).toBe("dashboard-analytics-dark");
    const cleared = await execute(tool("design_set_guide"), { name: "none" });
    expect(cleared.content[0]!.text).toContain("已解除");
    expect(current()!.guide).toBeUndefined();
    await expect(execute(tool("design_set_guide"), { name: "nope" })).rejects.toThrow("风格指南不存在");
  });

  it("design_update 质量门用文档绑定的指南标尺（非默认标尺）——用两者查向相反的值验证", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "标尺绑定", guide: "ai-product-dark" });
    // radius 24 在默认标尺上（0/2/4/6/8/10/12/16/20/24/9999），
    // 但不在 ai-product-dark 的圆角档位（6/8/12/16/20/9999）上。
    // 如果质量门用的是默认标尺，这个节点就不会报 off-scale-radius。
    const result = await execute(tool("design_update"), {
      ops: [{ op: "create", node: { type: "rect", id: "card", name: "卡", x: 0, y: 0, w: 200, h: 100, radius: 24 } }]
    });
    const text = result.content[0]!.text;
    expect(text).toContain("质量门标尺：文档已绑定风格指南「ai-product-dark」");
    expect(text).toContain("圆角 6/8/12/16/20/9999");
    expect(text).toContain("off-scale-radius");
    // 吸附到该指南标尺的最近档（20），而不是默认标尺上的 24。
    expect(text).toContain('"radius":20');
    expect(text).not.toContain('"radius":24');
  });

  it("未绑定指南的文档用默认标尺（radius 24 合法，不报 off-scale-radius）", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "默认标尺" });
    const result = await execute(tool("design_update"), {
      ops: [{ op: "create", node: { type: "rect", id: "card", name: "卡", x: 0, y: 0, w: 200, h: 100, radius: 24 } }]
    });
    const text = result.content[0]!.text;
    expect(text).not.toContain("off-scale-radius");
    expect(text).toContain("继续搭建其余屏幕/区域");
  });

  it("design_list 提示当前文档的风格指南绑定", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "带风格", guide: "ai-product-dark" });
    const listed = await execute(tool("design_list"), {});
    expect(listed.content[0]!.text).toContain("ai-product-dark");
  });

  it("design_update 带质量门：问题诊断 + 可套用的修复 ops 回执 + resize 生效", async () => {
    const { tool, current } = await harness();
    await execute(tool("design_create"), { name: "质检页", width: 400, height: 300 });
    const result = await execute(tool("design_update"), {
      ops: [
        { op: "resize", width: 400, height: 320 },
        { op: "create", node: { type: "frame", id: "rail", name: "轨道", x: 0, y: 0, w: 100, h: 200, layout: { direction: "row", gap: 20, padding: 16 }, children: [
          { type: "rect", id: "c1", name: "卡一", x: 0, y: 0, w: 150, h: 100 },
          { type: "rect", id: "c2", name: "卡二", x: 0, y: 0, w: 150, h: 100 }
        ] } }
      ]
    });
    const text = result.content[0]!.text;
    expect(text).toContain("质量检查");
    expect(text).toContain("container-overflow");
    expect(text).toContain("修复 ops");
    expect(text).toContain('"op":"update"');
    const details = result.details as { quality: { diagnostics: string[]; repairCount: number } };
    expect(details.quality.repairCount).toBeGreaterThanOrEqual(1);
    expect(current()!.canvas).toEqual({ width: 400, height: 320 });
  });

  it("design_update 超过 64 条 ops 拒绝并教分批", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "大批" });
    const ops = Array.from({ length: 65 }, (_, index) => ({ op: "create", node: { type: "rect", id: `r${index}`, x: index, y: 0, w: 5, h: 5 } }));
    await expect(execute(tool("design_update"), { ops })).rejects.toThrow("分批");
  });

  it("design_update patch 拼错字段名整批拒绝（不静默忽略）", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "拼写" });
    await execute(tool("design_update"), { ops: [{ op: "create", node: { type: "text", id: "t", text: "hi", x: 0, y: 0, w: 40, h: 20 } }] });
    await expect(execute(tool("design_update"), { ops: [{ op: "update", id: "t", patch: { fontsize: 20 } }] })).rejects.toThrow("fontsize");
  });

  it("design_update 顶层幻觉参数拒绝（如 edits）", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "顶层" });
    await expect(execute(tool("design_update"), { ops: [{ op: "resize", width: 500 }], edits: [] })).rejects.toThrow("edits");
  });

  it("design_update create 自造字段整批拒绝；move dx/dy 整树平移", async () => {
    const { tool, current } = await harness();
    await execute(tool("design_create"), { name: "平移" });
    await expect(execute(tool("design_update"), {
      ops: [{ op: "create", node: { type: "rect", id: "a", x: 0, y: 0, w: 10, h: 10, props: { strokeOpacity: 0.2 } } }]
    })).rejects.toThrow("props");
    const moved = await execute(tool("design_update"), {
      ops: [
        { op: "create", node: { type: "frame", id: "s1", name: "屏一", x: 0, y: 0, w: 100, h: 100 } },
        { op: "move", id: "s1", dx: 180, dy: 0 }
      ]
    });
    expect(moved.details).toMatchObject({ applied: 2 });
    expect(current()!.nodes[0]!.x).toBe(180);
  });

  it("design_list 多文档时提示整套原型应同文档", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "首页" });
    await execute(tool("design_create"), { name: "登录页" });
    const result = await execute(tool("design_list"), {});
    expect(result.content[0]!.text).toContain("一个文档 = 一块画布");
  });

  it("design_read 整树带布局摘要（地图先于 JSON）", async () => {
    const { tool } = await harness();
    await execute(tool("design_create"), { name: "摘要" });
    await execute(tool("design_update"), { ops: [{ op: "create", node: { type: "rect", id: "hero", name: "首屏", x: 0, y: 0, w: 300, h: 200 } }] });
    const result = await execute(tool("design_read"), {});
    expect(result.content[0]!.text).toContain("布局摘要");
    expect(result.content[0]!.text).toContain("首屏 rect 300×200");
  });
});

