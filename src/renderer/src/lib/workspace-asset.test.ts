import { describe, expect, it } from "vitest";
import { workspaceFilePreviewUrl } from "../../../shared/protocol";
import { resolveWorkspaceAssetUrl } from "./workspace-asset";

const workspace = "D:\\默认工作区";

describe("resolveWorkspaceAssetUrl", () => {
  it("maps workspace-relative image paths onto the preview protocol", () => {
    expect(resolveWorkspaceAssetUrl("outputs/fox.png", workspace)).toBe(workspaceFilePreviewUrl(workspace, "outputs/fox.png"));
    expect(resolveWorkspaceAssetUrl("./outputs/fox.png", workspace)).toBe(workspaceFilePreviewUrl(workspace, "outputs/fox.png"));
    expect(resolveWorkspaceAssetUrl("outputs\\fox.png", workspace)).toBe(workspaceFilePreviewUrl(workspace, "outputs/fox.png"));
    expect(resolveWorkspaceAssetUrl("  outputs/fox.png  ", workspace)).toBe(workspaceFilePreviewUrl(workspace, "outputs/fox.png"));
  });

  it("keeps query/hash suffixes outside the encoded path", () => {
    expect(resolveWorkspaceAssetUrl("outputs/fox.png?v=2", workspace)).toBe(`${workspaceFilePreviewUrl(workspace, "outputs/fox.png")}?v=2`);
    expect(resolveWorkspaceAssetUrl("outputs/fox.png#paint", workspace)).toBe(`${workspaceFilePreviewUrl(workspace, "outputs/fox.png")}#paint`);
  });

  it("leaves absolute and scheme URLs untouched", () => {
    for (const src of [
      "https://example.com/a.png",
      "http://example.com/a.png",
      "data:image/png;base64,AAAA",
      "file:///D:/work/a.png",
      "pidesktop-file://preview/x/y",
      "//cdn.example.com/a.png",
      "#section",
      "D:/work/a.png"
    ]) {
      expect(resolveWorkspaceAssetUrl(src, workspace)).toBe(src);
    }
  });

  it("refuses root-relative and escaping paths", () => {
    for (const src of ["/etc/passwd", "../secret.png", "outputs/../../secret.png", "..", ""]) {
      expect(resolveWorkspaceAssetUrl(src, workspace)).toBe(src);
    }
  });

  it("passes values through when there is no workspace context", () => {
    expect(resolveWorkspaceAssetUrl("outputs/fox.png", undefined)).toBe("outputs/fox.png");
    expect(resolveWorkspaceAssetUrl(undefined, workspace)).toBeUndefined();
    expect(resolveWorkspaceAssetUrl("", workspace)).toBe("");
  });
});
