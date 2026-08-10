import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedWorkspaceFile, readWorkspaceFilePreview } from "./workspace-preview.js";

describe("workspace file preview", () => {
  it("classifies Markdown and common code without exposing absolute paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-preview-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "README.md"), "# Preview\n", "utf8");
    await writeFile(join(workspace, "src", "app.ts"), "export const ready = true;\n", "utf8");

    await expect(readWorkspaceFilePreview(workspace, "README.md")).resolves.toMatchObject({ kind: "markdown", relativePath: "README.md", content: "# Preview\n" });
    await expect(readWorkspaceFilePreview(workspace, "src/app.ts")).resolves.toMatchObject({ kind: "code", language: "typescript", relativePath: "src/app.ts" });
  });

  it("rejects traversal, absolute paths, directories and symlinks outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-preview-boundary-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.md");
    await mkdir(workspace);
    await writeFile(outside, "private", "utf8");
    await symlink(outside, join(workspace, "linked.md"), "file");

    await expect(readWorkspaceFilePreview(workspace, "../outside.md")).rejects.toThrow("当前工作区");
    await expect(readWorkspaceFilePreview(workspace, outside)).rejects.toThrow("当前工作区");
    await expect(readWorkspaceFilePreview(workspace, ".")).rejects.toThrow();
    await expect(readWorkspaceFilePreview(workspace, "linked.md")).rejects.toThrow("当前工作区");
  });

  it("normalizes changed write/edit tool paths and ignores other or outside-workspace tools", () => {
    expect(changedWorkspaceFile("C:/work/demo", "edit", { path: "src/app.ts" })).toEqual({ relativePath: "src/app.ts" });
    expect(changedWorkspaceFile("C:/work/demo", "write", { file_path: "C:/work/demo/README.md" })).toEqual({ relativePath: "README.md" });
    expect(changedWorkspaceFile("C:/work/demo", "read", { path: "src/app.ts" })).toBeUndefined();
    expect(changedWorkspaceFile("C:/work/demo", "write", { path: "../outside.txt" })).toBeUndefined();
  });
});
