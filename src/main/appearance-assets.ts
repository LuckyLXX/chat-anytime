import type { AppearanceSettings, CustomThemeDefinition, DesktopSettings, ThemeAssetMap } from "../shared/protocol";

/**
 * 主题重资产的进程边界投影（2026-09-25 P1）。
 *
 * 实测：`%APPDATA%/chat-anytime/settings.json` 25.5MB，其中 `appearance` 占 25.2MB
 * —— `customThemes` 19.6MB（4 套主题的 base64 素材）+ `customCssAssets` 5.6MB。
 * 关键事实：**渲染端真正需要 base64 的只有「当前生效主题」那一份**
 * （`themeAssetsForAppearance` → customCssAssets ?? 内容相同的那条主题的 assets），
 * 非活动主题的 `.assets` 一路搭车过 bootstrap / 每次保存 / utility 初始化，
 * 没有任何消费者。
 *
 * 本模块只做一件事：**主进程 → 渲染端/utility 方向的投影**剥掉主题 `.assets`。
 * 反方向（渲染端 → 主进程）照旧收全量：外观页保存某个主题时确实要把活动资产
 * 附到那条主题上，而剥掉的语义需要额外的写入通道才能表达——收益（一次用户主动
 * 保存多带 5.6MB）远小于复杂度，明确不做。
 *
 * 另一个必须处理的边界：老数据里 `customCss` 是某条自定义主题的 CSS、但
 * `customCssAssets` 为空（applyCustomTheme 之前的历史写法）。若只剥主题资产，
 * 这类用户的壁纸会因为「回退到主题 assets」这条路被切断而消失。所以投影时若
 * `customCssAssets` 缺失，就用「CSS 内容相同的那条主题」的资产补齐一次。
 */

/** 主题元数据（剥掉 assets）——渲染端只需要 id/name/css 来做列表与等值匹配。 */
function stripThemeAssets(theme: CustomThemeDefinition): CustomThemeDefinition {
  if (theme.assets === undefined) return theme;
  const { assets: _assets, ...rest } = theme;
  return rest;
}

/** 找出 `customCss` 对应的那条自定义主题（与渲染端 themeAssetsForAppearance 同口径）。 */
function activeCustomTheme(appearance: AppearanceSettings): CustomThemeDefinition | undefined {
  return appearance.customThemes.find((theme) => theme.css === appearance.customCss);
}

/**
 * 主进程 → 渲染端/utility 方向的外观投影：主题不带 `.assets`；
 * `customCssAssets` 缺失且当前 CSS 命中了某条自定义主题时，用那条主题的资产补齐
 * （只在这一步补齐，之后渲染端始终从 customCssAssets 取，不再依赖主题正文）。
 */
export function appearanceForRenderer(appearance: AppearanceSettings): AppearanceSettings {
  const customCssAssets: ThemeAssetMap | undefined = appearance.customCssAssets
    ?? activeCustomTheme(appearance)?.assets;
  return {
    ...appearance,
    ...(customCssAssets && Object.keys(customCssAssets).length > 0 ? { customCssAssets } : {}),
    customThemes: appearance.customThemes.map(stripThemeAssets)
  };
}

/** 整份设置的同向投影（bootstrap 与 utility 初始化共用）。 */
export function settingsForRenderer(settings: DesktopSettings): DesktopSettings {
  return { ...settings, appearance: appearanceForRenderer(settings.appearance) };
}

/**
 * 渲染端 → 主进程方向的合并：元数据（名称/CSS/顺序）以收到的为准，
 * 主题 `.assets` 按 **id** 保留主进程已有的那份；只有收到的主题确实带了 assets
 * 才覆盖（外观页「保存主题」会把当前活动资产附到该主题上）。
 * 被删掉的主题随条目一起消失，其资产不再保留。
 */
export function mergeSavedAppearance(incoming: AppearanceSettings, existing: AppearanceSettings): AppearanceSettings {
  const existingAssetsById = new Map(existing.customThemes.map((theme) => [theme.id, theme.assets]));
  return {
    ...incoming,
    customThemes: incoming.customThemes.map((theme) => {
      const assets = theme.assets ?? existingAssetsById.get(theme.id);
      if (assets === undefined) return stripThemeAssets(theme);
      return { ...theme, assets };
    })
  };
}
