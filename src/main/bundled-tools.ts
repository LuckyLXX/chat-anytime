import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 内置查找工具（fd / ripgrep）→ `<agentDir>/bin` 的幂等同步。
 *
 * 为什么需要它：Pi 的 `find` / `grep` 只有一条实现路径——spawn fd 与 rg，二级回退顺序是
 * `<agentDir>/bin` → 系统 PATH → 从 GitHub Release 下载。内网/无外网机器的第三级必然失败，
 * 且 Pi 没有「下载失败」缓存：每调一次工具都重新尝试，防火墙丢包时先卡 30s 再报错。
 * 所以这两个二进制随安装包发（`resources/tools` → `<安装目录>/tools`，见 package.json 的
 * extraResources），启动时由这里落到 Pi 认得的位置。
 *
 * 同步规则（宁可保守，不动用户的东西）：
 *  - 目标不存在            → 复制，并在部署清单里记下哈希
 *  - 目标存在、且内容是最新 → 跳过（幂等）
 *  - 目标存在、内容与清单记录一致（= 上次是我们放的）→ 内置版本变了才覆盖
 *  - 目标存在、但内容与清单不一致或没有记录（= 用户自己放的，或手工替换过）→ 不动
 *
 * 清单 `pidesktop-tools-deploy.json` 放在 agentDir 根下而不是 bin/ 里：bin 目录只该躺着
 * Pi 会去 spawn 的可执行文件，多一个 json 会干扰用户排查。
 */

/** 内置工具的基础名；实际文件名按平台加后缀（Windows 是 `.exe`）。 */
export const BUNDLED_TOOL_BASENAMES = ["fd", "rg"] as const;
export type BundledToolBasename = (typeof BUNDLED_TOOL_BASENAMES)[number];

/** 部署清单文件名（相对 agentDir）。 */
export const TOOL_DEPLOY_MANIFEST = "pidesktop-tools-deploy.json";

export type BundledToolsOutcome = {
  /** 首次落地（目标原本不存在）。 */
  copied: string[];
  /** 覆盖了我们上一版部署的文件。 */
  updated: string[];
  /** 用户自己放的版本，按规则不动。 */
  kept: string[];
  /** 目标已是最新，无需动作。 */
  unchanged: string[];
  /** 内置目录里没有该平台对应的文件（例如只有 Windows 二进制却跑在 macOS 上）。 */
  missing: string[];
  /** 单个文件失败不影响其它文件。 */
  failed: { name: string; error: string }[];
};

export function bundledToolFileName(base: BundledToolBasename, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${base}.exe` : base;
}

export function syncBundledTools(options: {
  /** 随包分发的工具目录（`<安装目录>/tools`，dev 下是仓库 `resources/tools`）；缺省= 无内置来源。 */
  bundledDir: string | undefined;
  /** 目标目录，应为 Pi 的 `getBinDir()`（`<agentDir>/bin`）。 */
  targetDir: string;
  /** 部署清单路径，应为 `<agentDir>/pidesktop-tools-deploy.json`。 */
  manifestPath: string;
  platform?: NodeJS.Platform;
}): BundledToolsOutcome {
  const outcome: BundledToolsOutcome = { copied: [], updated: [], kept: [], unchanged: [], missing: [], failed: [] };
  const { bundledDir, targetDir, manifestPath } = options;
  if (!bundledDir || !existsSync(bundledDir)) return outcome;

  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (error) {
    outcome.failed.push({ name: targetDir, error: errorText(error) });
    return outcome;
  }

  const manifest = readDeployManifest(manifestPath);
  let manifestDirty = false;

  for (const base of BUNDLED_TOOL_BASENAMES) {
    const fileName = bundledToolFileName(base, options.platform);
    const source = join(bundledDir, fileName);
    if (!existsSync(source)) {
      outcome.missing.push(fileName);
      continue;
    }
    const target = join(targetDir, fileName);
    try {
      const bundledHash = hashFile(source);
      if (!existsSync(target)) {
        deployFile(source, target);
        outcome.copied.push(fileName);
        manifest[fileName] = bundledHash;
        manifestDirty = true;
        continue;
      }
      const targetHash = hashFile(target);
      if (targetHash === bundledHash) {
        // 已经是最新：顺手把清单补齐（老安装包没有清单时，下一次升级才认得出这是我们放的）。
        if (manifest[fileName] !== bundledHash) {
          manifest[fileName] = bundledHash;
          manifestDirty = true;
        }
        outcome.unchanged.push(fileName);
        continue;
      }
      if (manifest[fileName] === targetHash) {
        deployFile(source, target);
        outcome.updated.push(fileName);
        manifest[fileName] = bundledHash;
        manifestDirty = true;
        continue;
      }
      // 清单对不上：用户自己的版本（或手工替换过），尊重它。
      outcome.kept.push(fileName);
    } catch (error) {
      outcome.failed.push({ name: fileName, error: errorText(error) });
    }
  }

  if (manifestDirty) writeDeployManifest(manifestPath, manifest);
  return outcome;
}

/** 先写临时文件再替换：避免中途失败留下半个 exe 让 Pi 去 spawn。 */
function deployFile(source: string, target: string): void {
  const temp = `${target}.pidesktop-tmp`;
  try {
    copyFileSync(source, temp);
    // Windows 上 rename 不能覆盖已存在文件，先删；失败（被占用）时由上层记为 failed，
    // 下次启动重试，不会破坏用户已有的那份。
    rmSync(target, { force: true });
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readDeployManifest(path: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const tools = (parsed as { tools?: unknown } | null)?.tools;
    if (!tools || typeof tools !== "object") return {};
    const entries: Record<string, string> = {};
    for (const [name, hash] of Object.entries(tools as Record<string, unknown>)) {
      if (typeof hash === "string") entries[name] = hash;
    }
    return entries;
  } catch {
    // 缺失或损坏都按「没有清单」处理：此时目标文件一律视为用户的，不覆盖（保守）。
    return {};
  }
}

function writeDeployManifest(path: string, tools: Record<string, string>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, tools }, null, 2)}\n`, "utf8");
  } catch {
    // 清单写失败只影响下次的判断（退化为「用户的版本、不动」），不值得打断启动。
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
