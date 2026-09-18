// 浏览器预览书签：渲染端本地存储 + 可单测的纯读写层（与 lib/browser-address.ts
// 同一模式）。书签全局共享、不按浏览器标签 tabId 分隔——符合书签语义，多个
// 浏览器标签用同一份；storage 不可用（演示模式等）时静默降级、绝不抛错。

export interface BrowserBookmark {
  /** crypto.randomUUID()；不可用时降级 Date.now()+random。 */
  id: string;
  /** 页面标题；无标题时回落为域名。 */
  title: string;
  url: string;
  /** 新书签插列表最前；同 URL 重新收藏也会刷新该值并置顶。 */
  addedAt: number;
}

const BOOKMARKS_STORAGE_KEY = "pidesktop.browser-bookmarks";

function createBookmarkId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `bookmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** URL 的域名（含端口）；无法解析出主机名时返回空串。 */
export function bookmarkHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function normalizeStoredBookmark(value: unknown): BrowserBookmark | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (!url) return undefined;
  const title = typeof record.title === "string" && record.title.trim() ? record.title.trim() : bookmarkHost(url) || url;
  const id = typeof record.id === "string" && record.id ? record.id : createBookmarkId();
  const addedAt = typeof record.addedAt === "number" && Number.isFinite(record.addedAt) ? record.addedAt : 0;
  return { id, title, url, addedAt };
}

/** 存储中的书签（最新的在前）。坏数据 / storage 不可用时返回空数组，不抛错。 */
export function storedBrowserBookmarks(): BrowserBookmark[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(BOOKMARKS_STORAGE_KEY);
  } catch {
    // 浏览器演示模式等场景 localStorage 可能不可用：退化为空列表。
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeStoredBookmark)
      .filter((item): item is BrowserBookmark => item !== undefined);
  } catch {
    return [];
  }
}

function writeBrowserBookmarks(list: BrowserBookmark[]): void {
  try {
    window.localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* storage may be unavailable in browser demo */
  }
}

/**
 * 收藏一个 URL：同 URL 已存在则刷新标题并置顶（不新增条目，原有 id 保留）；
 * trim 后为空的 URL 返回 undefined（调用方据此提示），不做任何写入。
 */
export function addBrowserBookmark(url: string, title?: string): BrowserBookmark | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  const list = storedBrowserBookmarks();
  const existing = list.find((item) => item.url === trimmed);
  const nextTitle = title?.trim() || existing?.title || bookmarkHost(trimmed) || trimmed;
  const bookmark: BrowserBookmark = { id: existing?.id ?? createBookmarkId(), title: nextTitle, url: trimmed, addedAt: Date.now() };
  writeBrowserBookmarks([bookmark, ...list.filter((item) => item !== existing)]);
  return bookmark;
}

/** 按 id 删除；id 不存在或写入失败均静默。 */
export function removeBrowserBookmark(id: string): void {
  const list = storedBrowserBookmarks();
  const next = list.filter((item) => item.id !== id);
  if (next.length === list.length) return;
  writeBrowserBookmarks(next);
}

function hashHue(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) % 360;
  }
  return ((hash % 360) + 360) % 360;
}

/**
 * 首字母色块图标数据：域名首字母（大写）+ 域名 hash 映射 0–360 色相。
 * 纯函数、确定性——不依赖 favicon 在线服务，内网站点 / 离线场景均可用。
 */
export function bookmarkGlyph(url: string): { letter: string; hue: number } {
  const source = (bookmarkHost(url) || url.trim()).replace(/^www\./iu, "");
  const match = source.match(/[a-z0-9\u4e00-\u9fff]/iu);
  return { letter: (match?.[0] ?? "?").toUpperCase(), hue: hashHue(source) };
}
