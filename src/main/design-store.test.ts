import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDesignDoc, type DesignDoc } from "../shared/design-schema.js";
import { applyDesignOps } from "../shared/design-schema.js";
import { exportDesignHtml } from "../shared/design-export.js";
import { deleteDesign, designFilePath, designsDirFor, exportDesignFile, listDesigns, readDesign, writeDesign } from "./design-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-design-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sampleDoc(name = "登录页"): DesignDoc {
  const doc = createDesignDoc(name, 800, 600);
  const result = applyDesignOps(doc, [
    { op: "create", node: { type: "frame", id: "root", name: "卡片", x: 10, y: 10, w: 200, h: 100, children: [{ type: "text", id: "t", text: "你好" }] } },
    { op: "update", id: "root", patch: { fill: "#fff" } }
  ]);
  if (!result.ok) throw new Error(result.error);
  return result.doc;
}

describe("design-store", () => {
  it("未建目录时 listDesigns 返回空数组", async () => {
    const workspace = await tempWorkspace();
    expect(listDesigns(workspace)).toEqual([]);
  });

  it("writeDesign → readDesign 往返一致（原子写无残留 tmp）", async () => {
    const workspace = await tempWorkspace();
    const doc = sampleDoc();
    const fileName = writeDesign(workspace, doc);
    expect(fileName).toBe("登录页.design.json");
    expect(existsSync(designFilePath(workspace, "登录页"))).toBe(true);
    expect(readFileSync(designFilePath(workspace, "登录页"), "utf8")).not.toContain(".tmp");
    const round = readDesign(designFilePath(workspace, "登录页"));
    expect(round).toBeDefined();
    expect(round!.name).toBe("登录页");
    expect(round!.canvas).toEqual({ width: 800, height: 600 });
    expect(round!.nodes[0]!.id).toBe("root");
    expect(round!.nodes[0]!.children![0]!.text).toBe("你好");
    expect(round!.revision).toBe(doc.revision);
    const entries = listDirEntries(workspace);
    expect(entries).toContain("登录页.design.json");
    expect(entries.every((entry) => !entry.includes(".tmp"))).toBe(true);
  });

  it("listDesigns 汇总多文档（忽略损坏/非 design 文件）", async () => {
    const workspace = await tempWorkspace();
    writeDesign(workspace, sampleDoc("首页"));
    writeDesign(workspace, sampleDoc("关于我们"));
    mkdirSync(designsDirFor(workspace), { recursive: true });
    writeFileSync(join(designsDirFor(workspace), "broken.design.json"), "{oops", "utf8");
    writeFileSync(join(designsDirFor(workspace), "notes.txt"), "hi", "utf8");
    const summaries = listDesigns(workspace);
    expect(summaries.map((summary) => summary.name).sort()).toEqual(["关于我们", "首页"]);
    for (const summary of summaries) {
      expect(summary.nodeCount).toBe(2);
      expect(summary.width).toBe(800);
      expect(summary.relativePath.startsWith("designs")).toBe(true);
      expect(summary.modifiedAt).toBeGreaterThan(0);
    }
  });

  it("readDesign 对缺失/损坏文件返回 undefined", async () => {
    const workspace = await tempWorkspace();
    expect(readDesign(designFilePath(workspace, "不存在"))).toBeUndefined();
    mkdirSync(designsDirFor(workspace), { recursive: true });
    const broken = join(designsDirFor(workspace), "x.design.json");
    writeFileSync(broken, "not-json", "utf8");
    expect(readDesign(broken)).toBeUndefined();
  });

  it("改名写盘删除旧文件（一个文档一个文件）", async () => {
    const workspace = await tempWorkspace();
    const doc = sampleDoc("旧名");
    const first = writeDesign(workspace, doc);
    const renamed: DesignDoc = { ...doc, name: "新名" };
    const second = writeDesign(workspace, renamed, first);
    expect(second).toBe("新名.design.json");
    expect(existsSync(join(designsDirFor(workspace), first))).toBe(false);
    expect(existsSync(join(designsDirFor(workspace), second))).toBe(true);
  });

  it("writeDesign 净化危险名字（路径穿越不可行）", async () => {
    const workspace = await tempWorkspace();
    const doc = sampleDoc("../../escape");
    writeDesign(workspace, doc);
    const written = listDirEntries(workspace);
    expect(written).toHaveLength(1);
    expect(written[0]).toBe("..-..-escape.design.json");
    expect(existsSync(resolve(workspace, "escape.design.json"))).toBe(false);
  });

  it("deleteDesign 删除文件并幂等", async () => {
    const workspace = await tempWorkspace();
    writeDesign(workspace, sampleDoc("待删"));
    expect(deleteDesign(workspace, "待删")).toBe(true);
    expect(deleteDesign(workspace, "待删")).toBe(false);
    expect(listDesigns(workspace)).toEqual([]);
  });

  it("exportDesignFile 写入 exports/ 且重名加序号不覆盖", async () => {
    const workspace = await tempWorkspace();
    const doc = sampleDoc("海报");
    const html = exportDesignHtml(doc);
    const first = exportDesignFile(workspace, doc, html);
    const second = exportDesignFile(workspace, doc, html);
    expect(first).toBe(join("designs", "exports", "海报.html"));
    expect(second).toBe(join("designs", "exports", "海报-2.html"));
    expect(readFileSync(join(workspace, first), "utf8")).toContain("<!DOCTYPE html>");
  });
});

function listDirEntries(workspace: string): string[] {
  const dir = designsDirFor(workspace);
  return existsSync(dir) ? readdirSync(dir) : [];
}
