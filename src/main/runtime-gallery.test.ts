import { describe, expect, it } from "vitest";
import { publishReceipt, validatePublishInput, type GalleryToolContext } from "./runtime-gallery.js";

describe("validatePublishInput", () => {
  it("缺 path / title / kind 一律拒绝（工具参数错误要当场报，而不是静默发布空作品）", () => {
    expect(() => validatePublishInput({})).toThrow(/path/u);
    expect(() => validatePublishInput({ path: "a.html" })).toThrow(/kind/u);
    expect(() => validatePublishInput({ path: "a.html", kind: "file" })).toThrow(/title/u);
    expect(() => validatePublishInput({ path: "a.html", kind: "nope", title: "t" })).toThrow(/kind/u);
  });

  it("归一化可选字段：空白串丢弃、tags 去空", () => {
    const draft = validatePublishInput({ path: " demo.html ", kind: " file ", title: " 示例 ", entry: " ", command: "", url: "  ", description: " 说明 ", tags: [" a ", "", "b"] });
    expect(draft).toEqual({ title: "示例", kind: "file", path: "demo.html", description: "说明", tags: ["a", "b"] });
  });

  it("server 类型保留 command / url（运行分流的依据）", () => {
    const draft = validatePublishInput({ path: "apps/demo", kind: "server", title: "记账工具", command: "npm run dev", url: "http://localhost:5173" });
    expect(draft.command).toBe("npm run dev");
    expect(draft.url).toBe("http://localhost:5173");
  });

  it("panel 类型保留归一化后的窗口偏好；非法 panel 丢字段而不是报错", () => {
    const draft = validatePublishInput({ path: "panels/status/index.html", kind: "panel", title: "会话状态", panel: { width: 320, height: 700, alwaysOnTop: true } });
    expect(draft.kind).toBe("panel");
    expect(draft.panel).toEqual({ width: 320, height: 700, alwaysOnTop: true });
    // 尺寸写疯了只会被夹取；整个 panel 非法（字符串）则当没写
    expect(validatePublishInput({ path: "p.html", kind: "panel", title: "t", panel: { width: 99999 } }).panel).toEqual({ width: 1600 });
    expect(validatePublishInput({ path: "p.html", kind: "panel", title: "t", panel: "big" }).panel).toBeUndefined();
  });
});

describe("publishReceipt", () => {
  it("回执含标题、类型、入口与作品池数量，并给出下一步（anti-narration）", () => {
    const text = publishReceipt({ id: "g1", title: "收纳整理原型", kind: "file", workspace: "D:/ws", entry: "designs/exports/demo.html", createdAt: 1, updatedAt: 1 }, 3, "");
    expect(text).toContain("已发布作品「收纳整理原型」（网页）");
    expect(text).toContain("designs/exports/demo.html");
    expect(text).toContain("现有 3 个");
    expect(text).toContain("继续开发");
  });

  it("根目录入口有可读文案；缩略图降级说明单独附一行", () => {
    const text = publishReceipt({ id: "g1", title: "服务", kind: "server", workspace: "D:/ws", entry: ".", createdAt: 1, updatedAt: 1 }, 1, "（缩略图未生成：加载超时）");
    expect(text).toContain("工作区根目录");
    expect(text).toContain("缩略图未生成");
  });
});

describe("buildGalleryTools 契约", () => {
  it("工具描述把 panel 的数据接口写清楚（模型据此写面板页）", async () => {
    const { buildGalleryTools } = await import("./runtime-gallery.js");
    const tools = buildGalleryTools({ publish: async (draft) => ({ app: { id: "g1", title: draft.title, kind: draft.kind, workspace: "D:/ws", entry: draft.path, createdAt: 1, updatedAt: 1 }, thumbNote: "" }), list: () => [] });
    const description = String(tools[0]!.description ?? "");
    expect(description).toContain("panel");
    expect(description).toContain("__pidesktop_state.json");
  });

  it("只暴露一个 gallery_publish，且工具名符合 OpenAI 兼容的下划线命名", async () => {
    const calls: string[] = [];
    const ctx: GalleryToolContext = {
      publish: async (draft) => {
        calls.push(draft.path);
        return { app: { id: "g1", title: draft.title, kind: draft.kind, workspace: "D:/ws", entry: draft.path, createdAt: 1, updatedAt: 1 }, thumbNote: "" };
      },
      list: () => []
    };
    const { buildGalleryTools } = await import("./runtime-gallery.js");
    const tools = buildGalleryTools(ctx);
    expect(tools.map((tool) => tool.name)).toEqual(["gallery_publish"]);
    // 点号会被 DeepSeek 之类的 OpenAI 兼容服务拒绝（tools[].function.name 只允许 ^[a-zA-Z0-9_-]+$）
    for (const tool of tools) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/u);
  });
});
