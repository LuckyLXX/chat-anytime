/**
 * 主题运行时共用件（2026-09-23 从 App.tsx 抽出，App 与外观页共用）。
 *
 * `customCssHasWallpaper` 同时被应用外壳（App.tsx 把主题 CSS/壁纸属性写进 `<html>`）
 * 和外观页的实时预览（ThemePreview）消费，放在组件里会形成 App ↔ 外观页的循环依赖，
 * 所以落到 lib 层。
 *
 * 2026-09-26：资产不再经渲染端转换（旧 `themeAssetsForAppearance` /
 * `useThemeAssetUrls` / data URL → blob 的链路已删）。主题引用的相对 `url()` 由
 * `resolveThemeAssetUrls`（`src/shared/theme-assets.ts`）直接改写成
 * `pidesktop-file://theme/<scope>/<relative>`，浏览器自己读盘、解码、缓存。
 */

/** 自定义 CSS 是否声明了壁纸（决定 html[data-theme-wallpaper] 与预览的壁纸层）。 */
export function customCssHasWallpaper(css: string): boolean {
  return /--chat-bg-image\s*:\s*(?!none\b)/iu.test(css);
}
