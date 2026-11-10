import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { existsSync as _exists2, readFileSync as _read2 } from 'node:fs';
import {
  SKILL_FILE_COUNT_MAX,
  SKILL_FILE_MAX_BYTES,
  SKILL_TOTAL_MAX_BYTES,
  backupDirName,
  commitInstall,
  downloadAndVerify,
  findInstallRecord,
  installRecordKey,
  installSkillFromStore,
  listInstallRecords,
  skillStoreMetadataPath,
  planInstall,
  readStoreMetadata,
  removeInstallRecord,
  storeScopeRoot,
  uninstall,
  validateSkillStoreFilePath,
  validateSlugDirName,
  writeStoreMetadata,
  SkillStorePlanError
} from "./skill-store-install.js";
import { createHash } from "node:crypto";
import type { SkillStoreFile } from "../shared/skill-store.js";

let agentDir = "";
let targetRoot = "";

beforeEach(() => {
  agentDir = join(tmpdir(), `skill-store-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, "agent");
  targetRoot = join(agentDir, "pidesktop-skills");
  mkdirSync(targetRoot, { recursive: true });
});

function file(path: string, size: number, sha256?: string): SkillStoreFile {
  return { path, size, sha256: sha256 ?? "a".repeat(64) };
}

const text = (s: string) => new TextEncoder().encode(s);

describe("validateSkillStoreFilePath（路径安全）", () => {
  it("拒绝穿越/绝对路径/盘符/ADS/控制字符/保留名/空段", () => {
    expect(validateSkillStoreFilePath("../evil.txt")).toBeUndefined();
    expect(validateSkillStoreFilePath("a/../../evil.txt")).toBeUndefined();
    expect(validateSkillStoreFilePath("/abs/path.txt")).toBeUndefined();
    expect(validateSkillStoreFilePath("C:/evil.txt")).toBeUndefined();
    expect(validateSkillStoreFilePath("file.txt:hidden")).toBeUndefined();
    expect(validateSkillStoreFilePath("a\u0000b.txt")).toBeUndefined();
    expect(validateSkillStoreFilePath("CON")).toBeUndefined();
    expect(validateSkillStoreFilePath("docs/NUL.md")).toBeUndefined();
    expect(validateSkillStoreFilePath("a//b.txt")).toBeUndefined();
    expect(validateSkillStoreFilePath("./x.txt")).toBeUndefined();
    // 结尾空格经 trim 归一（无害）；结尾点是 Windows 非法名，拒绝。
    expect(validateSkillStoreFilePath("x.txt ")).toBe("x.txt");
    expect(validateSkillStoreFilePath("x.txt.")).toBeUndefined();
    expect(validateSkillStoreFilePath("a<b>.txt")).toBeUndefined();
    expect(validateSkillStoreFilePath("")).toBeUndefined();
  });

  it("混合分隔符统一归一后仍拒绝穿越", () => {
    expect(validateSkillStoreFilePath("docs\\..\\evil.txt")).toBeUndefined();
  });

  it("正常相对路径通过且保留原大小写", () => {
    expect(validateSkillStoreFilePath("SKILL.md")).toBe("SKILL.md");
    expect(validateSkillStoreFilePath("references\\Deep-Guide.md")).toBe("references/Deep-Guide.md");
    expect(validateSkillStoreFilePath("assets/icon.png")).toBe("assets/icon.png");
  });
});

describe("validateSlugDirName", () => {
  it("拒绝保留名/非法字符/点结尾/超长", () => {
    expect(validateSlugDirName("CON")).toBeUndefined();
    expect(validateSlugDirName("a/b")).toBeUndefined();
    expect(validateSlugDirName("a b")).toBeUndefined();
    expect(validateSlugDirName("abc.")).toBeUndefined();
    expect(validateSlugDirName(".hidden")).toBeUndefined();
    expect(validateSlugDirName("a".repeat(200))).toBeUndefined();
  });
  it("正常 slug 通过", () => {
    expect(validateSlugDirName("dev-god")).toBe("dev-god");
    expect(validateSlugDirName("find-skill-skillhub")).toBe("find-skill-skillhub");
  });
});

describe("planInstall（下载前全量前置校验）", () => {
  it("缺 SKILL.md → missing-skill-md", () => {
    expect(() => planInstall({ slug: "a", version: "1.0", scope: "global", files: [file("README.md", 10)], targetRoot, metadataDir: agentDir })).toThrow(SkillStorePlanError);
    try {
      planInstall({ slug: "a", version: "1.0", scope: "global", files: [file("README.md", 10)], targetRoot, metadataDir: agentDir });
    } catch (error) {
      expect((error as SkillStorePlanError).code).toBe("missing-skill-md");
    }
  });

  it("单文件超 1MB → limit（下载前即可判定）", () => {
    try {
      planInstall({ slug: "a", version: "1.0", scope: "global", files: [file("SKILL.md", SKILL_FILE_MAX_BYTES + 1)], targetRoot, metadataDir: agentDir });
      expect.fail("应抛出 limit 错误");
    } catch (error) {
      expect((error as SkillStorePlanError).code).toBe("limit");
      expect((error as Error).message).toContain("官方 CLI");
    }
  });

  it("合计超 32MB → limit", () => {
    const files = Array.from({ length: 40 }, (_, i) => file(`docs/${i}.md`, 900 * 1024));
    files.push(file("SKILL.md", 10));
    try {
      planInstall({ slug: "a", version: "1.0", scope: "global", files, targetRoot, metadataDir: agentDir });
      expect.fail("应抛出 limit 错误");
    } catch (error) {
      expect((error as SkillStorePlanError).code).toBe("limit");
    }
  });

  it("文件数超上限 → limit", () => {
    const files = Array.from({ length: SKILL_FILE_COUNT_MAX + 1 }, (_, i) => file(`f${i}.md`, 1));
    files.push(file("SKILL.md", 1));
    try {
      planInstall({ slug: "a", version: "1.0", scope: "global", files, targetRoot, metadataDir: agentDir });
      expect.fail("应抛出 limit 错误");
    } catch (error) {
      expect((error as SkillStorePlanError).code).toBe("limit");
    }
  });

  it("路径穿越/坏 sha256 → path", () => {
    try {
      planInstall({ slug: "a", version: "1.0", scope: "global", files: [file("../evil.txt", 1), file("SKILL.md", 1)], targetRoot, metadataDir: agentDir });
      expect.fail("应抛出 path 错误");
    } catch (error) {
      expect((error as SkillStorePlanError).code).toBe("path");
      expect((error as Error).message).toContain("evil.txt");
    }
    try {
      planInstall({ slug: "a", version: "1.0", scope: "global", files: [file("SKILL.md", 1, "短哈希")], targetRoot, metadataDir: agentDir });
      expect.fail("应抛出 path 错误");
    } catch (error) {
      expect((error as SkillStorePlanError).code).toBe("path");
    }
  });

  it("驱动器根不允许当安装根 → root", () => {
    try {
      planInstall({ slug: "a", version: "1.0", scope: "global", files: [file("SKILL.md", 1)], targetRoot: "D:\\", metadataDir: agentDir });
      expect.fail("应抛出 root 错误");
    } catch (error) {
      expect((error as SkillStorePlanError).code).toBe("root");
    }
  });

  it("已安装且未确认 → conflict（confirmReplace=true 通过）", () => {
    const files = [file("SKILL.md", 5)];
    commitInstall({ plan: planInstall({ slug: "a", version: "1.0", scope: "global", files, targetRoot, metadataDir: agentDir }), contents: new Map([["SKILL.md", new TextEncoder().encode("hello")]]), metadataDir: agentDir });
    try {
      planInstall({ slug: "a", version: "2.0", scope: "global", files, targetRoot, metadataDir: agentDir });
      expect.fail("应抛出 conflict 错误");
    } catch (error) {
      expect((error as SkillStorePlanError).code).toBe("conflict");
      expect((error as Error).message).toContain("已安装");
    }
    const plan = planInstall({ slug: "a", version: "2.0", scope: "global", files, targetRoot, metadataDir: agentDir, confirmReplace: true });
    expect(plan.existing).toBe(true);
  });

  it("异源覆盖（canonicalName 不一致）→ conflict，即使 confirmReplace", () => {
    const files = [file("SKILL.md", 5)];
    commitInstall({ plan: planInstall({ slug: "a", version: "1.0", scope: "global", files, targetRoot, metadataDir: agentDir }), contents: new Map([["SKILL.md", new TextEncoder().encode("hello")]]), metadataDir: agentDir, canonicalName: "@owner1/a" });
    try {
      planInstall({ slug: "a", version: "2.0", scope: "global", files, targetRoot, metadataDir: agentDir, canonicalName: "@owner2/a", confirmReplace: true });
      expect.fail("应抛出 conflict 错误");
    } catch (error) {
      expect((error as SkillStorePlanError).code).toBe("conflict");
      expect((error as Error).message).toContain("@owner1/a");
    }
  });
});

describe("downloadAndVerify（内存下载 + sha256 全量校验）", () => {
  function bytesOf(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }
  function sha(text: string): string {
    return createHash("sha256").update(bytesOf(text)).digest("hex");
  }

  it("全部匹配时返回路径→字节映射", async () => {
    const plan = planInstall({
      slug: "a",
      version: "1.0",
      scope: "global",
      files: [file("SKILL.md", 5, sha("hello")), file("docs/d.md", 4, sha("data"))],
      targetRoot,
      metadataDir: agentDir
    });
    const contents = await downloadAndVerify({ plan, fetchBytes: async (_slug, version, path) => (version === "1.0" && path === "SKILL.md" ? bytesOf("hello") : bytesOf("data")) });
    expect(contents.size).toBe(2);
  });

  it("sha256 不匹配 → 整体失败且消息含文件名", async () => {
    const plan = planInstall({ slug: "a", version: "1.0", scope: "global", files: [file("SKILL.md", 5, sha("hello"))], targetRoot, metadataDir: agentDir });
    await expect(downloadAndVerify({ plan, fetchBytes: async () => bytesOf("tampered") })).rejects.toThrow("sha256 校验不匹配");
  });

  it("下载器抛错（413 等）→ 整体失败且消息透传原因", async () => {
    const plan = planInstall({ slug: "a", version: "1.0", scope: "global", files: [file("SKILL.md", 5)], targetRoot, metadataDir: agentDir });
    await expect(downloadAndVerify({ plan, fetchBytes: async () => { throw new Error("HTTP 413"); } })).rejects.toThrow("HTTP 413");
  });

  it("实际字节超 1MB 上限 → 拒绝（不信任清单 size）", async () => {
    const big = bytesOf("x".repeat(SKILL_FILE_MAX_BYTES + 1));
    const plan = planInstall({ slug: "a", version: "1.0", scope: "global", files: [file("SKILL.md", 5, sha("ok"))], targetRoot, metadataDir: agentDir });
    await expect(downloadAndVerify({ plan, fetchBytes: async () => big })).rejects.toThrow("1MB");
  });
});

describe("commitInstall（临时目录 + 原子 rename + 账本）", () => {
  it("全新安装：落盘结构正确、账本可查、清单回执正确", () => {
    const plan = planInstall({ slug: "demo", version: "1.2.0", scope: "global", files: [file("SKILL.md", 5), file("refs/a.md", 2)], targetRoot, metadataDir: agentDir });
    const outcome = commitInstall({ plan, contents: new Map([["SKILL.md", text("hello")], ["refs/a.md", text("ok")]]), metadataDir: agentDir, canonicalName: "@x/demo" });
    expect(outcome.fileCount).toBe(2);
    expect(outcome.totalBytes).toBe(7);
    expect(outcome.scope).toBe("global");
    expect(existsSync(join(outcome.installDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(outcome.installDir, "refs", "a.md"))).toBe(true);
    expect(readFileSync(join(outcome.installDir, "SKILL.md"), "utf8")).toBe("hello");
    // 没有残留临时目录
    const siblings = readdirSync(targetRoot).filter((name) => name.includes(".tmp-"));
    expect(siblings).toEqual([]);
    // 账本
    const record = findInstallRecord(agentDir, "global", outcome.installDir);
    expect(record?.version).toBe("1.2.0");
    expect(record?.canonicalName).toBe("@x/demo");
    expect(record?.files).toHaveLength(2);
  });

  it("覆盖安装：旧目录先备份再清理、账本更新为新版本", () => {
    const files = [file("SKILL.md", 5)];
    commitInstall({ plan: planInstall({ slug: "demo", version: "1.0", scope: "global", files, targetRoot, metadataDir: agentDir }), contents: new Map([["SKILL.md", text("old")]]), metadataDir: agentDir });
    const plan = planInstall({ slug: "demo", version: "2.0", scope: "global", files, targetRoot, metadataDir: agentDir, confirmReplace: true });
    expect(plan.existing).toBe(true);
    const outcome = commitInstall({ plan, contents: new Map([["SKILL.md", text("new")]]), metadataDir: agentDir });
    expect(outcome.replaced).toBe(true);
    expect(readFileSync(join(outcome.installDir, "SKILL.md"), "utf8")).toBe("new");
    // 备份目录已被清理（安装成功后）：目标根下不再有任何 .bak- 残留
    expect(readdirSync(targetRoot).filter((name) => name.includes(".bak-"))).toEqual([]);
    expect(findInstallRecord(agentDir, "global", outcome.installDir)?.version).toBe("2.0");
  });

  it("写入中途抛错 → 临时目录清理、旧安装原封不动（零残留）", () => {
    const files = [file("SKILL.md", 5)];
    commitInstall({ plan: planInstall({ slug: "demo", version: "1.0", scope: "global", files, targetRoot, metadataDir: agentDir }), contents: new Map([["SKILL.md", text("old")]]), metadataDir: agentDir });
    // 第二次安装的内存内容缺一个清单文件 → 写入循环抛「内存内容缺失」
    const plan = planInstall({ slug: "demo", version: "2.0", scope: "global", files: [file("SKILL.md", 5), file("docs/a.md", 2)], targetRoot, metadataDir: agentDir, confirmReplace: true });
    expect(() => commitInstall({ plan, contents: new Map([["SKILL.md", text("new")]]), metadataDir: agentDir })).toThrow();
    // 临时目录被清掉
    expect(readdirSync(targetRoot).filter((name) => name.includes(".tmp-"))).toEqual([]);
    // 旧安装原样
    expect(readFileSync(join(targetRoot, "demo", "SKILL.md"), "utf8")).toBe("old");
    expect(findInstallRecord(agentDir, "global", join(targetRoot, "demo"))?.version).toBe("1.0");
  });
});

describe("uninstall（只删自己装的那层）", () => {
  it("无账本记录 → 拒绝（不误删手工放置的目录）", () => {
    const manualDir = join(targetRoot, "manual-skill");
    mkdirSync(manualDir, { recursive: true });
    writeFileSync(join(manualDir, "SKILL.md"), "hand made");
    try {
      uninstall({ slug: "manual-skill", scope: "global", targetRoot, metadataDir: agentDir });
      expect.fail("应拒绝卸载");
    } catch (error) {
      expect((error as Error).message).toContain("没有找到");
    }
    expect(existsSync(manualDir)).toBe(true);
  });

  it("有账本记录 → 删除目录并清账本；已不存在时幂等成功", () => {
    const files = [file("SKILL.md", 5), file("docs/a.md", 2)];
    const plan = planInstall({ slug: "demo", version: "1.0", scope: "global", files, targetRoot, metadataDir: agentDir });
    const outcome = commitInstall({ plan, contents: new Map([["SKILL.md", text("x")], ["docs/a.md", text("y")]]), metadataDir: agentDir });
    console.log("DBG metaPath=", skillStoreMetadataPath(agentDir), "exists=", _exists2(skillStoreMetadataPath(agentDir)));
    console.log("DBG meta=", _exists2(skillStoreMetadataPath(agentDir)) ? _read2(skillStoreMetadataPath(agentDir), "utf8").slice(0, 300) : "MISSING");
    const removed = uninstall({ slug: "demo", scope: "global", targetRoot, metadataDir: agentDir });
    expect(removed.removedFiles).toBe(2);
    expect(existsSync(outcome.installDir)).toBe(false);
    expect(findInstallRecord(agentDir, "global", outcome.installDir)).toBeUndefined();
    // 幂等：再卸一次仍成功（目录已不在，只清账本）
    const again = uninstall({ slug: "demo", scope: "global", targetRoot, metadataDir: agentDir });
    expect(again.removedFiles).toBe(0);
  });

  it("项目作用域与全局作用域互不干扰", () => {
    const projectRoot = join(agentDir, "workspace", ".pidesktop-skills");
    mkdirSync(projectRoot, { recursive: true });
    const plan = planInstall({ slug: "demo", version: "1.0", scope: "project", files: [file("SKILL.md", 1)], targetRoot: projectRoot, metadataDir: agentDir });
    commitInstall({ plan, contents: new Map([["SKILL.md", text("p")]]), metadataDir: agentDir });
    // 全局作用域下该 slug 目录不存在 → 幂等成功（removedFiles 0），项目目录安然无恙
    const globalAttempt = uninstall({ slug: "demo", scope: "global", targetRoot, metadataDir: agentDir });
    expect(globalAttempt.removedFiles).toBe(0);
    expect(existsSync(join(projectRoot, "demo"))).toBe(true);
    // 项目作用域可以卸载
    uninstall({ slug: "demo", scope: "project", targetRoot: projectRoot, metadataDir: agentDir });
    expect(existsSync(join(projectRoot, "demo"))).toBe(false);
  });
});

describe("元数据读写", () => {
  it("损坏/缺失 → 空账本不抛错；写入后 round-trip 一致", () => {
    expect(readStoreMetadata(join(agentDir, "not-exist"))).toEqual({ version: 1, installs: {} });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "pideskill-store-metadata.json"), "{broken", "utf8");
    expect(readStoreMetadata(agentDir)).toEqual({ version: 1, installs: {} });
    writeStoreMetadata(agentDir, { version: 1, installs: { [installRecordKey("global", "D:/x")]: { slug: "x", version: "1", installedAt: 1, scope: "global", installDir: "D:/x", files: [] } } });
    expect(listInstallRecords(agentDir)).toHaveLength(1);
    removeInstallRecord(agentDir, "global", "D:/x");
    expect(listInstallRecords(agentDir)).toHaveLength(0);
  });
});

describe("storeScopeRoot 与 installSkillFromStore 一条链", () => {
  it("global → <agentDir>/pidesktop-skills；project 无工作区 → 报错", () => {
    expect(storeScopeRoot("global", agentDir, undefined)).toBe(join(agentDir, "pidesktop-skills"));
    expect(() => storeScopeRoot("project", agentDir, undefined)).toThrow("请先打开工作区");
    expect(storeScopeRoot("project", agentDir, "D:/ws")).toContain(".pidesktop-skills");
  });

  it("一条链：计划 → 下载校验 → 提交全部成功", async () => {
    const sha = createHash("sha256").update("chain").digest("hex");
    const outcome = await installSkillFromStore({
      slug: "chain-skill",
      version: "3.1",
      scope: "global",
      agentDir,
      workspace: undefined,
      canonicalName: "@x/chain-skill",
      files: [file("SKILL.md", 5, sha)],
      fetchBytes: async () => new TextEncoder().encode("chain")
    });
    expect(outcome.fileCount).toBe(1);
    expect(readFileSync(join(outcome.installDir, "SKILL.md"), "utf8")).toBe("chain");
  });

  it("一条链：校验失败时磁盘零残留", async () => {
    const before = existsSync(join(targetRoot, "chain-bad"));
    expect(before).toBe(false);
    await expect(installSkillFromStore({
      slug: "chain-bad",
      version: "1",
      scope: "global",
      agentDir,
      workspace: undefined,
      files: [file("SKILL.md", 5, "f".repeat(64))],
      fetchBytes: async () => new TextEncoder().encode("bad bytes")
    })).rejects.toThrow("校验不匹配");
    expect(existsSync(join(targetRoot, "chain-bad"))).toBe(false);
    expect(readdirSync(targetRoot).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(listInstallRecords(agentDir).filter((record) => record.slug === "chain-bad")).toEqual([]);
  });
});

describe("备份目录命名", () => {
  it("bak 带时间戳", () => {
    expect(backupDirName("demo", 1234567)).toBe("demo.bak-1234567");
  });
});

describe("来源归属（sourceId：公开商店 / 内网商店）", () => {
  const files = [file("SKILL.md", 3)];
  const contents = new Map([["SKILL.md", text("hi!")]]);

  it("账本记录来源；同源覆盖需确认，异源同名目录直接拒绝", () => {
    const plan = planInstall({ slug: "demo", version: "1.0.0", scope: "global", files, targetRoot, metadataDir: agentDir });
    expect(plan.sourceId).toBe("public");
    commitInstall({ plan, contents, metadataDir: agentDir, sourceUrl: "https://api.skillhub.cn" });
    const record = findInstallRecord(agentDir, "global", plan.installDir);
    expect(record?.sourceId).toBe("public");
    expect(record?.sourceUrl).toBe("https://api.skillhub.cn");

    // 同源：没有 confirmReplace 时报「已安装」
    expect(() => planInstall({ slug: "demo", version: "1.0.1", scope: "global", sourceId: "public", files, targetRoot, metadataDir: agentDir })).toThrow(/已安装/);

    // 异源：无论是否 confirmReplace 都拒绝，并说明是哪个源装的
    expect(() => planInstall({ slug: "demo", version: "1.0.1", scope: "global", sourceId: "intranet", files, targetRoot, metadataDir: agentDir, confirmReplace: true })).toThrow(/已由「公开 SkillHub」安装/);
  });

  it("旧账本没有 sourceId 时视为 public", () => {
    const plan = planInstall({ slug: "legacy", version: "1.0.0", scope: "global", files, targetRoot, metadataDir: agentDir });
    commitInstall({ plan, contents, metadataDir: agentDir });
    // 模拟旧版账本：手工抹掉 sourceId
    const metadata = readStoreMetadata(agentDir);
    const key = installRecordKey("global", plan.installDir);
    delete metadata.installs[key]!.sourceId;
    writeStoreMetadata(agentDir, metadata);

    expect(() => planInstall({ slug: "legacy", version: "1.0.1", scope: "global", sourceId: "intranet", files, targetRoot, metadataDir: agentDir })).toThrow(/已由「公开 SkillHub」安装/);
    expect(() => planInstall({ slug: "legacy", version: "1.0.1", scope: "global", sourceId: "public", files, targetRoot, metadataDir: agentDir })).toThrow(/已安装/);
  });

  it("uninstall 只允许从安装它的那个来源卸载", () => {
    const plan = planInstall({ slug: "inner", version: "1.0.0", scope: "global", sourceId: "intranet", files, targetRoot, metadataDir: agentDir });
    commitInstall({ plan, contents, metadataDir: agentDir, sourceUrl: "http://skills.corp.local:8080" });
    expect(() => uninstall({ slug: "inner", scope: "global", sourceId: "public", targetRoot, metadataDir: agentDir })).toThrow(/由「内网 Skill 商店」安装/);

    const outcome = uninstall({ slug: "inner", scope: "global", sourceId: "intranet", targetRoot, metadataDir: agentDir });
    expect(outcome.sourceId).toBe("intranet");
    expect(outcome.removedFiles).toBe(1);
    expect(findInstallRecord(agentDir, "global", plan.installDir)).toBeUndefined();
  });
});
