import { describe, expect, it } from "vitest";
import {
  compactServiceTail,
  composeGalleryDevMessage,
  foldGalleryEntry,
  galleryAbsolutePath,
  galleryEntryDirectory,
  galleryEntryFromAbsolute,
  galleryKey,
  galleryPanelServicePairError,
  galleryRunPlan,
  galleryRunTarget,
  galleryServiceFailureMessage,
  galleryServiceLive,
  galleryServiceNote,
  galleryServiceOwnership,
  galleryRunMode,
  galleryCoverNote,
  galleryPlaceholderCoverHtml,
  gallerySnapshotTarget,
  galleryThumbEligible,
  galleryThumbName,
  galleryWorkspaceKey,
  isAbsoluteGalleryPath,
  MAX_GALLERY_APPS,
  normalizeGalleryApp,
  normalizeGalleryEntry,
  normalizeGalleryPanelOptions,
  PANEL_DEFAULT_HEIGHT,
  PANEL_DEFAULT_WIDTH,
  panelEffectiveAlwaysOnTop,
  panelMode,
  panelWindowSize,
  removeGalleryApp,
  resolveGalleryEntry,
  resolveGalleryPublish,
  sortGalleryApps,
  trimGalleryApps,
  upsertGalleryApp,
  workspaceLabel,
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

describe("workspaceLabel（作品墙卡片上的工作区名）", () => {
  it("取路径最后一段，Windows 反斜杠与尾斜杠都能处理", () => {
    expect(workspaceLabel("D:\\Projects\\designs")).toBe("designs");
    expect(workspaceLabel("D:/Projects/designs/")).toBe("designs");
    expect(workspaceLabel("/home/li/ws-proj")).toBe("ws-proj");
    // 盘符根保留盘符（否则名字就是空串了）
    expect(workspaceLabel("D:\\")).toBe("D:");
    expect(workspaceLabel("")).toBe("");
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

  it("runMode 只属于服务型作品，且只有 background 落字段（缺省 page 不写）", () => {
    const server = normalizeGalleryApp({ title: "t", kind: "server", workspace: "D:/ws", entry: ".", runMode: "background" });
    expect(server!.runMode).toBe("background");
    // 显式 page 与非法值都不落字段（读侧归一化：没声明就没字段）
    expect(normalizeGalleryApp({ title: "t", kind: "server", workspace: "D:/ws", entry: ".", runMode: "page" })!.runMode).toBeUndefined();
    expect(normalizeGalleryApp({ title: "t", kind: "server", workspace: "D:/ws", entry: ".", runMode: "bogus" })!.runMode).toBeUndefined();
    // 网页 / 面板带 runMode 是脏数据
    expect(normalizeGalleryApp({ title: "t", kind: "file", workspace: "D:/ws", entry: "a.html", runMode: "background" })!.runMode).toBeUndefined();
    expect(normalizeGalleryApp({ title: "t", kind: "panel", workspace: "D:/ws", entry: "p/index.html", runMode: "background" })!.runMode).toBeUndefined();
  });

  it("command / url 只对「服务型」作品生效（server 与 panel；file 带它们就是脏数据）", () => {
    const file = normalizeGalleryApp({ title: "t", kind: "file", workspace: "D:/ws", entry: "a.html", command: "npm run dev", url: "http://x" });
    expect(file!.command).toBeUndefined();
    expect(file!.url).toBeUndefined();
    const server = normalizeGalleryApp({ title: "t", kind: "server", workspace: "D:/ws", entry: ".", command: "npm run dev", url: "http://x" });
    expect(server!.command).toBe("npm run dev");
    expect(server!.url).toBe("http://x");
    // 面板同样能声明本地服务（2026-10-11）：面板页没有 preload 也跑不了进程，
    // 需要本地数据源的面板靠 command + url 在开窗前把服务拉起来。
    const panel = normalizeGalleryApp({ title: "t", kind: "panel", workspace: "D:/ws", entry: "panels/status/index.html", command: "node bridge.mjs", url: "http://127.0.0.1:8791/api/health" });
    expect(panel!.command).toBe("node bridge.mjs");
    expect(panel!.url).toBe("http://127.0.0.1:8791/api/health");
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

describe("upsertGalleryApp 的 id 生成（发布路径不再依赖读路径兜底）", () => {
  it("draft 没带 id 时由本函数生成（否则读盘时为空的 id 每次都会重新随机）", () => {
    // 回归：首版发布路径传 id:""，而补 id 只在读路径 normalizeGalleryApp 里——
    // 结果磁盘上 id 永远为空，每次读盘都换个新 id，update/remove/run 全按 id 寻址
    const published = upsertGalleryApp([], app({ id: "" }), 2000);
    expect(published.app.id).not.toBe("");
    expect(published.app.id).toMatch(/^g-/u);
    // 落盘 → 读回 → 再读回：id 必须**稳定不变**（这是本 bug 的核心症状）
    const once = normalizeGalleryApp(JSON.parse(JSON.stringify(published.app)));
    const twice = normalizeGalleryApp(JSON.parse(JSON.stringify(once)));
    expect(once!.id).toBe(published.app.id);
    expect(twice!.id).toBe(published.app.id);
  });

  it("draft 带了 id 时照用（测试夹具与「换 id 重建」场景）", () => {
    expect(upsertGalleryApp([], app({ id: "custom-id" })).app.id).toBe("custom-id");
  });

  it("空 id 的重复发布按入口键仍归并为更新（不会因 id 为空而插重复项）", () => {
    const first = upsertGalleryApp([], app({ id: "" }), 2000);
    const second = upsertGalleryApp(first.list, app({ id: "", title: "改名了" }), 3000);
    expect(second.list).toHaveLength(1);
    expect(second.app.id).toBe(first.app.id);
    expect(second.app.title).toBe("改名了");
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

  it("galleryEntryDirectory 取入口所在目录（正/反斜杠都算，无分隔符就原样返回）", () => {
    expect(galleryEntryDirectory("D:/ws/panels/status/index.html")).toBe("D:/ws/panels/status");
    expect(galleryEntryDirectory("D:\\ws\\panels\\index.html")).toBe("D:\\ws\\panels");
    // 面板入口不可能落在根上（读侧就拒了 "."），这是不可达的兜底
    expect(galleryEntryDirectory("index.html")).toBe("index.html");
  });
});

describe("galleryRunPlan（「先探测再决定」的唯一判据）", () => {
  const server = { kind: "server" as const, entry: "apps/ledger", command: "npm run dev", url: "http://localhost:5173" };

  it("file 作品与可达性无关，永远走静态服务开浏览器", () => {
    expect(galleryRunPlan(app(), true)).toEqual({ action: "open-file", absolutePath: "D:/ws/designs/exports/demo.html" });
    expect(galleryRunPlan(app(), false)).toEqual({ action: "open-file", absolutePath: "D:/ws/designs/exports/demo.html" });
  });

  it("server 且地址已可达 → 直接开浏览器（不重启服务）", () => {
    expect(galleryRunPlan(app(server), true)).toEqual({ action: "open-browser", url: "http://localhost:5173" });
  });

  it("server 不可达且有启动命令 → 后台起进程（就绪后顺带开页面）", () => {
    expect(galleryRunPlan(app(server), false)).toEqual({
      action: "start-service",
      directory: "D:/ws/apps/ledger",
      command: "npm run dev",
      url: "http://localhost:5173",
      openPage: true
    });
  });

  it("server 只有命令没有地址 → 起进程但没页面可开", () => {
    expect(galleryRunPlan(app({ kind: "server", entry: ".", command: "node server.js" }), false))
      .toEqual({ action: "start-service", directory: "D:/ws", command: "node server.js", openPage: false });
  });

  it("纯后台服务（runMode=background）：可达时不开页面，不可达时只起进程", () => {
    const proxy = app({ ...server, runMode: "background" });
    // 已可达（用户手工起的/上次留下的）：什么都不用做，更不开页面
    expect(galleryRunPlan(proxy, true)).toEqual({ action: "service-up", url: "http://localhost:5173" });
    expect(galleryRunPlan(app({ ...server, command: "node proxy.js", url: undefined, runMode: "background" }), true)).toEqual({ action: "service-up" });
    // 不可达：起后台进程，openPage=false（这就是「反代不该弹页面」的判据）
    expect(galleryRunPlan(proxy, false)).toEqual({
      action: "start-service",
      directory: "D:/ws/apps/ledger",
      command: "npm run dev",
      url: "http://localhost:5173",
      openPage: false
    });
    // 纯后台但没登记命令：没得可起，如实报
    expect(galleryRunPlan(app({ kind: "server", entry: ".", url: "http://localhost:5173", runMode: "background" }), false)).toEqual({ action: "manual" });
  });

  it("runMode 缺省是 page（旧清单不受影响）", () => {
    expect(galleryRunMode(app({ kind: "server", entry: "." }))).toBe("page");
    expect(galleryRunMode(app({ kind: "server", entry: ".", runMode: "background" }))).toBe("background");
  });

  it("server 既不可达又没命令 → manual（绝不假装跑起来了）", () => {
    expect(galleryRunPlan(app({ kind: "server", entry: ".", url: "http://localhost:5173" }), false)).toEqual({ action: "manual" });
    expect(galleryRunPlan(app({ kind: "server", entry: "." }), false)).toEqual({ action: "manual" });
  });
});

describe("galleryServiceFailureMessage / compactServiceTail", () => {
  const target = app({ kind: "server", entry: ".", url: "http://localhost:8787" });

  it("命令自己退出：给出退出码与输出尾部", () => {
    const message = galleryServiceFailureMessage(target, { reason: "exited", exitCode: 1, tail: "Error: Cannot find module 'express'\n    at ..." });
    expect(message).toContain("已退出（代码 1）");
    expect(message).toContain("Cannot find module");
    // 多行输出压成一行：toast 是单行流式布局
    expect(message).not.toContain("\n");
  });

  it("命令退出但没抓到输出尾部时指向看板日志，不留空占位（2026-11-12 起服务不再占终端标签）", () => {
    expect(galleryServiceFailureMessage(target, { reason: "exited", exitCode: 0 })).toContain("运行中的服务");
    expect(galleryServiceFailureMessage(target, { reason: "exited", exitCode: 0 })).not.toContain("终端标签");
  });

  it("命令正常结束（代码 0）但服务未就绪：按启动失败报（平台拿不回进程，无法建立可回收所有权）", () => {
    // 2026-11-16 契约变了：pythonw / start 这类启动器不再算正常成功路径
    const message = galleryServiceFailureMessage(target, { reason: "ended" });
    expect(message).toContain("服务就绪前就结束了");
    expect(message).toContain("可回收的服务所有权");
    expect(message).toContain("前台");
    expect(message).toContain("pythonw");
    // 不再是「进程结束是正常的，稍等再点一次运行」这种安慰式文案
    expect(message).not.toContain("进程结束是正常的");
    // toast 是纯文本流式：不能带 Markdown 标记或多行
    expect(message).not.toContain("**");
    expect(message).not.toContain("\n");
  });

  it("超时不是终局：进程留在后台，明确给出「再点一次运行」的出路", () => {
    const message = galleryServiceFailureMessage(target, { reason: "timeout" }, 30_000);
    expect(message).toContain("30 秒");
    expect(message).toContain("再点一次「运行」");
    expect(message).toContain("http://localhost:8787");
    // 进程没有因此消失：这句话要交代清楚，否则用户会以为被平台丢掉了
    expect(message).toContain("转到后台");
  });

  it("地址无法解析：指回继续开发修正", () => {
    expect(galleryServiceFailureMessage(target, { reason: "invalid-url" })).toContain("无法解析");
  });

  it("尾部只留末尾 limit 字符并加省略号", () => {
    expect(compactServiceTail("  a\n b\t c  ", 100)).toBe("a b c");
    const long = "x".repeat(300);
    expect(compactServiceTail(long, 200)).toHaveLength(201);
    expect(compactServiceTail(long, 200).startsWith("…")).toBe(true);
  });
});

describe("galleryServiceLive（看板/角标的唯一判据）", () => {
  it("启动中与运行中算活着；已停止/失败算死", () => {
    const base = { id: "s1", appId: "g1", title: "反代", command: "node proxy.js", cwd: "D:/ws", startedAt: 1, ready: false };
    expect(galleryServiceLive({ ...base, status: "starting" })).toBe(true);
    expect(galleryServiceLive({ ...base, status: "running" })).toBe(true);
    expect(galleryServiceLive({ ...base, status: "stopped" })).toBe(false);
    expect(galleryServiceLive({ ...base, status: "failed" })).toBe(false);
  });
});

describe("galleryThumbEligible / galleryThumbName", () => {
  it("网页入口（file 与 panel）可离屏渲染；非网页与 server 不直接截", () => {
    expect(galleryThumbEligible(app())).toBe(true);
    expect(galleryThumbEligible(app({ entry: "index.htm" }))).toBe(true);
    expect(galleryThumbEligible(app({ entry: "logo.svg" }))).toBe(true);
    expect(galleryThumbEligible(app({ kind: "panel", entry: "panels/status/index.html" }))).toBe(true);
    expect(galleryThumbEligible(app({ entry: "main.js" }))).toBe(false);
    expect(galleryThumbEligible(app({ kind: "server", entry: "." }))).toBe(false);
  });

  it("缩略图名带时间戳且以 gallery- 开头（与截图同风格，便于识别归属）", () => {
    expect(galleryThumbName(new Date(2026, 8, 20, 9, 30, 12, 123).getTime())).toBe("gallery-20260920-093012-123.png");
  });
});

describe("gallerySnapshotTarget（自动截图来源）", () => {
  it("file / panel 的网页入口 → 截本地文件；入口是位图 → 直接缩放", () => {
    expect(gallerySnapshotTarget(app())).toEqual({ kind: "file", path: "D:/ws/designs/exports/demo.html" });
    expect(gallerySnapshotTarget(app({ kind: "panel", entry: "panels/status/index.html" }))).toEqual({ kind: "file", path: "D:/ws/panels/status/index.html" });
    expect(gallerySnapshotTarget(app({ entry: "shots/cover.png" }))).toEqual({ kind: "image", path: "D:/ws/shots/cover.png" });
    // svg 走离屏渲染（保住矢量细节），不当图片处理
    expect(gallerySnapshotTarget(app({ entry: "logo.svg" }))).toEqual({ kind: "file", path: "D:/ws/logo.svg" });
  });

  it("server 只给 url（可达性由调用方探活决定）；非网页入口 → undefined", () => {
    expect(gallerySnapshotTarget(app({ kind: "server", entry: ".", url: "http://localhost:5173" }))).toEqual({ kind: "url", url: "http://localhost:5173" });
    expect(gallerySnapshotTarget(app({ kind: "server", entry: "." }))).toBeUndefined();
    expect(gallerySnapshotTarget(app({ entry: "notes.md" }))).toBeUndefined();
  });
});

describe("galleryPlaceholderCoverHtml（拿不到画面时的兜底封面）", () => {
  it("含标题、类型标签、工作区名与入口，且完全自包含", () => {
    const html = galleryPlaceholderCoverHtml(app({ title: "记账小工具", kind: "server", entry: ".", description: "本地记账" }));
    expect(html).toContain("记账小工具");
    expect(html).toContain("服务");
    expect(html).toContain("ws");
    expect(html).toContain("工作区根目录");
    expect(html).toContain("本地记账");
    expect(html).toContain("1440px");
    expect(html).toContain("900px");
    // 无外链（离屏截图不依赖网络与主题）
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<script");
  });

  it("标题/描述里的 HTML 字符被转义（作品名可能来自用户输入）", () => {
    const html = galleryPlaceholderCoverHtml(app({ title: '<img src=x onerror="boom">', description: "a & b" }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).toContain("a &amp; b");
  });

  it("三种类型用不同主色（卡片一眼区分形态）", () => {
    const gradients = (["file", "server", "panel"] as const).map((kind) =>
      galleryPlaceholderCoverHtml(app({ kind })).match(/radial-gradient[^;]+/u)?.[0]
    );
    expect(gradients.every(Boolean)).toBe(true);
    expect(new Set(gradients).size).toBe(3);
  });
});

describe("galleryCoverNote / coverSource 归一化", () => {
  it("按来源说清封面是什么；占位封面提示怎么更新", () => {
    expect(galleryCoverNote("custom")).toContain("自定义封面");
    expect(galleryCoverNote("entry")).toContain("入口");
    expect(galleryCoverNote("service")).toContain("服务页截图");
    expect(galleryCoverNote("generated")).toContain("占位封面");
    expect(galleryCoverNote("generated")).toContain("重新发布");
    expect(galleryCoverNote(undefined, "封面图片必须位于作品工作区内")).toContain("封面图片必须位于作品工作区内");
  });

  it("只在有缩略图时保留白名单来源", () => {
    const base = { id: "g1", title: "t", kind: "file", workspace: "D:/ws", entry: "a.html", createdAt: 1, updatedAt: 1 };
    expect(normalizeGalleryApp({ ...base, thumb: "gallery-1.png", coverSource: "generated" })?.coverSource).toBe("generated");
    expect(normalizeGalleryApp({ ...base, thumb: "gallery-1.png", coverSource: "nope" })?.coverSource).toBeUndefined();
    // 没有 thumb 时来源无意义，读侧丢掉
    expect(normalizeGalleryApp({ ...base, coverSource: "custom" })?.coverSource).toBeUndefined();
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
    // 2026-11-12：进程在后台跑，继续开发的人不能假设有终端可看/可交互
    expect(message).toContain("后台进程");
    expect(message).toContain("运行中的服务");
    expect(message).toContain("后台进程 + 打开页面");
  });

  it("纯后台服务在注入文本里点明「不打开页面」", () => {
    const message = composeGalleryDevMessage(app({ kind: "server", entry: ".", command: "node proxy.js", url: "http://127.0.0.1:8787", runMode: "background" }));
    expect(message).toContain("纯后台进程（不打开页面）");
    expect(message).toContain("只起进程、不打开页面");
  });
});

describe("面板作品（kind=panel）", () => {
  const panel = { kind: "panel" as const, entry: "panels/status/index.html" };

  it("normalizeGalleryPanelOptions 夹取尺寸、只收 boolean 置顶，全非法即 undefined", () => {
    expect(normalizeGalleryPanelOptions({ width: 99999, height: 1 })).toEqual({ width: 1600, height: 120 });
    expect(normalizeGalleryPanelOptions({ width: 420.6, height: 560.4, alwaysOnTop: true })).toEqual({ width: 421, height: 560, alwaysOnTop: true });
    expect(normalizeGalleryPanelOptions({ alwaysOnTop: "yes" })).toBeUndefined();
    expect(normalizeGalleryPanelOptions(null)).toBeUndefined();
    expect(normalizeGalleryPanelOptions([])).toBeUndefined();
    expect(normalizeGalleryPanelOptions("420x560")).toBeUndefined();
  });

  it("normalizeGalleryPanelOptions：mode 只收合法枚举，edge 只属于抽屉", () => {
    expect(normalizeGalleryPanelOptions({ mode: "pet", width: 280 })).toEqual({ mode: "pet", width: 280 });
    expect(normalizeGalleryPanelOptions({ mode: "drawer", edge: "left" })).toEqual({ mode: "drawer", edge: "left" });
    // 非法形态丢弃（回退普通窗口）；window 是缺省值，不落字段
    expect(normalizeGalleryPanelOptions({ mode: "widget" })).toBeUndefined();
    expect(normalizeGalleryPanelOptions({ mode: "window" })).toBeUndefined();
    // edge 在非抽屉形态下无意义，丢弃（避免「桌宠贴边」这种语义存进清单）
    expect(normalizeGalleryPanelOptions({ mode: "pet", edge: "right" })).toEqual({ mode: "pet" });
    expect(normalizeGalleryPanelOptions({ mode: "drawer", edge: "middle" })).toEqual({ mode: "drawer" });
    // mode 非法时 edge 一并丢弃（没有形态就没有贴边）
    expect(normalizeGalleryPanelOptions({ edge: "right" })).toBeUndefined();
  });

  it("panelMode 缺省 window；置顶缺省：桌宠置顶、其余不置顶（可显式改写）", () => {
    expect(panelMode(undefined)).toBe("window");
    expect(panelMode({ mode: "pet" })).toBe("pet");
    expect(panelEffectiveAlwaysOnTop(undefined)).toBe(false);
    expect(panelEffectiveAlwaysOnTop({ mode: "pet" })).toBe(true);
    expect(panelEffectiveAlwaysOnTop({ mode: "pet", alwaysOnTop: false })).toBe(false);
    expect(panelEffectiveAlwaysOnTop({ mode: "drawer" })).toBe(false);
    expect(panelEffectiveAlwaysOnTop({ mode: "drawer", alwaysOnTop: true })).toBe(true);
    expect(panelEffectiveAlwaysOnTop({ alwaysOnTop: true })).toBe(true);
  });

  it("panelWindowSize 缺省为 420×560（素材没声明尺寸时的开窗大小）", () => {
    expect(panelWindowSize()).toEqual({ width: PANEL_DEFAULT_WIDTH, height: PANEL_DEFAULT_HEIGHT });
    expect(panelWindowSize({ width: 320 })).toEqual({ width: 320, height: PANEL_DEFAULT_HEIGHT });
    expect(panelWindowSize({ height: 720 })).toEqual({ width: PANEL_DEFAULT_WIDTH, height: 720 });
  });

  it("读侧归一化：入口必须是具体网页（根目录入口的面板直接丢弃）", () => {
    const normalized = normalizeGalleryApp({ ...app(panel), panel: { width: 500, alwaysOnTop: true } });
    expect(normalized?.kind).toBe("panel");
    expect(normalized?.panel).toEqual({ width: 500, alwaysOnTop: true });
    expect(normalizeGalleryApp({ ...app(panel), entry: "." })).toBeUndefined();
  });

  it("panel 字段只属于面板类型（网页/服务型作品不会莫名其妙带上窗口偏好）", () => {
    expect(normalizeGalleryApp({ ...app({ kind: "file" }), panel: { width: 500 } })?.panel).toBeUndefined();
    expect(normalizeGalleryApp({ ...app({ kind: "server", entry: "." }), panel: { width: 500 } })?.panel).toBeUndefined();
  });

  it("galleryRunTarget 面板走自己的通道（不走内置浏览器），并带走可选的本地服务", () => {
    expect(galleryRunTarget(app(panel))).toEqual({ kind: "panel", absolutePath: "D:/ws/panels/status/index.html" });
    expect(galleryRunTarget(app({ ...panel, command: "node bridge.mjs", url: "http://127.0.0.1:8791/api/health" }))).toEqual({
      kind: "panel",
      absolutePath: "D:/ws/panels/status/index.html",
      command: "node bridge.mjs",
      url: "http://127.0.0.1:8791/api/health"
    });
  });

  it("galleryRunPlan：面板没声明本地服务时不受服务可达性影响，options 已归一化", () => {
    expect(galleryRunPlan(app(panel), true)).toEqual({
      action: "open-panel",
      absolutePath: "D:/ws/panels/status/index.html",
      options: {}
    });
    expect(galleryRunPlan(app({ ...panel, panel: { width: 99999, alwaysOnTop: true } }), false)).toEqual({
      action: "open-panel",
      absolutePath: "D:/ws/panels/status/index.html",
      options: { width: 1600, alwaysOnTop: true }
    });
    expect(galleryRunPlan(app({ ...panel, panel: { mode: "drawer", edge: "bottom" } }), false)).toEqual({
      action: "open-panel",
      absolutePath: "D:/ws/panels/status/index.html",
      options: { mode: "drawer", edge: "bottom" }
    });
  });

  it("galleryRunPlan：面板声明了 command + url 才先起服务；已在跑就直开窗", () => {
    const panels = "D:/ws/panels/status/index.html";
    const withService = app({ ...panel, command: "node bridge.mjs", url: "http://127.0.0.1:8791/api/health" });
    // 服务不可达 → 先起服务再开窗；cwd 是入口所在目录（启动命令在作品目录里执行）
    expect(galleryRunPlan(withService, false)).toEqual({
      action: "start-panel-service",
      absolutePath: panels,
      options: {},
      directory: "D:/ws/panels/status",
      command: "node bridge.mjs",
      url: "http://127.0.0.1:8791/api/health"
    });
    // 服务已可达（用户手工起的或上次运行留下的）→ 直接开窗，绝不重启用户正在用的服务
    expect(galleryRunPlan(withService, true)).toEqual({ action: "open-panel", absolutePath: panels, options: {} });
    // 声明了服务也要带上归一化后的窗口偏好（尺寸/形态不能在这一支里丢）
    expect(galleryRunPlan(app({ ...panel, panel: { width: 99999 }, command: "node bridge.mjs", url: "http://127.0.0.1:8791/api/health" }), false)).toEqual({
      action: "start-panel-service",
      absolutePath: panels,
      options: { width: 1600 },
      directory: "D:/ws/panels/status",
      command: "node bridge.mjs",
      url: "http://127.0.0.1:8791/api/health"
    });
  });

  it("galleryRunPlan：面板本地服务字段不成对 → manual + 具体原因（不再静默直开窗）", () => {
    const panels = "D:/ws/panels/status/index.html";
    // 只给 command：平台无法探活，也无从确认服务是否就绪
    for (const reachable of [false, true]) {
      const plan = galleryRunPlan(app({ ...panel, command: "node bridge.mjs" }), reachable);
      expect(plan.action).toBe("manual");
      expect(plan.action === "manual" ? plan.message : "").toContain("没有探活地址");
    }
    // 只给 url：无论此刻是否可达都是配置错误（成对规则），不能当外部服务放行
    for (const reachable of [false, true]) {
      const plan = galleryRunPlan(app({ ...panel, url: "http://127.0.0.1:8791/api/health" }), reachable);
      expect(plan.action).toBe("manual");
      const message = plan.action === "manual" ? plan.message : "";
      expect(message).toContain("没有启动命令");
      expect(message).toContain("http://127.0.0.1:8791/api/health");
    }
    // 反面：不成对时绝不能返回 open-panel（否则用户看到一个永远取不到数据的窗）
    expect(galleryRunPlan(app({ ...panel, command: "node bridge.mjs" }), false).action).not.toBe("open-panel");
    // 两个都不填 = 不依赖平台托管的本地服务 → 直开窗
    expect(galleryRunPlan(app(panel), false)).toEqual({ action: "open-panel", absolutePath: panels, options: {} });
  });

  it("面板也生成封面（2026-10-28 用户要求每个作品都有封面；离屏截图是页面骨架）", () => {
    expect(galleryThumbEligible(app(panel))).toBe(true);
  });

  it("继续开发文案带上窗口尺寸、置顶与数据接口（接手改面板的模型不用猜）", () => {
    const message = composeGalleryDevMessage(app({ ...panel, panel: { width: 320, height: 400, alwaysOnTop: true } }));
    expect(message).toContain("类型：面板（panel）");
    expect(message).toContain("窗口：320×400，系统边框窗口，置顶");
    expect(message).toContain("__pidesktop_state.json");
    // 未声明时置顶不能凭空出现
    expect(composeGalleryDevMessage(app(panel))).toContain("窗口：420×560，系统边框窗口\n");
  });

  it("继续开发文案按形态说清窗口形态与动作（桌宠/抽屉的页面契约不同）", () => {
    const pet = composeGalleryDevMessage(app({ ...panel, panel: { mode: "pet", width: 280, height: 340 } }));
    expect(pet).toContain("透明无边框桌宠窗口");
    expect(pet).toContain("窗口：280×340，透明无边框桌宠窗口（固定尺寸，页面自绘形状，CSS -webkit-app-region: drag 拖动），置顶");
    const drawer = composeGalleryDevMessage(app({ ...panel, panel: { mode: "drawer", edge: "left" } }));
    expect(drawer).toContain("贴边抽屉（left 缘窄条，点击窄条 POST toggle 展开/收起）");
    const hint = composeGalleryDevMessage(app(panel));
    expect(hint).toContain('"action\":\"close\"');
    expect(hint).toContain('"action\":\"toggle\"');
  });
});

describe("resolveGalleryEntry（path + entry 的唯一解析口径）", () => {
  const root = "D:/ws";

  it("file/panel 只给 path：path 就是最终入口", () => {
    expect(resolveGalleryEntry({ root, path: "designs/demo.html", kind: "file" }))
      .toEqual({ entry: "designs/demo.html", absolutePath: "D:/ws/designs/demo.html" });
    expect(resolveGalleryEntry({ root, path: "panels/status/index.html", kind: "panel" }).entry).toBe("panels/status/index.html");
  });

  it("目录 + entry：最终入口 = path/entry（清单里只存最终入口，不存二义性的两段路径）", () => {
    expect(resolveGalleryEntry({ root, path: "panels/status", entry: "index.html", kind: "panel" }))
      .toEqual({ entry: "panels/status/index.html", absolutePath: "D:/ws/panels/status/index.html" });
    expect(resolveGalleryEntry({ root, path: "designs", entry: "exports/demo.html", kind: "file" }).entry).toBe("designs/exports/demo.html");
    // "./index.html" 这类写法同样归一
    expect(resolveGalleryEntry({ root, path: "panels/status", entry: "./index.html", kind: "panel" }).entry).toBe("panels/status/index.html");
    // path 是工作区根时 entry 直接从根开始
    expect(resolveGalleryEntry({ root, path: ".", entry: "index.html", kind: "file" }).entry).toBe("index.html");
  });

  it("绝对路径与相对路径得到同一个最终入口（两种写法不能出两张卡）", () => {
    const relative = resolveGalleryEntry({ root, path: "panels/status", entry: "index.html", kind: "panel" });
    expect(resolveGalleryEntry({ root, path: "D:/ws/panels/status", entry: "index.html", kind: "panel" })).toEqual(relative);
    expect(resolveGalleryEntry({ root, path: "D:\\ws\\designs\\demo.html", kind: "file" }))
      .toEqual(resolveGalleryEntry({ root, path: "designs/demo.html", kind: "file" }));
    // 大小写不同的盘符路径也是同一个入口（Windows 不区分）
    expect(resolveGalleryEntry({ root, path: "d:/WS/designs/demo.html", kind: "file" }).entry).toBe("designs/demo.html");
  });

  it("`a/../b.html` 折叠成 `b.html`（否则同一个文件会因两种写法变成两张卡）", () => {
    expect(resolveGalleryEntry({ root, path: "designs/../demo.html", kind: "file" }).entry).toBe("demo.html");
    expect(resolveGalleryEntry({ root, path: "designs/./x/../../demo.html", kind: "file" }).entry).toBe("demo.html");
  });

  it("越界一律拒绝：工作区外 / entry 跳出目录 / entry 用绝对路径", () => {
    expect(() => resolveGalleryEntry({ root, path: "../outside.html", kind: "file" })).toThrow(/工作区内/u);
    expect(() => resolveGalleryEntry({ root, path: "D:/other/demo.html", kind: "file" })).toThrow(/工作区内/u);
    expect(() => resolveGalleryEntry({ root, path: "panels", entry: "../x.html", kind: "panel" })).toThrow(/不能跳出/u);
    expect(() => resolveGalleryEntry({ root, path: "panels", entry: "D:/other/index.html", kind: "panel" })).toThrow(/相对路径/u);
  });

  it("server 禁止 entry；path 为根目录时入口是 \".\"", () => {
    expect(() => resolveGalleryEntry({ root, path: "apps/api", entry: "index.html", kind: "server" })).toThrow(/不支持 entry/u);
    expect(resolveGalleryEntry({ root, path: ".", kind: "server" })).toEqual({ entry: ".", absolutePath: "D:/ws" });
    expect(resolveGalleryEntry({ root, path: "apps/api", kind: "server" }).entry).toBe("apps/api");
  });

  it("面板入口不能是工作区根；path 已经是文件时再给 entry 得到明确的错", () => {
    expect(() => resolveGalleryEntry({ root, path: ".", kind: "panel" })).toThrow(/网页文件/u);
    expect(() => resolveGalleryEntry({ root, path: "panels/status/index.html", entry: "index.html", kind: "panel" })).toThrow(/已经指向文件/u);
  });

  it("POSIX 根与 Windows 盘符根：绝对路径换算不丢根", () => {
    expect(galleryEntryFromAbsolute("/", "/a/b.html")).toBe("a/b.html");
    expect(galleryEntryFromAbsolute("/", "/")).toBe(".");
    expect(galleryEntryFromAbsolute("D:/", "D:/ws/a.html")).toBe("ws/a.html");
    expect(galleryEntryFromAbsolute("D:\\ws\\", "D:/ws/")).toBe(".");
    expect(galleryAbsolutePath("/", "a.html")).toBe("/a.html");
    expect(galleryAbsolutePath("/", ".")).toBe("/");
    expect(galleryAbsolutePath("D:\\ws", "a/b.html")).toBe("D:\\ws/a/b.html");
    // POSIX 根下也算得出最终入口
    expect(resolveGalleryEntry({ root: "/", path: "/srv/app/index.html", kind: "file" }).entry).toBe("srv/app/index.html");
  });

  it("POSIX 大小写敏感、Windows 不敏感（/home/ws 与 /home/WS 是两个目录）", () => {
    expect(galleryEntryFromAbsolute("/home/ws", "/home/ws/a.html")).toBe("a.html");
    expect(galleryEntryFromAbsolute("/home/ws", "/home/WS/a.html")).toBeUndefined();
    // 前缀相同但不同目录（ws 与 ws2）不能被当成子路径
    expect(galleryEntryFromAbsolute("/home/ws", "/home/ws2/a.html")).toBeUndefined();
    expect(galleryEntryFromAbsolute("D:/ws", "d:/WS/a.html")).toBe("a.html");
    expect(galleryWorkspaceKey("/home/ws")).not.toBe(galleryWorkspaceKey("/home/WS"));
    expect(galleryWorkspaceKey("D:\\ws\\")).toBe(galleryWorkspaceKey("d:/WS"));
  });

  it("isAbsoluteGalleryPath / foldGalleryEntry 的边界", () => {
    expect(isAbsoluteGalleryPath("C:/x")).toBe(true);
    expect(isAbsoluteGalleryPath("/x")).toBe(true);
    expect(isAbsoluteGalleryPath("a/b")).toBe(false);
    expect(foldGalleryEntry("a/./b/../c.html")).toBe("a/c.html");
    expect(foldGalleryEntry("..")).toBeUndefined();
    expect(foldGalleryEntry("")).toBe(".");
  });
});

describe("面板本地服务的成对规则与所有权", () => {
  it("command / url 成对：两个都填或两个都不填才算合法", () => {
    expect(galleryPanelServicePairError(undefined, undefined)).toBeUndefined();
    expect(galleryPanelServicePairError("node b.mjs", "http://127.0.0.1:1/x")).toBeUndefined();
    expect(galleryPanelServicePairError("node b.mjs", "  ")).toContain("成对");
    expect(galleryPanelServicePairError("   ", "http://127.0.0.1:1/x")).toContain("成对");
  });

  it("所有权只看配置（运行时是否可达不影响判定）", () => {
    expect(galleryServiceOwnership({ kind: "panel" })).toBe("none");
    expect(galleryServiceOwnership({ kind: "panel", command: "node b.mjs", url: "http://127.0.0.1:1/x" })).toBe("platform");
    expect(galleryServiceOwnership({ kind: "panel", command: "node b.mjs" })).toBe("misconfigured");
    expect(galleryServiceOwnership({ kind: "panel", url: "http://127.0.0.1:1/x" })).toBe("misconfigured");
    expect(galleryServiceOwnership({ kind: "server", command: "node api.js" })).toBe("platform");
    expect(galleryServiceOwnership({ kind: "server", url: "http://x" })).toBe("external");
    expect(galleryServiceOwnership({ kind: "file", command: "node x" })).toBe("none");
  });

  it("回执文案只陈述配置，不断言「已启动」", () => {
    expect(galleryServiceNote({ kind: "panel" })).toContain("未配置");
    const managed = galleryServiceNote({ kind: "panel", command: "node b.mjs", url: "http://127.0.0.1:1/x" });
    expect(managed).toContain("已配置（command + url）");
    expect(managed).toContain("复用外部服务");
    expect(managed).toContain("只停平台实际启动的那个进程");
    expect(managed).not.toContain("已启动");
    expect(galleryServiceNote({ kind: "panel", command: "node b.mjs" })).toContain("配置不完整");
    expect(galleryServiceNote({ kind: "server", command: "node api.js" })).toBe("");
  });
});

describe("resolveGalleryPublish（发布/更新的唯一判定）", () => {
  const workspace = "D:/ws";

  it("新建：created=true，id 留给 upsert 生成，入口是最终相对入口", () => {
    const result = resolveGalleryPublish({ apps: [], draft: { title: "新作品", kind: "file", path: "designs/demo.html" }, workspace });
    expect(result.created).toBe(true);
    expect(result.app.id).toBe("");
    expect(result.app.entry).toBe("designs/demo.html");
    expect(result.app.workspace).toBe(workspace);
    expect(result.target).toBeUndefined();
    const published = upsertGalleryApp([], result.app, 2000);
    expect(published.app.id).toMatch(/^g-/u);
  });

  it("同「工作区+类型+最终入口」重复发布 = 更新（id / createdAt / thumb 都不变）", () => {
    const existing = app({ id: "g-old", entry: "designs/demo.html", thumb: "gallery-1.png", coverSource: "custom", createdAt: 1000 });
    const result = resolveGalleryPublish({ apps: [existing], draft: { title: "改了标题", kind: "file", path: "designs/demo.html" }, workspace });
    expect(result.created).toBe(false);
    expect(result.app.id).toBe("g-old");
    expect(result.app.createdAt).toBe(1000);
    const merged = upsertGalleryApp([existing], result.app, 3000).app;
    expect(merged.id).toBe("g-old");
    expect(merged.createdAt).toBe(1000);
    expect(merged.thumb).toBe("gallery-1.png");
    expect(merged.title).toBe("改了标题");
  });

  it("目录 + entry 与直接给文件命中同一条（不出重复卡）", () => {
    const list = [app({ id: "g-panel", kind: "panel", entry: "panels/status/index.html" })];
    const viaEntry = resolveGalleryPublish({ apps: list, draft: { title: "状态", kind: "panel", path: "panels/status", entry: "index.html" }, workspace });
    expect(viaEntry.created).toBe(false);
    expect(viaEntry.app.id).toBe("g-panel");
    expect(viaEntry.entry.entry).toBe("panels/status/index.html");
  });

  it("`a/../b` 与 `b` 是同一入口（折叠后命中同一条，不新增卡）", () => {
    const first = resolveGalleryPublish({ apps: [], draft: { title: "t", kind: "file", path: "designs/../demo.html" }, workspace });
    const published = upsertGalleryApp([], first.app, 1000);
    const second = resolveGalleryPublish({ apps: published.list, draft: { title: "t2", kind: "file", path: "demo.html" }, workspace });
    expect(second.created).toBe(false);
    expect(second.app.id).toBe(published.app.id);
  });

  it("appId 优先：列表里其它项先命中入口键也不能改变更新目标", () => {
    const other = app({ id: "g-other", entry: "other.html" });
    const target = app({ id: "g-target", entry: "target.html", createdAt: 555 });
    // 目标项放在列表**后面**：upsertGalleryApp 的 find(id || key) 会先看到 g-other
    const list = [other, target];
    const result = resolveGalleryPublish({ apps: list, draft: { appId: "g-target", title: "改过", kind: "file", path: "target.html" }, workspace });
    expect(result.created).toBe(false);
    expect(result.app.id).toBe("g-target");
    expect(result.app.createdAt).toBe(555);
    const merged = upsertGalleryApp(list, result.app, 2000);
    expect(merged.app.id).toBe("g-target");
    expect(merged.list).toHaveLength(2);
    expect(merged.list.find((item) => item.id === "g-other")?.entry).toBe("other.html");
  });

  it("入口已经属于另一个作品时拒绝（不制造重复键，也不覆盖另一身份）", () => {
    const occupied = app({ id: "g-occupied", entry: "shared.html" });
    const target = app({ id: "g-target", entry: "target.html" });
    expect(() => resolveGalleryPublish({ apps: [occupied, target], draft: { appId: "g-target", title: "t", kind: "file", path: "shared.html" }, workspace }))
      .toThrow(/已经被另一个作品/u);
  });

  it("appId 不存在 / 跨工作区 / 跨类型一律报错（不静默新建、不跨区覆盖）", () => {
    const target = app({ id: "g-target", entry: "target.html" });
    expect(() => resolveGalleryPublish({ apps: [target], draft: { appId: "g-missing", title: "t", kind: "file", path: "target.html" }, workspace }))
      .toThrow(/找不到作品/u);
    expect(() => resolveGalleryPublish({ apps: [app({ id: "g-x", workspace: "D:/other" })], draft: { appId: "g-x", title: "t", kind: "file", path: "a.html" }, workspace }))
      .toThrow(/另一个工作区/u);
    expect(() => resolveGalleryPublish({ apps: [target], draft: { appId: "g-target", title: "t", kind: "server", path: "target.html" }, workspace }))
      .toThrow(/类型/u);
  });

  it("draft.workspace 不能改变校验根（填别的目录就是越界）", () => {
    expect(() => resolveGalleryPublish({ apps: [], draft: { title: "t", kind: "file", path: "a.html", workspace: "D:/other" }, workspace }))
      .toThrow(/当前会话的工作区/u);
    // 大小写 / 分隔符等价的写法不算越界（Windows 不敏感）
    expect(resolveGalleryPublish({ apps: [], draft: { title: "t", kind: "file", path: "a.html", workspace: "d:/WS/" }, workspace }).entry.entry).toBe("a.html");
  });

  it("panel 的 command/url 不成对：发布阶段直接报错（对话框 / 旧客户端也绕不过）", () => {
    expect(() => resolveGalleryPublish({ apps: [], draft: { title: "t", kind: "panel", path: "p/index.html", command: "node b.mjs" }, workspace })).toThrow(/成对/u);
    expect(() => resolveGalleryPublish({ apps: [], draft: { title: "t", kind: "panel", path: "p/index.html", url: "http://127.0.0.1:1/x" }, workspace })).toThrow(/成对/u);
  });

  it("panel 的 command/url 是权威字段：重新发布时省略 = 不要平台托管的本地服务", () => {
    const list = [app({ id: "g-p", kind: "panel", entry: "p/index.html", command: "node b.mjs", url: "http://127.0.0.1:8791/x" })];
    const cleared = resolveGalleryPublish({ apps: list, draft: { appId: "g-p", title: "t", kind: "panel", path: "p/index.html" }, workspace });
    expect(cleared.service).toBe("none");
    const merged = upsertGalleryApp(list, cleared.app, 2000).app;
    expect(merged.command).toBeUndefined();
    expect(merged.url).toBeUndefined();
    const withService = resolveGalleryPublish({ apps: list, draft: { appId: "g-p", title: "t", kind: "panel", path: "p/index.html", command: "node b.mjs", url: "http://127.0.0.1:8791/x" }, workspace });
    expect(withService.service).toBe("platform");
    expect(withService.app.command).toBe("node b.mjs");
  });

  it("panel 尺寸本次没给就沿用旧值（显示偏好不该被重发布清掉）", () => {
    const list = [app({ id: "g-p", kind: "panel", entry: "p/index.html", panel: { width: 500, mode: "drawer" } })];
    const kept = resolveGalleryPublish({ apps: list, draft: { appId: "g-p", title: "t", kind: "panel", path: "p/index.html" }, workspace });
    expect(kept.app.panel).toEqual({ width: 500, mode: "drawer" });
    const replaced = resolveGalleryPublish({ apps: list, draft: { appId: "g-p", title: "t", kind: "panel", path: "p/index.html", panel: { width: 300 } }, workspace });
    expect(replaced.app.panel).toEqual({ width: 300 });
  });

  it("server 省略 command/url 沿用旧值；runMode 可显式回落 page", () => {
    const list = [app({ id: "g-s", kind: "server", entry: "apps/api", command: "node api.js", url: "http://127.0.0.1:9000", runMode: "background" })];
    const kept = resolveGalleryPublish({ apps: list, draft: { appId: "g-s", title: "t", kind: "server", path: "apps/api" }, workspace });
    expect(kept.app.command).toBe("node api.js");
    expect(kept.app.url).toBe("http://127.0.0.1:9000");
    expect(kept.app.runMode).toBe("background");
    const toPage = resolveGalleryPublish({ apps: list, draft: { appId: "g-s", title: "t", kind: "server", path: "apps/api", runMode: "page" }, workspace });
    expect(toPage.app.runMode).toBeUndefined();
  });

  it("file 作品不会带上 command / url / runMode（脏字段不落盘）", () => {
    const result = resolveGalleryPublish({ apps: [], draft: { title: "t", kind: "file", path: "a.html", command: "npm run dev", url: "http://x", runMode: "background" }, workspace });
    expect(result.app.command).toBeUndefined();
    expect(result.app.url).toBeUndefined();
    expect(result.app.runMode).toBeUndefined();
    expect(result.service).toBe("none");
  });
});

describe("继续开发：稳定身份与回发布协议（2026-11-16）", () => {
  it("注入文本带作品 ID、最终入口、固定 origin 与「用同一 appId 重新发布」的协议", () => {
    const message = composeGalleryDevMessage(app({
      id: "g-panel",
      kind: "panel",
      entry: "panels/status/index.html",
      command: "node bridge.mjs",
      url: "http://127.0.0.1:8791/api/health"
    }));
    expect(message).toContain("作品 ID：g-panel");
    expect(message).toContain("入口：panels/status/index.html");
    expect(message).toContain("数据 origin：pidesktop-file://w-g-panel");
    expect(message).toContain("本地服务：已配置（command + url）");
    const example = /gallery_publish\((\{[^\n]+\})\)/u.exec(message)?.[1];
    expect(example).toBeDefined();
    expect(JSON.parse(example!)).toMatchObject({
      appId: "g-panel", kind: "panel", path: "panels/status/index.html",
      command: "node bridge.mjs", url: "http://127.0.0.1:8791/api/health"
    });
    expect(message).toContain("不要改 kind（panel）与最终入口");
    expect(message).toContain("「更新」");
  });

  it("回发布示例正确转义引号与反斜杠，可解析为完整参数", () => {
    const message = composeGalleryDevMessage(app({ id: 'id"1', title: '含"引号"', entry: 'panels/一号/index.html' }));
    const example = /gallery_publish\((\{[^\n]+\})\)/u.exec(message)?.[1];
    expect(JSON.parse(example!)).toMatchObject({ appId: 'id"1', title: '含"引号"', path: "panels/一号/index.html" });
  });

  it("没有本地服务的 panel：明确要求不要把 command/url 带上", () => {
    const message = composeGalleryDevMessage(app({ kind: "panel", entry: "panels/status/index.html" }));
    expect(message).toContain("本地服务：未配置");
    expect(message).toContain("command / url 都不要带");
  });

  it("服务型：保留后台进程说明，回发布协议用最终入口", () => {
    const message = composeGalleryDevMessage(app({ kind: "server", entry: ".", command: "node api.js", runMode: "background" }));
    expect(message).toContain("作品 ID：g1");
    const example = /gallery_publish\((\{[^\n]+\})\)/u.exec(message)?.[1];
    expect(example).toBeDefined();
    expect(JSON.parse(example!)).toMatchObject({ kind: "server", path: "." });
    expect(message).toContain("后台进程");
  });
});
