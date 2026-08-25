import { access, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactCandidatesFromBashCommand, artifactCandidatesFromOutput, changedWorkspaceFile, changedWorkspaceFiles, createWorkspaceDirectory, createWorkspaceFile, deleteWorkspaceEntry, existingWorkspaceFiles, isArtifactProducingTool, listWorkspaceDirectory, readWorkspaceFilePreview, renameWorkspaceEntry, searchWorkspaceFiles, writeWorkspaceFile } from "./workspace-preview.js";
import { IMAGE_PREVIEW_LIMIT_BYTES } from "../shared/protocol.js";

const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

describe("workspace file search (@ 提及)", () => {
  it("indexes files and directories while skipping ignored entries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-search-"));
    await mkdir(join(workspace, "src", "lib"), { recursive: true });
    await mkdir(join(workspace, "node_modules", "some-pkg"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "", "utf8");
    await writeFile(join(workspace, "src", "lib", "util.ts"), "", "utf8");
    await writeFile(join(workspace, "node_modules", "some-pkg", "index.js"), "", "utf8");

    const empty = await searchWorkspaceFiles(workspace, "");
    const paths = empty.entries.map((entry) => entry.relativePath);
    expect(paths).toContain("src");
    expect(paths).toContain("src/app.ts");
    expect(paths.some((path) => path.startsWith("node_modules"))).toBe(false);
  });

  it("ranks basename matches before path matches with shorter paths first", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-rank-"));
    await mkdir(join(workspace, "src", "components"), { recursive: true });
    await mkdir(join(workspace, "docs"), { recursive: true });
    await writeFile(join(workspace, "src", "app.ts"), "", "utf8");
    await writeFile(join(workspace, "src", "components", "app.tsx"), "", "utf8");
    await writeFile(join(workspace, "docs", "app-notes.md"), "", "utf8");
    await writeFile(join(workspace, "app.ts.bak"), "", "utf8");

    // basename 前缀命中同分时路径短者优先（同长则字典序）；docs/src 目录本身不匹配 “app” 不入榜。
    const result = await searchWorkspaceFiles(workspace, "app");
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      "app.ts.bak",
      "src/app.ts",
      "docs/app-notes.md",
      "src/components/app.tsx"
    ]);
    // 目录命中返回目录条目，可直接拼 @src/ 继续钻取子级
    const directory = await searchWorkspaceFiles(workspace, "sr");
    expect(directory.entries[0]).toMatchObject({ relativePath: "src", kind: "directory" });
    const scoped = await searchWorkspaceFiles(workspace, "src/");
    expect(scoped.entries.map((entry) => entry.relativePath)).toEqual(["src/app.ts", "src/components", "src/components/app.tsx"]);
  });

  it("refreshes cached results after workspace mutations", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-cache-"));
    await writeFile(join(workspace, "README.md"), "", "utf8");
    await expect(searchWorkspaceFiles(workspace, "todo")).resolves.toEqual({ entries: [] });

    await writeWorkspaceFile(workspace, "todo.txt", "x");
    await expect(searchWorkspaceFiles(workspace, "todo")).resolves.toEqual({ entries: [{ name: "todo.txt", relativePath: "todo.txt", kind: "file" }] });

    await deleteWorkspaceEntry(workspace, "todo.txt");
    await expect(searchWorkspaceFiles(workspace, "todo")).resolves.toEqual({ entries: [] });
  });

  it("normalizes query separators and caps the result size", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-limit-"));
    for (let index = 0; index < 6; index += 1) await writeFile(join(workspace, `item-${index}.txt`), "", "utf8");
    const windowsPath = await searchWorkspaceFiles(workspace, "\\item-");
    expect(windowsPath.entries).toHaveLength(6);
    const limited = await searchWorkspaceFiles(workspace, "item-", 2);
    expect(limited.entries).toHaveLength(2);
  });

  it("rejects blank workspaces", async () => {
    await expect(searchWorkspaceFiles("", "x")).rejects.toThrow("工作区");
  });
});

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

  it("classifies PDF as a streamed preview kind without reading content", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-pdf-"));
    const pdfBytes = Buffer.from("%PDF-1.7\n%%EOF\n");
    await writeFile(join(workspace, "manual.pdf"), pdfBytes);

    const preview = await readWorkspaceFilePreview(workspace, "manual.pdf");
    expect(preview).toMatchObject({ kind: "pdf", relativePath: "manual.pdf", name: "manual.pdf", size: pdfBytes.length, workspace });
    expect(preview.content).toBeUndefined();
    expect(preview.data).toBeUndefined();
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

  it("exposes the changed file as an array and only treats read-only tools as artifact producers", () => {
    expect(changedWorkspaceFiles("C:/work/demo", "edit", { path: "src/app.ts" })).toEqual([{ relativePath: "src/app.ts" }]);
    expect(changedWorkspaceFiles("C:/work/demo", "read", { path: "src/app.ts" })).toBeUndefined();
    expect(isArtifactProducingTool("bash")).toBe(true);
    expect(isArtifactProducingTool("mcp_fal_generate")).toBe(true);
    expect(isArtifactProducingTool("write")).toBe(false);
    expect(isArtifactProducingTool("read")).toBe(false);
    expect(isArtifactProducingTool("grep")).toBe(false);
    expect(isArtifactProducingTool("ls")).toBe(false);
    expect(isArtifactProducingTool("memory_read")).toBe(false);
    expect(isArtifactProducingTool("memory_write")).toBe(false);
    expect(isArtifactProducingTool("todo_write")).toBe(false);
    expect(isArtifactProducingTool("browser_snapshot")).toBe(false);
    expect(isArtifactProducingTool("browser_eval")).toBe(false);
    expect(isArtifactProducingTool("ask_question")).toBe(false);
    expect(isArtifactProducingTool("recognize_images")).toBe(false);
  });

  it("extracts workspace-relative artifact candidates near save signals from tool output text", () => {
    const workspace = "C:/work/demo";
    const output = [
      "图片已保存：C:/work/demo/outputs/fox.png。",
      "Saved: ./assets/海报.webp",
      "json: { path: \"docs/报告.md\" }",
      "写入 docs/说明.md 完成",
      "ignored: node_modules/pkg/icon.png",
      "outside: ../other/gone.jpg",
      "non-artifact: bundle.exe"
    ].join("\n");
    expect(artifactCandidatesFromOutput(workspace, output)).toEqual([
      "outputs/fox.png",
      "assets/海报.webp",
      "docs/说明.md"
    ]);
    expect(artifactCandidatesFromOutput(workspace, "")).toEqual([]);
    expect(artifactCandidatesFromOutput(undefined, "fox.png")).toEqual([]);
  });

  it("ignores plain reads, diffs and listings without save signals", () => {
    const workspace = "D:/proj";
    const catContent = "# Report\n详见 docs/guide.md 与 src/main.ts 的实现。\n";
    const diff = "diff --git a/src/main/workspace-preview.ts b/src/main/workspace-preview.ts\n+      \"relativePath\": \"outputs/fox.png\",\n";
    const gitLog = "e17f3be feat(chat): 交付产物\n docs/迭代记录.md | 1 +\n";
    const listing = "demo.png\nREADME.md\nassets/poster.png\n";
    expect(artifactCandidatesFromOutput(workspace, catContent)).toEqual([]);
    expect(artifactCandidatesFromOutput(workspace, diff)).toEqual([]);
    expect(artifactCandidatesFromOutput(workspace, gitLog)).toEqual([]);
    expect(artifactCandidatesFromOutput(workspace, listing)).toEqual([]);
  });

  it("extracts explicit output paths from bash commands", () => {
    const workspace = "C:/work/demo";
    expect(artifactCandidatesFromBashCommand(workspace, "python ~/.agents/skills/rolldek-image/rolldek_image.py generate 雪狐 -o outputs/fox.png")).toEqual(["outputs/fox.png"]);
    expect(artifactCandidatesFromBashCommand(workspace, "node gen.mjs --output gen/cover.webp && npm test")).toEqual(["gen/cover.webp"]);
    expect(artifactCandidatesFromBashCommand(workspace, "curl -s https://x.com/a.png -o assets/logo.png")).toEqual(["assets/logo.png"]);
    expect(artifactCandidatesFromBashCommand(workspace, "cat src/main.ts > docs/out.md && git add docs/out.md")).toEqual(["docs/out.md"]);
    expect(artifactCandidatesFromBashCommand(workspace, "convert a.png b.png && mv b.png outputs/final.png")).toEqual(["b.png", "outputs/final.png"]);
    expect(artifactCandidatesFromBashCommand(workspace, "ls *.txt")).toEqual([]);
    expect(artifactCandidatesFromBashCommand(undefined, "touch a.txt")).toEqual([]);
  });

  it("keeps only artifact candidates that actually exist as files inside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pidesktop-artifact-"));
    await mkdir(join(workspace, "outputs"));
    await writeFile(join(workspace, "outputs", "fox.png"), "png", "utf8");
    await writeFile(join(workspace, "image.png"), "png", "utf8");

    await expect(existingWorkspaceFiles(workspace, ["outputs/fox.png", "image.png", "missing.png"])).resolves.toEqual([
      { relativePath: "outputs/fox.png" },
      { relativePath: "image.png" }
    ]);
    await expect(existingWorkspaceFiles(workspace, ["missing.png"])).resolves.toEqual([]);
    await expect(existingWorkspaceFiles(undefined, ["image.png"])).resolves.toEqual([]);
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
