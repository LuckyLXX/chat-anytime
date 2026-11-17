import { describe, expect, it } from "vitest";
import { MAX_PREVIEW_FEEDBACK_LENGTH, MAX_PREVIEW_SELECTION_LENGTH, normalizePreviewSelection } from "../../../shared/preview-selection";
import { composePreviewSelectionMessage } from "./preview-selection";

describe("预览选区与修改意见", () => {
  it("拒绝空白和非字符串选区，同时保留文本两端的缩进与换行", () => {
    expect(normalizePreviewSelection(" \n\t")).toBeUndefined();
    expect(normalizePreviewSelection(null)).toBeUndefined();
    expect(normalizePreviewSelection("  一行\n第二行\n")).toBe("  一行\n第二行\n");
  });

  it("裁剪超长选区，不在代理对中间截断", () => {
    expect(normalizePreviewSelection("甲".repeat(MAX_PREVIEW_SELECTION_LENGTH + 3))).toHaveLength(MAX_PREVIEW_SELECTION_LENGTH);
    const prefix = "甲".repeat(MAX_PREVIEW_SELECTION_LENGTH - 1);
    expect(normalizePreviewSelection(prefix + "🐟尾")).toBe(prefix);
    expect(normalizePreviewSelection("🐟".repeat(MAX_PREVIEW_SELECTION_LENGTH / 2))).toHaveLength(MAX_PREVIEW_SELECTION_LENGTH);
  });

  it("生成带来源、原文与修改意见的草稿，保留换行、围栏和特殊字符", () => {
    const text = "  const x = \"🐟\";\n```【原文】\n";
    expect(composePreviewSelectionMessage({ source: "src/例子.ts", text }, " 请保留 <>&\n并调整 ")).toBe(
      "【预览选区修改】\n来源：src/例子.ts\n\n选中内容：\n" + text + "\n\n修改意见：\n请保留 <>&\n并调整"
    );
    expect(composePreviewSelectionMessage({ source: "https://example.com/?a=1&b=2", text: "网页" }, "修改")).toContain("来源：https://example.com/?a=1&b=2");
  });

  it("拒绝空意见和空选区，并限制意见长度", () => {
    expect(composePreviewSelectionMessage({ source: "a", text: " \n" }, "修改")).toBeUndefined();
    expect(composePreviewSelectionMessage({ source: "a", text: "内容" }, "  ")).toBeUndefined();
    const result = composePreviewSelectionMessage({ source: "a", text: "内容" }, "改".repeat(MAX_PREVIEW_FEEDBACK_LENGTH + 1));
    expect(result?.split("修改意见：\n")[1]).toHaveLength(MAX_PREVIEW_FEEDBACK_LENGTH);
    const prefix = "改".repeat(MAX_PREVIEW_FEEDBACK_LENGTH - 1);
    expect(composePreviewSelectionMessage({ source: "a", text: "内容" }, prefix + "🐟尾")?.split("修改意见：\n")[1]).toBe(prefix);
  });
});
