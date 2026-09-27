import { describe, expect, it } from "vitest";
import { showGalleryWallLanding } from "./landing-gallery";

/**
 * 空态首页作品墙开关（appearance.showGalleryWall）的判定回归网。
 *
 * 这个开关的语义是「缺省 = 展示」——老配置里没有这个字段，用户不该因为一次
 * 升级就看到空白首页换了样子。所以「undefined 走哪一支」是本测试的核心，
 * 而它正是那种能在重构中被无意识写反（`!== true` 就全反了）的地方。
 */
describe("空态首页作品墙开关", () => {
  it("缺省（老配置 / demo 桩没有这个字段）视为展示", () => {
    expect(showGalleryWallLanding(undefined)).toBe(true);
    expect(showGalleryWallLanding({} as { showGalleryWall: boolean })).toBe(true);
  });

  it("显式 true 展示，显式 false 隐藏", () => {
    expect(showGalleryWallLanding({ showGalleryWall: true })).toBe(true);
    expect(showGalleryWallLanding({ showGalleryWall: false })).toBe(false);
  });

  it("只有布尔 false 才算关闭——脏值（字符串/数字）按展示处理", () => {
    // 配置文件可能被手改过；`"false"` 这种真值字符串不该把作品墙意外关掉。
    expect(showGalleryWallLanding({ showGalleryWall: "false" as unknown as boolean })).toBe(true);
    expect(showGalleryWallLanding({ showGalleryWall: 0 as unknown as boolean })).toBe(true);
  });
});
