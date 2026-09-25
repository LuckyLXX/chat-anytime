import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppearanceSettings } from "../shared/protocol.js";
import { parseThemeAssetUrl, resolveThemeAssetUrls } from "../shared/theme-assets.js";
import { readSettingsFile, settingsPath, appearanceAssetsPath, writeSettingsFile } from "./settings-store.js";
import { migrateSettings } from "./settings.js";
import {
  THEME_ASSET_MAX_FILE_BYTES,
  importThemeCssFile,
  importThemeDirectory,
  migrateInlineThemeAssets,
  promoteThemeScope,
  reconcileThemeAssetDirs,
  serveThemeAsset,
  themeAssetsDirFor
} from "./theme-assets.js";

/**
 * 主题资产落盘的磁盘侧（2026-09-26）：导入 / 草稿槽提升 / 目录对账 / 内联 base64 迁移。
 * 全部用真实临时目录（迁移是本方案的唯一不可逆点，必须真写盘验证）。
 */

const PNG_BYTES = Buffer.from("PNG-bytes-0123456789");
const WOFF_BYTES = Buffer.from("WOFF-bytes");
const dataUrl = (mime: string, bytes: Buffer): string => `data:${mime};base64,${bytes.toString("base64")}`;

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeFile(root: string, relativePath: string, content: string | Buffer): void {
  const target = join(root, ...relativePath.split("/"));
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content);
}

function appearanceOf(themes: { id: string; css: string; assets?: boolean }[], customCss?: string): AppearanceSettings {
  return {
    theme: "system",
    themePreset: "default",
    customCss: customCss ?? themes.at(-1)?.css ?? "",
    customThemes: themes.map((theme) => ({
      id: theme.id,
      name: theme.id,
      css: theme.css,
      ...(theme.assets ? { assets: { "x.png": dataUrl("image/png", PNG_BYTES) } } : {})
    })),
    showThinking: true
  };
}

describe("importThemeDirectory：主进程读盘、按 CSS 引用落资产", () => {
  it("选 theme.css、保留相对结构、统计正确，草稿槽先清空再写", () => {
    const work = tempDir("pi-theme-import-");
    const themesDir = themeAssetsDirFor(join(work, "agent"));
    // 上一次导入的残留：新导入必须先清掉（否则同名旧图会被新 CSS 引用到）
    writeFile(themesDir, "current/stale.png", Buffer.from("stale"));
    const source = join(work, "My Theme");
    writeFile(source, "theme.css", ":root { --chat-bg-image: url(assets/bg dark.png); }\n@font-face { src: url(./Fonts/Theme.woff2); }");
    writeFile(source, "assets/bg dark.png", PNG_BYTES);
    writeFile(source, "Fonts/Theme.woff2", WOFF_BYTES);
    writeFile(source, "notes.txt", "not referenced");

    const result = importThemeDirectory(themesDir, source);
    expect(result.ok).toBe(true);
    expect(result.name).toBe("My Theme");
    expect(result.assetCount).toBe(2);
    expect(result.bytes).toBe(PNG_BYTES.length + WOFF_BYTES.length);
    expect(result.missing).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(themesDir, "current", "assets", "bg dark.png"))).toBe(true);
    expect(existsSync(join(themesDir, "current", "fonts", "theme.woff2"))).toBe(true);
    // 未被引用的文件不落盘；上一次导入的残留被清掉
    expect(existsSync(join(themesDir, "current", "notes.txt"))).toBe(false);
    expect(existsSync(join(themesDir, "current", "stale.png"))).toBe(false);
    rmSync(work, { recursive: true, force: true });
  });

  it("CSS 里的相对引用改写成协议 URL 后能被 handler 直接取到（端到端接缝）", async () => {
    const work = tempDir("pi-theme-import-e2e-");
    const themesDir = themeAssetsDirFor(join(work, "agent"));
    const source = join(work, "theme dir");
    writeFile(source, "theme.css", ":root { --chat-bg-image: url(wallpaper.png); }");
    writeFile(source, "wallpaper.png", PNG_BYTES);

    const result = importThemeDirectory(themesDir, source);
    const css = resolveThemeAssetUrls(result.css!, "current");
    const parsed = parseThemeAssetUrl(/url\("([^"]+)"\)/u.exec(css)![1]!);
    expect(parsed).toEqual({ scope: "current", relativePath: "wallpaper.png" });
    const response = await serveThemeAsset(parsed!, themesDir);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
    rmSync(work, { recursive: true, force: true });
  });

  it("找不到的引用如实上报；白名单外的扩展名跳过（不中止）", () => {
    const work = tempDir("pi-theme-import-missing-");
    const themesDir = themeAssetsDirFor(join(work, "agent"));
    const source = join(work, "t");
    writeFile(source, "theme.css", ":root { --a: url(missing.png); --b: url(bg.png); --c: url(clip.mp4); }");
    writeFile(source, "nested/bg.png", PNG_BYTES);
    writeFile(source, "clip.mp4", Buffer.from("video"));

    const result = importThemeDirectory(themesDir, source);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual(["missing.png"]);
    expect(result.skipped).toEqual(["clip.mp4"]);
    expect(result.assetCount).toBe(1);
    rmSync(work, { recursive: true, force: true });
  });

  it("单文件超限 → 报错中止且一个文件都不写", () => {
    const work = tempDir("pi-theme-import-limit-");
    const themesDir = themeAssetsDirFor(join(work, "agent"));
    const source = join(work, "t");
    writeFile(source, "theme.css", ":root { --a: url(big.png); --b: url(small.png); }");
    writeFile(source, "small.png", PNG_BYTES);
    writeFile(source, "big.png", Buffer.alloc(THEME_ASSET_MAX_FILE_BYTES + 1));

    const result = importThemeDirectory(themesDir, source);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("单文件");
    expect(existsSync(join(themesDir, "current"))).toBe(false);
    rmSync(work, { recursive: true, force: true });
  });

  it("没有 CSS / 路径不是目录 → 明确报错", () => {
    const work = tempDir("pi-theme-import-bad-");
    const themesDir = themeAssetsDirFor(join(work, "agent"));
    const source = join(work, "no-css");
    writeFile(source, "readme.md", "hi");
    expect(importThemeDirectory(themesDir, source).message).toContain("没有找到 CSS");
    expect(importThemeDirectory(themesDir, join(work, "nope")).ok).toBe(false);
    rmSync(work, { recursive: true, force: true });
  });
});

describe("importThemeCssFile：以 CSS 所在目录为根收集资产", () => {
  it("CSS 文件名与目录名不一致也能导入，主题名回落到文件名", () => {
    const work = tempDir("pi-theme-import-css-");
    const themesDir = themeAssetsDirFor(join(work, "agent"));
    const root = join(work, "bundle");
    writeFile(root, "my-theme.css", ":root { --chat-bg-image: url(assets/bg.webp); }");
    writeFile(root, "assets/bg.webp", PNG_BYTES);

    const result = importThemeCssFile(themesDir, join(root, "my-theme.css"));
    expect(result.ok).toBe(true);
    expect(result.name).toBe("my-theme");
    expect(result.assetCount).toBe(1);
    expect(existsSync(join(themesDir, "current", "assets", "bg.webp"))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it("CSS 里的 Theme Name 优先于文件名", () => {
    const work = tempDir("pi-theme-import-name-");
    const themesDir = themeAssetsDirFor(join(work, "agent"));
    const root = join(work, "b");
    writeFile(root, "t.css", "/* Theme Name: 霓虹街区 */\n:root { --accent: red; }");
    expect(importThemeCssFile(themesDir, join(root, "t.css")).name).toBe("霓虹街区");
    rmSync(work, { recursive: true, force: true });
  });
});

describe("promoteThemeScope / reconcileThemeAssetDirs：草稿槽与主题目录的归属", () => {
  it("promote 把 current 改名为 <id>；目标已存在时合并而不是丢弃", () => {
    const work = tempDir("pi-theme-promote-");
    const themesDir = themeAssetsDirFor(join(work, "agent"));
    writeFile(themesDir, "current/a.png", PNG_BYTES);
    expect(promoteThemeScope(themesDir, "custom-a")).toBe(true);
    expect(existsSync(join(themesDir, "custom-a", "a.png"))).toBe(true);
    expect(existsSync(join(themesDir, "current"))).toBe(false);

    writeFile(themesDir, "custom-a/keep.png", PNG_BYTES);
    writeFile(themesDir, "current/b.png", WOFF_BYTES);
    expect(promoteThemeScope(themesDir, "custom-a")).toBe(true);
    expect(existsSync(join(themesDir, "custom-a", "keep.png"))).toBe(true);
    expect(existsSync(join(themesDir, "custom-a", "b.png"))).toBe(true);
    expect(existsSync(join(themesDir, "current"))).toBe(false);
    // 没有草稿槽时是正常路径，不是错误
    expect(promoteThemeScope(themesDir, "custom-a")).toBe(false);
    rmSync(work, { recursive: true, force: true });
  });

  it("新增主题且 CSS 生效 → current 归位；被删主题 + 孤儿目录 → 一并清理", () => {
    const work = tempDir("pi-theme-reconcile-");
    const themesDir = themeAssetsDirFor(join(work, "agent"));
    const previous = appearanceOf([{ id: "custom-a", css: "A" }]);
    const next = appearanceOf([{ id: "custom-a", css: "A" }, { id: "custom-b", css: "B" }]);
    writeFile(themesDir, "custom-a/a.png", PNG_BYTES);
    writeFile(themesDir, "current/b.png", PNG_BYTES);
    writeFile(themesDir, "custom-orphan/x.png", PNG_BYTES); // 保存主题后取消留下的

    reconcileThemeAssetDirs(themesDir, previous, next);
    expect(existsSync(join(themesDir, "custom-b", "b.png"))).toBe(true);
    expect(existsSync(join(themesDir, "current"))).toBe(false);
    expect(existsSync(join(themesDir, "custom-orphan"))).toBe(false);

    // 删掉 custom-a → 目录一起消失
    const afterDelete = appearanceOf([{ id: "custom-b", css: "B" }]);
    reconcileThemeAssetDirs(themesDir, next, afterDelete);
    expect(existsSync(join(themesDir, "custom-a"))).toBe(false);
    expect(existsSync(join(themesDir, "custom-b"))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });

  it("切回已保存主题（当前生效不是草稿）→ 草稿槽清掉，主题目录不受影响", () => {
    const work = tempDir("pi-theme-reconcile-clear-");
    const themesDir = themeAssetsDirFor(join(work, "agent"));
    writeFile(themesDir, "current/a.png", PNG_BYTES);
    writeFile(themesDir, "custom-a/a.png", PNG_BYTES);
    const previous = appearanceOf([{ id: "custom-a", css: "A" }], "草稿 CSS");
    const next = appearanceOf([{ id: "custom-a", css: "A" }]);
    reconcileThemeAssetDirs(themesDir, previous, next);
    expect(existsSync(join(themesDir, "current"))).toBe(false);
    expect(existsSync(join(themesDir, "custom-a"))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });
});

describe("migrateInlineThemeAssets：真实形态 fixture 的读 → 迁移 → 写 → 再读", () => {
  /** 旧版真实形态：4 套主题各带 assets，加上活动主题资产。 */
  function legacyFixture(userData: string): void {
    const themes = [0, 1, 2, 3].map((index) => ({
      id: `custom-${index}`,
      name: `主题 ${index}`,
      css: `:root { --chat-bg-image: url(assets/bg-${index}.png); }`,
      assets: { [`assets/bg-${index}.png`]: dataUrl("image/png", Buffer.from(`theme-${index}`)), "fonts/x.woff2": dataUrl("font/woff2", WOFF_BYTES) }
    }));
    const settings = {
      version: 2,
      appearance: {
        theme: "system",
        themePreset: "default",
        customCss: themes[2]!.css,
        customCssAssets: { "assets/bg-2.png": dataUrl("image/png", Buffer.from("theme-2")) },
        customThemes: themes
      }
    };
    writeFileSync(settingsPath(userData), JSON.stringify(settings, null, 2), "utf8");
  }

  it("资产落盘、配置剥离、主题仍可见、CSS 能改写成协议 URL", async () => {
    const userData = tempDir("pi-theme-migrate-");
    const agentDir = join(userData, "agent");
    const themesDir = themeAssetsDirFor(agentDir);
    legacyFixture(userData);
    const before = statSync(settingsPath(userData)).size;

    // ① 读（资产按优先级合并回 appearance）
    const { raw } = readSettingsFile(userData);
    // ② 迁移（先写文件、逐个校验、全成功才剥离）
    const migration = migrateInlineThemeAssets(raw, themesDir);
    expect(migration.migrated).toBe(true);
    expect(migration.keptInline).toEqual([]);
    expect(migration.migratedAssets).toBe(9); // 4 套 × 2 + 活动资产 1
    // ③ 归一化（与真实启动路径一致）并落盘
    const settings = migrateSettings(migration.raw).settings;
    expect(settings.appearance.customThemes).toHaveLength(4);
    for (const theme of settings.appearance.customThemes) {
      expect(theme).not.toHaveProperty("assets");
      expect(theme.css).toContain("--chat-bg-image");
    }
    expect(settings.appearance.customCssAssets).toBeUndefined();
    writeSettingsFile(userData, settings, { small: true, assets: true });

    // ④ 再读：主题仍在，资产字段已消失，settings.json 明显变小
    const reread = readSettingsFile(userData);
    const rereadSettings = migrateSettings(reread.raw).settings;
    expect(rereadSettings.appearance.customThemes.map((theme) => theme.id)).toEqual(["custom-0", "custom-1", "custom-2", "custom-3"]);
    expect(rereadSettings.appearance.customCssAssets).toBeUndefined();
    const settingsText = readFileSync(settingsPath(userData), "utf8");
    const assetsText = readFileSync(appearanceAssetsPath(userData), "utf8");
    // 两个配置文件里都不再有任何内联资产；主题定义仍完整在资产文件里
    expect(settingsText).not.toContain("base64");
    expect(assetsText).not.toContain("base64");
    expect(assetsText).toContain("custom-3");
    expect(statSync(settingsPath(userData)).size).toBeLessThan(before);

    // ⑤ 资产真的在磁盘上、能被协议取到；CSS 改写成协议 URL 后逐个命中
    expect(readFileSync(join(themesDir, "custom-0", "assets", "bg-0.png"), "utf8")).toBe("theme-0");
    expect(readFileSync(join(themesDir, "custom-2", "assets", "bg-2.png"), "utf8")).toBe("theme-2");
    for (const theme of rereadSettings.appearance.customThemes) {
      const css = resolveThemeAssetUrls(theme.css, theme.id);
      const parsed = parseThemeAssetUrl(/url\("([^"]+)"\)/u.exec(css)![1]!);
      expect(parsed?.scope).toBe(theme.id);
      const response = await serveThemeAsset(parsed!, themesDir);
      expect(response.status).toBe(200);
    }
    // 活动资产的归属：CSS 命中 custom-2 → 写进 custom-2 而不是 current
    expect(existsSync(join(themesDir, "current"))).toBe(false);
    expect(readFileSync(join(themesDir, "custom-2", "assets", "bg-2.png"), "utf8")).toBe("theme-2");
    rmSync(userData, { recursive: true, force: true });
  });

  it("活动 CSS 不命中任何主题 → 活动资产进 current 草稿槽", () => {
    const userData = tempDir("pi-theme-migrate-current-");
    const themesDir = themeAssetsDirFor(join(userData, "agent"));
    writeFileSync(settingsPath(userData), JSON.stringify({
      version: 2,
      appearance: { theme: "system", customCss: "草稿 CSS", customCssAssets: { "wallpaper.png": dataUrl("image/png", PNG_BYTES) }, customThemes: [] }
    }), "utf8");

    const migration = migrateInlineThemeAssets(readSettingsFile(userData).raw, themesDir);
    expect(migration.migrated).toBe(true);
    expect(existsSync(join(themesDir, "current", "wallpaper.png"))).toBe(true);
    rmSync(userData, { recursive: true, force: true });
  });

  it("超限 / 写入不了的资产 → 完全保留内联原样（不静默丢，下次启动重试）", () => {
    const userData = tempDir("pi-theme-migrate-keep-");
    const themesDir = themeAssetsDirFor(join(userData, "agent"));
    writeFileSync(settingsPath(userData), JSON.stringify({
      version: 2,
      appearance: {
        theme: "system",
        customCss: ":root { --a: url(big.png); }",
        customThemes: [{ id: "custom-a", name: "A", css: ":root { --a: url(big.png); }", assets: { "big.png": dataUrl("image/png", Buffer.alloc(THEME_ASSET_MAX_FILE_BYTES + 1)) } }]
      }
    }), "utf8");

    const migration = migrateInlineThemeAssets(readSettingsFile(userData).raw, themesDir);
    expect(migration.migrated).toBe(false);
    expect(migration.keptInline).toEqual(["A/big.png"]);
    // raw 原样返回：资产字段仍在（下一步 migrateSettings 仍会读回，重启后重试）
    const settings = migrateSettings(migration.raw).settings;
    expect(settings.appearance.customThemes[0]?.assets?.["big.png"]).toContain("base64");
    expect(existsSync(join(themesDir, "custom-a"))).toBe(false);
    rmSync(userData, { recursive: true, force: true });
  });

  it("穿越路径 / 非 base64 / 白名单外扩展名的键保持内联（不写盘外的任何文件）", () => {
    const userData = tempDir("pi-theme-migrate-unsafe-");
    const themesDir = themeAssetsDirFor(join(userData, "agent"));
    writeFileSync(settingsPath(userData), JSON.stringify({
      version: 2,
      appearance: {
        theme: "system",
        customCss: ":root { --a: url(../../escape.png); }",
        customThemes: [{
          id: "custom-a",
          name: "A",
          css: ":root { --a: url(../../escape.png); }",
          assets: { "../../escape.png": dataUrl("image/png", PNG_BYTES), "note.txt": dataUrl("image/png", PNG_BYTES), "p.png": "data:image/png,raw-bytes" }
        }]
      }
    }), "utf8");

    const migration = migrateInlineThemeAssets(readSettingsFile(userData).raw, themesDir);
    expect(migration.migrated).toBe(false);
    expect(migration.keptInline.sort()).toEqual(["A/../../escape.png", "A/note.txt", "A/p.png"]);
    expect(existsSync(join(userData, "escape.png"))).toBe(false);
    rmSync(userData, { recursive: true, force: true });
  });

  it("没有内联资产时不动任何东西（幂等：迁移后再次启动不重写）", () => {
    const userData = tempDir("pi-theme-migrate-noop-");
    const themesDir = themeAssetsDirFor(join(userData, "agent"));
    writeFileSync(settingsPath(userData), JSON.stringify({ version: 2, appearance: { theme: "dark", customCss: "", customThemes: [{ id: "custom-a", name: "A", css: ":root {}" }] } }), "utf8");
    const migration = migrateInlineThemeAssets(readSettingsFile(userData).raw, themesDir);
    expect(migration).toEqual({ raw: expect.anything(), migrated: false, migratedAssets: 0, keptInline: [] });
    rmSync(userData, { recursive: true, force: true });
  });
});

describe("接线契约：启动迁移与保存对账都接在主进程", () => {
  const source = readFileSync(join(__dirname, "index.ts"), "utf8");

  it("loadSettings 先迁移内联资产再归一化（迁移失败保留 base64，下次启动重试）", () => {
    expect(source).toContain("migrateInlineThemeAssets(raw, themeAssetsDirFor(resolveThemeAgentDir()))");
    expect(source).toContain("const migrated = migrateSettings(themeAssetMigration.raw)");
  });

  it("appearance/settings 保存路径跑目录对账", () => {
    expect(source).toContain("reconcileThemeAssetDirs(themeAssetsDirFor(resolveThemeAgentDir()), previous.appearance, settings.appearance)");
  });
});
