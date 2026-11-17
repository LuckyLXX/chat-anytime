import { describe, expect, it } from "vitest";
import { MAX_PREVIEW_SELECTION_LENGTH, MAX_PREVIEW_SOURCE_LENGTH } from "../shared/preview-selection.js";
import { parseBrowserTextSelection } from "./browser-preview-pick.js";

const valid = { text: "  内容\n", note: "修改", requestId: "req-1" };
describe("网页选区 IPC 校验", () => {
  it("保留网页 URL、原始换行和缩进，缺失 URL 时回落标签地址", () => {
    expect(parseBrowserTextSelection({ ...valid, url: "https://example.com/frame" }, "fallback")).toEqual({ ...valid, url: "https://example.com/frame" });
    expect(parseBrowserTextSelection(valid, "fallback")).toEqual({ ...valid, url: "fallback" });
  });
  it("拒绝无效负载、空白选区、空意见和非法请求 ID", () => {
    for (const input of [null, 2, "内容", {}, { ...valid, text: " \n" }, { ...valid, note: " " }, { ...valid, requestId: "../bad" }]) {
      expect(parseBrowserTextSelection(input, "fallback")).toBeUndefined();
    }
  });
  it("主进程再次限制选区与 URL 长度", () => {
    const result = parseBrowserTextSelection({ ...valid, url: "u".repeat(MAX_PREVIEW_SOURCE_LENGTH + 1), text: "x".repeat(MAX_PREVIEW_SELECTION_LENGTH + 1) }, "fallback");
    expect(result?.url).toHaveLength(MAX_PREVIEW_SOURCE_LENGTH);
    expect(result?.text).toHaveLength(MAX_PREVIEW_SELECTION_LENGTH);
  });
});
