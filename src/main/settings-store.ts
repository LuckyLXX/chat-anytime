import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AppearanceSettings, CustomThemeDefinition, DesktopSettings, ThemeAssetMap } from "../shared/protocol.js";

/**
 * settings 的存储分层与写入纪律（2026-09-25 性能 P0）。
 *
 * 为什么分层：`appearance.customThemes` + `appearance.customCssAssets` 曾经是内联
 * base64 素材，实测 24.8 MB / 25.5 MB（占 99.1%）。2026-09-26 起主题资产落成磁盘文件
 * （`<agentDir>/pidesktop-themes/<scope>/`），这两个字段只剩「超限/写盘失败的迁移残留」；
 * 分层本身仍然保留：旧版本/未迁移完的数据随时可能把它们带回来，而当时的分层解决了
 * 真实痛点（旧实现每次用户命令都 `stringify(settings, null, 2)` + 全量重写 ≈170 ms 主进程
 * 阻塞，而 `session.open` 只改 `agentWorkspaces` 的几十字节）：
 *
 * - `settings.json`          全部字段，但两个资产字段**不写入**
 * - `appearance-assets.json` 装 `{ customThemes, customCssAssets? }`——语义已是「主题定义文件」
 *
 * 内存里的 `settingsCache` 形状完全不变（兼容字段照旧读回），所以
 * `migrateSettings` / bootstrap / 协议 / 渲染端零改动。
 *
 * 读取优先级（**必须按此实现**，否则旧版本会静默抹掉新写的主题）：
 *
 * 1. 读 `settings.json` 得 base。
 * 2. `appearance-assets.json` 存在且可解析 → 记 A（并取其 mtime）。
 * 3. base 的 `appearance` 里这两个键存在 → 记 I（内联，旧格式或旧版本刚写过）。
 * 4. A 存在 且（I 不存在 或 `mtime(A) >= mtime(settings.json)`）→ 用 A；
 *    否则 I 存在 → 用 I（尊重最新写入者：旧版本刚改过主题时吸收其结果）；
 *    都没有 → 无资产。
 * 5. 读取路径**绝不删除** `appearance-assets.json`。
 *
 * 于是任何一侧都不会静默丢数据：新版本写分层 → 旧版本之后重建内联 → 新版本
 * 再读时按 mtime 吸收回来；反之亦然。旧格式的手动恢复办法：把
 * `appearance-assets.json` 的两个字段合并回 `settings.json` 的 `appearance`。
 */

/** 由本模块负责剥离/合并的两个资产字段（唯一事实来源）。 */
const APPEARANCE_ASSET_KEYS = ["customThemes", "customCssAssets"] as const;

/** 资产字段的载荷形状：只装非空值，空数组/空对象不落键。 */
export interface AppearanceAssets {
  customThemes?: CustomThemeDefinition[];
  customCssAssets?: ThemeAssetMap;
}

/** 本次读到的资产来自哪里。 */
export type AppearanceAssetsSource = "file" | "inline" | "none";

export interface SettingsFileRead {
  /** settings.json 的解析结果（资产已按优先级合并回 `appearance`）；缺失/损坏为 undefined。 */
  raw: unknown;
  assetsSource: AppearanceAssetsSource;
}

/** 落盘计划：small = `settings.json`（小字段），assets = `appearance-assets.json`。 */
export interface SettingsWritePlan {
  small: boolean;
  assets: boolean;
}

export function settingsPath(userDataDir: string): string {
  return join(userDataDir, "settings.json");
}

export function appearanceAssetsPath(userDataDir: string): string {
  return join(userDataDir, "appearance-assets.json");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * JSON 值语义的精确深比较。
 *
 * - 键集合顺序无关（逐键 hasOwnProperty + 递归）；
 * - 字符串走 `Object.is`（V8 对等长字符串即 memcmp 值语义）；
 * - 非普通对象（Date/Map…）不是 JSON 值，只认同一引用；
 * - **不能**用 `JSON.stringify` 比较：键序不同的等价对象会被误判为变化
 *   （资产多报一次 = 白写 24 MB，正是要消灭的成本）。
 */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameJsonValue(item, right[index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]));
}

/** 只保留非空的资产字段：`[]` / `{}` / 缺省一律视作「无资产」，三者等价。 */
function appearanceAssetsOf(appearance: unknown): AppearanceAssets {
  const source = isPlainRecord(appearance) ? appearance : undefined;
  const assets: AppearanceAssets = {};
  const themes = source?.customThemes;
  if (Array.isArray(themes) && themes.length > 0) assets.customThemes = themes as CustomThemeDefinition[];
  const cssAssets = source?.customCssAssets;
  if (isPlainRecord(cssAssets) && Object.keys(cssAssets).length > 0) assets.customCssAssets = cssAssets as ThemeAssetMap;
  return assets;
}

/** 取出记录里**存在**的资产键（原样，不做值校验——归一化交给 migrateSettings）。 */
function pickAssetKeys(source: unknown): AppearanceAssets | undefined {
  if (!isPlainRecord(source)) return undefined;
  const picked: Record<string, unknown> = {};
  let present = false;
  for (const key of APPEARANCE_ASSET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      picked[key] = source[key];
      present = true;
    }
  }
  return present ? (picked as AppearanceAssets) : undefined;
}

function mtimeMsOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 内联资产候选是否真的带东西。
 * 为什么必须单独判：迁移之后旧版本（看不到主题的那版）任何一次保存都会把
 * `customThemes: []` 写回 settings.json 且 mtime 变新，而合并规则是「最新写入者
 * 优先」——空列表会因此压过资产文件，主题在**新版本里也**看起来没了（数据还在
 * appearance-assets.json 里，但对用户就是「主题消失」）。所以空的内联候选一律
 * 不当候选；真的想把主题清空，走新版本的写入路径（资产文件会被同步写成空）。
 */
function hasAssetPayload(assets: AppearanceAssets | undefined): boolean {
  if (!assets) return false;
  const themes = (assets as Record<string, unknown>).customThemes;
  if (Array.isArray(themes) && themes.length > 0) return true;
  const cssAssets = (assets as Record<string, unknown>).customCssAssets;
  if (isPlainRecord(cssAssets) && Object.keys(cssAssets).length > 0) return true;
  return false;
}

/**
 * 读 settings（含资产合并）。合并是**浅克隆**：不修改入参对象，也不在解析结果
 * 上做归一化——归一化仍是 `migrateSettings` 的唯一职责。
 */
export function readSettingsFile(userDataDir: string): SettingsFileRead {
  const base = readJsonFile(settingsPath(userDataDir));
  const baseTime = mtimeMsOf(settingsPath(userDataDir));
  const assetsFile = readJsonFile(appearanceAssetsPath(userDataDir));
  const assetsTime = mtimeMsOf(appearanceAssetsPath(userDataDir));
  const fileAssets = isPlainRecord(assetsFile) ? pickAssetKeys(assetsFile) : undefined;
  const inlineRaw = isPlainRecord(base) ? pickAssetKeys(base.appearance) : undefined;
  const inlineAssets = hasAssetPayload(inlineRaw) ? inlineRaw : undefined;

  let chosen: AppearanceAssets | undefined;
  let assetsSource: AppearanceAssetsSource = "none";
  if (fileAssets && (inlineAssets === undefined || (baseTime !== undefined && assetsTime !== undefined && assetsTime >= baseTime))) {
    chosen = fileAssets;
    assetsSource = "file";
  } else if (inlineAssets) {
    chosen = inlineAssets;
    assetsSource = "inline";
  }

  return { raw: mergeAssets(base, chosen), assetsSource };
}

/** 把选定的资产合并回 `raw.appearance`（浅克隆；选定资产没有的键从 appearance 上删掉）。 */
function mergeAssets(raw: unknown, chosen: AppearanceAssets | undefined): unknown {
  if (chosen === undefined) return raw;
  const base = isPlainRecord(raw) ? raw : {};
  const appearance = isPlainRecord(base.appearance) ? { ...base.appearance } : {};
  for (const key of APPEARANCE_ASSET_KEYS) {
    if (Object.prototype.hasOwnProperty.call(chosen, key)) appearance[key] = (chosen as Record<string, unknown>)[key];
    else delete appearance[key];
  }
  return { ...base, appearance };
}

/**
 * 脏标记判定。`previous` 必须是进入 `updateSettings` 的 switch **之前**的浅快照
 * （`{ ...settings }`，引用级别，零成本）。
 *
 * - `small`：除 `appearance` 外的所有顶层键逐个 `Object.is`（字符串是值比较天然
 *   正确；对象/数组引用不同时**多报**，最多多写 0.2 MB，宁多写不少写）；
 *   `appearance` 单独比较：排除两个资产字段后逐键 `Object.is` + 深比较兜底
 *   （资产以外的部分只有几个小字段，深比较是微秒级，且能识别「内容相同但引用
 *   不同」的 IPC 载荷 → 不写）。
 * - `assets`：两个资产字段的**精确**深比较。**必须精确**——多报就白写 24 MB
 *   （正是要消灭的成本），少报就丢数据。代价实测：customThemes（19.6 MB）2 ms /
 *   customCssAssets（5.6 MB）18 ms，且只在 `previous.appearance !== settings.appearance`
 *   （即 settings.save / appearance.save）时才需要——其它命令早退为 0 ms。
 */
export function diffSettings(previous: DesktopSettings, next: DesktopSettings): SettingsWritePlan {
  let small = false;
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === "appearance") continue;
    if (!Object.is((previous as unknown as Record<string, unknown>)[key], (next as unknown as Record<string, unknown>)[key])) {
      small = true;
      break;
    }
  }
  if (!small) small = !appearanceSmallEqual(previous.appearance, next.appearance);
  const assets = previous.appearance !== next.appearance
    && !sameJsonValue(appearanceAssetsOf(previous.appearance), appearanceAssetsOf(next.appearance));
  return { small, assets };
}

/** `appearance` 去掉两个资产字段后的等价判定。 */
function appearanceSmallEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if ((APPEARANCE_ASSET_KEYS as readonly string[]).includes(key)) continue;
    const leftValue = left[key];
    const rightValue = right[key];
    if (Object.is(leftValue, rightValue)) continue;
    if (!sameJsonValue(leftValue, rightValue)) return false;
  }
  return true;
}

/**
 * 原子写（同目录 tmp + `renameSync` 覆盖）。旧实现是原地截断写，
 * 一次半写崩溃 + `readJson` 吞异常回落默认值 = 静默清空 24 MB 主题。
 * rename 失败（少见：被杀软/文件锁占用）回退直接写，并在返回值里如实标记。
 */
export function writeJsonAtomic(path: string, value: unknown): { atomic: boolean } {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(value, null, 2);
  const tempPath = `${path}.${process.pid}.${tempWriteCounter++}.tmp`;
  try {
    writeFileSync(tempPath, text, "utf8");
    renameSync(tempPath, path);
    return { atomic: true };
  } catch {
    try {
      unlinkSync(tempPath);
    } catch {
      /* tmp 可能压根没建起来 */
    }
    writeFileSync(path, text, "utf8");
    return { atomic: false };
  }
}

let tempWriteCounter = 0;

/** `settings.json` 的载荷：保持键顺序，只剥掉两个资产字段。 */
function settingsPayload(settings: DesktopSettings): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key !== "appearance") {
      payload[key] = value;
      continue;
    }
    const appearance = { ...((value ?? {}) as Record<string, unknown>) };
    for (const assetKey of APPEARANCE_ASSET_KEYS) delete appearance[assetKey];
    payload[key] = appearance;
  }
  return payload;
}

/**
 * 按计划落盘。顺序很重要：**先写资产文件再写 settings.json**——反过来一旦在两步
 * 之间崩溃，`settings.json`（新 mtime）已不含内联资产、资产文件还是旧的 → 丢数据。
 */
export function writeSettingsFile(userDataDir: string, settings: DesktopSettings, plan: SettingsWritePlan): void {
  if (plan.assets) writeJsonAtomic(appearanceAssetsPath(userDataDir), appearanceAssetsOf(settings.appearance));
  if (plan.small) writeJsonAtomic(settingsPath(userDataDir), settingsPayload(settings));
}

/** 脏标记合并：两个计划逐位取或（debounce 窗口内的多次命令合成一次落盘）。 */
export function mergeSettingsWritePlan(pending: SettingsWritePlan | undefined, next: SettingsWritePlan): SettingsWritePlan {
  return {
    small: (pending?.small ?? false) || next.small,
    assets: (pending?.assets ?? false) || next.assets
  };
}

export interface SettingsPersistence {
  /**
   * 标记「当前 `settings.json` 里内联着资产」（`loadSettings` 读到
   * `assetsSource === "inline"` 时调用）：下次落盘**两个文件一起写**做一次性迁移
   * ——只摘内联会让 24 MB 素材无处可去。
   */
  markInlineAssets(): void;
  /** 立即落盘（首启初始化、以及 `flush()` 的实际写入口）。 */
  writeNow(plan: SettingsWritePlan): void;
  /** 合并 + debounce（默认 300 ms）后落盘。 */
  schedule(plan: SettingsWritePlan): void;
  /** 取消防抖并立即把待写计划落盘；正常退出（before-quit）必须调用。 */
  flush(): void;
}

/**
 * settings 落盘调度器（脏标记 + debounce + 分层 + 原子写）。
 *
 * 为什么不是每条命令都写：旧实现无条件 `stringify(24.8 MB)` + 全量重写，
 * `session.open` 只改几十字节却要阻塞主进程 ≈170 ms——「切换会话/助手卡」的
 * 第一号成因。现在只有真变了才写，且只写变的那一部分。
 *
 * 取舍：debounce 窗口内的改动在**异常**崩溃时可能丢最后一次（与主流应用同量级）；
 * 正常退出由 `before-quit → flush()` 兜底。
 */
export function createSettingsPersistence(options: {
  userDataDir: string;
  /** 当前内存 settings（未就绪时返回 undefined → 本次不写）。 */
  getSettings: () => DesktopSettings | undefined;
  debounceMs?: number;
}): SettingsPersistence {
  const debounceMs = options.debounceMs ?? 300;
  let pending: SettingsWritePlan | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inlineAssets = false;

  const writeNow = (plan: SettingsWritePlan): void => {
    const settings = options.getSettings();
    if (!settings) return;
    const target: SettingsWritePlan = inlineAssets ? { small: true, assets: true } : plan;
    inlineAssets = false;
    if (!target.small && !target.assets) return;
    writeSettingsFile(options.userDataDir, settings, target);
  };

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    const plan = pending;
    pending = undefined;
    if (!plan) return;
    writeNow(plan);
  };

  return {
    markInlineAssets: () => { inlineAssets = true; },
    writeNow,
    schedule: (plan) => {
      pending = mergeSettingsWritePlan(pending, plan);
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        flush();
      }, debounceMs);
    },
    flush
  };
}
