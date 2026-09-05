import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { countNodes, normalizeDesignDoc, sanitizeDesignName, type DesignDoc } from "../shared/design-schema.js";
import type { DesignDocSummary } from "../shared/protocol.js";

/**
 * 设计文档存储（utility 进程，权威数据源）。参照 todo-store / plan-store 范式：
 * 文档落 `<workspace>/designs/<name>.design.json`（原子 tmp+rename 写），导出
 * HTML 落 `<workspace>/designs/exports/<name>.html`（重名加序号不覆盖）。
 * 会话级「当前打开的文档」绑定在 pi-runtime 的 SessionRuntimeRecord 上（内存态），
 * 本文件只管磁盘。
 */

export const DESIGNS_DIR = "designs";
export const DESIGN_EXPORTS_DIR = "exports";
export const DESIGN_FILE_SUFFIX = ".design.json";

export function designsDirFor(workspace: string): string {
  return join(workspace, DESIGNS_DIR);
}

/** 文档名 → 工作区内绝对路径（名字先净化，天然杜绝路径穿越）。 */
export function designFilePath(workspace: string, name: string): string {
  return join(designsDirFor(workspace), `${sanitizeDesignName(name)}${DESIGN_FILE_SUFFIX}`);
}

/** 扫描 designs/ 目录，返回全部可读文档的摘要（mtime 升序由调用方决定）。 */
export function listDesigns(workspace: string): DesignDocSummary[] {
  const dir = designsDirFor(workspace);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const summaries: DesignDocSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(DESIGN_FILE_SUFFIX)) continue;
    const filePath = join(dir, entry);
    const doc = readDesign(filePath);
    if (!doc) continue;
    let modifiedAt = 0;
    try {
      modifiedAt = statSync(filePath).mtimeMs;
    } catch {
      // 读取中文件被删：仍以 0 时间戳列出（下一次刷新自然消失）
    }
    summaries.push({
      id: doc.id,
      name: doc.name,
      revision: doc.revision,
      width: doc.canvas.width,
      height: doc.canvas.height,
      nodeCount: countNodes(doc.nodes),
      modifiedAt,
      relativePath: join(DESIGNS_DIR, entry)
    });
  }
  return summaries;
}

/** 读取并容错归一化单个文档；缺失/损坏返回 undefined。 */
export function readDesign(filePath: string): DesignDoc | undefined {
  try {
    return normalizeDesignDoc(JSON.parse(readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * 原子写文档（mkdir → tmp → rename）。文档改名时（fileName 与 name 派生名不一致）
 * 删除旧文件，保证「一个文档一个文件」。返回落盘的文件名。
 */
export function writeDesign(workspace: string, doc: DesignDoc, previousFileName?: string): string {
  const dir = designsDirFor(workspace);
  mkdirSync(dir, { recursive: true });
  const fileName = `${sanitizeDesignName(doc.name)}${DESIGN_FILE_SUFFIX}`;
  const filePath = join(dir, fileName);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
  if (previousFileName && previousFileName !== fileName) {
    try {
      unlinkSync(join(dir, previousFileName));
    } catch {
      // 旧文件可能已不存在
    }
  }
  return fileName;
}

/** 删除文档文件；返回是否确实删除。 */
export function deleteDesign(workspace: string, name: string): boolean {
  const filePath = designFilePath(workspace, name);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

/**
 * 导出 HTML 到 `<workspace>/designs/exports/<name>.html`（重名加序号不覆盖旧导出，
 * saveApprovedPlan 同款）。返回工作区相对路径。
 */
export function exportDesignFile(workspace: string, doc: DesignDoc, html: string): string {
  const dir = join(designsDirFor(workspace), DESIGN_EXPORTS_DIR);
  mkdirSync(dir, { recursive: true });
  const base = sanitizeDesignName(doc.name);
  let candidate = `${base}.html`;
  for (let index = 2; existsSync(join(dir, candidate)); index++) {
    candidate = `${base}-${index}.html`;
  }
  const filePath = join(dir, candidate);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, html, "utf8");
  renameSync(tempPath, filePath);
  return join(DESIGNS_DIR, DESIGN_EXPORTS_DIR, candidate);
}

/**
 * 导出 HTML 到用户指定的工作区相对路径（原子写，目录自动创建）；绝对路径/盘符/
 * `..` 段一律抛错。返回规范化后的相对路径。
 */
export function writeExportFile(workspace: string, html: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || /^[a-zA-Z]:/u.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error("导出路径必须是工作区内相对路径");
  }
  const target = join(workspace, normalized);
  mkdirSync(dirname(target), { recursive: true });
  const tempPath = `${target}.${process.pid}.tmp`;
  writeFileSync(tempPath, html, "utf8");
  renameSync(tempPath, target);
  return normalized;
}
