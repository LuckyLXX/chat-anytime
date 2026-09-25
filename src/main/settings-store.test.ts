import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appearanceAssetsPath, createSettingsPersistence, diffSettings, mergeSettingsWritePlan, readSettingsFile, sameJsonValue, settingsPath, writeJsonAtomic, writeSettingsFile } from "./settings-store.js";
import { defaultAppearance, defaultSettings, migrateSettings } from "./settings.js";
import type { AppearanceSettings, CustomThemeDefinition, DesktopSettings } from "../shared/protocol.js";

/**
 * settings 存储分层（2026-09-25 性能 P0）的回归网。
 *
 * 为什么必须有这个文件：本次改动把 settings 的**落盘格式**从单文件改成两文件，
 * 且把「每条命令无条件重写 24.8 MB」改成「脏标记 + debounce + 原子写」。两类
 * 故障都是静默且昂贵：
 *
 * - 脏标记**少报**（或深比较误判「相等」）→ 设置改了不落盘，重启回退；
 * - 脏标记**多报**（或深比较误判「不等」）→ 白写 24 MB（正是要消灭的成本）；
 * - 分层读写优先级写错 → 旧版本/新版本来回切换时 24 MB 主题与壁纸静默消失。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pidesktop-settings-store-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

const THEME: CustomThemeDefinition = { id: "theme-1", name: "主题一", css: ":root{--accent:#0af}" };
const WALLPAPER = { "wallpapers/a.png": "data:image/png;base64,AAAA" };

function themedSettings(themeIds: string[] = [THEME.id]): DesktopSettings {
  return {
    ...defaultSettings(),
    appearance: {
      ...defaultAppearance(),
      customThemes: themeIds.map((id) => ({ ...THEME, id })),
      customCssAssets: { ...WALLPAPER }
    }
  };
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** 旧格式：资产内联在 settings.json（迁移前的形态，也是旧版本 1.3.2 写的形态）。 */
function writeLegacySettings(userDataDir: string, settings: DesktopSettings): void {
  writeFileSync(settingsPath(userDataDir), JSON.stringify(settings, null, 2), "utf8");
}

describe("sameJsonValue", () => {
  it("ignores key order but catches real differences", () => {
    expect(sameJsonValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameJsonValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJsonValue({ a: 1 }, { a: 1, b: 1 })).toBe(false);
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false);
    expect(sameJsonValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameJsonValue({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    expect(sameJsonValue({ a: { b: 1 } }, { a: { b: "1" } })).toBe(false);
    // undefined 与 null 不等价（顶层缺键与显式 null 是两种状态）。
    expect(sameJsonValue({ a: undefined }, { a: null })).toBe(false);
  });

  it("compares equal strings by content rather than by reference", () => {
    // 等价 data: URL 的常见形态：运行时拼出来的字符串（V8 可能顺手归一引用，
    // 但正确性不能依赖它——`Object.is` 只是快路径，值语义必须成立）。
    const build = (payload: string): string => `data:image/png;base64,${payload}`;
    expect(sameJsonValue({ asset: build("AAAA") }, { asset: build("AAAA") })).toBe(true);
    expect(sameJsonValue({ asset: build("AAAA") }, { asset: build("BBBB") })).toBe(false);
  });

  it("only trusts object identity for non-JSON values", () => {
    const date = new Date(0);
    expect(sameJsonValue(date, date)).toBe(true);
    expect(sameJsonValue(new Date(0), new Date(0))).toBe(false);
  });
});

describe("diffSettings", () => {
  it("reports no writes for the very same object", () => {
    const settings = themedSettings();
    expect(diffSettings(settings, settings)).toEqual({ small: false, assets: false });
  });

  it("reports no writes when appearance content is identical but every reference is fresh", () => {
    // IPC 载荷的形态：`appearance` 每帧都是新对象（含新数组）。两个资产字段的
    // 深比较必须认出「内容相同」——误报一次就是白写 24 MB。
    const previous = themedSettings();
    const next: DesktopSettings = { ...previous, appearance: JSON.parse(JSON.stringify(previous.appearance)) as AppearanceSettings };
    expect(next.appearance).not.toBe(previous.appearance);
    expect(next.appearance.customThemes).not.toBe(previous.appearance.customThemes);
    expect(diffSettings(previous, next)).toEqual({ small: false, assets: false });
  });

  it("does not re-write 24 MB of assets when only a small appearance field changed", () => {
    const previous = themedSettings();
    const next: DesktopSettings = { ...previous, appearance: { ...previous.appearance, motion: false } };
    expect(diffSettings(previous, next)).toEqual({ small: true, assets: false });
  });

  it("flags asset changes on their own (small fields untouched)", () => {
    const previous = themedSettings();
    const next: DesktopSettings = { ...previous, appearance: { ...previous.appearance, customThemes: [{ ...THEME, css: ":root{--accent:#f0a}" }] } };
    expect(diffSettings(previous, next)).toEqual({ small: false, assets: true });
    // 新增 / 清空都算变化。
    expect(diffSettings(previous, { ...previous, appearance: { ...previous.appearance, customThemes: [] } }).assets).toBe(true);
    expect(diffSettings(previous, { ...previous, appearance: { ...previous.appearance, customCssAssets: undefined } }).assets).toBe(true);
  });

  it("treats empty asset values as equivalent (no write for [] / {} / absent)", () => {
    const previous: DesktopSettings = { ...defaultSettings(), appearance: { ...defaultAppearance(), customThemes: [] } };
    const next: DesktopSettings = { ...previous, appearance: { ...defaultAppearance() } };
    expect(diffSettings(previous, next)).toEqual({ small: false, assets: false });
  });

  it("flags every top-level settings key (contract: a new key must join the fixture)", () => {
    const base = defaultSettings();
    const mutations: Record<string, (settings: DesktopSettings) => DesktopSettings> = {
      version: (settings) => ({ ...settings, version: 3 as unknown as 2 }),
      thinkingLevel: (settings) => ({ ...settings, thinkingLevel: "high" }),
      accessMode: (settings) => ({ ...settings, accessMode: "workspace" }),
      providers: (settings) => ({ ...settings, providers: [...settings.providers, { id: "p1", name: "P", baseUrl: "https://example.com", models: [] }] }),
      agents: (settings) => ({ ...settings, agents: [...settings.agents, { ...settings.agents[0]!, id: "agent-2" }] }),
      currentAgentId: (settings) => ({ ...settings, currentAgentId: "agent-2" }),
      appearance: (settings) => ({ ...settings, appearance: { ...settings.appearance, showThinking: false } })
    };
    // 新增一个顶层设置字段时这里会红（要求同步补 mutation），而不是等用户发现它不落盘。
    expect(Object.keys(base).sort()).toEqual(Object.keys(mutations).sort());
    for (const [key, mutate] of Object.entries(mutations)) {
      expect(diffSettings(base, mutate(base)).small, `顶层键 ${key} 的变更未被判定为脏`).toBe(true);
    }
  });

  it("merges pending plans with OR semantics so one debounce window cannot drop a file", () => {
    expect(mergeSettingsWritePlan(undefined, { small: true, assets: false })).toEqual({ small: true, assets: false });
    expect(mergeSettingsWritePlan({ small: true, assets: false }, { small: false, assets: true })).toEqual({ small: true, assets: true });
    expect(mergeSettingsWritePlan({ small: false, assets: false }, { small: false, assets: false })).toEqual({ small: false, assets: false });
  });
});

describe("writeJsonAtomic", () => {
  it("round-trips and leaves no tmp file behind", async () => {
    const dir = await tempDir("atomic");
    const path = join(dir, "value.json");
    expect(writeJsonAtomic(path, { a: 1 })).toEqual({ atomic: true });
    expect(readJson(path)).toEqual({ a: 1 });
    writeJsonAtomic(path, { a: 2, nested: { b: [1, 2] } });
    expect(readJson(path)).toEqual({ a: 2, nested: { b: [1, 2] } });
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("settings storage layering", () => {
  it("writes assets only to appearance-assets.json and keeps settings.json small", async () => {
    const dir = await tempDir("layered");
    const settings = themedSettings();
    writeSettingsFile(dir, settings, { small: true, assets: true });

    const assets = readJson(appearanceAssetsPath(dir));
    expect(assets.customThemes).toEqual(settings.appearance.customThemes);
    expect(assets.customCssAssets).toEqual(WALLPAPER);

    const raw = readJson(settingsPath(dir));
    expect(raw.appearance.customThemes).toBeUndefined();
    expect(raw.appearance.customCssAssets).toBeUndefined();
    // 小字段一个都不能少（分层只搬走两个资产字段）。
    expect(raw.appearance.theme).toBe(settings.appearance.theme);
    expect(raw.appearance.showThinking).toBe(settings.appearance.showThinking);
    expect(raw.agents).toEqual(settings.agents);
    expect(raw.accessMode).toBe(settings.accessMode);
  });

  it("skips a no-op plan (no write at all)", async () => {
    const dir = await tempDir("noop");
    const settings = themedSettings();
    writeSettingsFile(dir, settings, { small: true, assets: true });
    const before = { settings: statSync(settingsPath(dir)).mtimeMs, assets: statSync(appearanceAssetsPath(dir)).mtimeMs };
    writeSettingsFile(dir, settings, { small: false, assets: false });
    expect(statSync(settingsPath(dir)).mtimeMs).toBe(before.settings);
    expect(statSync(appearanceAssetsPath(dir)).mtimeMs).toBe(before.assets);
  });

  it("round-trips the legacy inline format without losing assets", async () => {
    const dir = await tempDir("roundtrip");
    const settings = themedSettings(["theme-1", "theme-2"]);
    writeLegacySettings(dir, settings);
    expect(existsSync(appearanceAssetsPath(dir))).toBe(false);

    const first = readSettingsFile(dir);
    expect(first.assetsSource).toBe("inline");
    const before = migrateSettings(first.raw).settings;
    expect(before.appearance.customThemes).toHaveLength(2);
    expect(before.appearance.customCssAssets).toEqual(WALLPAPER);

    // 一次性迁移：两个文件一起写。
    writeSettingsFile(dir, before, { small: true, assets: true });

    const second = readSettingsFile(dir);
    expect(second.assetsSource).toBe("file");
    expect(migrateSettings(second.raw).settings).toEqual(before);
    // settings.json 确实摘掉了内联资产（体积级差）。
    expect(readFileSync(settingsPath(dir), "utf8")).not.toContain("data:image/png;base64,AAAA");
  });

  it("prefers the assets file when it is at least as new as settings.json", async () => {
    const dir = await tempDir("priority-file");
    writeLegacySettings(dir, themedSettings(["inline-theme"]));
    writeFileSync(appearanceAssetsPath(dir), JSON.stringify({ customThemes: [{ ...THEME, id: "file-theme" }] }), "utf8");
    await utimes(settingsPath(dir), new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    await utimes(appearanceAssetsPath(dir), new Date(1_600_000_100_000), new Date(1_600_000_100_000));

    const read = readSettingsFile(dir);
    expect(read.assetsSource).toBe("file");
    expect((read.raw as any).appearance.customThemes.map((theme: CustomThemeDefinition) => theme.id)).toEqual(["file-theme"]);
  });

  it("prefers the newer inline copy when settings.json was written after the assets file", async () => {
    const dir = await tempDir("priority-inline");
    writeLegacySettings(dir, themedSettings(["inline-theme"]));
    writeFileSync(appearanceAssetsPath(dir), JSON.stringify({ customThemes: [{ ...THEME, id: "file-theme" }] }), "utf8");
    await utimes(appearanceAssetsPath(dir), new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    await utimes(settingsPath(dir), new Date(1_600_000_100_000), new Date(1_600_000_100_000));

    const read = readSettingsFile(dir);
    expect(read.assetsSource).toBe("inline");
    expect((read.raw as any).appearance.customThemes.map((theme: CustomThemeDefinition) => theme.id)).toEqual(["inline-theme"]);
    // 读取路径绝不删除资产文件。
    expect(existsSync(appearanceAssetsPath(dir))).toBe(true);
  });

  it("uses the assets file when settings.json has no inline copy, whatever the mtimes are", async () => {
    const dir = await tempDir("priority-only-file");
    const settings = themedSettings(["file-theme"]);
    writeSettingsFile(dir, settings, { small: true, assets: true });
    // 把 settings.json 的时间推到资产文件之后（稳态：任何时候都只改了设置的小字段）。
    await utimes(appearanceAssetsPath(dir), new Date(1_600_000_000_000), new Date(1_600_000_000_000));
    await utimes(settingsPath(dir), new Date(1_600_000_100_000), new Date(1_600_000_100_000));

    const read = readSettingsFile(dir);
    expect(read.assetsSource).toBe("file");
    expect((read.raw as any).appearance.customThemes.map((theme: CustomThemeDefinition) => theme.id)).toEqual(["file-theme"]);
  });

  it("uses the inline copy when only settings.json exists", async () => {
    const dir = await tempDir("priority-only-inline");
    writeLegacySettings(dir, themedSettings(["inline-theme"]));
    const read = readSettingsFile(dir);
    expect(read.assetsSource).toBe("inline");
    expect((read.raw as any).appearance.customThemes.map((theme: CustomThemeDefinition) => theme.id)).toEqual(["inline-theme"]);
  });

  it("reports no assets at all when neither file exists", async () => {
    const dir = await tempDir("priority-none");
    const read = readSettingsFile(dir);
    expect(read.assetsSource).toBe("none");
    expect(read.raw).toBeUndefined();
    const migrated: AppearanceSettings = migrateSettings(read.raw).settings.appearance;
    expect(migrated.customThemes).toEqual([]);
    expect(migrated.customCssAssets).toBeUndefined();
  });

  it("treats an unreadable assets file as absent and falls back to the inline copy", async () => {
    const dir = await tempDir("priority-corrupt");
    writeLegacySettings(dir, themedSettings(["inline-theme"]));
    writeFileSync(appearanceAssetsPath(dir), "{not json", "utf8");
    const read = readSettingsFile(dir);
    expect(read.assetsSource).toBe("inline");
    expect((read.raw as any).appearance.customThemes.map((theme: CustomThemeDefinition) => theme.id)).toEqual(["inline-theme"]);
  });
});

describe("settings persistence scheduling", () => {
  it("debounces consecutive commands into one write (and merges both files' plans)", async () => {
    const dir = await tempDir("debounce");
    const settings = themedSettings();
    vi.useFakeTimers();
    const persistence = createSettingsPersistence({ userDataDir: dir, getSettings: () => settings, debounceMs: 300 });
    persistence.schedule({ small: true, assets: false });
    persistence.schedule({ small: false, assets: true });
    expect(existsSync(settingsPath(dir))).toBe(false);
    vi.advanceTimersByTime(299);
    expect(existsSync(settingsPath(dir))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(existsSync(settingsPath(dir))).toBe(true);
    expect(existsSync(appearanceAssetsPath(dir))).toBe(true);
  });

  it("flush() persists immediately without waiting out the debounce window", async () => {
    const dir = await tempDir("flush");
    const settings = themedSettings();
    vi.useFakeTimers();
    const persistence = createSettingsPersistence({ userDataDir: dir, getSettings: () => settings });
    persistence.schedule({ small: true, assets: false });
    persistence.flush();
    expect(existsSync(settingsPath(dir))).toBe(true);
    // flush 之后定时器不应再触发第二次写入（计划已清空）。
    const mtime = statSync(settingsPath(dir)).mtimeMs;
    vi.advanceTimersByTime(1_000);
    expect(statSync(settingsPath(dir)).mtimeMs).toBe(mtime);
  });

  it("writes nothing for a no-op plan, and nothing before settings are ready", async () => {
    const dir = await tempDir("noop-schedule");
    const settings = themedSettings();
    let current: DesktopSettings | undefined;
    const persistence = createSettingsPersistence({ userDataDir: dir, getSettings: () => current });
    persistence.schedule({ small: false, assets: false });
    persistence.flush();
    persistence.schedule({ small: true, assets: true });
    persistence.flush();
    expect(existsSync(settingsPath(dir))).toBe(false);
    current = settings;
    persistence.schedule({ small: false, assets: false });
    persistence.flush();
    expect(existsSync(settingsPath(dir))).toBe(false);
  });

  it("migrates inline assets by writing both files on the first persist", async () => {
    const dir = await tempDir("inline-migration");
    const settings = themedSettings();
    writeLegacySettings(dir, settings);
    const persistence = createSettingsPersistence({ userDataDir: dir, getSettings: () => settings });
    persistence.markInlineAssets();
    // 只请求 small：迁移必须把资产一起写出去，否则摘掉内联即丢数据。
    persistence.writeNow({ small: true, assets: false });
    expect(existsSync(appearanceAssetsPath(dir))).toBe(true);
    expect(readJson(appearanceAssetsPath(dir)).customThemes).toEqual(settings.appearance.customThemes);
    const read = readSettingsFile(dir);
    expect(read.assetsSource).toBe("file");
    expect(migrateSettings(read.raw).settings.appearance.customThemes).toEqual(settings.appearance.customThemes);
  });
});
