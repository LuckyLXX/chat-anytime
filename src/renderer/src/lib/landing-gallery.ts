import type { AppearanceSettings } from "../../../shared/protocol";

/**
 * 空态首页（新话题的空白主区域）是否展示作品墙。
 *
 * 开关是 `appearance.showGalleryWall`（通用设置 →「界面」卡片），**缺省 = 展示**：
 * 没设置过的用户与开关存在之前的视觉逐字节一致，只有显式 `false` 才换回默认
 * 空态「今天想开发什么？」。三处消费点（App 的两处 renderLanding 注入）都走
 * 这个函数，避免「缺省口径」在两个字面量里各写一遍。
 *
 * 为什么单独一个函数而不是内联 `settings.appearance.showGalleryWall`：
 * 这个字段是**后加**的，磁盘上的旧配置、demo 桩、单测夹具都可能没有它
 * （`migrateSettings` 会在重启读盘时补上，但渲染端在补上之前就可能先渲染一次），
 * 而 `undefined !== false` 与 `!== false` 在「缺省值该是什么」上正好相反——
 * 把这条口径钉在一个带测试的函数里，改错就会红。
 *
 * 注意作用范围：只管空白首页那面墙。顶栏作品下拉里的「打开作品墙」是另一条
 * 通路（`galleryWallOpen`），不开这个开关也始终可达。
 */
export function showGalleryWallLanding(appearance: Pick<AppearanceSettings, "showGalleryWall"> | undefined): boolean {
  return appearance?.showGalleryWall !== false;
}
