import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppearanceSettings, CustomThemeDefinition, DesktopSettings, ThemeAssetMap } from "../shared/protocol";
import { appearanceForRenderer, mergeSavedAppearance, settingsForRenderer } from "./appearance-assets";
import { defaultSettings } from "./settings";

/**
 * 主题内联资产（迁移残留）的进程边界投影（2026-09-25 P1，2026-09-26 修订）。
 *
 * 2026-09-26 起资产落磁盘，这两个字段只在「超限/写盘失败」时作为残留存在。本文件钉住：
 * ① 两个方向的内联资产都不再搭车过 IPC（渲染端不消费）；
 * ② 保存方向按 id 把主进程那份残留保留回来（否则一次「保存通用设置」就把它抹掉 = 数据丢失）；
 * ③ 主题被删时残留随条目一起消失（用户明确删了这个主题）。
 */

const THEME_A: CustomThemeDefinition = { id: "theme-a", name: "霓虹", css: "--accent: red;", assets: { "a.png": "data:image/png;base64,AAAA" } };
const THEME_B: CustomThemeDefinition = { id: "theme-b", name: "海雾", css: "--accent: blue;", assets: { "b.png": "data:image/png;base64,BBBB" } };
const INLINE_ASSETS: ThemeAssetMap = { "wallpaper.png": "data:image/png;base64,WWWW" };

function appearance(patch: Partial<AppearanceSettings> = {}): AppearanceSettings {
  return { theme: "system", themePreset: "default", customCss: THEME_A.css, customThemes: [THEME_A, THEME_B], showThinking: true, showGalleryWall: true, ...patch };
}

function settings(patch: Partial<DesktopSettings> = {}): DesktopSettings {
  return { ...defaultSettings(), appearance: appearance(), ...patch };
}

describe("appearanceForRenderer：下行投影剥掉残留的内联资产", () => {
  it("每条主题都不再带 assets（残留 base64 不搭车过进程边界）", () => {
    const projected = appearanceForRenderer(appearance({ customCssAssets: INLINE_ASSETS }));
    expect(projected.customThemes).toHaveLength(2);
    for (const theme of projected.customThemes) {
      expect(theme).not.toHaveProperty("assets");
      expect(theme.id).toBeTruthy();
      expect(theme.css).toBeTruthy();
    }
  });

  it("customCssAssets 同样不下发（渲染端只按作用域拼协议 URL，不消费 base64）", () => {
    const projected = appearanceForRenderer(appearance({ customCssAssets: INLINE_ASSETS }));
    expect(projected).not.toHaveProperty("customCssAssets");
  });

  it("本来就没有残留时原样返回（不动引用）", () => {
    const clean = appearance({ customThemes: [{ id: "theme-a", name: "霓虹", css: "--accent: red;" }] });
    expect(appearanceForRenderer(clean)).toBe(clean);
    const cleanSettings = settings({ appearance: clean });
    expect(settingsForRenderer(cleanSettings)).toBe(cleanSettings);
  });

  it("不修改入参（主进程内存态必须原样保留全量资产）", () => {
    const source = appearance({ customCssAssets: INLINE_ASSETS });
    appearanceForRenderer(source);
    expect(source.customThemes[0]?.assets).toEqual(THEME_A.assets);
    expect(source.customCssAssets).toBe(INLINE_ASSETS);
  });

  it("settingsForRenderer 只动 appearance，其它字段原样透传", () => {
    const source = settings({ appearance: appearance({ customCssAssets: INLINE_ASSETS }) });
    const projected = settingsForRenderer(source);
    expect(projected.appearance.customThemes[0]).not.toHaveProperty("assets");
    expect(projected.providers).toBe(source.providers);
    expect(projected.agents).toBe(source.agents);
  });
});

describe("mergeSavedAppearance：保存方向按 id 保留主进程存的残留资产", () => {
  it("收到的主题不带 assets（普通保存）时，按 id 保留原有的那份", () => {
    const existing = appearance({ customCssAssets: INLINE_ASSETS });
    const incoming = appearanceForRenderer(existing);
    const merged = mergeSavedAppearance({ ...incoming, customCss: "--accent: pink;" }, existing);
    expect(merged.customThemes.find((theme) => theme.id === "theme-a")?.assets).toEqual(THEME_A.assets);
    expect(merged.customThemes.find((theme) => theme.id === "theme-b")?.assets).toEqual(THEME_B.assets);
    expect(merged.customCss).toBe("--accent: pink;");
    // 活动资产的残留字段也必须带回来，否则一次保存就把它抹掉了
    expect(merged.customCssAssets).toBe(INLINE_ASSETS);
  });

  it("收到的主题带了 assets 时按收到的覆盖", () => {
    const existing = appearance({ customCssAssets: INLINE_ASSETS });
    const nextAssets: ThemeAssetMap = { "new.png": "data:image/png;base64,NNNN" };
    const incoming = appearanceForRenderer(existing).customThemes.map((theme) => theme.id === "theme-a" ? { ...theme, assets: nextAssets } : theme);
    const merged = mergeSavedAppearance({ ...appearanceForRenderer(existing), customThemes: incoming }, existing);
    expect(merged.customThemes.find((theme) => theme.id === "theme-a")?.assets).toEqual(nextAssets);
    // 未携带的那条仍然保留原有资产
    expect(merged.customThemes.find((theme) => theme.id === "theme-b")?.assets).toEqual(THEME_B.assets);
  });

  it("被删掉的主题连同其残留资产一起消失（不留孤儿）", () => {
    const existing = appearance({ customCssAssets: INLINE_ASSETS });
    const incoming = appearanceForRenderer(existing);
    const merged = mergeSavedAppearance({ ...incoming, customThemes: incoming.customThemes.filter((theme) => theme.id !== "theme-b") }, existing);
    expect(merged.customThemes.map((theme) => theme.id)).toEqual(["theme-a"]);
  });

  it("新增的主题没有资产时保持没有（不凭空造一个）", () => {
    const existing = appearance({ customCssAssets: INLINE_ASSETS });
    const incoming = appearanceForRenderer(existing);
    const merged = mergeSavedAppearance({ ...incoming, customThemes: [...incoming.customThemes, { id: "theme-c", name: "新主题", css: "--accent: black;" }] }, existing);
    expect(merged.customThemes.find((theme) => theme.id === "theme-c")).not.toHaveProperty("assets");
  });

  it("往返不变量：投影 → 原样合并回来，残留资产逐字节不变", () => {
    const existing = appearance({ customCssAssets: INLINE_ASSETS });
    const merged = mergeSavedAppearance(appearanceForRenderer(existing), existing);
    expect(merged.customThemes).toEqual(existing.customThemes);
    expect(merged.customCssAssets).toBe(INLINE_ASSETS);
  });

  it("两侧都没有残留时不会凭空加字段", () => {
    const existing = appearance({ customThemes: [{ id: "theme-a", name: "霓虹", css: "--accent: red;" }] });
    const merged = mergeSavedAppearance(existing, existing);
    expect(merged).not.toHaveProperty("customCssAssets");
    expect(merged.customThemes[0]).not.toHaveProperty("assets");
  });

  it("不修改入参", () => {
    const existing = appearance({ customCssAssets: INLINE_ASSETS });
    const incoming = appearanceForRenderer(existing);
    mergeSavedAppearance(incoming, existing);
    expect(incoming.customThemes[0]).not.toHaveProperty("assets");
    expect(existing.customThemes[0]?.assets).toEqual(THEME_A.assets);
  });
});

describe("接线契约：两个下行通道都必须走投影", () => {
  const source = readFileSync(join(__dirname, "index.ts"), "utf8");

  it("bootstrap 不再原样下发 settings（否则残留 base64 又搭车回几十 MB）", () => {
    expect(source).toContain("settingsForRenderer({ ...source, providers:");
    expect(source).not.toContain("const settings: DesktopSettings = { ...source, providers:");
  });

  it("utility 初始化同样走投影（utility 不读 appearance）", () => {
    expect(source).toContain('sendToRuntime({ type: "initialize", settings: settingsForRenderer(settings)');
  });

  it("settings.save / appearance.save 走合并而非直接覆盖（否则保存即抹掉残留资产）", () => {
    expect(source).toContain("mergeSavedAppearance(command.settings.appearance, settings.appearance)");
    expect(source).toContain("mergeSavedAppearance(command.appearance, settings.appearance)");
  });

  it("资产协议与目录工作都在 shared/main 的主题资产模块（单一口径）", () => {
    expect(source).toContain("parseThemeAssetUrl(request.url)");
    expect(source).toContain("serveThemeAsset(themeAsset)");
  });
});
