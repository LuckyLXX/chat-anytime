import { describe, expect, it } from "vitest";
import { parseWorkspaceFilePreviewUrl, workspaceFilePreviewUrl } from "./protocol.js";

describe("workspace file preview URL protocol", () => {
  it("round-trips Windows workspaces and paths with non-ASCII/space segments", () => {
    const url = workspaceFilePreviewUrl("C:\\工作区\\my project", "docs\\需求 说明.pdf");
    expect(url).toMatch(/^pidesktop-file:\/\/preview\//);
    // 反斜杠在 standard scheme 的 URL 解析里会被规范化掉（%5C → 路径分隔符），
    // 所以协议 URL 一律以正斜杠承载；主进程 resolve() 在 Windows 接受正斜杠。
    expect(url).not.toContain("%5C");
    expect(parseWorkspaceFilePreviewUrl(url)).toEqual({ workspace: "C:/工作区/my project", relativePath: "docs/需求 说明.pdf" });
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
