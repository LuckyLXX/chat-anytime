import { describe, expect, it } from "vitest";
import { clampPreviewSplit, PREVIEW_SPLIT_MAX, PREVIEW_SPLIT_MIN, previewSplitFromKey } from "./preview-split";

describe("preview split controls", () => {
  it("clamps pointer values to usable chat and preview widths", () => {
    expect(clampPreviewSplit(Number.NaN)).toBe(50);
    expect(clampPreviewSplit(10)).toBe(PREVIEW_SPLIT_MIN);
    expect(clampPreviewSplit(90)).toBe(PREVIEW_SPLIT_MAX);
    expect(clampPreviewSplit(61.5)).toBe(61.5);
  });

  it("supports keyboard resizing and reset boundaries", () => {
    expect(previewSplitFromKey("ArrowLeft", 50)).toBe(48);
    expect(previewSplitFromKey("ArrowDown", 50)).toBe(52);
    expect(previewSplitFromKey("Home", 50)).toBe(PREVIEW_SPLIT_MIN);
    expect(previewSplitFromKey("End", 50)).toBe(PREVIEW_SPLIT_MAX);
    expect(previewSplitFromKey("Escape", 50)).toBeUndefined();
  });
});
