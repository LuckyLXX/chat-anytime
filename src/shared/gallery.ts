/**
 * 作品（Gallery）：把用 AI 做出来的成果登记成「可反复运行、可一键继续开发」的
 * 一等公民。作品不一定单文件——可能是一个 html，也可能是一整个目录 + 启动命令，
 * 还可能是一个**面板**（一个脱离主界面独立存活的小窗口，见 kind = "panel"）。
 *
 * 本模块是**纯数据层**：类型 + 归一化 + 增删改 + 运行分流判定。所有 IO（读盘、
 * 缩略图渲染、静态服务、composer 注入）都在调用方；渲染端与主进程共享同一组
 * 纯函数，避免两处各判一套「这作品该怎么跑」。
 *
 * 关键设计（2026-09-20 与用户对齐）：
 * - 清单**全局跨工作区**（一个池子，换工作区也在），落 `<agentDir>/pidesktop-gallery/`；
 * - 同一「工作区 + 入口 + 类型」重复发布 = 更新而非新增（否则作品墙会出重复卡片）；
 * - 运行**一律走内置浏览器 + 本地静态服务**（单文件也能跑，且 console/网络/相对
 *   资源全可用）；沙箱 iframe 只跑得了单文件且有 origin 限制，故不作运行通道；
 * - panel 是唯一例外：它开的是**独立 BrowserWindow**（主窗口关掉后仍能展示），
 *   因此它必须是一个网页文件，且由 main 侧的窗口管理器负责（2026-09-26）。
 */

import { panelDevHint } from "./panel.js";

/**
 * 作品类型：
 * - file：入口文件（如导出的单文件 html），在主界面内置浏览器里运行；
 * - server：需要起服务的项目目录 + 启动命令/地址，同样在内置浏览器里打开；
 * - panel：入口网页被开成独立小窗口（面板），脱离主界面存活，可读会话状态端点。
 */
export type GalleryKind = "file" | "server" | "panel";

/** kind=panel 的窗口偏好（缺省值见 PANEL_DEFAULT_*）。 */
export interface GalleryPanelOptions {
  width?: number;
  height?: number;
  alwaysOnTop?: boolean;
  /** 窗口形态（缺省 window = 系统边框窗口）。pet = 桌宠（透明无边框）；drawer = 贴边抽屉。 */
  mode?: GalleryPanelMode;
  /** drawer 专用：贴哪条边（缺省 right）。非 drawer 形态下无意义，归一化时丢弃。 */
  edge?: GalleryPanelEdge;
}

/** 面板窗口形态：window（系统边框窗口）/ pet（透明无边框桌宠）/ drawer（贴边抽屉）。 */
export type GalleryPanelMode = "window" | "pet" | "drawer";

/** 抽屉停靠的屏幕边：left / right / top / bottom。 */
export type GalleryPanelEdge = "left" | "right" | "top" | "bottom";

export const PANEL_MODES: readonly GalleryPanelMode[] = ["window", "pet", "drawer"];
export const PANEL_EDGES: readonly GalleryPanelEdge[] = ["left", "right", "top", "bottom"];
export const GALLERY_PANEL_MODE_LABELS: Record<GalleryPanelMode, string> = { window: "窗口", pet: "桌宠", drawer: "贴边抽屉" };

/** 面板窗口缺省尺寸：竖长条，装得下「几个会话 + todo」而不占地。 */
export const PANEL_DEFAULT_WIDTH = 420;
export const PANEL_DEFAULT_HEIGHT = 560;
/**
 * 尺寸下限。2026-10-04 从 240×200 放宽到 140×120：桌宠（mode="pet"）要能缩得
 * 很小（一只小尺寸的猫挂在屏幕角上），而这个下限同时管着三处夹取——作品声明
 * 归一化、位置尺寸记忆读回、运行时缩放——改这一处即可三处同步。
 * 普通面板声明到 140 宽也是用户自己的选择，无害。
 */
export const PANEL_MIN_WIDTH = 140;
export const PANEL_MAX_WIDTH = 1600;
export const PANEL_MIN_HEIGHT = 120;
export const PANEL_MAX_HEIGHT = 1400;

export interface GalleryApp {
  id: string;
  title: string;
  description?: string;
  kind: GalleryKind;
  /** 绝对路径：运行、继续开发、打开文件全靠它，因此跨工作区清单必须存绝对路径。 */
  workspace: string;
  /** 入口：kind=file 时是工作区相对路径；kind=server 时是目录相对路径（"." = 工作区根）。 */
  entry: string;
  /**
   * 启动命令。
   * - kind=server：作品的服务启动命令（「运行」时在终端标签里自动执行，不是手工回车）。
   * - kind=panel：**开窗前要拉起的本地服务**（面板页没有 preload 也跑不了进程，
   *   需要本地数据源的作品靠它；见 2026-10-11 的 Git 管理器）。
   */
  command?: string;
  /**
   * 服务地址。
   * - kind=server：存在时「运行」直接开浏览器，无需起进程。
   * - kind=panel：**只用于探活**（`waitForService` 的判据是 TCP connect），不用于打开页面
   *   —— 面板页自己 fetch 这个地址取数，平台只用它判断「服务起没起来」。
   */
  url?: string;
  /** kind=panel：独立窗口的尺寸与置顶偏好（非法值在读侧夹取/丢弃）。 */
  panel?: GalleryPanelOptions;
  /** 缩略图文件名（位于全局 thumbs 目录内，与条目同生共死）。 */
  thumb?: string;
  /** 封面的来源（仅在有 thumb 时有意义；读侧白名单归一化，发布回执与调试用）。 */
  coverSource?: GalleryCoverSource;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  /** 手动排序权重（缺省按 updatedAt 倒序）。 */
  order?: number;
}

/** 发布请求（AI 工具与实体按钮共用同一形状）。 */
export interface GalleryDraft {
  title: string;
  kind: GalleryKind;
  /** 发布源路径：kind=file 时是文件（相对工作区或绝对）；kind=server 时是目录。 */
  path: string;
  /** 入口（缺省 = path）；仅 kind=file 有意义。 */
  entry?: string;
  command?: string;
  url?: string;
  /** kind=panel：窗口偏好。 */
  panel?: GalleryPanelOptions;
  description?: string;
  tags?: string[];
  workspace?: string;
  /**
   * 封面图片的工作区相对路径（可留空自动取图）。
   * 优先级：这本字段 → 入口图片 → 入口页/服务页截图 → 程序化占位封面。
   */
  cover?: string;
}

export const GALLERY_KIND_LABELS: Record<GalleryKind, string> = {
  file: "网页",
  server: "服务",
  panel: "面板"
};

/** 清单上限：超出按 updatedAt 淘汰最旧（调用方负责同步清理其缩略图）。 */
export const MAX_GALLERY_APPS = 200;

const KINDS: readonly GalleryKind[] = ["file", "server", "panel"];

function randomAppId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return `g-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  return `g-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 面板窗口的生效形态（作品没声明就是 window，向后兼容旧清单）。 */
export function panelMode(options?: GalleryPanelOptions): GalleryPanelMode {
  return options?.mode ?? "window";
}

/**
 * 面板窗口的生效置顶（纯函数，主进程开窗与复用窗口同步共用）：
 * 桌宠缺省置顶（不置顶的桌宠会被任何普通窗口瞬间吞没，等于没做）；
 * 抽屉与普通窗口缺省不置顶（常驻窄条一直压在用户工作之上反而碍事）。
 */
export function panelEffectiveAlwaysOnTop(options?: GalleryPanelOptions): boolean {
  if (panelMode(options) === "pet") return options?.alwaysOnTop ?? true;
  return options?.alwaysOnTop === true;
}

/**
 * 面板窗口偏好的读侧归一化：非对象返回 undefined；尺寸取整并夹到可用区间
 * （写了个 0 宽或 99999 高的作品不应当造出一个点不动的窗口）；
 * 全部字段非法时返回 undefined，调用方自然回退到缺省尺寸。
 */
export function normalizeGalleryPanelOptions(value: unknown): GalleryPanelOptions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const options: GalleryPanelOptions = {};
  const width = finite(record.width);
  if (width !== undefined) options.width = clamp(Math.round(width), PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
  const height = finite(record.height);
  if (height !== undefined) options.height = clamp(Math.round(height), PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT);
  if (typeof record.alwaysOnTop === "boolean") options.alwaysOnTop = record.alwaysOnTop;
  // mode="window" 是缺省值，不落字段（与尺寸缺省不落盘同一风格：没声明就没字段）。
  if (typeof record.mode === "string" && record.mode !== "window" && (PANEL_MODES as readonly string[]).includes(record.mode)) {
    options.mode = record.mode as GalleryPanelMode;
  }
  // edge 只属于抽屉：别的形态下带了也丢（避免「桌宠贴边」这种语义存进清单）。
  if (options.mode === "drawer" && typeof record.edge === "string" && (PANEL_EDGES as readonly string[]).includes(record.edge)) {
    options.edge = record.edge as GalleryPanelEdge;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

/** 面板窗口的生效尺寸（作品没声明就用缺省）。 */
export function panelWindowSize(options?: GalleryPanelOptions): { width: number; height: number } {
  return { width: options?.width ?? PANEL_DEFAULT_WIDTH, height: options?.height ?? PANEL_DEFAULT_HEIGHT };
}

/**
 * 工作区显示名（作品墙卡片用）：取路径最后一段（`D:\\Projects\\proj` → `proj`）。
 * 盘符根（`D:\\`）保留盘符，因为「D:/」这个名字没有信息量；空串原样返回。
 *
 * 只用于展示，**不能用来比较工作区**——比较走大小写不敏感 + 统一分隔符的
 * workspaceKey（渲染端 `lib/session-groups.ts`）。
 */
export function workspaceLabel(path: string): string {
  const text = path.trim().replace(/[\\/]+$/u, "");
  if (!text) return path;
  const parts = text.split(/[\\/]/u);
  return parts[parts.length - 1] || text;
}

/** 工作区相对路径归一化：反斜杠转正斜杠、去掉 `./` 前缀（"." 保留为根）。 */
export function normalizeGalleryEntry(value: string): string {
  const text = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!text || text === "." || text === "./") return ".";
  return text.replace(/\/+$/u, "");
}

/**
 * 读侧归一化：非法项一律丢弃（与 automation-store 同口径——宁可少一条坏数据，
 * 也不要让作品墙渲染出点不动的卡片）。
 */
export function normalizeGalleryApp(value: unknown): GalleryApp | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const title = trimmed(record.title);
  const workspace = trimmed(record.workspace);
  const entry = trimmed(record.entry);
  const kind = trimmed(record.kind) as GalleryKind | undefined;
  if (!title || !workspace || !entry || !kind || !KINDS.includes(kind)) return undefined;
  // 面板必须指向一个网页文件：入口为工作区根（"."）的「面板」是配置错误，读侧丢弃。
  if (kind === "panel" && normalizeGalleryEntry(entry) === ".") return undefined;
  const createdAt = finite(record.createdAt) ?? Date.now();
  const updatedAt = finite(record.updatedAt) ?? createdAt;
  const app: GalleryApp = {
    id: trimmed(record.id) ?? randomAppId(),
    title,
    kind,
    workspace,
    entry: normalizeGalleryEntry(entry),
    createdAt,
    updatedAt
  };
  const description = trimmed(record.description);
  if (description) app.description = description;
  // command / url 只对「服务型」作品有意义：server（服务 + 页面地址）与 panel
  // （可选本地服务 + 探活地址）。file 型带上它们是脏数据，读侧丢弃。
  const command = trimmed(record.command);
  if ((kind === "server" || kind === "panel") && command) app.command = command;
  const url = trimmed(record.url);
  if ((kind === "server" || kind === "panel") && url) app.url = url;
  if (kind === "panel") {
    const panel = normalizeGalleryPanelOptions(record.panel);
    if (panel) app.panel = panel;
  }
  const thumb = trimmed(record.thumb);
  if (thumb) app.thumb = thumb;
  // 封面来源只在真有缩略图时保留：thumb 被换掉/清空后残留的来源会误导读侧。
  const coverSource = trimmed(record.coverSource) as GalleryCoverSource | undefined;
  if (thumb && coverSource && GALLERY_COVER_SOURCES.includes(coverSource)) app.coverSource = coverSource;
  if (Array.isArray(record.tags)) {
    const tags = record.tags.map((tag) => trimmed(tag)).filter((tag): tag is string => Boolean(tag));
    if (tags.length > 0) app.tags = tags.slice(0, 8);
  }
  const lastRunAt = finite(record.lastRunAt);
  if (lastRunAt !== undefined) app.lastRunAt = lastRunAt;
  const order = finite(record.order);
  if (order !== undefined) app.order = order;
  return app;
}

/** 同一入口的判等键：工作区 + 类型 + 入口（大小写不敏感，Windows 盘符/路径大小写会漂）。 */
export function galleryKey(app: Pick<GalleryApp, "workspace" | "kind" | "entry">): string {
  return `${app.workspace.toLowerCase()}|${app.kind}|${normalizeGalleryEntry(app.entry).toLowerCase()}`;
}

/**
 * 发布/更新（纯函数，调用方负责落盘）。
 *
 * id 是**本函数生成**的，调用方不应自己造：发布路径曾经传 `id: ""`，而补 id 的
 * 兜底只写在读路径的 `normalizeGalleryApp` 里——结果每次读盘都因 id 为空而**重新
 * 随机生成一个**，作品的 id 每次重启都在变（而 update/remove/run 全按 id 寻址）。
 * 所以这里对空 id 兜底（draft 带 id 时照用，供测试与「换 id 重建」场景）。
 *
 * 同 id 或同入口键视为更新，保留 createdAt 与已有缩略图（除非本次带了新缩略图）。
 */
export function upsertGalleryApp(list: readonly GalleryApp[], draft: GalleryApp, now = Date.now()): { list: GalleryApp[]; app: GalleryApp } {
  const key = galleryKey(draft);
  const draftId = draft.id || randomAppId();
  const index = list.findIndex((item) => (draft.id !== "" && item.id === draft.id) || galleryKey(item) === key);
  if (index < 0) {
    const app: GalleryApp = { ...draft, id: draftId, createdAt: draft.createdAt || now, updatedAt: now };
    return { list: sortGalleryApps([app, ...list]), app };
  }
  const existing = list[index]!;
  const app: GalleryApp = {
    ...existing,
    ...draft,
    // 身份与创建时间跟着原条目走；缩略图本次没给就保留旧的（避免重发布把图弄丢）。
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: now,
    thumb: draft.thumb ?? existing.thumb
  };
  const next = [...list];
  next[index] = app;
  return { list: sortGalleryApps(next), app };
}

export function removeGalleryApp(list: readonly GalleryApp[], id: string): { list: GalleryApp[]; removed?: GalleryApp } {
  const removed = list.find((item) => item.id === id);
  if (!removed) return { list: [...list] };
  return { list: list.filter((item) => item.id !== id), removed };
}

/**
 * 默认排序：显式 order 升序在前，其余按 updatedAt 倒序（最近动过的排前面）。
 * 键不稳定时用 id 兜底，保证同一份输入永远产出同一顺序（测试与渲染都依赖这点）。
 */
export function sortGalleryApps(list: readonly GalleryApp[]): GalleryApp[] {
  return [...list].sort((left, right) => {
    const leftOrder = left.order;
    const rightOrder = right.order;
    if (leftOrder !== undefined || rightOrder !== undefined) {
      if (leftOrder === undefined) return 1;
      if (rightOrder === undefined) return -1;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    }
    if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
    return left.id.localeCompare(right.id);
  });
}

/** 超出上限时返回应淘汰的尾部条目（调用方负责删其缩略图）。 */
export function trimGalleryApps(list: readonly GalleryApp[], max = MAX_GALLERY_APPS): { list: GalleryApp[]; dropped: GalleryApp[] } {
  const sorted = sortGalleryApps(list);
  if (sorted.length <= max) return { list: sorted, dropped: [] };
  return { list: sorted.slice(0, max), dropped: sorted.slice(max) };
}

/** 运行分流结果：唯一判定来源（渲染端与主进程共用）。 */
export type GalleryRunTarget =
  | { kind: "file"; absolutePath: string }
  /** 面板：入口网页会被 main 开成独立窗口，不走内置浏览器；command/url 是它的可选本地服务。 */
  | { kind: "panel"; absolutePath: string; command?: string; url?: string }
  | { kind: "server"; url?: string; directory: string; command?: string };

/** 绝对路径拼装（纯字符串操作；调用方已保证 workspace 是绝对路径）。 */
export function galleryAbsolutePath(workspace: string, entry: string): string {
  const base = workspace.replace(/[\\/]+$/u, "");
  const relative = normalizeGalleryEntry(entry);
  if (relative === ".") return base;
  return `${base}/${relative}`;
}

/**
 * 入口文件所在目录（纯字符串操作，不 import `node:path`——本模块是渲染端与主进程
 * 共享的纯数据层）。面板作品的启动命令要**在作品目录里**执行（作品自带的 bridge
 * 脚本就放在入口旁边），所以 `start-panel-service` 靠它给出 cwd。
 * 没有分隔符时原样返回（调用方已保证是绝对路径，这是不可达的兜底）。
 */
export function galleryEntryDirectory(absolutePath: string): string {
  const index = Math.max(absolutePath.lastIndexOf("/"), absolutePath.lastIndexOf("\\"));
  return index > 0 ? absolutePath.slice(0, index) : absolutePath;
}

export function galleryRunTarget(app: Pick<GalleryApp, "kind" | "workspace" | "entry" | "url" | "command">): GalleryRunTarget {
  const absolutePath = galleryAbsolutePath(app.workspace, app.entry);
  if (app.kind === "panel") {
    const target: GalleryRunTarget = { kind: "panel", absolutePath };
    if (app.command) target.command = app.command;
    if (app.url) target.url = app.url;
    return target;
  }
  if (app.kind === "server") {
    const target: GalleryRunTarget = { kind: "server", directory: absolutePath };
    if (app.url) target.url = app.url;
    if (app.command) target.command = app.command;
    return target;
  }
  return { kind: "file", absolutePath };
}

/**
 * 服务型作品等「地址可访问」的预算（毫秒，渲染端传给主进程）。
 *
 * 30 秒的取舍（2026-09-23 与用户对齐）：本机 dev server 通常 1–5 秒起来，
 * 首次 `npm install` 后的启动可能十几秒；再长就会让「点了运行」看起来像卡死。
 * 超时不是失败终局——地址随时会就绪，提示里明确让人再点一次「运行」。
 */
export const GALLERY_SERVICE_WAIT_MS = 30_000;

/**
 * 启动命令**正常结束**（退出码 0）后，还给服务的宽限窗口（毫秒）。
 *
 * 为什么需要这一档（2026-10-04 真机事故，用户的 Python 桌宠）：`pythonw xxx.pyw`、
 * `start xxx`、`cmd /c start ...` 这类命令是**启动器**——GUI 子系统程序不占控制台，
 * shell 不等它就返回 0，而真正的服务还要一两秒才开始监听。旧实现对「命令已退出 +
 * 端口未通」一律判失败，于是一次正常的启动被报成「启动命令已退出（代码 0），
 * 服务没有起来」。退出码 0 是「命令成功结束」，只有非 0 才是「命令报错退出」。
 *
 * 上限不能大：命令已结束还等满 30 秒会让真写错的命令拖很久；10 秒够本机服务
 * 把端口监听起来，超过就如实报「命令已结束、服务未就绪，稍后再点一次运行」。
 */
export const GALLERY_SERVICE_LAUNCHER_GRACE_MS = 10_000;

/** 失败提示里带的输出尾部长度（字符）：完整输出在终端标签里，提示只给个线头。 */
export const GALLERY_SERVICE_TAIL_CHARS = 200;

/**
 * 运行分流结果：**唯一判据**（渲染端据此决定开浏览器还是先起服务）。
 *
 * 与 `galleryRunTarget` 的分工：后者只做「这个作品该怎么跑」的静态判定，
 * 本函数把「服务此刻是否已经跑着」这一动态事实并进来——同一个作品，服务没起
 * 时先起服务，已经起了就直接开浏览器（用户 2026-09-23 的选择：已可达不重启）。
 */
export type GalleryRunPlan =
  | { action: "open-file"; absolutePath: string }
  /** 面板：把入口网页开成独立窗口（主界面关掉后仍能显示）；options 已归一化。 */
  | { action: "open-panel"; absolutePath: string; options: GalleryPanelOptions }
  /**
   * 面板 + 本地服务（2026-10-11）：先把 `command` 在终端标签里拉起来、探活通过再开窗。
   * `directory` 是**入口所在目录**（启动命令在那里执行），`url` 是探活地址。
   */
  | { action: "start-panel-service"; absolutePath: string; options: GalleryPanelOptions; directory: string; command: string; url: string }
  | { action: "open-browser"; url: string }
  | { action: "start-service"; directory: string; command: string; url?: string }
  /** 服务型但既连不上、又没登记启动命令：只能如实说，不能装作跑起来了。 */
  | { action: "manual" };

export function galleryRunPlan(
  app: Pick<GalleryApp, "kind" | "workspace" | "entry" | "url" | "command" | "panel">,
  serviceReachable: boolean
): GalleryRunPlan {
  const target = galleryRunTarget(app);
  // 面板：可以带一个**可选的本地服务**（command + url）。三态刻意分开——
  // 没声明服务、服务已可达（用户手工起的或上次运行留下的）都直接开窗，
  // 绝不重启用户正在用的服务；只有「声明了服务且此刻不可达」才先起服务再开窗。
  // 缺 url 时无法探活，宁可直开窗让面板页自己报「连不上」，也不盲起服务。
  if (target.kind === "panel") {
    const options = normalizeGalleryPanelOptions(app.panel) ?? {};
    if (target.command && target.url && !serviceReachable) {
      return {
        action: "start-panel-service",
        absolutePath: target.absolutePath,
        options,
        directory: galleryEntryDirectory(target.absolutePath),
        command: target.command,
        url: target.url
      };
    }
    return { action: "open-panel", absolutePath: target.absolutePath, options };
  }
  if (target.kind === "file") return { action: "open-file", absolutePath: target.absolutePath };
  if (target.url && serviceReachable) return { action: "open-browser", url: target.url };
  if (target.command) {
    return target.url
      ? { action: "start-service", directory: target.directory, command: target.command, url: target.url }
      : { action: "start-service", directory: target.directory, command: target.command };
  }
  return { action: "manual" };
}

/**
 * 服务型作品的「服务终端」标签 id：同一个作品**每次运行都不一样**。
 *
 * 第一版用固定 id（`terminal-gallery-<appId>`），用户第一次真机使用就撞上了：终端 id
 * 是主进程记住「这个进程为啥退出」的键，固定 id 意味着上次尝试的退出记录（用户关掉
 * 服务标签、强杀进程都会留下）还在表里——而「开标签」与「等就绪」是两个 IPC，
 * 等待方常常在新 PTY 建好之前就读到旧记录，于是直接弹「启动命令已退出（代码
 * -1073741510）」，可终端里服务其实正在正常启动（2026-09-23 实测）。
 * 每次新 id 同时修掉另一个坑：旧标签的 PTY 已经死了时，重复用同一个 id 不会再发
 * create，服务永远起不起来；现在「运行」先回收旧标签再开新标签，一定是一个全新的
 * 服务进程（地址真的可达时根本不会走到这条分支，见 galleryRunPlan）。
 */
export function galleryServiceTerminalId(appId: string, nonce: string): string {
  return `terminal-gallery-${appId}-${nonce}`;
}

/** 服务起不来的原因（主进程 await-service 回执与本地判定共用同一形状）。 */
export interface GalleryServiceFailure {
  reason?: "invalid-url" | "timeout" | "exited" | "ended";
  /** reason=exited：启动命令的退出码。 */
  exitCode?: number;
  /** reason=exited / ended：启动命令的输出尾部（主进程已裁剪）。 */
  tail?: string;
}

/** 输出尾部压成一行：toast 是 430px 单行流式布局，多行原文会撑成一整块。 */
export function compactServiceTail(text: string | undefined, limit = GALLERY_SERVICE_TAIL_CHARS): string {
  const flattened = (text ?? "").replace(/\s+/gu, " ").trim();
  if (flattened.length <= limit) return flattened;
  return `…${flattened.slice(flattened.length - limit)}`;
}

/**
 * 服务启动失败的用户提示（唯一来源）。
 *
 * 三种原因分开写：
 * - exited：命令自己退出了（写错了/依赖没装/端口被占）——带上退出码与输出尾部，
 *   这是最需要「原因」的一类；
 * - ended：命令**正常结束（退出码 0）**但服务没在宽限窗口内就绪——典型是
 *   「命令只是把程序拉起来」（pythonw / start 这类启动器形态），要点明「终端标签
 *   显示已退出是正常的」，否则用户会以为启动失败；
 * - timeout：进程还在跑但地址在预算内没就绪，明确给出「再点一次运行」的出路；
 * - invalid-url：登记的服务地址连解析都不行（多是自己手写的地址写错了）。
 */
export function galleryServiceFailureMessage(
  app: Pick<GalleryApp, "title" | "url">,
  failure: GalleryServiceFailure,
  waitMs = GALLERY_SERVICE_WAIT_MS
): string {
  if (failure.reason === "exited") {
    const code = typeof failure.exitCode === "number" ? `（代码 ${failure.exitCode}）` : "";
    const tail = compactServiceTail(failure.tail);
    return `「${app.title}」的启动命令已退出${code}，服务没有起来。${tail ? `输出尾部：${tail}` : "请看终端标签里的输出。"}`;
  }
  if (failure.reason === "ended") {
    const seconds = Math.max(1, Math.round(GALLERY_SERVICE_LAUNCHER_GRACE_MS / 1000));
    const where = app.url ? `（${app.url} 连不上）` : "";
    return `「${app.title}」的启动命令已正常结束（代码 0）${where}，但服务在 ${seconds} 秒内没有就绪：如果这条命令只是把程序拉起来（pythonw / start 这类会立刻返回的写法），终端标签显示「已退出」是正常的，稍等一下再点一次「运行」。`;
  }
  if (failure.reason === "invalid-url") {
    return `「${app.title}」登记的服务地址无法解析${app.url ? `（${app.url}）` : ""}：点「继续开发」让 AI 修正后再运行。`;
  }
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  const where = app.url ? `（${app.url} 连不上）` : "";
  return `「${app.title}」的服务在 ${seconds} 秒内没有就绪${where}：可能还在启动，稍后再点一次「运行」；输出见终端标签。`;
}

/** 缩略图文件名（全局 thumbs 目录内）：`gallery-<yyyyMMdd-HHmmss-mmm>.png`，与截图同风格。 */
export function galleryThumbName(at = Date.now()): string {
  const date = new Date(at);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `gallery-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}.png`;
}

/** 封面图的离屏视口与卡片裁切口径：16:10（1440×900），卡片 `object-fit: cover`。 */
export const GALLERY_COVER_WIDTH = 1440;
export const GALLERY_COVER_HEIGHT = 900;

/** 显式封面（`cover`）允许的图片扩展名：位图优先 nativeImage，svg 由离屏窗口渲染。 */
export const GALLERY_COVER_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"] as const;

/** 入口本身就是图片时能直接当封面的扩展名（svg 留走离屏渲染，保护矢量细节）。 */
const GALLERY_IMAGE_ENTRY_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"] as const;

/** 可离屏渲染为封面的页面入口。 */
const GALLERY_SNAPSHOT_PAGE = /\.(?:html?|svg)$/iu;

/**
 * 封面来源：
 * - custom：发布时显式指定的 cover；
 * - entry：入口本身就是图片，直接用它；
 * - service：服务型作品的页面截图（服务当时可达）；
 * - generated：程序化占位封面（没拿到真实画面时的兜底）。
 */
export type GalleryCoverSource = "custom" | "entry" | "service" | "generated";

export const GALLERY_COVER_SOURCES: readonly GalleryCoverSource[] = ["custom", "entry", "service", "generated"];

function entryExtension(entry: string): string {
  const last = normalizeGalleryEntry(entry).split("/").pop() ?? "";
  const index = last.lastIndexOf(".");
  return index >= 0 ? last.slice(index).toLowerCase() : "";
}

/** 入口本身就是一张图片（`file` 作品在浏览器里看这张图，封面就是它）。 */
export function galleryCoverImageEntry(entry: string): boolean {
  return (GALLERY_IMAGE_ENTRY_EXTENSIONS as readonly string[]).includes(entryExtension(entry));
}

/** 自动截图的来源（undefined = 这个入口截不了，只能靠显式封面或占位图）。 */
export type GallerySnapshotTarget =
  | { kind: "file"; path: string }
  | { kind: "image"; path: string }
  /** server：服务页地址（调用方先做一次 TCP 探活，不可达就不截）。 */
  | { kind: "url"; url: string };

/**
 * 「这个作品该截哪里」的唯一判据（发布时与启动补齐共用）。
 *
 * - file / panel：入口页 → 离屏加载文件；入口是位图 → 直接缩放；
 * - server：只给已登记的 url（是否真能截由调用方探活决定，本函数不碰网络）。
 */
export function gallerySnapshotTarget(app: Pick<GalleryApp, "kind" | "workspace" | "entry" | "url">): GallerySnapshotTarget | undefined {
  const absolutePath = galleryAbsolutePath(app.workspace, app.entry);
  if (app.kind === "file" || app.kind === "panel") {
    if (galleryCoverImageEntry(app.entry)) return { kind: "image", path: absolutePath };
    if (GALLERY_SNAPSHOT_PAGE.test(app.entry)) return { kind: "file", path: absolutePath };
    return undefined;
  }
  return app.url ? { kind: "url", url: app.url } : undefined;
}

const COVER_PALETTE: Record<GalleryKind, { from: string; to: string; accent: string }> = {
  file: { from: "#0b1533", to: "#1d2b6b", accent: "#8ea2ff" },
  server: { from: "#04201f", to: "#0c4740", accent: "#5eead4" },
  panel: { from: "#241206", to: "#5a2c0a", accent: "#f6c26b" }
};

function escapeCoverText(value: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/gu, (char) => map[char] ?? char);
}

/**
 * 程序化占位封面（自包含 HTML，由离屏窗口截成 PNG）。
 *
 * 为什么用 HTML 而不是在 Node 里画图：主进程已有成熟的离屏截图链路
 * （design-snapshot），一张带渐变、大标题、类型徐标的封面用 CSS 写三行就有，
 * 不需要引入 canvas/PNG 编码依赖；而 CSS 能做文本折行与中文字体回退。
 * 样式全部内联、无外链，截图像不依赖网络与主题。
 */
export function galleryPlaceholderCoverHtml(app: Pick<GalleryApp, "title" | "kind" | "workspace" | "entry" | "description">): string {
  const palette = COVER_PALETTE[app.kind];
  const title = escapeCoverText(app.title);
  const workspace = escapeCoverText(workspaceLabel(app.workspace));
  const entry = escapeCoverText(app.entry === "." ? "工作区根目录" : app.entry);
  const description = app.description ? escapeCoverText(app.description) : "";
  const label = GALLERY_KIND_LABELS[app.kind];
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
html,body{margin:0;width:${GALLERY_COVER_WIDTH}px;height:${GALLERY_COVER_HEIGHT}px;overflow:hidden}
body{box-sizing:border-box;padding:104px 112px;display:flex;flex-direction:column;justify-content:center;gap:26px;background:radial-gradient(120% 120% at 12% 8%, ${palette.from} 0%, ${palette.to} 62%, #05070f 100%);color:#f4f7ff;font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
.badge{display:inline-flex;align-items:center;width:fit-content;padding:10px 18px;border:1px solid ${palette.accent}55;border-radius:999px;background:${palette.accent}14;color:${palette.accent};font-size:22px;font-weight:700;letter-spacing:.08em}
h1{margin:0;max-width:1180px;font-size:76px;line-height:1.14;font-weight:750;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{margin:0;color:#a9b8d8;font-size:26px;letter-spacing:.02em}
.desc{margin:0;max-width:1080px;color:#8fa2c4;font-size:24px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.brand{margin-top:36px;color:${palette.accent}99;font-size:20px;letter-spacing:.24em}
</style></head><body>
<span class="badge">${label}</span>
<h1>${title}</h1>
<p class="meta">${workspace} · ${entry}</p>
${description ? `<p class="desc">${description}</p>` : ""}
<div class="brand">PiDesktop · 作品墙</div>
</body></html>`;
}

/** 封面结果文案（发布回执与 toast 共用；没有封面时也如实说一声）。 */
export function galleryCoverNote(source: GalleryCoverSource | undefined, failure?: string): string {
  if (source === "custom") return "封面：自定义封面。";
  if (source === "entry") return "封面：入口图片。";
  if (source === "service") return "封面：服务页截图。";
  if (source === "generated") return "封面：占位封面（没拿到真实画面；把服务跑起来或给一张 cover 后重新发布可更新）。";
  return failure ? `封面未生成：${failure}` : "封面未生成。";
}

/**
 * 具备自动封面资格的类型：`file` / `panel` 的网页入口。
 *
 * 面板现在也截图（2026-10-28 用户要求「每个作品都要有封面」）：离屏窗口里没有
 * 状态端点，截到的是页面骨架/降级态——比一个裸图标好；想要真实画面就用 cover
 * 指定一张（skill 里有说明）。
 */
export function galleryThumbEligible(app: Pick<GalleryApp, "kind" | "entry">): boolean {
  if (app.kind !== "file" && app.kind !== "panel") return false;
  return /\.(?:html?|svg)$/iu.test(app.entry);
}

/**
 * 面板作品的数据用量（「作品数据…」对话框的展示物，2026-10-10）。
 *
 * 两个数字刻意不合并：`localStorageBytes` 由量测页逐键自己算（localStorage **不在**
 * `navigator.storage.estimate()` 的统计里），`storageBytes` 是 Chromium 对 IDB /
 * CacheStorage / ServiceWorker 的估算值与配额。
 */
export interface GalleryDataUsage {
  /** 数据所在的 origin：面板作品是固定值 `pidesktop-file://w-<作品>`（无端口，所以跨启动不丢）。 */
  origin: string;
  /** localStorage 合计字节数（UTF-8，键+值逐项求和）。 */
  localStorageBytes: number;
  /** 占用最大的若干键（最多 8 个），用于「数据里有什么」的摘要。 */
  keys: { key: string; bytes: number }[];
  /** IndexedDB / CacheStorage / ServiceWorker 的估算用量（不含 localStorage）。 */
  storageBytes?: number;
  /** 该 origin 的配额上限。 */
  quotaBytes?: number;
  /** IndexedDB 库名列表。 */
  databaseNames?: string[];
  /** 存储是否已被判定为持久（`navigator.storage.persisted()`）。 */
  persisted?: boolean;
}

export type GalleryDataResult = { ok: true; usage: GalleryDataUsage } | { ok: false; message: string };
export type GalleryDataClearResult = { ok: true } | { ok: false; message: string };

/**
 * 「继续开发」注入文本块：照 lib/browser-pick.ts 的 composePickMessage 形状
 * （首行标签 + 逐字段行），末尾给出下一步，便于模型直接接着干。
 */
export function composeGalleryDevMessage(app: GalleryApp): string {
  const lines = [
    "【作品】",
    `标题：${app.title}`,
    `类型：${GALLERY_KIND_LABELS[app.kind]}（${app.kind}）`,
    `入口：${app.entry === "." ? "（工作区根目录）" : app.entry}`,
    `工作区：${app.workspace}`
  ];
  if (app.description) lines.push(`说明：${app.description}`);
  if (app.command) lines.push(`启动命令：${app.command}`);
  if (app.url) lines.push(`服务地址：${app.url}`);
  if (app.kind === "panel") {
    const size = panelWindowSize(app.panel);
    const mode = panelMode(app.panel);
    const shape =
      mode === "pet"
        ? "透明无边框桌宠窗口（固定尺寸，页面自绘形状，CSS -webkit-app-region: drag 拖动）"
        : mode === "drawer"
          ? `贴边抽屉（${app.panel?.edge ?? "right"} 缘窄条，点击窄条 POST toggle 展开/收起）`
          : "系统边框窗口";
    lines.push(`窗口：${size.width}×${size.height}，${shape}${panelEffectiveAlwaysOnTop(app.panel) ? "，置顶" : ""}`);
    lines.push(panelDevHint());
  }
  lines.push("", "我要在这个作品上继续开发，请先读入口相关的代码再动手。");
  return lines.join("\n");
}
