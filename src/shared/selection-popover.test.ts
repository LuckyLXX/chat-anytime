import { describe, expect, it } from "vitest";
import { positionSelectionPopover } from "./selection-popover";

describe("选区浮层定位", () => {
  const bounds = { left: 100, top: 50, right: 500, bottom: 450 };
  it("优先放在选区上方，边界不足时放下方", () => {
    expect(positionSelectionPopover({ left: 220, top: 200, right: 300, bottom: 220 }, bounds, 82, 30)).toEqual({ left: 220, top: 162 });
    expect(positionSelectionPopover({ left: 220, top: 60, right: 300, bottom: 80 }, bounds, 82, 30)).toEqual({ left: 220, top: 88 });
  });
  it("在右侧和底部钳制，不超出可视区", () => {
    expect(positionSelectionPopover({ left: 490, top: 440, right: 500, bottom: 450 }, bounds, 300, 42)).toEqual({ left: 192, top: 390 });
  });
});
