import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { SkillDetail, SkillFileEntry } from "../shared/protocol.js";

/**
 * Skill 详情读取（设置页「Skill」右侧详情用）。
 *
 * 目的很窄：把一个 Skill 的**文件内容**给用户看——SKILL.md 正文 + 目录里的附件
 * 清单。目录本身（ResourceCatalog.skills）是高频推送，不塞正文（26 个 Skill 的
 * SKILL.md 合计数百 KB，每次 emitResourceCatalog 都带上纯属浪费），所以这里做成
 * 一条按需命令 `skill.inspect` 的实现，由渲染端选中条目时发起。
 *
 * 三条边界（都会实际碰到）：
 * 1. **只认已知 Skill**：调用方必须先用目录里的 id 找到 filePath 再传进来，本模块
 *    不接受任意路径——否则就成了渲染端可读全盘的口子。
 * 2. **跳过噪声目录**：内置 skill 目录里常有 `__pycache__`、`.pyc`、`.git`、
 *    `node_modules`（computer-use/theme-creator 实测都有），列表里出现它们只会让
 *    「附件」变成垃圾场。
 * 3. **有上限**：正文按字符截断、附件按条数截断（并在详情里标记），避免一个
 *    巨型目录把设置页卡住；截断是显式的，不静默丢。
 */

/** SKILL.md 正文上限（字符）。当前最大的内置 SKILL.md ≈ 28KB，留足余量。 */
export const SKILL_CONTENT_MAX_CHARS = 240_000;
/** 附件条数上限（含子目录递归）。 */
export const SKILL_FILES_MAX = 200;
/** 附件递归深度上限（skill 目录算第 0 层）。 */
export const SKILL_FILE_MAX_DEPTH = 5;

/** 不当作附件展示的目录名（缓存/依赖/版本库/VCS 元数据）。 */
const SKIP_DIR_NAMES = new Set(["__pycache__", "node_modules", "bower_components", ".git", ".svn", ".hg", ".venv", "venv", "dist", "build", "coverage"]);
/** 不当作附件展示的文件名（系统垃圾文件）。 */
const SKIP_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** 读取结果 → 协议详情。失败也返回一条带 error 的详情（渲染端只需处理一种形态）。 */
export function inspectSkill(skill: { id: string; filePath?: string }): SkillDetail {
  const empty: SkillDetail = { id: skill.id, filePath: skill.filePath ?? "", content: "", files: [] };
  if (!skill.filePath) return { ...empty, error: "该 Skill 没有记录 SKILL.md 路径，无法读取内容" };

  let raw: string;
  try {
    raw = readFileSync(skill.filePath, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...empty, error: `读取 SKILL.md 失败：${reason}` };
  }

  const truncated = raw.length > SKILL_CONTENT_MAX_CHARS;
  const content = truncated ? raw.slice(0, SKILL_CONTENT_MAX_CHARS) : raw;
  const walked = listSkillFiles(dirname(skill.filePath));
  return {
    ...empty,
    content,
    ...(truncated ? { contentTruncated: true } : {}),
    files: walked.files,
    ...(walked.truncated ? { filesTruncated: true } : {})
  };
}

interface WalkResult {
  files: SkillFileEntry[];
  truncated: boolean;
}

/** 递归列出 skill 目录里的附件（跳过 SKILL.md、隐藏项与噪声目录）。 */
export function listSkillFiles(dir: string): WalkResult {
  const files: SkillFileEntry[] = [];
  let truncated = false;

  const walk = (current: string, depth: number): void => {
    if (truncated || depth > SKILL_FILE_MAX_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".") || SKIP_FILE_NAMES.has(entry.name)) continue;
      const fullPath = join(current, entry.name);
      // 符号链接一律跳过：skill 目录本身可能是链接（Windows junction），但内部再
      // 跟链接就有环与越界的风险，而附件清单不需要这个能力。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      // SKILL.md 是主体内容，不重复进附件清单。
      if (depth === 0 && entry.name.toLowerCase() === "skill.md") continue;
      if (files.length >= SKILL_FILES_MAX) {
        truncated = true;
        return;
      }
      files.push({ path: relativePosix(dir, fullPath), size: fileSize(fullPath) });
    }
  };

  walk(dir, 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, truncated };
}

function relativePosix(root: string, target: string): string {
  return target.slice(root.length + 1).split(sep).join("/");
}

/** 单文件大小；stat 失败给 0（列表照常展示，不因为一个文件消失而整页报错）。 */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
