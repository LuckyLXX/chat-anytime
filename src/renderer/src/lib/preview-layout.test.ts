import { describe, expect, it } from "vitest";
import { workAreaPreviewClasses } from "./preview-layout";

describe("preview work-area layout classes", () => {
  it("keeps the shape class for both open and closed states", () => {
    // 形状必须常驻：收起态若退化成单列，下一次展开就没有可插值的起点
    // （styles.css「预览面板开合」一节的 --preview-open 过渡需要同类轨道）。
    expect(workAreaPreviewClasses({ open: true, tabs: false })).toBe("with-preview-empty");
    expect(workAreaPreviewClasses({ open: false, tabs: false })).toBe("with-preview-empty preview-collapsed");
    expect(workAreaPreviewClasses({ open: true, tabs: true })).toBe("with-preview");
    expect(workAreaPreviewClasses({ open: false, tabs: true })).toBe("with-preview preview-collapsed");
  });

  it("marks the collapsed state only through preview-collapsed (no track-count change)", () => {
    const open = workAreaPreviewClasses({ open: true, tabs: true }).split(" ");
    const closed = workAreaPreviewClasses({ open: false, tabs: true }).split(" ");
    expect(closed.filter((name) => !open.includes(name))).toEqual(["preview-collapsed"]);
    expect(open.filter((name) => !closed.includes(name))).toEqual([]);
  });

  it("never mixes the empty and tab shapes", () => {
    for (const open of [true, false]) {
      const classes = workAreaPreviewClasses({ open, tabs: true }).split(" ");
      expect(classes).toContain("with-preview");
      expect(classes).not.toContain("with-preview-empty");
    }
  });
});
