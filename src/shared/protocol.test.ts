import { describe, expect, it } from "vitest";
import { parseWorkspaceFilePreviewUrl, workspaceFilePreviewUrl } from "./protocol.js";

describe("workspace file preview URL protocol", () => {
  it("round-trips Windows workspaces and paths with non-ASCII/space segments", () => {
    const input = { workspace: "C:\\工作区\\my project", relativePath: "docs\\需求 说明.pdf" };
    const url = workspaceFilePreviewUrl(input.workspace, input.relativePath);
    expect(url).toMatch(/^pidesktop-file:\/\/preview\//);
    expect(parseWorkspaceFilePreviewUrl(url)).toEqual(input);
  });

  it("round-trips POSIX-style workspaces", () => {
    const input = { workspace: "/home/user/repo", relativePath: "docs/manual.pdf" };
    expect(parseWorkspaceFilePreviewUrl(workspaceFilePreviewUrl(input.workspace, input.relativePath))).toEqual(input);
  });

  it("rejects traversal, missing segments and foreign schemes", () => {
    expect(parseWorkspaceFilePreviewUrl("pidesktop-file://preview/C%3A%5Cwork/..%2F..%2Fetc%2Fpasswd")).toBeUndefined();
    expect(parseWorkspaceFilePreviewUrl("pidesktop-file://preview/C%3A%5Cwork")).toBeUndefined();
    expect(parseWorkspaceFilePreviewUrl("https://preview/C%3A%5Cwork/docs.pdf")).toBeUndefined();
    expect(parseWorkspaceFilePreviewUrl("not a url")).toBeUndefined();
  });
});
