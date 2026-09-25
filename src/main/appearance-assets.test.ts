import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppearanceSettings, CustomThemeDefinition, DesktopSettings, ThemeAssetMap } from "../shared/protocol";
import { appearanceForRenderer, mergeSavedAppearance, settingsForRenderer } from "./appearance-assets";
import { defaultSettings } from "./settings";

/**
 * 主题重资产的进程边界投影（2026-09-25 P1）。
 *
 * 实测背景：settings.json 25.5MB，其中 appearance 25.2MB = customThemes 19.6MB
 * （4 套主题的 base64）+ customCssAssets 5.6MB；而渲染端只用得到「当前生效」那一份。
 * 本文件钉住三件事：① 下行投影剥掉主题资产且不破坏当前生效的资产；
 * ② 保存方向按 id 把主进程存的资产保留回来（否则一次「保存通用设置」就会
 *    静默抹掉全部主题资产）；③ 老数据（有主题、无 customCssAssets）靠 CSS 等值
 *    命中补齐，壁纸不会因为资产改按需取而消失。
 */

const THEME_A: CustomThemeDefinition = { id: "theme-a", name: "霓虹", css: "--accent: red;", assets: { "a.png": "data:image/png;base64,AAAA" } };
const THEME_B: CustomThemeDefinition = { id: "theme-b", name: "海雾", css: "--accent: blue;", assets: { "b.png": "data:image/png;base64,BBBB" } };
const ACTIVE_ASSETS: ThemeAssetMap = { "wallpaper.png": "data:image/png;base64,WWWW" };

function appearance(patch: Partial<AppearanceSettings> = {}): AppearanceSettings {
  return { theme: "system", themePreset: "default", customCss: THEME_A.css, customThemes: [THEME_A, THEME_B], showThinking: true, ...patch };
}

function settings(patch: Partial<DesktopSettings> = {}): DesktopSettings {
  return { ...defaultSettings(), appearance: appearance(), ...patch };
}

describe("appearanceForRenderer：下行投影剥掉搭车的主题资产", () => {
  it("每条主题都不再带 assets（19.6MB 的那部分不再过进程边界）", () => {
    const projected = appearanceForRenderer(appearance({ customCssAssets: ACTIVE_ASSETS }));
    expect(projected.customThemes).toHaveLength(2);
    for (const theme of projected.customThemes) {
      expect(theme).not.toHaveProperty("assets");
      expect(theme.id).toBeTruthy();
      expect(theme.css).toBeTruthy();
    }
  });

  it("当前生效的资产照旧保留（渲染端首帧就要用）", () => {
    const projected = appearanceForRenderer(appearance({ customCssAssets: ACTIVE_ASSETS }));
    expect(projected.customCssAssets).toBe(ACTIVE_ASSETS);
  });

  it("老数据（有主题、无 customCssAssets）按 CSS 等值命中补齐，壁纸不消失", () => {
    const projected = appearanceForRenderer(appearance());
    expect(projected.customCssAssets).toEqual(THEME_A.assets);
  });

  it("CSS 不命中任何主题时不补空对象（settings 保持干净）", () => {
    const projected = appearanceForRenderer(appearance({ customCss: "--accent: green;" }));
    expect(projected).not.toHaveProperty("customCssAssets");
  });

  it("不修改入参（主进程内存态必须原样保留全量资产）", () => {
    const source = appearance({ customCssAssets: ACTIVE_ASSETS });
    appearanceForRenderer(source);
    expect(source.customThemes[0]?.assets).toEqual(THEME_A.assets);
  });

  it("settingsForRenderer 只动 appearance，其它字段原样透传", () => {
    const source = settings();
    const projected = settingsForRenderer(source);
    expect(projected.appearance.customThemes[0]).not.toHaveProperty("assets");
    expect(projected.providers).toBe(source.providers);
    expect(projected.agents).toBe(source.agents);
  });
});

describe("mergeSavedAppearance：保存方向按 id 保留主进程存的资产", () => {
  it("收到的主题不带 assets（普通保存）时，按 id 保留原有的那份", () => {
    const existing = appearance({ customCssAssets: ACTIVE_ASSETS });
    const incoming = appearanceForRenderer(existing);
    const merged = mergeSavedAppearance({ ...incoming, customCss: "--accent: pink;" }, existing);
    expect(merged.customThemes.find((theme) => theme.id === "theme-a")?.assets).toEqual(THEME_A.assets);
    expect(merged.customThemes.find((theme) => theme.id === "theme-b")?.assets).toEqual(THEME_B.assets);
    expect(merged.customCss).toBe("--accent: pink;");
  });

  it("收到的主题带了 assets（外观页保存该主题）时按收到的覆盖", () => {
    const existing = appearance({ customCssAssets: ACTIVE_ASSETS });
    const nextAssets: ThemeAssetMap = { "new.png": "data:image/png;base64,NNNN" };
    const incoming = appearanceForRenderer(existing).customThemes.map((theme) => theme.id === "theme-a" ? { ...theme, assets: nextAssets } : theme);
    const merged = mergeSavedAppearance({ ...appearanceForRenderer(existing), customThemes: incoming }, existing);
    expect(merged.customThemes.find((theme) => theme.id === "theme-a")?.assets).toEqual(nextAssets);
    // 未携带的那条仍然保留原有资产
    expect(merged.customThemes.find((theme) => theme.id === "theme-b")?.assets).toEqual(THEME_B.assets);
  });

  it("被删掉的主题连同其资产一起消失（不留孤儿）", () => {
    const existing = appearance({ customCssAssets: ACTIVE_ASSETS });
    const incoming = appearanceForRenderer(existing);
    const merged = mergeSavedAppearance({ ...incoming, customThemes: incoming.customThemes.filter((theme) => theme.id !== "theme-b") }, existing);
    expect(merged.customThemes.map((theme) => theme.id)).toEqual(["theme-a"]);
  });

  it("新增的主题没有资产时保持没有（不凭空造一个）", () => {
    const existing = appearance({ customCssAssets: ACTIVE_ASSETS });
    const incoming = appearanceForRenderer(existing);
    const merged = mergeSavedAppearance({ ...incoming, customThemes: [...incoming.customThemes, { id: "theme-c", name: "新主题", css: "--accent: black;" }] }, existing);
    expect(merged.customThemes.find((theme) => theme.id === "theme-c")).not.toHaveProperty("assets");
  });

  it("往返不变量：投影 → 原样合并回来，主题资产逐字节不变", () => {
    const existing = appearance({ customCssAssets: ACTIVE_ASSETS });
    const merged = mergeSavedAppearance(appearanceForRenderer(existing), existing);
    expect(merged.customThemes).toEqual(existing.customThemes);
    expect(merged.customCssAssets).toBe(ACTIVE_ASSETS);
  });

  it("不修改入参", () => {
    const existing = appearance({ customCssAssets: ACTIVE_ASSETS });
    const incoming = appearanceForRenderer(existing);
    mergeSavedAppearance(incoming, existing);
    expect(incoming.customThemes[0]).not.toHaveProperty("assets");
    expect(existing.customThemes[0]?.assets).toEqual(THEME_A.assets);
  });
});

describe("接线契约：两个下行通道都必须走投影", () => {
  const source = readFileSync(join(__dirname, "index.ts"), "utf8");

  it("bootstrap 不再原样下发 settings（否则主题资产又搭车回 24MB）", () => {
    expect(source).toContain("settingsForRenderer({ ...source, providers:");
    expect(source).not.toContain("const settings: DesktopSettings = { ...source, providers:");
  });

  it("utility 初始化同样走投影（utility 不读 appearance）", () => {
    expect(source).toContain('sendToRuntime({ type: "initialize", settings: settingsForRenderer(settings)');
  });

  it("settings.save / appearance.save 走合并而非直接覆盖（否则保存即抹掉主题资产）", () => {
    expect(source).toContain("mergeSavedAppearance(command.settings.appearance, settings.appearance)");
    expect(source).toContain("mergeSavedAppearance(command.appearance, settings.appearance)");
  });
});
