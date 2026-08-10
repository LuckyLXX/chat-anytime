import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importExternalAttachment, workspaceRelativeAttachment } from "./attachments.js";

describe("attachment path validation", () => {
  it("returns stable workspace-relative paths", () => {
    expect(workspaceRelativeAttachment("C:/work/demo", "C:/work/demo/src/index.ts")).toBe("src/index.ts");
  });

  it("rejects paths outside the workspace", () => {
    expect(() => workspaceRelativeAttachment("C:/work/demo", "C:/work/other/file.ts")).toThrow();
  });

  it("rejects the workspace directory itself", () => {
    expect(() => workspaceRelativeAttachment("C:/work/demo", "C:/work/demo")).toThrow();
  });

  it("normalizes nested separators", () => {
    expect(workspaceRelativeAttachment("C:/work/demo", "C:/work/demo/src\\main.ts")).toBe("src/main.ts");
  });

  it("imports an external file into a stable workspace-relative location", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-attachments-"));
    const workspace = join(root, "workspace");
    const external = join(root, "outside file.txt");
    await mkdir(workspace);
    await writeFile(external, "external attachment", "utf8");

    const first = await importExternalAttachment(workspace, external);
    const second = await importExternalAttachment(workspace, external);

    expect(first).toBe(second);
    expect(first).toMatch(/^\.pidesktop\/attachments\/[a-f0-9]{16}-outside file\.txt$/u);
    expect(await readFile(join(workspace, ...first.split("/")), "utf8")).toBe("external attachment");
  });

  it("rejects a symlinked attachment import directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-attachments-link-"));
    const workspace = join(root, "workspace");
    const externalDirectory = join(root, "external");
    const external = join(root, "outside.txt");
    await mkdir(workspace);
    await mkdir(externalDirectory);
    await writeFile(external, "external attachment", "utf8");
    await symlink(externalDirectory, join(workspace, ".pidesktop"), "junction");

    await expect(importExternalAttachment(workspace, external)).rejects.toThrow("附件导入目录必须是工作区内的普通目录");
  });

  it("rejects a symlinked attachment import target", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-attachment-target-link-"));
    const workspace = join(root, "workspace");
    const importDirectory = join(workspace, ".pidesktop", "attachments");
    const external = join(root, "outside.txt");
    const linkedFile = join(root, "linked.txt");
    const content = "external attachment";
    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    await mkdir(importDirectory, { recursive: true });
    await writeFile(external, content, "utf8");
    await writeFile(linkedFile, content, "utf8");
    await symlink(linkedFile, join(importDirectory, `${contentHash}-outside.txt`), "file");

    await expect(importExternalAttachment(workspace, external)).rejects.toThrow("附件导入目标不是普通文件");
  });
});
