import { useEffect, useState } from "react";
import type { AppearanceSettings as AppearanceSettingsValue, ThemeAssetMap } from "../../../shared/protocol";
import { createThemeAssetUrls } from "./theme-assets";

/**
 * 主题运行时（2026-09-23 从 App.tsx 抽出，App 与外观页共用）。
 *
 * 三个件都同时被应用外壳（App.tsx 把主题 CSS/壁纸属性写进 <html>）和外观页的
 * 实时预览（ThemePreview）消费，放在组件里会形成 App ↔ 外观页的循环依赖，
 * 所以落到 lib 层。
 */

/** 主题资产来源：显式导入的 assets 优先，否则跟随「CSS 内容相同」的那条自定义主题。 */
export function themeAssetsForAppearance(appearance: AppearanceSettingsValue): ThemeAssetMap | undefined {
  if (appearance.customCssAssets) return appearance.customCssAssets;
  return appearance.customThemes.find((theme) => theme.css === appearance.customCss)?.assets;
}

/** data URL 资产 → object URL（挂载期创建、卸载或资产变更时 revoke）。 */
export function useThemeAssetUrls(assets: ThemeAssetMap | undefined): ThemeAssetMap {
  const [urls, setUrls] = useState<ThemeAssetMap>({});
  useEffect(() => {
    const assetUrlSet = createThemeAssetUrls(assets);
    setUrls(assetUrlSet.urls);
    return assetUrlSet.revoke;
  }, [assets]);
  return urls;
}

/** 自定义 CSS 是否声明了壁纸（决定 html[data-theme-wallpaper] 与预览的壁纸层）。 */
export function customCssHasWallpaper(css: string): boolean {
  return /--chat-bg-image\s*:\s*(?!none\b)/iu.test(css);
}
