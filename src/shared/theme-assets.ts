import type { AppearanceSettings } from "./protocol.js";

/**
 * 主题资产的协议与纯函数（2026-09-26 主题资产落磁盘）。
 *
 * 为什么不再把资产变成 data URL 内联进 CSS/设置：主题 CSS 是**内联 `<style>`** 注入的，
 * 而 CSS 规范里相对 `url()` 的解析基准是「样式表自身的 URL」——内联样式表没有自身 URL，
 * 于是只能退回文档 origin（dev 下是 http://localhost），相对路径必然 404。所以旧实现
 * 强制把资产读成 data URL 再改写 `url()`；体量小时能用，实测 24MB 时是灾难。
 *
 * 现在资产**落成磁盘文件**（`<agentDir>/pidesktop-themes/<scope>/`），CSS 里的安全相对
 * 引用被改写成 `pidesktop-file://theme/<scope>/<relativePath>`（已有特权 scheme，主进程
 * 流式读盘），浏览器自己去取、解码、缓存。base64 在整条链路上消失。
 *
 * 本模块只放**纯函数与协议**（渲染端、主进程、迁移三处共用），文件系统操作在
 * `src/main/theme-assets.ts`。
 */

/** 协议 URL 的固定 host：`pidesktop-file://theme/<enc scope>/<enc relativePath>`。 */
export const THEME_ASSET_URL_HOST = "theme";

/** 未保存为主题的活动资产所用作用域目录名（导入 CSS 后还没点「保存主题」的状态）。 */
export const THEME_ASSET_CURRENT_SCOPE = "current";

/**
 * 与 `PREVIEW_FILE_SCHEME` 同值。这里单独声明是刻意的：本模块被 `protocol.ts`
 * 反向引用（DesktopApi 的返回类型），从 protocol 取值会形成循环导入。
 * `theme-assets.test.ts` 钉住两者必须相等。
 */
export const THEME_ASSET_SCHEME = "pidesktop-file";

/** CSS `url(...)` 的引用抽取（带引号/不带引号、空白容忍）。 */
export const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/giu;

/** 不需要（也不能）当成主题资产解析的引用：外链、data URL、变量与 SVG 内部引用。 */
const EXTERNAL_REFERENCE_PATTERN = /^(?:data:|https?:|file:|blob:|pidesktop-file:|var\(|#)/iu;

export function isExternalThemeReference(reference: string): boolean {
  return !reference || EXTERNAL_REFERENCE_PATTERN.test(reference.trim());
}

const MAX_RELATIVE_PATH_LENGTH = 1024;

/**
 * 归一化 + 安全判定：返回可直接拼进作用域目录的**小写正斜杠**相对路径，
 * 任何越界/可疑写法返回 undefined（调用方保持原样，不猜）。
 *
 * 拒绝清单：空、绝对路径（`/x`、`C:/x`、`\\server\share`）、含 `:`（协议前缀 /
 * NTFS 数据流）、`.`/`..`/空路径段、控制字符、超长。
 */
export function themeAssetRelativePath(value: string): string | undefined {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\/+?/u, "").toLowerCase();
  if (!normalized || normalized.length > MAX_RELATIVE_PATH_LENGTH) return undefined;
  if (normalized.startsWith("/") || normalized.includes(":")) return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return normalized;
}

/** 作用域名（主题 id 或 `current`）：不得含路径分隔符或 Windows 非法字符。 */
export function themeAssetScopeName(value: string): string | undefined {
  const scope = value.trim();
  if (!scope || scope.length > 128 || scope === "." || scope === "..") return undefined;
  if (/[\\/:*?"<>|\u0000-\u001f]/u.test(scope)) return undefined;
  return scope;
}

export function themeAssetFileUrl(scope: string, relativePath: string): string {
  return `${THEME_ASSET_SCHEME}://${THEME_ASSET_URL_HOST}/${encodeURIComponent(scope)}/${encodeURIComponent(relativePath)}`;
}

/**
 * 是不是「主题资产形态」的 URL（host 对得上，但**不保证内容合法**）。
 * 协议 handler 用它把「解析失败的 theme URL」（穿越/绝对路径/非法编码）与
 * 「跟主题无关的 URL」分开：前者 403，后者落回其它分支或 400。
 */
export function isThemeAssetUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === `${THEME_ASSET_SCHEME}:` && url.hostname === THEME_ASSET_URL_HOST;
  } catch {
    return false;
  }
}

/**
 * 解析主题资产 URL，非法一律返回 undefined（协议 handler 据此回 400）。
 * 与 `parseWorkspaceFilePreviewUrl` 同款：分段解码、段数必须恰好 2、
 * 作用域与相对路径都要通过安全判定（纵深防御：handler 还会再查一次根目录包含）。
 */
export function parseThemeAssetUrl(input: string): { scope: string; relativePath: string } | undefined {
  try {
    const url = new URL(input);
    if (url.protocol !== `${THEME_ASSET_SCHEME}:` || url.hostname !== THEME_ASSET_URL_HOST) return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) return undefined;
    const scope = themeAssetScopeName(decodeURIComponent(segments[0]!));
    const relativePath = themeAssetRelativePath(decodeURIComponent(segments[1]!));
    if (!scope || !relativePath) return undefined;
    return { scope, relativePath };
  } catch {
    return undefined;
  }
}

/** CSS 里全部**安全相对**引用（已归一化、去重、保持出现顺序）——落盘收集的清单来源。 */
export function themeAssetReferences(css: string): string[] {
  const found = new Set<string>();
  css.replace(CSS_URL_PATTERN, (match, _quote: string, rawReference: string) => {
    if (!isExternalThemeReference(rawReference)) {
      const relativePath = themeAssetRelativePath(rawReference);
      if (relativePath) found.add(relativePath);
    }
    return match;
  });
  return [...found];
}

/**
 * 把 CSS 里的安全相对引用改写成协议 URL（`url("pidesktop-file://theme/<scope>/<rel>")`）。
 * 其余引用（外链 / data / var / `#id` / 不安全相对路径）原样保留——与旧 `resolveThemeAssets`
 * 的跳过清单一致。作用域名非法时整篇不改写（宁可主题图不显示，也不拼出可疑路径）。
 */
export function resolveThemeAssetUrls(css: string, scope: string): string {
  const safeScope = themeAssetScopeName(scope);
  if (!safeScope || !css) return css;
  return css.replace(CSS_URL_PATTERN, (match, _quote: string, rawReference: string) => {
    if (isExternalThemeReference(rawReference)) return match;
    const relativePath = themeAssetRelativePath(rawReference);
    return relativePath ? `url("${themeAssetFileUrl(safeScope, relativePath)}")` : match;
  });
}

/**
 * 当前生效的作用域：CSS 内容等于某条自定义主题 → 该主题 id（资产在 `<id>/`），
 * 否则是导入后未保存成主题的草稿 → `current`。
 * 与主进程的对账口径（`reconcileThemeAssetDirs`）必须一致。
 */
export function activeThemeScope(appearance: Pick<AppearanceSettings, "customCss" | "customThemes">): string {
  return appearance.customThemes.find((theme) => theme.css === appearance.customCss)?.id ?? THEME_ASSET_CURRENT_SCOPE;
}

/** 主题导入结果（主进程 `theme.import` 的返回形状）。 */
export interface ThemeImportOutcome {
  ok: boolean;
  /** 用户在选择对话框里点了取消：不是错误，渲染端不显示。 */
  canceled?: boolean;
  /** 失败原因（ok=false 且有值）。 */
  message?: string;
  /** 主题名（CSS 里的 `Theme Name:` / `主题:` 优先，否则目录名）。 */
  name?: string;
  css?: string;
  /** 成功落盘的资产数。 */
  assetCount?: number;
  /** 落盘资产总字节数。 */
  bytes?: number;
  /** CSS 引用了、但在源目录里找不到的资产（如实上报，不静默）。 */
  missing?: string[];
  /** 找到了、但扩展名不在白名单内的资产（跳过并上报）。 */
  skipped?: string[];
}
