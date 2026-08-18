import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changedWorkspaceFile, createWorkspaceDirectory, createWorkspaceFile, deleteWorkspaceEntry, listWorkspaceDirectory, readWorkspaceFilePreview, renameWorkspaceEntry, writeWorkspaceFile } from "./workspace-preview.js";
import { IMAGE_PREVIEW_LIMIT_BYTES } from "../shared/protocol.js";

const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("workspace file preview", () => {
  it("classifies Markdown and common code without exposing absolute paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-preview-"));
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "README.md"), "# Preview\n", "utf8");
    await writeFile(join(workspace, "src", "app.ts"), "export const ready = true;\n", "utf8");

    await expect(readWorkspaceFilePreview(workspace, "README.md")).resolves.toMatchObject({ kind: "markdown", relativePath: "README.md", content: "# Preview\n", workspace });
    await expect(readWorkspaceFilePreview(workspace, "src/app.ts")).resolves.toMatchObject({ kind: "code", language: "typescript", relativePath: "src/app.ts", workspace });
  });

  it("previews raster images as inline base64 data and marks oversized ones as binary", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-image-"));
    await writeFile(join(workspace, "tiny.png"), TINY_PNG);
    await writeFile(join(workspace, "icon.ico"), Buffer.from([0, 0, 1, 0]));
    const oversized = Buffer.alloc(IMAGE_PREVIEW_LIMIT_BYTES + 1, 0);
    await writeFile(join(workspace, "huge.png"), oversized);

    const tiny = await readWorkspaceFilePreview(workspace, "tiny.png");
    expect(tiny).toMatchObject({ kind: "image", mimeType: "image/png", relativePath: "tiny.png", size: TINY_PNG.length });
    expect(tiny.data).toBe(TINY_PNG.toString("base64"));

    await expect(readWorkspaceFilePreview(workspace, "icon.ico")).resolves.toMatchObject({ kind: "image", mimeType: "image/x-icon" });

    const huge = await readWorkspaceFilePreview(workspace, "huge.png");
    expect(huge).toMatchObject({ kind: "binary", mimeType: "image/png", size: oversized.length });
    expect(huge.data).toBeUndefined();
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

  it("writes a new markdown file (creating parent dirs) and overwrites existing files inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-write-"));
    await writeFile(join(workspace, "doc.md"), "old", "utf8");
    const created = await writeWorkspaceFile(workspace, "notes/hello.md", "# Hello\n");
    expect(created).toMatchObject({ saved: true, relativePath: "notes/hello.md" });
    expect(created.size).toBe(Buffer.byteLength("# Hello\n", "utf8"));
    await expect(readWorkspaceFilePreview(workspace, "notes/hello.md")).resolves.toMatchObject({ kind: "markdown", content: "# Hello\n" });
    await writeWorkspaceFile(workspace, "doc.md", "new content");
    await expect(readWorkspaceFilePreview(workspace, "doc.md")).resolves.toMatchObject({ content: "new content" });
  });

  it("rejects writes that traverse, use absolute paths, or target symlinks outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-write-boundary-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(outside, "private", "utf8");
    await symlink(outside, join(workspace, "linked.md"), "file");

    await expect(writeWorkspaceFile(workspace, "../outside.txt", "x")).rejects.toThrow("当前工作区");
    await expect(writeWorkspaceFile(workspace, outside, "x")).rejects.toThrow("当前工作区");
    await expect(writeWorkspaceFile(workspace, "linked.md", "x")).rejects.toThrow("当前工作区");
  });

  it("lists a workspace directory without leaking ignored folders, sorting dirs first", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-list-"));
    await mkdir(join(workspace, "src"));
    await mkdir(join(workspace, "node_modules"));
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, "README.md"), "", "utf8");
    await writeFile(join(workspace, "src", "app.ts"), "", "utf8");

    const root = await listWorkspaceDirectory(workspace);
    expect(root.relativePath).toBe("");
    const rootNames = root.entries.map((entry) => entry.name);
    expect(rootNames).toContain("src");
    expect(rootNames).toContain("README.md");
    expect(rootNames).not.toContain("node_modules");
    expect(rootNames).not.toContain(".git");
    expect(root.entries.at(0)?.kind).toBe("directory");

    const src = await listWorkspaceDirectory(workspace, "src");
    expect(src.relativePath).toBe("src");
    expect(src.entries).toEqual([{ name: "app.ts", relativePath: "src/app.ts", kind: "file" }]);
  });

  it("rejects directory listings that traverse or sit outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-list-boundary-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    await expect(listWorkspaceDirectory(workspace, "../outside")).rejects.toThrow("当前工作区");
    await expect(listWorkspaceDirectory(workspace, join(root, "outside"))).rejects.toThrow("当前工作区");
  });

  it("creates files and directories (with parent dirs) and refuses name collisions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-create-"));
    await expect(createWorkspaceFile(workspace, "notes.md")).resolves.toEqual({ relativePath: "notes.md" });
    await expect(createWorkspaceFile(workspace, "src/app.ts")).resolves.toEqual({ relativePath: "src/app.ts" });
    await expect(createWorkspaceDirectory(workspace, "assets")).resolves.toEqual({ relativePath: "assets" });
    await expect(createWorkspaceDirectory(workspace, "docs/guides")).resolves.toEqual({ relativePath: "docs/guides" });

    await expect(createWorkspaceFile(workspace, "notes.md")).rejects.toThrow("已存在");
    await expect(createWorkspaceDirectory(workspace, "assets")).rejects.toThrow("已存在");

    const listing = await listWorkspaceDirectory(workspace);
    expect(listing.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(["notes.md", "src", "assets", "docs"]));
    await expect(readWorkspaceFilePreview(workspace, "src/app.ts")).resolves.toMatchObject({ kind: "code", content: "" });
  });

  it("rejects creating entries outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-create-boundary-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(outside, "private", "utf8");
    await symlink(outside, join(workspace, "linked.md"), "file");

    await expect(createWorkspaceFile(workspace, "../evil.txt")).rejects.toThrow("当前工作区");
    await expect(createWorkspaceFile(workspace, join(root, "evil.txt"))).rejects.toThrow("当前工作区");
    await expect(createWorkspaceDirectory(workspace, "../evil-dir")).rejects.toThrow("当前工作区");
    await expect(createWorkspaceFile(workspace, "linked.md")).rejects.toThrow("当前工作区");
    await expect(createWorkspaceFile(workspace, "linked.md/new.md")).rejects.toThrow("当前工作区");
  });

  it("renames entries inside the workspace with collision and name guards", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-rename-"));
    await writeFile(join(workspace, "a.txt"), "old", "utf8");
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "readme.md"), "# doc", "utf8");
    await writeFile(join(workspace, "b.txt"), "keep", "utf8");

    await expect(renameWorkspaceEntry(workspace, "a.txt", "b.txt")).rejects.toThrow("已存在");
    await expect(renameWorkspaceEntry(workspace, "a.txt", "../evil.txt")).rejects.toThrow("名称无效");
    await expect(renameWorkspaceEntry(workspace, "a.txt", "nested/name.txt")).rejects.toThrow("名称无效");
    await expect(renameWorkspaceEntry(workspace, "a.txt", "  ")).rejects.toThrow("名称无效");
    await expect(renameWorkspaceEntry(workspace, "missing.txt", "x.txt")).rejects.toThrow("不存在");
    await expect(renameWorkspaceEntry(workspace, "a.txt", "renamed.txt")).resolves.toEqual({ relativePath: "renamed.txt" });
    await expect(renameWorkspaceEntry(workspace, "docs/readme.md", "guide.md")).resolves.toEqual({ relativePath: "docs/guide.md" });
    await expect(readWorkspaceFilePreview(workspace, "renamed.txt")).resolves.toMatchObject({ content: "old" });
    await expect(listWorkspaceDirectory(workspace, "docs")).resolves.toMatchObject({ entries: [{ name: "guide.md", relativePath: "docs/guide.md", kind: "file" }] });
  });

  it("deletes files and whole directories and refuses outside-workspace targets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-delete-"));
    await writeFile(join(workspace, "a.txt"), "x", "utf8");
    await mkdir(join(workspace, "docs"));
    await writeFile(join(workspace, "docs", "readme.md"), "# doc", "utf8");

    await expect(deleteWorkspaceEntry(workspace, "a.txt")).resolves.toEqual({ relativePath: "a.txt" });
    await expect(readWorkspaceFilePreview(workspace, "a.txt")).rejects.toThrow();
    await expect(deleteWorkspaceEntry(workspace, "docs")).resolves.toEqual({ relativePath: "docs" });
    await expect(deleteWorkspaceEntry(workspace, "docs")).rejects.toThrow("不存在");
    await expect(deleteWorkspaceEntry(workspace, ".")).rejects.toThrow("当前工作区");
    await expect(deleteWorkspaceEntry(workspace, "../x")).rejects.toThrow("当前工作区");
  });

  it("refuses renaming or deleting symlinks that escape the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-mutate-boundary-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(outside, "private", "utf8");
    await symlink(outside, join(workspace, "linked.md"), "file");

    await expect(deleteWorkspaceEntry(workspace, "linked.md")).rejects.toThrow("当前工作区");
    await expect(renameWorkspaceEntry(workspace, "linked.md", "renamed.md")).rejects.toThrow("当前工作区");
  });

  it("browses and previews through directory links while keeping the write boundary", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-dirlink-"));
    const workspace = join(root, "workspace");
    const externalRepo = join(root, "external-repo");
    await mkdir(workspace);
    await mkdir(join(externalRepo, "skill"), { recursive: true });
    await writeFile(join(externalRepo, "skill", "SKILL.md"), "# Linked\n", "utf8");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    try {
      await symlink(externalRepo, join(workspace, "repo-link"), linkType);
    } catch {
      context.skip(); // 环境不允许创建目录链接
      return;
    }

    // 目录链接在树里按目录展示，可展开，其中文件可预览
    const rootListing = await listWorkspaceDirectory(workspace);
    expect(rootListing.entries.find((entry) => entry.name === "repo-link")).toMatchObject({ kind: "directory" });
    const inside = await listWorkspaceDirectory(workspace, "repo-link/skill");
    expect(inside.entries).toEqual([{ name: "SKILL.md", relativePath: "repo-link/skill/SKILL.md", kind: "file" }]);
    await expect(readWorkspaceFilePreview(workspace, "repo-link/skill/SKILL.md")).resolves.toMatchObject({ kind: "markdown", relativePath: "repo-link/skill/SKILL.md", content: "# Linked\n" });

    // 写入边界保持：不允许通过链接在工作区外创建/保存
    await expect(writeWorkspaceFile(workspace, "repo-link/skill/new.md", "x")).rejects.toThrow("当前工作区");
    await expect(createWorkspaceFile(workspace, "repo-link/skill/other.md")).rejects.toThrow("当前工作区");

    // 链接节点本身可重命名/删除，且不影响外部目标
    await expect(renameWorkspaceEntry(workspace, "repo-link", "repo-link-2")).resolves.toEqual({ relativePath: "repo-link-2" });
    await expect(deleteWorkspaceEntry(workspace, "repo-link-2")).resolves.toEqual({ relativePath: "repo-link-2" });
    await expect(access(join(externalRepo, "skill", "SKILL.md"))).resolves.toBeUndefined();
  });
});
