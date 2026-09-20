import { describe, expect, it } from "vitest";
import {
  composeGalleryDevMessage,
  galleryAbsolutePath,
  galleryKey,
  galleryRunTarget,
  galleryThumbEligible,
  galleryThumbName,
  MAX_GALLERY_APPS,
  normalizeGalleryApp,
  normalizeGalleryEntry,
  removeGalleryApp,
  sortGalleryApps,
  trimGalleryApps,
  upsertGalleryApp,
  type GalleryApp
} from "./gallery.js";

function app(patch: Partial<GalleryApp> = {}): GalleryApp {
  return {
    id: "g1",
    title: "收纳整理 App 原型",
    kind: "file",
    workspace: "D:/ws",
    entry: "designs/exports/demo.html",
    createdAt: 1000,
    updatedAt: 1000,
    ...patch
  };
}

describe("normalizeGalleryEntry", () => {
  it("反斜杠转正斜杠、去 ./ 前缀与尾部斜杠", () => {
    expect(normalizeGalleryEntry("designs\\exports\\demo.html")).toBe("designs/exports/demo.html");
    expect(normalizeGalleryEntry("./dist/")).toBe("dist");
    expect(normalizeGalleryEntry("dist///")).toBe("dist");
  });

  it("空串与根目录都归一为 .（服务型作品的「工作区根」判据）", () => {
    for (const value of ["", "  ", ".", "./"]) expect(normalizeGalleryEntry(value)).toBe(".");
  });
});

describe("normalizeGalleryApp", () => {
  it("丢弃缺字段或类型非法的条目（宁可少一条坏数据）", () => {
    expect(normalizeGalleryApp(null)).toBeUndefined();
    expect(normalizeGalleryApp("x")).toBeUndefined();
    expect(normalizeGalleryApp({})).toBeUndefined();
    expect(normalizeGalleryApp({ title: "t", kind: "file", workspace: "D:/ws" })).toBeUndefined(); // 缺 entry
    expect(normalizeGalleryApp({ title: "t", kind: "nope", workspace: "D:/ws", entry: "a.html" })).toBeUndefined();
    expect(normalizeGalleryApp({ title: " ", kind: "file", workspace: "D:/ws", entry: "a.html" })).toBeUndefined();
  });

  it("保底补 id / 时间戳，并归一入口", () => {
    const parsed = normalizeGalleryApp({ title: " t ", kind: "file", workspace: " D:/ws ", entry: "./a\\b.html" });
    expect(parsed).toBeDefined();
    expect(parsed!.id).toMatch(/^g-/u);
    expect(parsed!.title).toBe("t");
    expect(parsed!.workspace).toBe("D:/ws");
    expect(parsed!.entry).toBe("a/b.html");
    expect(typeof parsed!.createdAt).toBe("number");
    expect(parsed!.updatedAt).toBe(parsed!.createdAt);
  });

  it("command / url 只对 server 生效（file 作品带它们就是脏数据）", () => {
    const file = normalizeGalleryApp({ title: "t", kind: "file", workspace: "D:/ws", entry: "a.html", command: "npm run dev", url: "http://x" });
    expect(file!.command).toBeUndefined();
    expect(file!.url).toBeUndefined();
    const server = normalizeGalleryApp({ title: "t", kind: "server", workspace: "D:/ws", entry: ".", command: "npm run dev", url: "http://x" });
    expect(server!.command).toBe("npm run dev");
    expect(server!.url).toBe("http://x");
  });
});

describe("galleryKey / upsertGalleryApp", () => {
  it("同一入口键大小写不敏感（Windows 盘符与路径大小写都会漂）", () => {
    expect(galleryKey(app())).toBe(galleryKey(app({ id: "other", workspace: "d:/WS", entry: "Designs/Exports/Demo.HTML" })));
  });

  it("同入口重复发布 = 更新而非新增（作品墙不出重复卡片）", () => {
    const first = upsertGalleryApp([], app(), 2000);
    expect(first.list).toHaveLength(1);
    const second = upsertGalleryApp(first.list, app({ id: "g2", title: "改了标题" }), 3000);
    expect(second.list).toHaveLength(1);
    expect(second.app.id).toBe("g1");
    expect(second.app.title).toBe("改了标题");
    expect(second.app.createdAt).toBe(1000); // createdAt 跟原条目
    expect(second.app.updatedAt).toBe(3000);
  });

  it("重发布不带缩略图时保留旧缩略图（否则每次更新都把图弄丢）", () => {
    const first = upsertGalleryApp([], app({ thumb: "gallery-1.png" }), 2000);
    const second = upsertGalleryApp(first.list, app({ id: "g1" }), 3000);
    expect(second.app.thumb).toBe("gallery-1.png");
  });

  it("同 id 更新也走更新分支（实体按钮改标题场景）", () => {
    const first = upsertGalleryApp([], app(), 2000);
    const second = upsertGalleryApp(first.list, app({ id: "g1", entry: "renamed.html" }), 3000);
    expect(second.list).toHaveLength(1);
    expect(second.app.entry).toBe("renamed.html");
  });
});

describe("removeGalleryApp / sortGalleryApps / trimGalleryApps", () => {
  it("删除返回被删项（调用方要清它的缩略图）", () => {
    const list = [app({ id: "a" }), app({ id: "b", entry: "b.html" })];
    const result = removeGalleryApp(list, "a");
    expect(result.removed?.id).toBe("a");
    expect(result.list.map((item) => item.id)).toEqual(["b"]);
    expect(removeGalleryApp(list, "missing").removed).toBeUndefined();
  });

  it("默认按 updatedAt 倒序，同值用 id 兜底（顺序稳定）", () => {
    const list = [app({ id: "b", entry: "b.html", updatedAt: 5 }), app({ id: "a", entry: "a.html", updatedAt: 9 })];
    expect(sortGalleryApps(list).map((item) => item.id)).toEqual(["a", "b"]);
    const tied = [app({ id: "b", entry: "b.html", updatedAt: 5 }), app({ id: "a", entry: "a.html", updatedAt: 5 })];
    expect(sortGalleryApps(tied).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("显式 order 升序排在未排序项之前", () => {
    const list = [app({ id: "a", entry: "a.html", updatedAt: 9 }), app({ id: "b", entry: "b.html", updatedAt: 1, order: 0 })];
    expect(sortGalleryApps(list).map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("超上限返回被淘汰条目供清理缩略图", () => {
    let list: GalleryApp[] = [];
    for (let index = 0; index < MAX_GALLERY_APPS + 3; index += 1) {
      list = upsertGalleryApp(list, app({ id: `g${index}`, entry: `${index}.html` }), 1000 + index).list;
    }
    const trimmed = trimGalleryApps(list);
    expect(trimmed.list).toHaveLength(MAX_GALLERY_APPS);
    expect(trimmed.dropped).toHaveLength(3);
    expect(trimGalleryApps(list.slice(0, 5)).dropped).toHaveLength(0);
  });
});

describe("galleryRunTarget（运行分流的唯一判据）", () => {
  it("file 作品 → 绝对路径（走静态服务）", () => {
    expect(galleryRunTarget(app())).toEqual({ kind: "file", absolutePath: "D:/ws/designs/exports/demo.html" });
  });

  it("server 作品 → 目录 + 可选 url/command", () => {
    expect(galleryRunTarget(app({ kind: "server", entry: ".", command: "npm run dev", url: "http://localhost:5173" })))
      .toEqual({ kind: "server", directory: "D:/ws", command: "npm run dev", url: "http://localhost:5173" });
    expect(galleryRunTarget(app({ kind: "server", entry: "apps/demo" })))
      .toEqual({ kind: "server", directory: "D:/ws/apps/demo" });
  });

  it("galleryAbsolutePath 处理根目录与尾部斜杠", () => {
    expect(galleryAbsolutePath("D:/ws/", ".")).toBe("D:/ws");
    expect(galleryAbsolutePath("D:\\ws", "a/b.html")).toBe("D:\\ws/a/b.html");
  });
});

describe("galleryThumbEligible / galleryThumbName", () => {
  it("只有静态页面才值得离屏渲染缩略图", () => {
    expect(galleryThumbEligible(app())).toBe(true);
    expect(galleryThumbEligible(app({ entry: "index.htm" }))).toBe(true);
    expect(galleryThumbEligible(app({ entry: "logo.svg" }))).toBe(true);
    expect(galleryThumbEligible(app({ entry: "main.js" }))).toBe(false);
    expect(galleryThumbEligible(app({ kind: "server", entry: "." }))).toBe(false);
  });

  it("缩略图名带时间戳且以 gallery- 开头（与截图同风格，便于识别归属）", () => {
    expect(galleryThumbName(new Date(2026, 8, 20, 9, 30, 12, 123).getTime())).toBe("gallery-20260920-093012-123.png");
  });
});

describe("composeGalleryDevMessage", () => {
  it("输出作品块（标题/类型/入口/工作区）+ 继续开发的意图", () => {
    const message = composeGalleryDevMessage(app({ description: "记账小工具", tags: ["工具"] }));
    expect(message.startsWith("【作品】")).toBe(true);
    expect(message).toContain("标题：收纳整理 App 原型");
    expect(message).toContain("类型：网页（file）");
    expect(message).toContain("入口：designs/exports/demo.html");
    expect(message).toContain("工作区：D:/ws");
    expect(message).toContain("说明：记账小工具");
    expect(message).toContain("继续开发");
  });

  it("服务型作品带上启动命令与地址，根目录入口有可读文案", () => {
    const message = composeGalleryDevMessage(app({ kind: "server", entry: ".", command: "npm run dev", url: "http://localhost:5173" }));
    expect(message).toContain("入口：（工作区根目录）");
    expect(message).toContain("启动命令：npm run dev");
    expect(message).toContain("服务地址：http://localhost:5173");
  });
});
