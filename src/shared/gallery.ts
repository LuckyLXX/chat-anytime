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

/**
 * 服务型作品「进程起来之后去哪」（2026-11-12，用户提出「服务型作品不该在标签页里跑」）：
 *
 * - `page`（缺省）：有页面要看。进程**照样在后台**起（宿主是主进程，不是终端标签），
 *   就绪后打开内置浏览器标签页——关掉标签页不再连带杀掉服务。
 * - `background`：纯后台服务（反代 / API / 给别的程序用的进程）。只起进程，"运行"
 *   不打开任何页面，在作品墙的「运行中的服务」看板上管理。
 *
 * 两种形态的**进程位置完全相同**（都是后台进程，随应用退出而停），差别只在要不要
 * 顺手开一个页面。
 */
export type GalleryRunMode = "page" | "background";

export const GALLERY_RUN_MODES: readonly GalleryRunMode[] = ["page", "background"];

export const GALLERY_RUN_MODE_LABELS: Record<GalleryRunMode, string> = {
  page: "后台进程 + 打开页面",
  background: "纯后台进程（不打开页面）"
};

/** 作品的生效运行方式（缺省 page，向后兼容旧清单）。 */
export function galleryRunMode(app: Pick<GalleryApp, "runMode">): GalleryRunMode {
  return app.runMode === "background" ? "background" : "page";
}

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
   * - kind=server：作品的前台长期运行命令（平台在后台进程中托管）。
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
  /**
   * kind=server：进程起来之后要不要打开页面（缺省 page）。
   * 只对服务型作品有意义——网页/面板作品的页面由 kind 自己决定怎么开。
   */
  runMode?: GalleryRunMode;
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
  /**
   * 既有作品的 id（「继续开发」后重新发布时带上）：存在且属于当前工作区时
   * **优先更新这一条目**，而不是按「工作区 + 类型 + 入口」另找/新建（2026-11-16）。
   *
   * panel 作品的 id 决定固定 origin（`pidesktop-file://w-<id>`），换 id 等于换一份
   * localStorage / IndexedDB——所以同一个面板的后续发布必须沿用同一 id。
   * 类型（kind）与工作区不许跟着 id 一起变：那是另一个作品，宁可报错。
   */
  appId?: string;
  title: string;
  kind: GalleryKind;
  /**
   * 发布源路径：kind=file/panel 时是入口文件，或「目录 + entry」里的那个目录
   *（相对工作区或绝对）；kind=server 时必须是项目目录。
   */
  path: string;
  /**
   * 目录内的最终入口：最终入口 = `resolve(path, entry)`（只在 path 是目录时有意义）。
   * - file / panel 可选：不给时 path 本身就是最终入口；
   * - server 禁止（服务没有「入口页」）。
   */
  entry?: string;
  command?: string;
  url?: string;
  /** kind=server：page（缺省，就绪后打开页面）/ background（纯后台服务，不打开页面）。 */
  runMode?: GalleryRunMode;
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
 * 工作区身份键（工作区比较的唯一纯函数判据）：分隔符与尾斜杠归一；
 * Windows（盘符 / UNC）不区分大小写，POSIX **区分**（`/home/ws` 与 `/home/WS` 是两个目录）。
 */
export function galleryWorkspaceKey(workspace: string): string {
  const text = normalizeAbsoluteForCompare(workspace);
  return caseInsensitiveGalleryPath(text) ? text.toLowerCase() : text;
}

/** 绝对路径判据（Windows 盘符 / UNC / POSIX 根）：纯字符串，不碰 node:path。 */
export function isAbsoluteGalleryPath(value: string): boolean {
  const text = value.trim();
  return /^[a-zA-Z]:/u.test(text) || /^[\\/]/u.test(text);
}

/** 大小写是否不敏感：Windows 盘符路径与 UNC 不敏感，POSIX 路径敏感。 */
function caseInsensitiveGalleryPath(value: string): boolean {
  return /^[a-zA-Z]:/u.test(value) || value.startsWith("//");
}

/**
 * 比较用的绝对路径归一化：反斜杠转正斜杠、折叠重复分隔符、去尾斜杠。
 *
 * 两个边界（2026-11-16）：POSIX 根 `/` 去尾斜杠会变成空串（丢了根，所有比较都失效），
 * 所以单独保留；Windows 盘符根 `D:/` 去尾斜杠得到 `D:`，正好能和 `D:/ws` 前缀匹配。
 */
function normalizeAbsoluteForCompare(value: string): string {
  const text = value.trim().replaceAll("\\", "/").replace(/(?<!^)\/{2,}/gu, "/");
  if (/^\/+$/u.test(text)) return "/";
  return text.replace(/\/+$/u, "");
}

/**
 * 绝对路径 → 工作区相对入口（分隔符归一；Windows 不区分大小写，POSIX 区分；
 * 保留原大小写）。不在 root 之下返回 undefined（调用方据此拒绝越界发布）。
 *
 * 这里只做**词法**判定；真正的越界（软链接 / 目录联接）由 node 侧 realpath 再复核。
 */
export function galleryEntryFromAbsolute(root: string, target: string): string | undefined {
  const rootText = normalizeAbsoluteForCompare(root);
  const targetText = normalizeAbsoluteForCompare(target);
  if (!rootText || !targetText) return undefined;
  const fold = caseInsensitiveGalleryPath(rootText) ? (value: string): string => value.toLowerCase() : (value: string): string => value;
  const rootKey = fold(rootText);
  const targetKey = fold(targetText);
  if (targetKey === rootKey) return ".";
  const rootIsPosixRoot = rootKey === "/";
  if (!targetKey.startsWith(rootIsPosixRoot ? "/" : `${rootKey}/`)) return undefined;
  return normalizeGalleryEntry(targetText.slice(rootIsPosixRoot ? 1 : rootText.length + 1));
}

/** 相对路径段折叠：丢掉空段与 "."，用 ".." 回退；回退越过起点返回 undefined（= 越界）。 */
function foldGallerySegments(segments: readonly string[]): string[] | undefined {
  const stack: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack;
}

/**
 * 工作区相对路径的规范折叠：`a/../b.html` → `b.html`（缺了这一步，同一个文件会
 * 因两种写法变成两张作品卡）；越界（".." 跳过起点）返回 undefined。
 */
export function foldGalleryEntry(value: string): string | undefined {
  const segments = foldGallerySegments(value.replaceAll("\\", "/").split("/"));
  if (!segments) return undefined;
  return segments.length > 0 ? segments.join("/") : ".";
}

function foldOrThrow(value: string, message: string): string {
  const folded = foldGalleryEntry(value);
  if (folded === undefined) throw new Error(message);
  return folded;
}

/** 看起来已经是一个网页文件（给「path 已经指向文件却又给了 entry」这条错配一个明确的错）。 */
const GALLERY_PAGE_FILE = /\.(?:html?|xhtml|svg)$/iu;

/** 作品入口的最终解析结果：工作区相对入口 + 绝对路径。 */
export interface GalleryEntryResolution {
  /** 最终入口：工作区相对路径（分隔符已归一为 /；"." = 工作区根，只有 server 可能）。 */
  entry: string;
  /** 最终入口的绝对路径（root 是绝对路径时）。 */
  absolutePath: string;
}

/**
 * 作品入口的**唯一**解析口径（渲染端 / utility / 主进程共用，别再各自拼一套）：
 *
 * - `file` / `panel`：没有 `entry` 时 `path` 就是最终入口；有 `entry` 时最终入口 =
 *   `resolve(path, entry)`（`path` 应是目录，`entry` 应是其中的相对路径）。
 * - `server`：`path` 必须是项目目录；`entry` 不适用（传了直接报错）。
 * - 路径一律折叠成工作区相对路径（`a/../b.html` → `b.html`），清单里只存**最终**入口，
 *   不存二义性的两段路径；越界（跳出工作区 / 跳出 path 目录）直接报错，绝不静默
 *   发布一个指向外面的入口。
 */
export function resolveGalleryEntry(input: { root: string; path: string; entry?: string; kind: GalleryKind }): GalleryEntryResolution {
  const root = input.root.trim();
  if (!root) throw new Error("请先打开一个工作区，再发布作品");
  const rawPath = input.path?.trim() ?? "";
  if (!rawPath) throw new Error("path 不能为空（要发布的入口文件或项目目录）");
  const rawEntry = input.entry?.trim() ?? "";
  if (input.kind === "server" && rawEntry) {
    throw new Error("kind=server 的 path 必须是项目目录，不支持 entry（服务没有「入口页」）：把 path 写成项目目录，启动命令写在 command");
  }
  // path：绝对路径先换算成工作区相对路径，再统一折叠（两种写法必须得到同一个入口）。
  const relativePath = isAbsoluteGalleryPath(rawPath) ? galleryEntryFromAbsolute(root, rawPath) : rawPath;
  if (relativePath === undefined) throw new Error("作品入口必须位于当前工作区内");
  const base = foldOrThrow(relativePath, "作品入口必须位于当前工作区内");
  let entry = base;
  if (rawEntry) {
    if (isAbsoluteGalleryPath(rawEntry)) throw new Error("entry 必须是相对于 path 的相对路径（要直接指定工作区相对入口就把值写进 path）");
    const nested = foldOrThrow(rawEntry, "entry 不能跳出 path 目录");
    if (base !== "." && GALLERY_PAGE_FILE.test(base)) {
      throw new Error(`path 已经指向文件（${base}）：要发布目录里的某个页面就把 path 写成那个目录；或用 path 直接指向入口文件（不要同时给 entry）`);
    }
    const segments = foldGallerySegments([...base.split("/"), ...nested.split("/")]);
    if (!segments) throw new Error("entry 不能跳出工作区");
    entry = segments.length > 0 ? segments.join("/") : ".";
  }
  if (input.kind === "panel" && entry === ".") throw new Error("面板作品的入口必须是具体网页文件（收到工作区根目录）：把 path 指向那个 html");
  return { entry, absolutePath: galleryAbsolutePath(root, entry) };
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
  // runMode 只属于服务型作品；缺省 page 不落字段（与 panel.mode 同一风格：没声明就没字段）。
  if (kind === "server" && record.runMode === "background") app.runMode = "background";
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

/** 同一入口的判等键：工作区 + 类型 + 入口（大小写不敏感，Windows 盘符/路径大小写会漂）。
 * 入口一律是**最终**相对入口（见 resolveGalleryEntry）：两段式 path+entry 不会各自成键。 */
export function galleryKey(app: Pick<GalleryApp, "workspace" | "kind" | "entry">): string {
  return `${galleryWorkspaceKey(app.workspace)}|${app.kind}|${normalizeGalleryEntry(app.entry).toLowerCase()}`;
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
/**
 * 绝对路径拼装（纯字符串操作；调用方已保证 workspace 是绝对路径）。
 * POSIX 根（`/`）要特别照顾：去尾斜杠会得到空串，拼出来就丢了根（`/a.html` 变相对路径）。
 */
export function galleryAbsolutePath(workspace: string, entry: string): string {
  const trimmed = workspace.trim();
  const base = /^[\\/]+$/u.test(trimmed) ? "/" : trimmed.replace(/[\\/]+$/u, "");
  const relative = normalizeGalleryEntry(entry);
  if (relative === ".") return base;
  return `${base.endsWith("/") ? base : `${base}/`}${relative}`;
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
 * panel 本地服务的字段成对规则（2026-11-16）：填 `command` 必须填 `url`，填 `url`
 * 必须填 `command`。只给其一时平台既不能探活也不能启动——旧实现会「面板直接开窗、
 * 服务从来没起」，用户只看到页面报连不上，却找不到任何报错。
 * 返回 undefined = 合法（成对齐全，或两个都没填 = 不依赖平台托管的本地服务）。
 */
export function galleryPanelServicePairError(command: string | undefined, url: string | undefined): string | undefined {
  const hasCommand = Boolean(command?.trim());
  const hasUrl = Boolean(url?.trim());
  if (hasCommand === hasUrl) return undefined;
  if (hasCommand) {
    return "panel 的本地服务字段必须成对：给了 command 也要给 url（url 只用于探活，如 http://127.0.0.1:8791/api/health）——否则平台无法确认服务起没起；两个都不填表示面板不依赖平台托管的本地服务";
  }
  return "panel 的本地服务字段必须成对：给了 url 也要给 command（启动命令，如 node bridge.mjs，在入口所在目录执行）——否则平台不知道该怎么把服务拉起来；两个都不填表示面板不依赖平台托管的本地服务";
}

/**
 * 「谁拥有这个作品的本地服务」的唯一判据（发布回执 / 运行分流 / 文案共用）。
 *
 * **只看配置，不看此刻是否可达**（2026-11-16 与 Lead 对齐）：发布回执只能陈述
 * 配置事实，「已由平台启动」是运行时才知道的事；地址是否已经有人跑着，由运行时
 * 的探活/服务看板判定。
 *
 * - `none`：没配本地服务（面板直接开窗，由页面自己连数据源）；
 * - `platform`：配齐了 command + url → 由平台统一托管（运行时启动、关窗时停）；
 * - `external`：只配了地址、没有启动命令（只对 server 合法）→ 那是外部服务，平台不接管；
 * - `misconfigured`：panel 的字段不成对 → 平台既起不来也不知道该探什么。
 */
export type GalleryServiceOwnership = "none" | "platform" | "external" | "misconfigured";

export function galleryServiceOwnership(app: Pick<GalleryApp, "kind" | "command" | "url">): GalleryServiceOwnership {
  if (app.kind !== "panel" && app.kind !== "server") return "none";
  const hasCommand = Boolean(app.command?.trim());
  const hasUrl = Boolean(app.url?.trim());
  if (app.kind === "panel") {
    if (hasCommand && hasUrl) return "platform";
    if (!hasCommand && !hasUrl) return "none";
    // 只给一半：无论此刻可达与否都是配置错误（成对规则），不能当外部服务放行。
    return "misconfigured";
  }
  // server：有启动命令就是平台托管的后台进程（地址可达时「运行」会复用它而不重启）；
  // 只有地址没有命令 → 那是外部服务。
  if (hasCommand) return "platform";
  return hasUrl ? "external" : "none";
}

/**
 * 运行时的「面板本地服务配置不完整」提示（运行分流与回执共用，2026-11-16）：
 * 不允许再「静默直开窗」——那只会让用户看到一个永远取不到数据的页面。
 */
export function galleryPanelServiceRunError(app: Pick<GalleryApp, "title" | "command" | "url">): string {
  if (app.command?.trim()) {
    return `「${app.title}」的本地服务配置不完整：有启动命令但没有探活地址（url），平台无法确认服务是否就绪，所以不会替你启动它。点「继续开发」补上 url 再重新发布。`;
  }
  const url = app.url?.trim();
  return `「${app.title}」的本地服务配置不完整：只登记了地址${url ? ` ${url}` : ""}，没有启动命令，平台无从拉起它（面板的本地服务必须 command + url 成对，或两个都不填、由面板页自己连）。点「继续开发」补上 command 再重新发布。`;
}

/**
 * 本地服务的一句话状态（发布回执、toast、继续开发文本共用，2026-11-16）。
 *
 * 刻意只陈述**配置**，不断言「已启动」（那是运行时事实）：用户需要知道的是
 * 关窗后这个服务会不会被停——只有「平台托管」会被停。
 *
 * 空串 = 这个类型/配置不必多说一句（server 的托管说明在 runMode 文案里）。
 */
export function galleryServiceNote(app: Pick<GalleryApp, "kind" | "command" | "url">): string {
  if (app.kind !== "panel") return "";
  const ownership = galleryServiceOwnership(app);
  if (ownership === "misconfigured") {
    const missing = app.command?.trim() ? "有 command 缺 url" : "有 url 缺 command";
    return `本地服务：配置不完整（${missing}）——平台不会托管它（面板的本地服务必须 command + url 成对，或两个都不填、由面板页自己连），面板里的请求可能全部失败。`;
  }
  if (ownership === "none") return "本地服务：未配置（面板直接打开，由面板页自己连数据源；平台不启动任何进程）。";
  return "本地服务：已配置（command + url）——运行时探活：地址已可达就复用外部服务（平台不接管也不停它），否则由平台在后台启动，关窗时只停平台实际启动的那个进程。";
}

/** 发布解析结果（纯函数产出；调用方只负责 fs 校验、封面与落盘）。 */
export interface GalleryPublishResolution {
  /** 待写入的条目（更新时已带既有 id / createdAt；新建时 id 为空串，由 upsertGalleryApp 生成）。 */
  app: GalleryApp;
  /** true = 新增一张卡片；false = 更新既有条目。 */
  created: boolean;
  /** 命中的既有条目（更新时；调用方据此保留 thumb 等读侧字段）。 */
  target?: GalleryApp;
  /** 最终入口（工作区相对入口 + 绝对路径）。 */
  entry: GalleryEntryResolution;
  /** panel / server 的本地服务归属。 */
  service: GalleryServiceOwnership;
}

/**
 * 发布 / 更新的统一解析（2026-11-16）：把「草稿 → 条目 + 更新目标」这段判定收在
 * shared，utility 只补 fs 校验与封面。
 *
 * 身份优先级：`draft.appId` > 「工作区 + 类型 + 最终入口」（旧清单兼容）。
 * - appId 命中但工作区 / 类型不同 → 直接报错（绝不跨工作区、跨形态覆盖别人的作品）；
 * - appId 未命中（作品已被删）→ 报错而不是静默新建（否则用户以为改的是老作品）；
 * - 最终入口已被另一个作品占用 → 报错（否则两张卡会争同一个 id / 同一个 panel origin）；
 * - panel 的 command / url 是**权威字段**：本次没给等于「不要平台托管的本地服务」
 *   （否则成对语义无法表达「把服务去掉」）；其余可选字段（说明 / tags / 面板尺寸 /
 *   server 的 command）本次没给就沿用旧值。
 */
export function resolveGalleryPublish(input: {
  apps: readonly GalleryApp[];
  draft: GalleryDraft;
  /** 权威工作区（调用会话的工作区绝对路径）：draft.workspace 只能与它一致。 */
  workspace: string;
}): GalleryPublishResolution {
  const root = input.workspace.trim();
  if (!root) throw new Error("请先打开一个工作区，再发布作品");
  // 草稿里的 workspace 只是回显：它**不能**改变校验根（否则填一个别的目录就能绕开越界检查）。
  const declared = input.draft.workspace?.trim() ?? "";
  if (declared && galleryWorkspaceKey(declared) !== galleryWorkspaceKey(root)) {
    throw new Error(`作品必须发布到当前会话的工作区（${root}）：草稿里写的是 ${declared}`);
  }
  const title = input.draft.title.trim();
  if (!title) throw new Error("title 不能为空（作品墙上展示的名字）");
  const kind = input.draft.kind;
  if (!KINDS.includes(kind)) throw new Error(`kind 必须是 file / server / panel（收到 ${JSON.stringify(kind)}）`);
  const command = kind === "panel" || kind === "server" ? input.draft.command?.trim() || undefined : undefined;
  const url = kind === "panel" || kind === "server" ? input.draft.url?.trim() || undefined : undefined;
  if (kind === "panel") {
    // 发布阶段二次 fail-closed：实体对话框 / 旧客户端都能绕过工具层校验，这里再拒一次。
    const pairError = galleryPanelServicePairError(command, url);
    if (pairError) throw new Error(pairError);
  }
  const entry = resolveGalleryEntry({ root, path: input.draft.path, entry: input.draft.entry, kind });
  const key = galleryKey({ workspace: root, kind, entry: entry.entry });
  const appId = input.draft.appId?.trim() ?? "";
  let target: GalleryApp | undefined;
  if (appId) {
    target = input.apps.find((item) => item.id === appId);
    if (!target) throw new Error(`找不到作品 ${appId}（可能已被删除）：要新建作品就去掉 appId，或先确认作品墙里的作品 ID`);
    if (galleryWorkspaceKey(target.workspace) !== galleryWorkspaceKey(root)) {
      throw new Error(`作品 ${appId} 属于另一个工作区（${target.workspace}），不能在这里更新`);
    }
    if (target.kind !== kind) {
      throw new Error(`作品 ${appId} 的类型是 ${GALLERY_KIND_LABELS[target.kind]}（${target.kind}），不能改成 ${GALLERY_KIND_LABELS[kind]}（${kind}）：换形态请新建一个作品`);
    }
    const clash = input.apps.find((item) => item.id !== target!.id && galleryKey(item) === key);
    if (clash) {
      throw new Error(`入口 ${entry.entry} 已经被另一个作品「${clash.title}」（${clash.id}）占用：同「工作区+类型+入口」只能有一个作品，请确认要更新哪一个`);
    }
  } else {
    target = input.apps.find((item) => galleryKey(item) === key);
  }
  const now = Date.now();
  const app: GalleryApp = {
    id: target?.id ?? "",
    title,
    kind,
    workspace: root,
    entry: entry.entry,
    createdAt: target?.createdAt ?? now,
    updatedAt: now
  };
  const description = input.draft.description?.trim();
  if (description) app.description = description;
  if (input.draft.tags && input.draft.tags.length > 0) app.tags = input.draft.tags;
  if (kind === "panel") {
    if (command && url) {
      app.command = command;
      app.url = url;
    } else {
      // 成对语义要求「省略 = 不要平台托管的本地服务」。upsertGalleryApp 是
      // `{ ...existing, ...draft }` 合并，缺键会沿用旧命令——所以这里显式置空。
      app.command = undefined;
      app.url = undefined;
    }
    // 面板尺寸/形态是显示偏好：本次没给就沿用旧值（丢了会跳回缺省尺寸）。
    const panel = normalizeGalleryPanelOptions(input.draft.panel) ?? target?.panel;
    if (panel) app.panel = panel;
  }
  if (kind === "server") {
    // server 不强制成对：只给命令（无地址）也是合法登记；省略则沿用旧值。
    const nextCommand = command ?? target?.command;
    const nextUrl = url ?? target?.url;
    if (nextCommand) app.command = nextCommand;
    if (nextUrl) app.url = nextUrl;
    const runMode = input.draft.runMode === "background" ? "background" : input.draft.runMode === "page" ? "page" : target?.runMode;
    if (runMode === "background") app.runMode = "background";
  }
  return { app, created: !target, ...(target ? { target } : {}), entry, service: galleryServiceOwnership(app) };
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
 * 启动命令**在服务就绪前就结束**后，还给端口的宽限窗口（毫秒）。
 *
 * 2026-11-16 起语义变了（旧行为曾是「启动器也算正常成功路径」）：平台只托管
 * **前台、非交互、长期运行**的服务命令——命令自己结束就意味着平台再也没法回收
 * 那个进程（`pythonw` / `start` / `cmd /c start` 这类脱离进程树的启动器都属于
 * 这一类），所以「就绪前退出」一律按启动失败处理。宽限窗口只用来识别那种
 * 「命令刚结束、端口随后就通」的写法，**不再**把它当成可回收的成功服务。
 *
 * 上限不能大：命令已结束还等满 30 秒会让真写错的命令拖很久；10 秒够本机服务
 * 把端口监听起来。
 */
export const GALLERY_SERVICE_LAUNCHER_GRACE_MS = 10_000;

/** 失败提示里带的输出尾部长度（字符）：完整尾部在作品墙的服务看板里。 */
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
   * 面板 + 本地服务（2026-10-11）：先把 `command` 拉起来（**后台进程**，2026-11-12 起
   * 不再占终端标签）、探活通过再开窗。`directory` 是**入口所在目录**（启动命令在那里执行），
   * `url` 是探活地址。
   */
  | { action: "start-panel-service"; absolutePath: string; options: GalleryPanelOptions; directory: string; command: string; url: string }
  | { action: "open-browser"; url: string }
  /**
   * 服务型作品：把启动命令交给**后台进程**执行（不再开终端标签）。
   * `openPage` = 就绪后是否顺带打开内置浏览器标签页（纯后台服务为 false）。
   */
  | { action: "start-service"; directory: string; command: string; url?: string; openPage: boolean }
  /** 纯后台服务且此刻已可达（可能是用户手工起的、也可能是上一次留下的）：没有页面可开。 */
  | { action: "service-up"; url?: string }
  /**
   * 服务型但平台难以为力：只能如实说，不能装作跑起来了。
   * `message` 是具体原因（如面板本地服务字段不成对）；渲染端有它就优先显示。
   */
  | { action: "manual"; message?: string };

export function galleryRunPlan(
  app: Pick<GalleryApp, "title" | "kind" | "workspace" | "entry" | "url" | "command" | "panel" | "runMode">,
  serviceReachable: boolean
): GalleryRunPlan {
  const target = galleryRunTarget(app);
  // 面板：可以带一个**可选的本地服务**（command + url）。四种情况刻意分开（2026-11-16）：
  // 没声明服务 / 服务已可达（用户手工起的或上次运行留下的，视为外部服务）都直接开窗，
  // 绝不重启用户正在用的服务；声明了服务且不可达才先起服务再开窗；字段不成对则明确
  // 报错——旧实现会直接开窗，用户只会看到一个永远取不到数据的页面。
  if (target.kind === "panel") {
    const options = normalizeGalleryPanelOptions(app.panel) ?? {};
    const ownership = galleryServiceOwnership({ kind: "panel", command: target.command, url: target.url });
    if (ownership === "misconfigured") return { action: "manual", message: galleryPanelServiceRunError(app) };
    if (ownership === "platform" && !serviceReachable && target.command && target.url) {
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
  // 纯后台服务（反代 / API / 给别的程序用）：没有页面可开，只要进程在。
  if (galleryRunMode(app) === "background") {
    if (serviceReachable) {
      const plan: GalleryRunPlan = { action: "service-up" };
      if (target.url) plan.url = target.url;
      return plan;
    }
    if (target.command) {
      const plan: GalleryRunPlan = { action: "start-service", directory: target.directory, command: target.command, openPage: false };
      if (target.url) plan.url = target.url;
      return plan;
    }
    return { action: "manual" };
  }
  if (target.url && serviceReachable) return { action: "open-browser", url: target.url };
  if (target.command) {
    const plan: GalleryRunPlan = { action: "start-service", directory: target.directory, command: target.command, openPage: Boolean(target.url) };
    if (target.url) plan.url = target.url;
    return plan;
  }
  return { action: "manual" };
}

/**
 * 服务型作品的进程宿主：**主进程的后台进程**（2026-11-12 起的唯一形态）。
 *
 * 历史：以前是「在预览面板里开一个终端标签跑命令，进程与标签同生共死」。用户真机使用时
 * 暴露了两个问题：① 那些「给别的服务用」的反代 / API 进程根本不需要看终端，却占了主界面
 * 一个标签；② 一关标签（或关浏览器页面）服务就没了，用户没法边聊边用。现在进程由
 * `main/gallery-service-runner.ts` 持有（不占任何标签），作品墙顶部的「运行中的服务」看板
 * 是它的可见/可停入口。
 *
 * 这个字段只是「就绪后要不要顺手开页面」，见 GalleryRunMode 的说明。
 */

/** 后台服务的生命周期状态。 */
export type GalleryServiceStatus = "starting" | "running" | "stopped" | "failed";

export const GALLERY_SERVICE_STATUS_LABELS: Record<GalleryServiceStatus, string> = {
  starting: "启动中",
  running: "运行中",
  stopped: "已停止",
  failed: "启动失败"
};

/**
 * 一个后台服务（作品墙看板的数据形状，main → 渲染端整表推送）。
 *
 * 刻意带上 title / command / url 而不仅是 appId：作品被删掉之后，看板上那个还在跑的
 * 进程仍然要能被认出来、能被停掉（它不会因为清单里没这张卡就自己消失）。
 */
export interface GalleryServiceRecord {
  id: string;
  appId: string;
  title: string;
  command: string;
  /** 命令执行目录（绝对路径）。 */
  cwd: string;
  /** 探活地址（没有 url 的服务不探活，spawn 后直接算就绪）。 */
  url?: string;
  /** 面板作品的本地服务：面板窗口关掉时自动停（网关侧 stopByOwner）。 */
  ownerPanelId?: string;
  pid?: number;
  status: GalleryServiceStatus;
  /** 探活是否通过（无 url 的服务视为 true）。 */
  ready: boolean;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  /** 一句话说明（超时 / spawn 失败 / 用户停止等）。 */
  note?: string;
  /** 输出尾部（ANSI 已剥，长度≤ GALLERY_SERVICE_LOG_TAIL_CHARS）。 */
  log?: string;
}

/** 推送/展示的输出尾部上限（完整环形缓冲在 runner 内，更大）。 */
export const GALLERY_SERVICE_LOG_TAIL_CHARS = 4_000;

/** 看板只记这么多个**已结束**的服务（活着的永远不淘汰）。 */
export const MAX_GALLERY_SERVICE_RECORDS = 24;

/**
 * 起一个后台服务的请求（渲染端 → 主进程，`gallery:service-start`）。
 *
 * 带上 title / command / cwd / url 而不是只带 appId：主进程不持有作品清单（它在
 * utility 进程里），也正因为如此，清单里的作品被删掉之后看板上那个仍在跑的进程
 * 依旧能显示自己的名字与命令。
 */
export interface GalleryServiceStartRequest {
  appId: string;
  title: string;
  command: string;
  /** 命令执行目录（绝对路径）。 */
  cwd: string;
  /** 探活地址；没有它就不探活，spawn 成功即算就绪。 */
  url?: string;
  /** 面板作品的本地服务：面板窗口关掉时按它自动停。 */
  ownerPanelId?: string;
}

/** `gallery:service-start` 的回执。 */
export type GalleryServiceStartResult =
  | {
    ok: true;
    /** 平台拉起的（或复用的）服务；`external` 时没有记录（那是别人起的进程）。 */
    record?: GalleryServiceRecord;
    /** true = 复用同一个作品的同一个活进程（没有额外 spawn）。 */
    reused: boolean;
    /** true = 地址已可达但不是平台起的，没碰它。 */
    external: boolean;
    /** 面板本轮运行代际；开窗时验证，防止关窗后旧请求重新打开。 */
    panelRunToken?: number;
  }
  | { ok: false; message: string; failure?: GalleryServiceFailure; record?: GalleryServiceRecord };

/** 服务是否还活着（启动中 / 运行中）——看板与卡片角标的唯一判据。 */
export function galleryServiceLive(service: Pick<GalleryServiceRecord, "status">): boolean {
  return service.status === "starting" || service.status === "running";
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
 * 四种原因分开写：
 * - exited：命令自己退出了（写错了/依赖没装/端口被占）——带上退出码与输出尾部，
 *   这是最需要「原因」的一类；
 * - ended：命令在服务就绪前就结束了（典型是 `pythonw` / `start` / `cmd /c start`
 *   这类把服务脱离进程树的启动器）。2026-11-16 起这是**启动失败**：平台只托管
 *   前台长期运行的服务命令，命令一结束就无法建立可回收的服务所有权；
 * - timeout：进程还在跑但地址在预算内没就绪，明确给出「再点一次运行」的出路；
 * - invalid-url：登记的服务地址连解析都不行（多是自己手写的地址写错了）。
 *
 * 2026-11-12 起服务进程不再占用终端标签，所以输出指向作品墙看板的日志，而不再是
 * 「终端标签」——文案与事实必须同步，否则用户会去找一个不存在的标签。
 */
export function galleryServiceFailureMessage(
  app: Pick<GalleryApp, "title" | "url">,
  failure: GalleryServiceFailure,
  waitMs = GALLERY_SERVICE_WAIT_MS
): string {
  if (failure.reason === "exited") {
    const code = typeof failure.exitCode === "number" ? `（代码 ${failure.exitCode}）` : "";
    const tail = compactServiceTail(failure.tail);
    return `「${app.title}」的启动命令已退出${code}，服务没有起来。${tail ? `输出尾部：${tail}` : "完整输出见作品墙「运行中的服务」里的日志。"}`;
  }
  if (failure.reason === "ended") {
    const seconds = Math.max(1, Math.round(GALLERY_SERVICE_LAUNCHER_GRACE_MS / 1000));
    const where = app.url ? `（${app.url} 连不上）` : "";
    // 2026-11-16：退出码 0 **不再是**可回收的成功路径。平台只托管前台、非交互、
    // 长期运行的服务命令——命令自己结束时，平台再也拿不到那个进程，关窗回收与
    // 应用退出回收都会漏（pythonw / start / cmd /c start 这类启动器就是典型）。
    return `「${app.title}」的启动命令在服务就绪前就结束了${where}，服务在 ${seconds} 秒内没有起来。平台只托管前台、非交互、长期运行的命令；命令一结束就无法建立可回收的服务所有权（pythonw / start / cmd /c start 这类把服务脱离进程树的启动器不算）。改成前台运行的命令（如 node server.mjs）后重新发布。`;
  }
  if (failure.reason === "invalid-url") {
    return `「${app.title}」登记的服务地址无法解析${app.url ? `（${app.url}）` : ""}：点「继续开发」让 AI 修正后再运行。`;
  }
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  const where = app.url ? `（${app.url} 连不上）` : "";
  return `「${app.title}」的服务在 ${seconds} 秒内没有就绪${where}：进程已转到后台继续跑，稍后在看板上看日志，或再点一次「运行」。`;
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
 *
 * 2026-11-16 整改：光把作品信息塞进输入框不算闭环。稳定身份（作品 ID）+ 固定
 * origin 说明 + 「改完用同一 appId 重新发布」的操作协议必须写进来，否则模型
 * 改完就停手，用户运行的还是旧页面（panel 还会因换 id 而丢数据）。
 */
export function composeGalleryDevMessage(app: GalleryApp): string {
  const entryLabel = app.entry === "." ? "（工作区根目录）" : app.entry;
  const lines = [
    "【作品】",
    `作品 ID：${app.id}`,
    `标题：${app.title}`,
    `类型：${GALLERY_KIND_LABELS[app.kind]}（${app.kind}）`,
    `入口：${entryLabel}`,
    `工作区：${app.workspace}`
  ];
  if (app.description) lines.push(`说明：${app.description}`);
  if (app.command) lines.push(`启动命令：${app.command}`);
  if (app.url) lines.push(`服务地址：${app.url}`);
  if (app.kind === "server") {
    // 服务进程的宿主是主进程后台进程（2026-11-12），继续开发的人需要知道这件事：
    // 启动命令里不能再假设「有人看着 stdout」，也不能依赖交互输入。
    lines.push(`运行方式：${GALLERY_RUN_MODE_LABELS[galleryRunMode(app)]}——启动命令由平台作为**后台进程**执行（不在终端标签里），输出会被收进作品墙顶部「运行中的服务」看板，应用退出时统一停掉。`);
    if (app.runMode === "background") lines.push("这个作品是纯后台服务（给别的程序用）：点「运行」只起进程、不打开页面。");
  }
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
    // 固定 origin 是 panel 的数据契约（2026-10-10）：继续开发的人要知道「换 id 等于换数据」。
    lines.push(`数据 origin：pidesktop-file://w-${app.id}（固定：由作品 ID 决定，localStorage / IndexedDB 按作品隔离且跨启动保留；更换作品 ID 会使原数据不可见）`);
    // 服务归属说清楚（平台托管 / 外部复用 / 没有本地服务）——本次整改的核心之一。
    lines.push(galleryServiceNote(app));
    lines.push(panelDevHint());
  }
  // 示例使用合法 JSON，模型可以直接复用；引号、路径和命令由 JSON.stringify 转义。
  const republishExample: Record<string, string> = { appId: app.id, title: app.title, kind: app.kind, path: app.entry };
  if (app.kind === "panel" && galleryServiceOwnership(app) === "platform") {
    republishExample.command = app.command!;
    republishExample.url = app.url!;
  }
  if (app.kind === "panel" && galleryServiceOwnership(app) === "none") {
    lines.push("这个面板不启用平台托管的本地服务，重新发布时 command / url 都不要带。");
  } else if (app.kind === "panel" && galleryServiceOwnership(app) === "misconfigured") {
    lines.push("现有面板服务配置不完整；重新发布前补齐 command 和 url，或将两项都移除。");
  }
  lines.push(
    "",
    "我要在这个作品上继续开发，请先读入口相关的代码再动手。",
    "改完请重新发布，确保作品墙登记信息、封面和运行配置与最终成果一致。",
    `1. 先读代码：入口（${entryLabel}）与它依赖的文件（含启动命令指向的脚本）读清楚，不要凭推测改。`,
    "2. 改完自己验证：真的跑一遍（页面 / 接口 / console），确认结果对了再往下走。",
    `3. 保持同一作品身份：除非用户明确要新做一个作品，不要改 kind（${app.kind}）与最终入口（${app.entry}）${app.kind === "panel" ? "；面板数据 origin 由作品 ID 决定，换 id 会使旧数据不可见" : ""}。`,
    `4. 完成后用同一 appId 重新发布：gallery_publish(${JSON.stringify(republishExample)})。`,
    "5. 回执必须显示这是「更新」（作品 ID 与入口都和上面一致）；确认之后才能告诉用户改完了。"
  );
  return lines.join("\n");
}
