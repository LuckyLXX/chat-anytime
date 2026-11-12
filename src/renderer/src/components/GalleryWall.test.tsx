import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GalleryApp, GalleryServiceRecord } from "../../../shared/gallery";
import { GalleryMenu } from "./GalleryMenu";
import { GalleryWall } from "./GalleryWall";
import { GalleryDataDialog, GalleryPublishDialog, GalleryWallDialog } from "./GalleryDialogs";

/**
 * 作品墙 / 顶栏下拉的结构钩子契约测试。
 *
 * 这些钩子（`data-pane="gallery-menu"` / `gallery-wall` 与六个 `data-control="gallery-*"`）
 * 是**公开主题 API**，五处镜像（AGENTS.md、docs/theme-guide.md、pidesktop-theme-creator
 * 的 SKILL.md 与 check_theme.py、源码）必须与这里一致 —— 与 SshFilesPanel.test.tsx 同一
 * 口径。交互行为（运行分流、注入、发布）由 gallery / gallery-store / runtime-gallery 的
 * 单测与真机冒烟覆盖，这里只钉字符串契约。
 */

const apps: GalleryApp[] = [
  { id: "g1", title: "收纳整理 App 原型", kind: "file", workspace: "D:/ws", entry: "designs/exports/demo.html", createdAt: 1, updatedAt: 1 },
  { id: "g2", title: "记账小工具", kind: "server", workspace: "D:/ws", entry: "apps/ledger", command: "npm run dev", url: "http://localhost:5173", createdAt: 1, updatedAt: 2 },
  { id: "g3", title: "会话状态面板", kind: "panel", workspace: "D:/ws", entry: "panels/status/index.html", panel: { width: 420, height: 560, alwaysOnTop: true }, createdAt: 1, updatedAt: 3 }
];

function noop(): void {
  // 契约测试不触发回调
}

/** 看板的服务 fixture：一个在跑（带 url 与日志）、一个已失败（看日志/移出的形态）。 */
const services: GalleryServiceRecord[] = [
  { id: "s1", appId: "g2", title: "记账小工具", command: "npm run dev", cwd: "D:/ws/apps/ledger", url: "http://localhost:5173", pid: 12_345, status: "running", ready: true, startedAt: Date.now() - 65_000 },
  { id: "s2", appId: "g2", title: "记账小工具", command: "npm run dev", cwd: "D:/ws/apps/ledger", status: "failed", ready: false, startedAt: Date.now() - 90_000, endedAt: Date.now() - 80_000, exitCode: 1, note: "进程已退出（退出码 1）", log: "Error: EADDRINUSE" }
];

/** GalleryWall 的必需 props 骨架（服务看板三件套每处都要传，集中在这里避免漂移）。 */
const wallChrome = { onOpenServicePage: noop, onStopService: noop, onRestartService: noop, services: [] as GalleryServiceRecord[] };

describe("GalleryMenu theme hooks", () => {
  it("carries the topbar dropdown hooks (toggle + menu container)", () => {
    const markup = renderToStaticMarkup(<GalleryMenu apps={apps} onRun={noop} onDevelop={noop} onOpenWall={noop} onPublish={noop} />);
    expect(markup).toContain('data-pane="gallery-menu"');
    expect(markup).toContain('data-control="gallery-toggle"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("shows the 作品 count badge only when the pool is non-empty", () => {
    expect(renderToStaticMarkup(<GalleryMenu apps={apps} onRun={noop} onDevelop={noop} onOpenWall={noop} onPublish={noop} />)).toContain("gallery-toggle-count");
    expect(renderToStaticMarkup(<GalleryMenu apps={[]} onRun={noop} onDevelop={noop} onOpenWall={noop} onPublish={noop} />)).not.toContain("gallery-toggle-count");
  });
});

describe("GalleryWall theme hooks", () => {
  it("carries the wall container + per-card action hooks", () => {
    const markup = renderToStaticMarkup(<GalleryWall apps={apps} workspace="D:/ws" onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} {...wallChrome} />);
    expect(markup).toContain('data-pane="gallery-wall"');
    for (const control of ["gallery-run", "gallery-develop", "gallery-publish", "gallery-remove", "gallery-reveal", "gallery-data"]) {
      expect(markup).toContain(`data-control="${control}"`);
    }
    // 数据入口只给面板作品：fixture 里只有 g3 是面板，所以恰好一个；
    // 「打开所在文件夹」则每张卡片都有（三张卡）。
    expect(markup.match(/data-control="gallery-data"/gu)?.length).toBe(1);
    expect(markup.match(/data-control="gallery-reveal"/gu)?.length).toBe(3);
    // 卡片带作品 id，便于主题/调试定位
    expect(markup).toContain('data-gallery-id="g1"');
    expect(markup).toContain('data-gallery-id="g2"');
  });

  it("renders the landing empty state (not the grid) when the pool is empty", () => {
    const markup = renderToStaticMarkup(<GalleryWall apps={[]} onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} {...wallChrome} />);
    expect(markup).toContain('data-pane="landing"');
    expect(markup).not.toContain('data-pane="gallery-wall"');
    // 保留原空态语义的引导文案 + 发布入口
    expect(markup).toContain("今天想开发什么？");
    expect(markup).toContain('data-control="gallery-publish"');
  });

  it("卡片直接显示工作区名，跨工作区时高亮（不用悬停也能找到源文件在哪个工作区）", () => {
    const current = renderToStaticMarkup(<GalleryWall apps={[apps[0]!]} workspace="D:/ws" onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} {...wallChrome} />);
    // 同工作区：名字照常显示，但不带高亮标记
    expect(current).toContain(">ws<");
    expect(current).not.toContain("gallery-card-workspace is-other");
    expect(current).toContain("title=\"工作区：D:/ws\"");
    // 跨工作区：高亮标记 + 完整路径仍在 tooltip 里
    const other = renderToStaticMarkup(<GalleryWall apps={[apps[0]!]} workspace="D:/other" onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} {...wallChrome} />);
    expect(other).toContain("gallery-card-workspace is-other");
    expect(other).toContain("title=\"作品在另一个工作区（当前：D:/other）：D:/ws\"");
  });

  it("面板作品有独立的类型徽标与图标（不跟网页作品混为一谈）", () => {
    const markup = renderToStaticMarkup(<GalleryWall apps={[apps[2]!]} workspace="D:/ws" onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} {...wallChrome} />);
    expect(markup).toContain('data-gallery-id="g3"');
    expect(markup).toContain(">面板<");
    expect(markup).toContain("lucide-app-window");
  });

  it("嵌入弹窗时不自带「作品墙」标题（容器头部已有，避免同屏两个同名标题）", () => {
    const embedded = renderToStaticMarkup(<GalleryWall apps={apps} embedded onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} {...wallChrome} />);
    expect(embedded).not.toContain("<h1>作品墙</h1>");
    expect(embedded).toContain("gallery-wall-embedded");
    expect(embedded).toContain("gallery-wall-count");
    // 计数与发布动作仍要在（弹窗里不能丢掉这两个信息）
    expect(embedded).toContain("个作品");
    expect(embedded).toContain('data-control="gallery-publish"');
    // 独立渲染时保留标题
    const standalone = renderToStaticMarkup(<GalleryWall apps={apps} onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} {...wallChrome} />);
    expect(standalone).toContain("<h1>作品墙</h1>");
  });
});

describe("GalleryDialogs theme hooks", () => {
  it("数据对话框带量测说明、清空入口与二次确认语义的钩子", () => {
    const markup = renderToStaticMarkup(<GalleryDataDialog app={apps[2]!} onClose={noop} />);
    expect(markup).toContain('data-control="gallery-data-clear"');
    expect(markup).toContain('aria-label="会话状态面板 的数据"');
    // 固定 origin 要写在界面上（用户找不到数据在哪，就只会以为又丢了）
    expect(markup).toContain("pidesktop-file://w-g3");
    expect(markup).toContain("清空数据");
  });

  it("wall dialog reuses the same GalleryWall hooks", () => {
    const markup = renderToStaticMarkup(<GalleryWallDialog apps={apps} workspace="D:/ws" services={services} onRun={noop} onDevelop={noop} onRemove={noop} onReveal={noop} onData={noop} onPublish={noop} onOpenServicePage={noop} onStopService={noop} onRestartService={noop} onClose={noop} />);
    expect(markup).toContain('data-pane="gallery-wall"');
    expect(markup).toContain('role="dialog"');
  });

  it("publish dialog prefills the entry path and title (文件树/预览面板入口带上的预填)", () => {
    const markup = renderToStaticMarkup(<GalleryPublishDialog initial={{ path: "designs/exports/demo.html", title: "demo.html", kind: "file" }} workspace="D:/ws" onSubmit={noop} onClose={noop} />);
    expect(markup).toContain('aria-label="登记新作品"');
    expect(markup).toContain("designs/exports/demo.html");
    expect(markup).toContain("demo.html");
  });

  it("publish dialog 有封面输入与自动取图提示（每个作品都要有封面）", () => {
    const markup = renderToStaticMarkup(<GalleryPublishDialog initial={{ path: "a.html", kind: "file" }} workspace="D:/ws" onSubmit={noop} onClose={noop} />);
    expect(markup).toContain("封面图片（可选）");
    expect(markup).toContain("留空自动截图");
    // 没填封面时不渲染预览块（留空 = 主进程自动取图）
    expect(markup).not.toContain("gallery-cover-field");
  });

  it("publish dialog offers 面板 as a third type with its window options", () => {
    const markup = renderToStaticMarkup(<GalleryPublishDialog initial={{ path: "panels/status/index.html", kind: "panel" }} workspace="D:/ws" onSubmit={noop} onClose={noop} />);
    expect(markup).toContain('<option value="panel"');
    expect(markup).toContain("gallery-panel-options");
    // 选面板时入口标签换成「入口网页」，与 kind=file 区分
    expect(markup).toContain("入口网页");
    // 网页/服务型的窗口选项不该出现
    const fileDialog = renderToStaticMarkup(<GalleryPublishDialog workspace="D:/ws" onSubmit={noop} onClose={noop} />);
    expect(fileDialog).not.toContain("gallery-panel-options");
  });
});

describe("运行中的服务看板（2026-11-12：服务进程改到主进程后台）", () => {
  it("作品墙顶部渲染看板：区域钩子 + 每行四个动作钩子 + 状态文案", () => {
    const markup = renderToStaticMarkup(<GalleryWall apps={apps} workspace="D:/ws" services={services} onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} onOpenServicePage={noop} onStopService={noop} onRestartService={noop} />);
    expect(markup).toContain('data-pane="gallery-services"');
    // 行钩子：打开页面 / 日志 / 重启 / 停止（这四项是看板对外的全部能力）
    for (const control of ["gallery-service-open", "gallery-service-log", "gallery-service-restart", "gallery-service-stop"]) {
      expect(markup).toContain(`data-control="${control}"`);
    }
    // 「在跑」与「已结束」分开计数（已结束的记录留在看板上是为了能看失败原因）
    expect(markup).toContain("1 个在后台");
    expect(markup).toContain("1 个已结束");
    // 失败记录要能看到退出码与说明（「为啥没起来」的唯一出口）
    expect(markup).toContain("退出码 1");
    expect(markup).toContain("进程已退出（退出码 1）");
    // 活着的服务才有 PID（死记录的 pid 已无意义）
    expect(markup).toContain("PID");
  });

  it("看板只在有记录时出现（空态 landing 不该多一行「暂无」）", () => {
    const markup = renderToStaticMarkup(<GalleryWall apps={apps} workspace="D:/ws" onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} {...wallChrome} />);
    expect(markup).not.toContain('data-pane="gallery-services"');
  });

  it("清单为空时看板照常显示（作品删了但进程还在跑，不能变成隐形进程）", () => {
    const markup = renderToStaticMarkup(<GalleryWall apps={[]} services={services} onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} onOpenServicePage={noop} onStopService={noop} onRestartService={noop} />);
    expect(markup).toContain('data-pane="landing"');
    expect(markup).toContain('data-pane="gallery-services"');
  });

  it("卡片上标出「服务运行中」（用户点运行的地方必须能回答「现在什么状态」）", () => {
    const markup = renderToStaticMarkup(<GalleryWall apps={[apps[1]!]} workspace="D:/ws" services={services} onRun={noop} onDevelop={noop} onPublish={noop} onRemove={noop} onReveal={noop} onData={noop} onOpenServicePage={noop} onStopService={noop} onRestartService={noop} />);
    expect(markup).toContain("gallery-service-badge");
    expect(markup).toContain("服务运行中");
  });

  it("顶栏下拉显示运行中计数（服务不占标签页后，这里是主界面唯一常驻信号）", () => {
    const markup = renderToStaticMarkup(<GalleryMenu apps={apps} runningServices={2} onRun={noop} onDevelop={noop} onOpenWall={noop} onPublish={noop} />);
    expect(markup).toContain("gallery-toggle-dot");
    expect(markup).toContain("2 个服务在后台运行");
    const idle = renderToStaticMarkup(<GalleryMenu apps={apps} onRun={noop} onDevelop={noop} onOpenWall={noop} onPublish={noop} />);
    expect(idle).not.toContain("gallery-toggle-dot");
  });
});
