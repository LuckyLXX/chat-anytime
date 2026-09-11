import { describe, expect, it } from "vitest";
import { workspaceFilePreviewUrl } from "../../../shared/protocol";
import { resolveMarkdownAssetUrl, resolveWorkspaceAssetUrl, resolveWorkspaceRelativePath } from "./workspace-asset";

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

describe("resolveWorkspaceRelativePath", () => {
  it("resolves against the markdown file's own directory", () => {
    expect(resolveWorkspaceRelativePath("docs/note.md", "./img.png")).toBe("docs/img.png");
    expect(resolveWorkspaceRelativePath("docs/note.md", "img.png")).toBe("docs/img.png");
    expect(resolveWorkspaceRelativePath("docs/sub/note.md", "../assets/img.png")).toBe("docs/assets/img.png");
    expect(resolveWorkspaceRelativePath("note.md", "outputs/fox.png")).toBe("outputs/fox.png");
  });

  it("normalizes redundant segments and backslashes", () => {
    expect(resolveWorkspaceRelativePath("docs/note.md", "./a/./b/../c.png")).toBe("docs/a/c.png");
    expect(resolveWorkspaceRelativePath("docs\\note.md", ".\\img.png")).toBe("docs/img.png");
  });

  it("refuses to escape the workspace root", () => {
    expect(resolveWorkspaceRelativePath("docs/note.md", "../../escape.png")).toBeUndefined();
    expect(resolveWorkspaceRelativePath("note.md", "../escape.png")).toBeUndefined();
  });
});

describe("resolveMarkdownAssetUrl", () => {
  it("resolves relative images against the markdown directory first", () => {
    const options = { markdownPath: "docs/note.md", workspace };
    expect(resolveMarkdownAssetUrl("./img.png", options)).toBe(workspaceFilePreviewUrl(workspace, "docs/img.png"));
    // 计划要求的 ../ 场景：之前 `../` 被显式拒绝、图片加载不出来。
    expect(resolveMarkdownAssetUrl("../assets/img.png", options)).toBe(workspaceFilePreviewUrl(workspace, "assets/img.png"));
  });

  it("keeps query/hash suffixes outside the encoded path", () => {
    const options = { markdownPath: "docs/note.md", workspace };
    expect(resolveMarkdownAssetUrl("./img.png?v=2", options)).toBe(`${workspaceFilePreviewUrl(workspace, "docs/img.png")}?v=2`);
    expect(resolveMarkdownAssetUrl("./img.png#paint", options)).toBe(`${workspaceFilePreviewUrl(workspace, "docs/img.png")}#paint`);
  });

  it("rejects paths escaping the workspace", () => {
    const options = { markdownPath: "docs/note.md", workspace };
    for (const src of ["../../escape.png", "/root.png"]) {
      expect(resolveMarkdownAssetUrl(src, options)).toBe(src);
    }
  });

  it("leaves absolute URLs, anchors and data URIs untouched", () => {
    const options = { markdownPath: "docs/note.md", workspace };
    for (const src of ["https://example.com/a.png", "data:image/png;base64,AAAA", "pidesktop-file://preview/x/y", "//cdn.example.com/a.png", "#section"]) {
      expect(resolveMarkdownAssetUrl(src, options)).toBe(src);
    }
  });

  it("falls back to the workspace-root semantics without a markdown path", () => {
    expect(resolveMarkdownAssetUrl("outputs/fox.png", { workspace })).toBe(workspaceFilePreviewUrl(workspace, "outputs/fox.png"));
    // 无 markdown 上下文时仍沿用旧的安全策略：`..` 与根相对被拒绝。
    expect(resolveMarkdownAssetUrl("../secret.png", { workspace })).toBe("../secret.png");
    expect(resolveMarkdownAssetUrl("outputs/fox.png", undefined)).toBe("outputs/fox.png");
    expect(resolveMarkdownAssetUrl(undefined, { markdownPath: "docs/note.md", workspace })).toBeUndefined();
  });
});
