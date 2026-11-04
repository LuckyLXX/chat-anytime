// Skill 商店的安装/卸载执行层（纯逻辑 + 显式依赖注入，全部在 utility 进程运行）。
//
// 「逐文件下载 + 逐文件 sha256 校验 + 全部通过才落盘」纪律（对应 theme-assets 的
// 「不写半套」）：
//   1. planInstall   —— 下载前用 /files 清单全量前置校验（路径安全、体积/数量上限、
//                       必含 SKILL.md），任何一项不合格直接拒绝，磁盘零改动；
//   2. downloadAndVerify —— 并发 ≤4 把文件字节全部下到内存，逐文件 sha256 校验
//                       （以 /files 清单为唯一校验源，**不依赖 302 后对象存储的
//                       X-Content-SHA256 头**——重定向后可能丢失）；
//   3. commitInstall —— 全部通过后才写临时目录并原子 rename；旧安装先备份为
//                       `<slug>.bak-<时间戳>`，元数据最后原子写。
// 任一步失败即整体失败：内存丢弃、临时目录删除，磁盘零残留。
//
// 路径安全参照 theme-assets 的拒绝清单并按安装场景加固：绝对路径 / `..` / 盘符与
// NTFS ADS 冒号 / 控制字符 / Windows 保留名 / 超长全部拒绝。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SkillStoreFile, SkillStoreInstallOutcome, SkillStoreScope, SkillStoreUninstallOutcome } from "../shared/skill-store.js";
import { storeSkillFileBytes } from "./skill-store-client.js";

/** `/file` 接口的单文件硬限（超出返回 413）。含大文件的技能首版明确拒绝。 */
export const SKILL_FILE_MAX_BYTES = 1024 * 1024;
/** 合计体积上限（对齐 theme-assets 的单主题 32MB）。 */
export const SKILL_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
/** 文件数上限。 */
export const SKILL_FILE_COUNT_MAX = 200;
/** 下载并发上限。 */
export const SKILL_DOWNLOAD_CONCURRENCY = 4;
/** 相对路径长度上限（Windows MAX_PATH 留出目标根目录余量）。 */
const MAX_RELATIVE_PATH_LENGTH = 400;
/** 目录名（slug）长度上限。 */
const MAX_SLUG_LENGTH = 96;

/** Windows 保留设备名（不带扩展名也拒绝）。 */
const WINDOWS_RESERVED_NAMES = new Set(["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"]);

function isWindowsReserved(segment: string): boolean {
  // Windows 保留名对「带任意扩展名」同样生效（NUL.md 也指向设备），所以只看第一个点之前的主名。
  const baseName = segment.split(".", 1)[0] ?? segment;
  return WINDOWS_RESERVED_NAMES.has(baseName.toUpperCase());
}

/**
 * 相对路径安全判定（返回归一化正斜杠路径，保留原大小写——skill 文件名大小写有语义）：
 * 拒绝绝对路径、`:`（盘符/协议/NTFS ADS）、控制字符、`.`/`..`/空段、Windows 保留名、
 * 结尾点/空格、Windows 非法字符、超长、混合分隔符穿越（统一替换 `\` 后逐段检查）。
 * 返回 undefined = 不安全（调用方拒绝，不猜）。
 */
export function validateSkillStoreFilePath(value: string): string | undefined {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.length > MAX_RELATIVE_PATH_LENGTH) return undefined;
  if (normalized.includes(":")) return undefined; // 盘符 / 协议前缀 / NTFS ADS
  if (normalized.startsWith("/")) return undefined; // 绝对路径
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) return undefined;
  if (/["*<>|]/u.test(normalized)) return undefined;
  if (/[. ]$/u.test(normalized)) return undefined;
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  if (segments.some(isWindowsReserved)) return undefined;
  return normalized;
}

/** slug（同时是目标目录名）安全判定：字母数字开头，`_` `-` `.`，禁保留名与点结尾。 */
export function validateSlugDirName(slug: string): string | undefined {
  const trimmed = slug.trim();
  if (!trimmed || trimmed.length > MAX_SLUG_LENGTH) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(trimmed)) return undefined;
  if (trimmed.endsWith(".")) return undefined;
  if (isWindowsReserved(trimmed)) return undefined;
  return trimmed;
}

/** 安装计划（commit 所需的全部信息；校验全在构造期完成）。 */
export interface SkillStoreInstallPlan {
  slug: string;
  version: string;
  scope: SkillStoreScope;
  targetRoot: string;
  /** 安装目录（绝对路径）。 */
  installDir: string;
  /** 归一化后的文件清单（相对路径已校验）。 */
  files: SkillStoreFile[];
  totalBytes: number;
  /** 现有同名目录（覆盖时先备份；false = 全新安装）。 */
  existing: boolean;
}

/** 安装计划失败的结构化原因（渲染端内联展示）。 */
export class SkillStorePlanError extends Error {
  constructor(message: string, readonly code: "path" | "limit" | "missing-skill-md" | "empty" | "conflict" | "root") {
    super(message);
  }
}

/** 元数据里的一条安装记录。 */
export interface StoreInstallRecord {
  slug: string;
  /** 来源规范名（`@owner/slug`，未文档化字段容错读取；冲突判定用）。 */
  canonicalName?: string;
  version: string;
  installedAt: number;
  scope: SkillStoreScope;
  installDir: string;
  files: { path: string; sha256: string }[];
}

export interface StoreInstallMetadata {
  version: 1;
  installs: Record<string, StoreInstallRecord>;
}

/** 元数据文件名（`<agentDir>/pideskill-store-metadata.json`，tmp+rename 原子写）。
 *  不污染 skill 目录本身（扫描只找 SKILL.md，无关文件不影响；账本集中放 agentDir）。 */
export const SKILL_STORE_METADATA_FILENAME = "pideskill-store-metadata.json";

export function skillStoreMetadataPath(agentDir: string): string {
  return join(agentDir, SKILL_STORE_METADATA_FILENAME);
}

/** 元数据键：scope + 安装目录绝对路径（小写归一，Windows 大小写漂移视为同一目录）。 */
export function installRecordKey(scope: SkillStoreScope, installDir: string): string {
  return `${scope}::${installDir.replaceAll("\\", "/").toLowerCase()}`;
}

function normalizeInstallRecord(value: unknown): StoreInstallRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.slug !== "string" || typeof raw.version !== "string" || typeof raw.installedAt !== "number" || (raw.scope !== "global" && raw.scope !== "project") || typeof raw.installDir !== "string") return undefined;
  const files: { path: string; sha256: string }[] = [];
  if (Array.isArray(raw.files)) {
    for (const item of raw.files) {
      if (typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).path === "string" && typeof (item as Record<string, unknown>).sha256 === "string") {
        files.push({ path: (item as Record<string, unknown>).path as string, sha256: (item as Record<string, unknown>).sha256 as string });
      }
    }
  }
  return {
    slug: raw.slug,
    version: raw.version,
    installedAt: raw.installedAt,
    scope: raw.scope,
    installDir: raw.installDir,
    files,
    ...(typeof raw.canonicalName === "string" ? { canonicalName: raw.canonicalName } : {})
  };
}

/** 读元数据（缺失/损坏 = 空账本，绝不抛错——账本只是辅助记录）。 */
export function readStoreMetadata(agentDir: string): StoreInstallMetadata {
  try {
    const parsed = JSON.parse(readFileSync(skillStoreMetadataPath(agentDir), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && (parsed as { version?: unknown }).version === 1 && (parsed as { installs?: unknown }).installs && typeof (parsed as { installs?: unknown }).installs === "object") {
      const installs: Record<string, StoreInstallRecord> = {};
      for (const [key, value] of Object.entries((parsed as { installs: Record<string, unknown> }).installs)) {
        const record = normalizeInstallRecord(value);
        if (record) installs[key] = record;
      }
      return { version: 1, installs };
    }
  } catch {
    // 缺失/损坏 → 空账本
  }
  return { version: 1, installs: {} };
}

/** 原子写元数据（tmp+rename）。 */
export function writeStoreMetadata(agentDir: string, metadata: StoreInstallMetadata): void {
  mkdirSync(agentDir, { recursive: true });
  const path = skillStoreMetadataPath(agentDir);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
}

/** 追加/更新一条安装记录并落盘。 */
export function recordInstall(agentDir: string, record: StoreInstallRecord): void {
  const metadata = readStoreMetadata(agentDir);
  metadata.installs[installRecordKey(record.scope, record.installDir)] = record;
  writeStoreMetadata(agentDir, metadata);
}

/** 删除一条安装记录并落盘（记录不存在不算失败）。 */
export function removeInstallRecord(agentDir: string, scope: SkillStoreScope, installDir: string): void {
  const metadata = readStoreMetadata(agentDir);
  const key = installRecordKey(scope, installDir);
  if (key in metadata.installs) {
    delete metadata.installs[key];
    writeStoreMetadata(agentDir, metadata);
  }
}

/** 查一条安装记录。 */
export function findInstallRecord(agentDir: string, scope: SkillStoreScope, installDir: string): StoreInstallRecord | undefined {
  return readStoreMetadata(agentDir).installs[installRecordKey(scope, installDir)];
}

/** 全部安装记录（渲染端「已安装」徽标比对用）。 */
export function listInstallRecords(agentDir: string): StoreInstallRecord[] {
  return Object.values(readStoreMetadata(agentDir).installs);
}

/** 旧安装的备份目录名（覆盖前 rename 的同一形态）。 */
export function backupDirName(slug: string, now = Date.now()): string {
  return `${slug}.bak-${now}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 安装前计划：下载前用 /files 清单做**全量前置校验**（磁盘零改动）。 */
export function planInstall(options: {
  slug: string;
  version: string;
  scope: SkillStoreScope;
  files: readonly SkillStoreFile[];
  targetRoot: string;
  canonicalName?: string;
  metadataDir: string;
  confirmReplace?: boolean;
}): SkillStoreInstallPlan {
  const slug = validateSlugDirName(options.slug);
  if (!slug) throw new SkillStorePlanError(`技能标识不安全，无法作为目录名：${options.slug}`, "path");
  if (options.files.length === 0) throw new SkillStorePlanError("文件清单为空，无法安装", "empty");

  const files: SkillStoreFile[] = [];
  let totalBytes = 0;
  let hasSkillMd = false;
  const seen = new Set<string>();
  for (const file of options.files) {
    const normalizedPath = validateSkillStoreFilePath(file.path);
    if (!normalizedPath) throw new SkillStorePlanError(`文件路径不安全，已拒绝安装：${file.path}`, "path");
    if (normalizedPath === "SKILL.md") hasSkillMd = true;
    if (seen.has(normalizedPath)) throw new SkillStorePlanError(`文件清单含重复路径：${normalizedPath}`, "path");
    seen.add(normalizedPath);
    if (file.size > SKILL_FILE_MAX_BYTES) {
      throw new SkillStorePlanError(`文件 ${normalizedPath} 超过单文件 1MB 上限（${formatBytes(file.size)}）。该技能包含大文件，暂不支持面板安装，请用官方 CLI 或网页安装。`, "limit");
    }
    totalBytes += file.size;
    if (totalBytes > SKILL_TOTAL_MAX_BYTES) {
      throw new SkillStorePlanError(`技能合计体积超过 32MB 上限（${formatBytes(totalBytes)}），暂不支持面板安装，请用官方 CLI 或网页安装。`, "limit");
    }
    if (file.sha256.length !== 64 || !/^[0-9a-f]{64}$/iu.test(file.sha256)) {
      throw new SkillStorePlanError(`文件清单里的 sha256 不是合法的 64 位十六进制：${normalizedPath}`, "path");
    }
    files.push({ path: normalizedPath, size: file.size, sha256: file.sha256.toLowerCase() });
  }
  if (files.length > SKILL_FILE_COUNT_MAX) {
    throw new SkillStorePlanError(`技能包含 ${files.length} 个文件，超过 ${SKILL_FILE_COUNT_MAX} 个的上限，暂不支持面板安装。`, "limit");
  }
  if (!hasSkillMd) throw new SkillStorePlanError("文件清单缺少 SKILL.md（PiDesktop 要求每个技能目录至少包含它），无法安装", "missing-skill-md");

  const targetRoot = resolve(options.targetRoot);
  if (!isAbsolute(targetRoot) || /^[a-zA-Z]:\\?$/u.test(targetRoot)) {
    throw new SkillStorePlanError(`安装目标根目录不安全：${options.targetRoot}`, "root");
  }
  const installDir = join(targetRoot, slug);

  // 冲突判定：同名目录已存在时——
  //  1. 异源（账本记录的 canonicalName 与本次不同）→ 拒绝；
  //  2. 同源/无记录但未确认 → 要求显式 confirmReplace（commit 阶段会先备份旧目录）。
  if (existsSync(installDir)) {
    const existingRecord = findInstallRecord(options.metadataDir, options.scope, installDir);
    if (existingRecord?.canonicalName && options.canonicalName && existingRecord.canonicalName !== options.canonicalName) {
      throw new SkillStorePlanError(`目录 ${slug} 已被另一个来源的安装占用（${existingRecord.canonicalName}），本次安装（${options.canonicalName}）被拒绝。请先卸载它或手动删除该目录。`, "conflict");
    }
    if (existingRecord && !options.confirmReplace) {
      throw new SkillStorePlanError(`技能 ${slug} 已安装（版本 ${existingRecord.version}）。重复安装会覆盖现有目录（旧目录会先备份为 ${slug}.bak-<时间戳>），请确认后重试。`, "conflict");
    }
  }

  return {
    slug,
    version: options.version,
    scope: options.scope,
    targetRoot,
    installDir,
    files,
    totalBytes,
    existing: existsSync(installDir)
  };
}

/** 下载字节源（注入；生产 = storeSkillFileBytes）。 */
export type FetchStoreBytes = (slug: string, version: string | undefined, path: string) => Promise<Uint8Array>;

export const defaultFetchStoreBytes: FetchStoreBytes = (slug, version, path) => storeSkillFileBytes(slug, version, path);

/**
 * 下载并逐文件校验：并发 ≤4 全部下到内存，再按清单 sha256 一一核对。
 * **任何失败抛错即整体失败**——本函数只碰内存，调用方磁盘仍零改动。
 */
export async function downloadAndVerify(options: { plan: SkillStoreInstallPlan; fetchBytes?: FetchStoreBytes }): Promise<Map<string, Uint8Array>> {
  const fetchBytes = options.fetchBytes ?? defaultFetchStoreBytes;
  const { plan } = options;
  const contents = new Map<string, Uint8Array>();
  const queue = [...plan.files];
  const errors: string[] = [];

  async function worker(): Promise<void> {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      try {
        const bytes = await fetchBytes(plan.slug, plan.version, file.path);
        if (bytes.byteLength > SKILL_FILE_MAX_BYTES) {
          errors.push(`文件 ${file.path} 实际字节超过 1MB 上限（${formatBytes(bytes.byteLength)}）`);
          continue;
        }
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== file.sha256) {
          errors.push(`文件 ${file.path} 的 sha256 校验不匹配（清单 ${file.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
          continue;
        }
        contents.set(file.path, bytes);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(SKILL_DOWNLOAD_CONCURRENCY, Math.max(1, plan.files.length)) }, () => worker()));
  if (errors.length > 0) {
    throw new Error(`下载或校验失败（共 ${errors.length} 项，已全部放弃，磁盘零改动）：\n${errors.slice(0, 5).join("\n")}${errors.length > 5 ? `\n… 等共 ${errors.length} 项` : ""}`);
  }
  if (contents.size !== plan.files.length) {
    throw new Error(`下载结果不完整（${contents.size}/${plan.files.length}），已全部放弃，磁盘零改动。`);
  }
  return contents;
}

/** 删除目录树（rmSync 递归；不存在视为已删）。 */
function removeDirTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 统计目录里的文件数（卸载回执与落盘复核用，递归）。 */
function countFilesRecursive(root: string): number {
  let count = 0;
  let entries: { isDirectory(): boolean; name: string }[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return count;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) count += countFilesRecursive(join(root, entry.name));
    else count += 1;
  }
  return count;
}

/**
 * 提交安装：全部字节已校验通过后才落盘。
 *   临时目录（同根、`<slug>.tmp-<pid>-<ts>`）→ 逐文件写入 → 复核文件数与 SKILL.md →
 *   旧安装 rename 备份 → 临时目录 rename 为正式目录 → 写元数据（最后一步）。
 * 中间任何一步抛错：清掉临时目录后原样上抛（旧安装未被动过 = 零残留）。
 */
export function commitInstall(options: { plan: SkillStoreInstallPlan; contents: Map<string, Uint8Array>; metadataDir: string; canonicalName?: string; now?: () => number }): SkillStoreInstallOutcome {
  const { plan, contents } = options;
  const now = options.now ?? (() => Date.now());
  if (!plan.existing && existsSync(plan.installDir)) {
    throw new Error(`目标目录 ${plan.installDir} 已存在（安装计划之后被外部创建），为避免覆盖已中止。`);
  }

  const tempDir = `${plan.installDir}.tmp-${process.pid}-${now()}`;
  let backupDir: string | undefined;
  try {
    mkdirSync(dirname(plan.installDir), { recursive: true });
    mkdirSync(tempDir, { recursive: true });
    for (const file of plan.files) {
      const bytes = contents.get(file.path);
      if (!bytes) throw new Error(`内存内容缺失：${file.path}（应不可能）`);
      const target = join(tempDir, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    // 复核（写坏一半就停）：文件数一致 + SKILL.md 真实存在。
    const written = countFilesRecursive(tempDir);
    if (written !== plan.files.length) throw new Error(`临时目录复核失败（写出 ${written} 个文件，应写 ${plan.files.length} 个）`);
    if (!existsSync(join(tempDir, "SKILL.md"))) throw new Error("临时目录复核失败：SKILL.md 不存在");

    if (plan.existing) {
      backupDir = join(plan.targetRoot, backupDirName(plan.slug, now()));
      if (existsSync(backupDir)) removeDirTree(backupDir);
      renameSync(plan.installDir, backupDir);
    }
    renameSync(tempDir, plan.installDir);
    recordInstall(options.metadataDir, {
      slug: plan.slug,
      ...(options.canonicalName ? { canonicalName: options.canonicalName } : {}),
      version: plan.version,
      installedAt: now(),
      scope: plan.scope,
      installDir: plan.installDir,
      files: plan.files.map((file) => ({ path: file.path, sha256: file.sha256 }))
    });
    if (backupDir) {
      try {
        removeDirTree(backupDir);
      } catch {
        // 备份清理失败不影响安装结果（留着旧目录总比丢用户数据强）。
      }
    }
    return {
      slug: plan.slug,
      scope: plan.scope,
      targetRoot: plan.targetRoot,
      installDir: plan.installDir,
      version: plan.version,
      fileCount: plan.files.length,
      totalBytes: plan.totalBytes,
      ...(plan.existing ? { replaced: true } : {})
    };
  } catch (error) {
    removeDirTree(tempDir);
    throw error;
  }
}

/**
 * 卸载：**只删本商店账本记录在案的目录**。
 * - 没有账本记录 → 拒绝（不误删用户手工放置的同名 skill）；
 * - realpath 后不在目标根内 → 拒绝（防符号链接把删除指到根外）；
 * - 删除成功后清账本；目录已不在 = 幂等成功并清账本。
 */
export function uninstall(options: { slug: string; scope: SkillStoreScope; targetRoot: string; metadataDir: string }): SkillStoreUninstallOutcome {
  const slug = validateSlugDirName(options.slug);
  if (!slug) throw new SkillStorePlanError(`技能标识不安全：${options.slug}`, "path");
  const targetRoot = resolve(options.targetRoot);
  const installDir = join(targetRoot, slug);
  // 幂等前置：目录已不存在 = 已卸载（无论账本是否有记录），只清账本即可。
  if (!existsSync(installDir)) {
    removeInstallRecord(options.metadataDir, options.scope, installDir);
    return { slug, scope: options.scope, installDir, removedFiles: 0 };
  }
  // 目录还在但账本无记录：可能是手工放置的同名 skill，绝不误删。
  const record = findInstallRecord(options.metadataDir, options.scope, installDir);
  if (!record) {
    throw new SkillStorePlanError(`没有找到 ${slug} 的商店安装记录（该目录可能是手工放置的，或账本缺失）；为避免误删，请手动确认后删除目录 ${installDir}`, "conflict");
  }
  // realpath 纵深防御：安装目录的真实位置必须仍在目标根之内。
  let realDir = installDir;
  let realRoot = targetRoot;
  try {
    realDir = realpathSync(installDir);
    realRoot = realpathSync(targetRoot);
  } catch {
    // realpath 失败按原路径继续（真实包含性校验在下方按小写前缀再兜）。
  }
  const dirLower = realDir.toLowerCase().replaceAll("\\", "/");
  const rootLower = realRoot.toLowerCase().replaceAll("\\", "/").replace(/\/+$/u, "");
  if (dirLower !== rootLower && !dirLower.startsWith(`${rootLower}/`)) {
    throw new SkillStorePlanError(`安装目录 ${installDir}（真实路径 ${realDir}）不在目标根 ${realRoot} 内，拒绝删除`, "root");
  }
  if (dirLower === rootLower) throw new SkillStorePlanError("拒绝删除安装根目录本身", "root");
  const removedFiles = countFilesRecursive(installDir);
  removeDirTree(installDir);
  removeInstallRecord(options.metadataDir, options.scope, installDir);
  return { slug, scope: options.scope, installDir, removedFiles };
}

/** 目标根目录解析（安装命令入口用）：global = `<agentDir>/pidesktop-skills`，project = `<workspace>/.pidesktop-skills`。 */
export function storeScopeRoot(scope: SkillStoreScope, agentDir: string, workspace: string | undefined): string {
  if (scope === "project") {
    if (!workspace) throw new Error("请先打开工作区，再安装到当前项目");
    return join(resolve(workspace), ".pidesktop-skills");
  }
  return join(agentDir, "pidesktop-skills");
}

/** 便捷入口：计划 → 下载校验 → 提交（一条链；utility 的 skill-store.install case 调这个）。 */
export async function installSkillFromStore(options: {
  slug: string;
  version: string;
  scope: SkillStoreScope;
  agentDir: string;
  workspace: string | undefined;
  canonicalName?: string;
  confirmReplace?: boolean;
  files: readonly SkillStoreFile[];
  fetchBytes?: FetchStoreBytes;
}): Promise<SkillStoreInstallOutcome> {
  const targetRoot = storeScopeRoot(options.scope, options.agentDir, options.workspace);
  const plan = planInstall({
    slug: options.slug,
    version: options.version,
    scope: options.scope,
    files: options.files,
    targetRoot,
    metadataDir: options.agentDir,
    ...(options.canonicalName ? { canonicalName: options.canonicalName } : {}),
    ...(options.confirmReplace !== undefined ? { confirmReplace: options.confirmReplace } : {})
  });
  const contents = await downloadAndVerify({ plan, ...(options.fetchBytes ? { fetchBytes: options.fetchBytes } : {}) });
  return commitInstall({ plan, contents, metadataDir: options.agentDir, ...(options.canonicalName ? { canonicalName: options.canonicalName } : {}) });
}
