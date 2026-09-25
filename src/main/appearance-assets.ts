import type { AppearanceSettings, CustomThemeDefinition, DesktopSettings } from "../shared/protocol";

/**
 * 主题**内联资产**（迁移残留）的进程边界投影。
 *
 * 历史：2026-09-25 之前主题资产是内联 base64（`customThemes[].assets` +
 * `appearance.customCssAssets`，实测 `settings.json` 25.5MB），P1-4 只把「渲染端真正会
 * 用到的那一份」留下、其余剥掉，24.30MB → 5.55MB。
 *
 * 2026-09-26 主题资产落磁盘（`<agentDir>/pidesktop-themes/<scope>/` + `pidesktop-file://`
 * 协议）之后，这两个字段**只是迁移残留**：只有「超过体积上限 / 写盘失败」的资产会继续
 * 以 base64 留在配置文件里（见 `theme-assets.ts` 的 `migrateInlineThemeAssets`）。
 * 渲染端**完全不消费**它们——CSS 里的相对 `url()` 由 `resolveThemeAssetUrls` 改写成
 * 协议 URL。
 *
 * 于是本模块只剩两件事：
 *
 * 1. 主进程 → 渲染端方向剥掉内联资产：渲染端不消费，就不该搭车过 IPC（尤其渲染端
 *    保存时会 `structuredClone(settings)`，残留 base64 会随每次保存走一遍进程边界）。
 * 2. 渲染端 → 主进程方向按 id / 按字段把主进程那份**保留回来**——渲染端手里没有这些
 *    字段，直接覆盖就会把残留的 base64 抹掉（那是数据丢失，不是清理）。被删掉的主题
 *    随条目一起消失（用户明确删了这个主题）。
 */

/** 主题定义（剥掉内联资产）——渲染端只需要 id/name/css 来做列表与等值匹配。 */
function stripThemeAssets(theme: CustomThemeDefinition): CustomThemeDefinition {
  if (theme.assets === undefined) return theme;
  const { assets: _assets, ...rest } = theme;
  return rest;
}

/**
 * 主进程 → 渲染端/utility 方向的外观投影：不带任何内联资产。
 * 本来就没有残留时原样返回（保持引用身份，避免无谓的重渲染与 IPC 载荷差异）。
 */
export function appearanceForRenderer(appearance: AppearanceSettings): AppearanceSettings {
  if (appearance.customCssAssets === undefined && appearance.customThemes.every((theme) => theme.assets === undefined)) return appearance;
  const { customCssAssets: _customCssAssets, ...rest } = appearance;
  return { ...rest, customThemes: appearance.customThemes.map(stripThemeAssets) };
}

/** 整份设置的同向投影（bootstrap 与 utility 初始化共用）。 */
export function settingsForRenderer(settings: DesktopSettings): DesktopSettings {
  const appearance = appearanceForRenderer(settings.appearance);
  return appearance === settings.appearance ? settings : { ...settings, appearance };
}

/**
 * 渲染端 → 主进程方向的合并：元数据（名称/CSS/顺序）以收到的为准，
 * 内联资产按 **主题 id**（以及 customCssAssets 字段本身）保留主进程已有的那份；
 * 只有收到的载荷确实带了资产才覆盖。渲染端手里的载荷永远不带这些字段（下行已剥），
 * 所以这条恢复路径是「残留数据不被一次保存抹掉」的唯一保障。
 */
export function mergeSavedAppearance(incoming: AppearanceSettings, existing: AppearanceSettings): AppearanceSettings {
  const existingAssetsById = new Map(existing.customThemes.map((theme) => [theme.id, theme.assets]));
  return {
    ...incoming,
    ...(incoming.customCssAssets === undefined && existing.customCssAssets !== undefined ? { customCssAssets: existing.customCssAssets } : {}),
    customThemes: incoming.customThemes.map((theme) => {
      const assets = theme.assets ?? existingAssetsById.get(theme.id);
      return assets === undefined ? theme : { ...theme, assets };
    })
  };
}
