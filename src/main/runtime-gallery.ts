// 作品（Gallery）自定义工具（自建能力，utility 进程内，暴露给 Pi 会话）。
//
// 「发布」是用户/模型把「已经做完、能跑、值得留下」的成果登记到作品墙的动作。
// 登记之后作品就有了常驻入口：顶栏下拉与空态作品墙里能一键运行、一键继续开发
// （否则成果就是一堆做完即沉底的文件）。
//
// 只有一个工具（永远激活，≈200 tokens/请求的前缀成本可接受）：工具描述是按请求
// 付前缀的地方，所以规范写全、数量压到最少。持久化/缩略图/推送都在 pi-runtime
// 侧的回调里（本模块只做参数校验与回执文案，便于独立单测）。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GalleryApp, GalleryDraft, GalleryKind } from "../shared/protocol.js";
import {
  GALLERY_KIND_LABELS,
  galleryPanelServicePairError,
  normalizeGalleryPanelOptions,
  type GalleryCoverSource,
  type GalleryPanelOptions,
  type GalleryRunMode
} from "../shared/gallery.js";

/** 发布结果（utility 发布实现回给工具的唯一形状）。 */
export interface GalleryPublishOutcome {
  app: GalleryApp;
  /** 封面结果说明（galleryCoverNote 或「沿用上一张」）。 */
  coverNote: string;
  coverSource?: GalleryCoverSource;
  /** true = 新增卡片；false = 就地更新既有条目（appId 优先，「工作区+类型+最终入口」兜底）。 */
  created: boolean;
  /** panel 本地服务托管状态说明（其它类型为空串）。 */
  serviceNote?: string;
}

export interface GalleryToolContext {
  /**
   * 发布/更新一个作品（draft.appId 优先，否则同「工作区 + 类型 + 最终入口」= 更新）。
   * 入口解析、越界检查与落盘由实现侧负责（这里只知道工作区根）。
   */
  publish: (draft: GalleryDraft) => Promise<GalleryPublishOutcome>;
  /** 当前作品清单（回执里给数量，让模型知道池子里有什么）。 */
  list: () => GalleryApp[];
}

const KINDS: readonly GalleryKind[] = ["file", "server", "panel"];

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 参数校验（纯函数，可单测）。
 *
 * 字段名 `path` 是有意的：权限层的越界检查（`pathLeavesWorkspace`）只读
 * `args.path` / `file_path` / `filePath`，换个名字就等于放弃「工作区外」这道门。
 *
 * 2026-11-16 收紧：以前 entry / panel 服务字段填错只会被静默忽略（发布出一个
 * 看起来正常、跑起来不对的作品）。现在能当场判定的语义错误一律抛错：
 * - `kind=server` 不支持 entry（服务没「入口页」）；
 * - `kind=panel` 的 command / url 必须成对（只给一半 = 既不探活也不启动）。
 * 能缺省归一化的仍然归一化（runMode / 面板尺寸），不因参数不完美就拒绝发布。
 */
export function validatePublishInput(raw: unknown): GalleryDraft {
  const input = (raw ?? {}) as Record<string, unknown>;
  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (!path) throw new Error("path 不能为空（要发布的入口文件或项目目录）");
  const kind = (typeof input.kind === "string" ? input.kind.trim() : "") as GalleryKind;
  if (!KINDS.includes(kind)) throw new Error(`kind 必须是 file / server / panel（收到 ${JSON.stringify(input.kind)}）`);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) throw new Error("title 不能为空（作品墙上展示的名字）");
  const entry = text(input.entry);
  const command = text(input.command);
  const url = text(input.url);
  if (kind === "server" && entry) {
    throw new Error("kind=server 的 path 必须是项目目录，不支持 entry（服务没有「入口页」）：启动命令写在 command 里");
  }
  if (kind === "panel") {
    const pairError = galleryPanelServicePairError(command, url);
    if (pairError) throw new Error(pairError);
  }
  const description = text(input.description);
  const cover = text(input.cover);
  const tags = Array.isArray(input.tags) ? input.tags.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean) : undefined;
  const draft: GalleryDraft = { title, kind, path };
  const appId = text(input.appId);
  if (appId) draft.appId = appId;
  if (entry) draft.entry = entry;
  if (command) draft.command = command;
  if (url) draft.url = url;
  // runMode 只对服务型作品有意义：page（缺省，就绪后打开页面）/ background（纯后台服务）。
  // 非法值当没写（与 panel 的窗口偏好同一态度：作品能发布比参数完美重要）。
  const runMode = typeof input.runMode === "string" ? input.runMode.trim() : "";
  if (kind === "server" && (runMode === "page" || runMode === "background")) draft.runMode = runMode as GalleryRunMode;
  if (description) draft.description = description;
  if (cover) draft.cover = cover;
  if (tags && tags.length > 0) draft.tags = tags;
  if (kind === "panel") {
    // 窗口偏好：非法值直接丢掉（走缺省）而不是报错——作品能发布比参数完美重要。
    const panel: GalleryPanelOptions | undefined = normalizeGalleryPanelOptions(input.panel);
    if (panel) draft.panel = panel;
  }
  return draft;
}

/** 发布回执的输入（工具与 toast 共用同一组状态词，避免「已运行」同时表示三件不同的事）。 */
export interface PublishReceiptInput {
  app: GalleryApp;
  /** true = 新增卡片；false = 就地更新既有条目。 */
  created: boolean;
  /** 作品池总量。 */
  total: number;
  /** 封面结果说明（可选）。 */
  coverNote?: string;
  /** panel 本地服务托管状态说明（galleryServiceNote 的产物；空串不占行）。 */
  serviceNote?: string;
}

/**
 * 工具回执（2026-11-16 契约）：必须能回答「新建还是更新 / 是哪个作品 / 最终入口
 * 是什么 / 面板服务归谁 / 封面是哪来的 / 去哪看」。模型就是靠这五行确认自己真的
 * 改到了同一张卡。
 */
export function publishReceipt(input: PublishReceiptInput): string {
  const { app, created, total } = input;
  const lines = [
    `${created ? "已发布新作品" : "已更新作品"}「${app.title}」（${GALLERY_KIND_LABELS[app.kind]}）。`,
    `作品 ID：${app.id}`,
    `最终入口：${app.entry === "." ? "（工作区根目录）" : app.entry}`,
    created
      ? "发布结果：新增一张作品卡片。"
      : "发布结果：原条目已就地更新（作品 ID / 创建时间不变；面板的固定 origin 与 localStorage 也跟旧数据一致）。"
  ];
  if (input.serviceNote) lines.push(input.serviceNote);
  if (input.coverNote) lines.push(input.coverNote);
  lines.push(`作品池现有 ${total} 个，可在顶栏「作品」下拉或空会话的作品墙里运行/继续开发。`);
  return lines.join("\n");
}

/**
 * 实体按钮路径 toast 的头一句（与 publishReceipt 同一组状态词，只是压成一行）：
 * 「已发布新作品」与「已更新作品」必须分开——用户就是靠这句话判断自己改到的是
 * 原作品还是一张新卡。封面与服务说明由调用方按自己的判据接在后面。
 */
export function publishHeadline(app: Pick<GalleryApp, "title">, created: boolean): string {
  return `${created ? "已发布新作品" : "已更新作品"}「${app.title}」`;
}

/** Build the gallery customTools（gallery_publish）. */
export function buildGalleryTools(ctx: GalleryToolContext): ToolDefinition[] {
  return [
    defineTool({
      name: "gallery_publish",
      label: "发布作品",
      description: [
        "把一个**已经做完、能运行、值得保留**的成果登记到作品墙（用户能一键运行、一键继续开发）。",
        "kind=file 时 path 指入口文件（如导出的单文件 html）；kind=server 时 path 指项目目录，并给出启动命令 command 或服务地址 url。",
        "path 是工作区内路径（文件或目录）；path 为目录时用 entry 指明目录内的页面（最终入口 = path/entry，清单只存最终入口）。改自己已经发布过的作品时带上 appId，它必须同工作区、同类型（省略则按「工作区+类型+最终入口」更新）。",
        "**服务（kind=server）的进程一律是后台进程**：点「运行」由平台在后台 spawn 启动命令（**不占终端标签**，关掉页面也不会停），就绪判定与输出都进作品墙顶部的「运行中的服务」看板（可看日志、停止、重启）。所以 command 必须是**前台、非交互、长期运行**的命令（不能在就绪前自己结束：`pythonw` / `start` / `cmd /c start` 这类脱离进程树的启动器不行）。",
        "服务型还有 runMode 两种：page（缺省）= 就绪后顺带打开页面（前端 dev server 这类有界面要看的）；background = 纯后台服务（反代 / API / 桥 / 给别的程序提供数据的进程），只起进程、不打开任何页面。分不清时问自己：这个地址打开会是给人看的页面吗？不是就 background。",
        `kind=panel 时 path 指一个网页文件（.html/.htm/.svg）：它会被开成**独立小窗口**，主界面关掉后仍能展示（用它可以做常驻小工具/监控面板）。面板页可用相对自己 fetch("./__pidesktop_state.json") 读本机会话执行状态（只读），POST 同一地址 {"action":"show-main"} 唤回主界面 / {"action":"close"} 关窗 / {"action":"toggle"} 切换抽屉两态。窗口用 panel 声明：mode="window"（缺省，系统边框窗口）| "pet"（桌宠：透明无边框固定尺寸，页面自绘形状并用 CSS -webkit-app-region: drag 拖动，需自带关闭钮 POST close）| "drawer"（贴边抽屉：edge 声明贴哪条边 left/right/top/bottom，缺省 right，窗口在窄把手与完整面板两态切换，页面监听 resize 自适应渲染，点把手 POST toggle）；width/height/alwaysOnTop 三种形态通用（桌宠缺省置顶）。`,
        `kind=panel 也可以带一个**本地服务**：同时声明 command（启动命令）与 url（探活地址，如 http://127.0.0.1:8791/api/health）时，点「运行」会先在**后台**起 command、探活通过后才开面板窗口（服务已在跑就直接开窗不重启；面板窗口关闭时平台自动停掉它起的服务）。面板页没有 preload 也跑不了外部命令，需要本地数据源（读数据库/跑 git/访问本机文件）的面板就是这么接的。**这两个字段必须成对**（只给一半会报错）；两个都不填 = 不依赖平台托管的本地服务。url 只用于探活，不当页面地址；地址可达但非平台进程时按外部服务复用，关窗不停它；平台已有同作品服务则复用并按归属管理。`,
        "kind 怎么选（三种形态的运行环境与跨域能力差异——尤其要直连外部模型 API 时）先读 skill gallery-publish。",
        "**每个作品都要有封面**（作品墙卡片头图）：不指定 cover 时自动截入口页；server 型在服务此刻可达时截服务页；入口本身是图片就直接用；仍拿不到画面则生成占位封面（渐变底 + 作品名，卡片不会裸图标）。想要好看的封面就用 cover 指定工作区里的一张图片（png/jpg/webp/gif/svg，建议 16:10、≥1024 宽）。",
        "入口必须位于当前工作区内。同「工作区+类型+入口」重复发布是更新而非新增（改了标题/命令再发一次即可）。",
        "只在成果确实完成时调用——临时脚本、中间产物不要发布，否则作品墙会被噪声塞满。"
      ].join(""),
      promptSnippet: "gallery_publish: 把完成的成果发布到作品墙",
      parameters: Type.Object({
        appId: Type.Optional(Type.String({ description: "既有作品的 id（给了就更新那一条；须同工作区、同类型）" })),
        title: Type.String({ description: "作品名（作品墙展示名）" }),
        kind: Type.String({ description: "file = 入口文件（单文件网页）；server = 目录 + 启动命令/地址；panel = 网页开成独立小窗口" }),
        path: Type.String({ description: "入口文件或项目目录（相对工作区或绝对）；path 是目录时用 entry 指明目录内的页面" }),
        entry: Type.Optional(Type.String({ description: "kind=file/panel：path 为目录时的最终入口（相对 path，不能越界）；kind=server 禁止传" })),
        command: Type.Optional(Type.String({ description: "kind=server：启动命令（非交互、前台长期运行）；kind=panel：本地服务启动命令——须与 url 成对" })),
        url: Type.Optional(Type.String({ description: "kind=server：服务地址（也用于探活）；kind=panel：探活地址——须与 command 成对" })),
        runMode: Type.Optional(Type.String({ description: "kind=server：page（缺省，就绪后打开页面）/ background（纯后台服务：反代 / API / 给别的程序用，只起进程不打开页面）" })),
        panel: Type.Optional(Type.Object({ width: Type.Optional(Type.Number()), height: Type.Optional(Type.Number()), alwaysOnTop: Type.Optional(Type.Boolean()), mode: Type.Optional(Type.String({ description: "窗口形态：window（缺省，系统边框窗口）| pet（桌宠，透明无边框固定尺寸）| drawer（贴边抽屉）" })), edge: Type.Optional(Type.String({ description: "drawer 专用：贴哪条边 left/right/top/bottom，缺省 right" })) }, { description: "kind=panel：窗口形态与尺寸（可选）" })),
        cover: Type.Optional(Type.String({ description: "封面图片的工作区相对路径（png/jpg/webp/gif/svg，建议 16:10）；不填则自动截图，拿不到画面时生成占位封面" })),
        description: Type.Optional(Type.String({ description: "一句话说明这个作品是什么" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "可选标签" }))
      }),
      execute: async (_id, params) => {
        const draft = validatePublishInput(params);
        const { app, coverNote, coverSource, created, serviceNote } = await ctx.publish(draft);
        return {
          content: [{ type: "text" as const, text: publishReceipt({ app, created, total: ctx.list().length, coverNote, ...(serviceNote ? { serviceNote } : {}) }) }],
          details: { id: app.id, title: app.title, kind: app.kind, entry: app.entry, created, coverSource: coverSource ?? app.coverSource }
        };
      }
    })
  ];
}
