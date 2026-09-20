/**
 * 作品（Gallery）：把用 AI 做出来的成果登记成「可反复运行、可一键继续开发」的
 * 一等公民。作品不一定单文件——可能是一个 html，也可能是一整个目录 + 启动命令。
 *
 * 本模块是**纯数据层**：类型 + 归一化 + 增删改 + 运行分流判定。所有 IO（读盘、
 * 缩略图渲染、静态服务、composer 注入）都在调用方；渲染端与主进程共享同一组
 * 纯函数，避免两处各判一套「这作品该怎么跑」。
 *
 * 关键设计（2026-09-20 与用户对齐）：
 * - 清单**全局跨工作区**（一个池子，换工作区也在），落 `<agentDir>/pidesktop-gallery/`；
 * - 同一「工作区 + 入口 + 类型」重复发布 = 更新而非新增（否则作品墙会出重复卡片）；
 * - 运行**一律走内置浏览器 + 本地静态服务**（单文件也能跑，且 console/网络/相对
 *   资源全可用）；沙箱 iframe 只跑得了单文件且有 origin 限制，故不作运行通道。
 */

/** 作品类型：file = 入口文件（如导出的单文件 html）；server = 需要起服务的项目目录。 */
export type GalleryKind = "file" | "server";

export interface GalleryApp {
  id: string;
  title: string;
  description?: string;
  kind: GalleryKind;
  /** 绝对路径：运行、继续开发、打开文件全靠它，因此跨工作区清单必须存绝对路径。 */
  workspace: string;
  /** 入口：kind=file 时是工作区相对路径；kind=server 时是目录相对路径（"." = 工作区根）。 */
  entry: string;
  /** kind=server：启动命令（本期不自动执行，用户在终端里回车）。 */
  command?: string;
  /** kind=server：服务地址。存在时「运行」直接开浏览器，无需起进程。 */
  url?: string;
  /** 缩略图文件名（位于全局 thumbs 目录内，与条目同生共死）。 */
  thumb?: string;
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
  description?: string;
  tags?: string[];
  workspace?: string;
}

export const GALLERY_KIND_LABELS: Record<GalleryKind, string> = {
  file: "网页",
  server: "服务"
};

/** 清单上限：超出按 updatedAt 淘汰最旧（调用方负责同步清理其缩略图）。 */
export const MAX_GALLERY_APPS = 200;

const KINDS: readonly GalleryKind[] = ["file", "server"];

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
  const command = trimmed(record.command);
  if (kind === "server" && command) app.command = command;
  const url = trimmed(record.url);
  if (kind === "server" && url) app.url = url;
  const thumb = trimmed(record.thumb);
  if (thumb) app.thumb = thumb;
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
 * 发布/更新（纯函数，调用方负责落盘）：同 id 或同入口键视为更新，保留 createdAt 与
 * 已有缩略图（除非本次带了新缩略图）。
 */
export function upsertGalleryApp(list: readonly GalleryApp[], draft: GalleryApp, now = Date.now()): { list: GalleryApp[]; app: GalleryApp } {
  const key = galleryKey(draft);
  const index = list.findIndex((item) => item.id === draft.id || galleryKey(item) === key);
  if (index < 0) {
    const app: GalleryApp = { ...draft, createdAt: draft.createdAt || now, updatedAt: now };
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
  | { kind: "server"; url?: string; directory: string; command?: string };

/** 绝对路径拼装（纯字符串操作；调用方已保证 workspace 是绝对路径）。 */
export function galleryAbsolutePath(workspace: string, entry: string): string {
  const base = workspace.replace(/[\\/]+$/u, "");
  const relative = normalizeGalleryEntry(entry);
  if (relative === ".") return base;
  return `${base}/${relative}`;
}

export function galleryRunTarget(app: Pick<GalleryApp, "kind" | "workspace" | "entry" | "url" | "command">): GalleryRunTarget {
  const absolutePath = galleryAbsolutePath(app.workspace, app.entry);
  if (app.kind === "server") {
    const target: GalleryRunTarget = { kind: "server", directory: absolutePath };
    if (app.url) target.url = app.url;
    if (app.command) target.command = app.command;
    return target;
  }
  return { kind: "file", absolutePath };
}

/** 缩略图文件名（全局 thumbs 目录内）：`gallery-<yyyyMMdd-HHmmss-mmm>.png`，与截图同风格。 */
export function galleryThumbName(at = Date.now()): string {
  const date = new Date(at);
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `gallery-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}.png`;
}

/** 只有可离屏渲染的静态页面才值得生成缩略图（服务型留空，卡片用类型徽标站位）。 */
export function galleryThumbEligible(app: Pick<GalleryApp, "kind" | "entry">): boolean {
  if (app.kind !== "file") return false;
  return /\.(?:html?|svg)$/iu.test(app.entry);
}

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
  lines.push("", "我要在这个作品上继续开发，请先读入口相关的代码再动手。");
  return lines.join("\n");
}
