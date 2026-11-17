import { describe, expect, it } from "vitest";
import { MAX_PREVIEW_SELECTION_LENGTH, MAX_PREVIEW_SOURCE_LENGTH } from "../shared/preview-selection.js";
import { parseBrowserTextSelection } from "./browser-preview-pick.js";

describe("网页选区 IPC 校验", () => {
  it("保留网页 URL、原始换行和缩进，缺失 URL 时回落标签地址", () => {
    expect(parseBrowserTextSelection({ url: "https://example.com/frame", text: "  内容\n" }, "fallback")).toEqual({ url: "https://example.com/frame", text: "  内容\n" });
    expect(parseBrowserTextSelection({ text: "内容" }, "fallback")).toEqual({ url: "fallback", text: "内容" });
  });
  it("拒绝无效负载及空白选区", () => {
    for (const input of [null, 2, "内容", {}, { text: 3 }, { text: " \n" }]) {
      expect(parseBrowserTextSelection(input, "fallback")).toBeUndefined();
    }
  });
  it("主进程再次限制选区与 URL 长度", () => {
    const result = parseBrowserTextSelection({ url: "u".repeat(MAX_PREVIEW_SOURCE_LENGTH + 1), text: "x".repeat(MAX_PREVIEW_SELECTION_LENGTH + 1) }, "fallback");
    expect(result?.url).toHaveLength(MAX_PREVIEW_SOURCE_LENGTH);
    expect(result?.text).toHaveLength(MAX_PREVIEW_SELECTION_LENGTH);
  });
});
