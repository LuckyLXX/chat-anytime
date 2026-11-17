import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_TOOL_BASENAMES, TOOL_DEPLOY_MANIFEST, bundledToolFileName, syncBundledTools } from "./bundled-tools.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pidesktop-bundled-tools-"));
  roots.push(root);
  return root;
}

function writeBundled(files: Record<string, string>): string {
  const dir = join(tempRoot(), "tools");
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function readManifest(path: string): { version: number; tools: Record<string, string> } {
  return JSON.parse(readFileSync(path, "utf8")) as { version: number; tools: Record<string, string> };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bundledToolFileName", () => {
  it("Windows 带 .exe，mac/linux 不带后缀", () => {
    expect(bundledToolFileName("fd", "win32")).toBe("fd.exe");
    expect(bundledToolFileName("rg", "win32")).toBe("rg.exe");
    expect(bundledToolFileName("fd", "linux")).toBe("fd");
    expect(bundledToolFileName("rg", "darwin")).toBe("rg");
  });

  it("只处理 fd 与 rg 两个工具", () => {
    expect([...BUNDLED_TOOL_BASENAMES]).toEqual(["fd", "rg"]);
  });
});

describe("syncBundledTools", () => {
  it("首次落地：复制到目标目录并写部署清单", () => {
    const bundledDir = writeBundled({ "fd.exe": "fd-v1", "rg.exe": "rg-v1" });
    const root = tempRoot();
    const targetDir = join(root, "agent", "bin");
    const manifestPath = join(root, "agent", TOOL_DEPLOY_MANIFEST);

    const outcome = syncBundledTools({ bundledDir, targetDir, manifestPath, platform: "win32" });

    expect(outcome.copied).toEqual(["fd.exe", "rg.exe"]);
    expect(outcome.failed).toEqual([]);
    expect(readFileSync(join(targetDir, "fd.exe"), "utf8")).toBe("fd-v1");
    expect(readFileSync(join(targetDir, "rg.exe"), "utf8")).toBe("rg-v1");
    // 清单落在 agentDir 根，不进 bin 目录（bin 里只该有 Pi 会 spawn 的可执行文件）
    expect(existsSync(join(targetDir, TOOL_DEPLOY_MANIFEST))).toBe(false);
    const manifest = readManifest(manifestPath);
    expect(manifest.version).toBe(1);
    expect(Object.keys(manifest.tools).sort()).toEqual(["fd.exe", "rg.exe"]);
  });

  it("幂等：再跑一次什么都不动", () => {
    const bundledDir = writeBundled({ "fd.exe": "fd-v1", "rg.exe": "rg-v1" });
    const root = tempRoot();
    const targetDir = join(root, "bin");
    const manifestPath = join(root, TOOL_DEPLOY_MANIFEST);

    syncBundledTools({ bundledDir, targetDir, manifestPath, platform: "win32" });
    const second = syncBundledTools({ bundledDir, targetDir, manifestPath, platform: "win32" });

    expect(second.copied).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.kept).toEqual([]);
    expect(second.unchanged).toEqual(["fd.exe", "rg.exe"]);
  });

  it("安装包升级：覆盖上一版由我们部署的文件", () => {
    const bundledDir = writeBundled({ "fd.exe": "fd-v1", "rg.exe": "rg-v1" });
    const root = tempRoot();
    const targetDir = join(root, "bin");
    const manifestPath = join(root, TOOL_DEPLOY_MANIFEST);

    syncBundledTools({ bundledDir, targetDir, manifestPath, platform: "win32" });
    writeFileSync(join(bundledDir, "fd.exe"), "fd-v2");
    const second = syncBundledTools({ bundledDir, targetDir, manifestPath, platform: "win32" });

    expect(second.updated).toEqual(["fd.exe"]);
    expect(second.unchanged).toEqual(["rg.exe"]);
    expect(readFileSync(join(targetDir, "fd.exe"), "utf8")).toBe("fd-v2");
    // 清单跟的是新内容的哈希：下一次启动才认得出这是我们放的
    expect(readManifest(manifestPath).tools["fd.exe"]).toBe(createHash("sha256").update("fd-v2").digest("hex"));
  });

  it("用户自己放的版本不被覆盖，也不写进清单", () => {
    const bundledDir = writeBundled({ "rg.exe": "rg-bundled" });
    const root = tempRoot();
    const targetDir = join(root, "bin");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "rg.exe"), "rg-user");
    const manifestPath = join(root, TOOL_DEPLOY_MANIFEST);

    const outcome = syncBundledTools({ bundledDir, targetDir, manifestPath, platform: "win32" });

    expect(outcome.kept).toEqual(["rg.exe"]);
    expect(outcome.copied).toEqual([]);
    expect(readFileSync(join(targetDir, "rg.exe"), "utf8")).toBe("rg-user");
    // 没动过任何文件 → 不需要清单
    expect(existsSync(manifestPath)).toBe(false);
  });

  it("清单损坏时按「用户的版本」处理，仍然不覆盖", () => {
    const bundledDir = writeBundled({ "rg.exe": "rg-bundled" });
    const root = tempRoot();
    const targetDir = join(root, "bin");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "rg.exe"), "rg-user");
    const manifestPath = join(root, TOOL_DEPLOY_MANIFEST);
    writeFileSync(manifestPath, "{ not json");

    const outcome = syncBundledTools({ bundledDir, targetDir, manifestPath, platform: "win32" });

    expect(outcome.kept).toEqual(["rg.exe"]);
    expect(readFileSync(join(targetDir, "rg.exe"), "utf8")).toBe("rg-user");
  });

  it("内置目录里只有 Windows 二进制时，mac/linux 报 missing 而不是复制错文件", () => {
    const bundledDir = writeBundled({ "fd.exe": "fd-v1", "rg.exe": "rg-v1" });
    const root = tempRoot();
    const targetDir = join(root, "bin");

    const outcome = syncBundledTools({ bundledDir, targetDir, manifestPath: join(root, TOOL_DEPLOY_MANIFEST), platform: "linux" });

    expect(outcome.missing).toEqual(["fd", "rg"]);
    expect(outcome.copied).toEqual([]);
  });

  it("内置目录不存在时直接跳过，不建目标目录", () => {
    const root = tempRoot();
    const targetDir = join(root, "bin");

    const outcome = syncBundledTools({ bundledDir: join(root, "nope"), targetDir, manifestPath: join(root, TOOL_DEPLOY_MANIFEST), platform: "win32" });

    expect(outcome).toMatchObject({ copied: [], updated: [], kept: [], unchanged: [], missing: [], failed: [] });
    expect(existsSync(targetDir)).toBe(false);
    expect(syncBundledTools({ bundledDir: undefined, targetDir, manifestPath: join(root, TOOL_DEPLOY_MANIFEST) }).copied).toEqual([]);
  });

  it("单个文件失败不影响另一个：坏的记为 failed，好的照常落地", () => {
    const bundledDir = writeBundled({ "fd.exe": "fd-v1", "rg.exe": "rg-v1" });
    const root = tempRoot();
    const targetDir = join(root, "bin");
    // 用一个目录占住 fd.exe 的位置：哈希读取失败 → failed，但 rg.exe 必须照常复制
    mkdirSync(join(targetDir, "fd.exe"), { recursive: true });

    const outcome = syncBundledTools({ bundledDir, targetDir, manifestPath: join(root, TOOL_DEPLOY_MANIFEST), platform: "win32" });

    expect(outcome.failed.map((item) => item.name)).toEqual(["fd.exe"]);
    expect(outcome.copied).toEqual(["rg.exe"]);
    expect(readFileSync(join(targetDir, "rg.exe"), "utf8")).toBe("rg-v1");
  });
});
