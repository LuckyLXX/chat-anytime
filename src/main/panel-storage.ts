/**
 * 面板作品的数据治理（main 进程，2026-10-10）：用量量测与按 origin 清空。
 *
 * 背景：面板窗口改由自定义协议承载后，每个作品的存储落在**固定 origin**
 * `pidesktop-file://w-<作品>`（见 panel-protocol.ts）。数据在 Chromium profile 里，
 * 用户看不见也摸不到，所以必须由平台给出两个入口：
 *  - **用量**：在作品自己的 origin 上加载平台自带的量测页（`__pidesktop_measure.html`），
 *    页内逐键量 localStorage 并读 `navigator.storage.estimate()`；
 *  - **清空**：`clearStorageData({ origin })` —— 只清这一个作品（真机探针已验证不会
 *    误伤别的作品），作品被删除时也走这里。
 *
 * 量测刻意不依赖作品代码：作品写坏了、入口 404 了，用户仍然要能看到并清掉数据。
 * 因此量测页是平台页面，而不是作品自己的某个页面；面板窗口开着就复用它
 * （省一次窗口创建、也保证读到的就是那个页面正在用的存储）。
 *
 * 依赖全部注入（不引 Electron 类型）：纯逻辑可在 vitest 里跑，Electron 一侧由
 * index.ts 装配（`session.defaultSession.clearStorageData` / 隐藏窗口工厂）。
 */

import { PANEL_MEASURE_PAGE } from "../shared/panel.js";
import { PREVIEW_FILE_SCHEME, panelWorkHost, panelWorkUrl } from "../shared/protocol.js";
import type { GalleryDataClearResult, GalleryDataResult, GalleryDataUsage } from "../shared/gallery.js";
import { PANEL_MEASURE_SCRIPT } from "./panel-protocol.js";

/** 清空时覆盖的存储类型（与 Chromium 的 storage 名对齐）。 */
export const PANEL_DATA_STORAGES = ["localstorage", "indexdb", "cachestorage", "serviceworkers"] as const;

/** 量测页轮询：脚本是同步开跑的，正常 1 次就够；轮询只是防空窗/慢机。 */
export const PANEL_DATA_POLL_MS = 150;
export const PANEL_DATA_POLL_ATTEMPTS = 20;

/** 只用到 executeJavaScript 这一件事（注入后可直接假件）。 */
export interface PanelDataWebContents {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

export interface PanelDataDeps {
  /** 已开着的面板窗口的 webContents（按 appId）；没有就开隐藏窗口。 */
  openWebContents?(appId: string): PanelDataWebContents | undefined;
  /** 开一个隐藏窗口加载量测页；打不开返回 undefined（量测降级为「用量未知」）。 */
  createMeasureWindow?(url: string): Promise<{ contents: PanelDataWebContents; close(): void } | undefined>;
  /** 按 origin 清存储（index.ts 传 defaultSession.clearStorageData）。 */
  clearOrigin?(origin: string, storages: readonly string[]): Promise<void>;
  sleep?(ms: number): Promise<void>;
}

/** 作品数据的 origin：无端口，所以跨启动稳定，也永不与别的作品共用。 */
export function panelStorageOrigin(appId: string): string {
  return `${PREVIEW_FILE_SCHEME}://${panelWorkHost(appId)}`;
}

/** 量测页地址（该作品 origin 上的平台自带页面）。 */
export function panelMeasureUrl(appId: string): string {
  return panelWorkUrl(panelWorkHost(appId), PANEL_MEASURE_PAGE);
}

/**
 * 归一化量测页写回的结果（纯函数）。形状不对一律返回 undefined——调用方降级成
 * 「用量未知」，绝不把不可信结构直接塞进 UI。
 */
export function parsePanelDataProbe(value: unknown): Omit<GalleryDataUsage, "origin"> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const localStorageBytes = byteCount(raw.localStorageBytes);
  if (localStorageBytes === undefined) return undefined;
  const keys: { key: string; bytes: number }[] = [];
  if (Array.isArray(raw.keys)) {
    for (const entry of raw.keys) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const bytes = byteCount(item.bytes);
      if (typeof item.key !== "string" || bytes === undefined) continue;
      keys.push({ key: item.key, bytes });
    }
  }
  // 先排序再截断（量测页已经排过序并截过，这里兜住「页面没截」的情况）。
  const top = keys.sort((left, right) => right.bytes - left.bytes).slice(0, 8);
  const usage: Omit<GalleryDataUsage, "origin"> = { localStorageBytes, keys: top };
  const storageBytes = byteCount(raw.storageBytes);
  const quotaBytes = byteCount(raw.quotaBytes);
  if (storageBytes !== undefined) usage.storageBytes = storageBytes;
  if (quotaBytes !== undefined) usage.quotaBytes = quotaBytes;
  if (typeof raw.persisted === "boolean") usage.persisted = raw.persisted;
  if (Array.isArray(raw.databaseNames)) {
    const names = raw.databaseNames.filter((name): name is string => typeof name === "string");
    if (names.length > 0) usage.databaseNames = names;
  }
  return usage;
}

/** 量测一个作品的数据用量：优先复用已开着的面板窗口，否则开隐藏窗口量完即关。 */
export async function measurePanelData(appId: string, deps: PanelDataDeps): Promise<GalleryDataResult> {
  const origin = panelStorageOrigin(appId);
  const reused = deps.openWebContents?.(appId);
  let opened: { contents: PanelDataWebContents; close(): void } | undefined;
  if (!reused) {
    opened = await deps.createMeasureWindow?.(panelMeasureUrl(appId)).catch(() => undefined);
    if (!opened) return { ok: false, message: "打不开该作品的数据量测页（面板可能已失效）" };
  }
  const contents = reused ?? opened!.contents;
  try {
    // 复用面板页时必须自己注入（那页上是作品自己的代码，没有量测脚本）；
    // 注入失败不致命——量测页自己会跑脚本，接着轮询就知道到底有没有结果。
    if (reused) await contents.executeJavaScript(PANEL_MEASURE_SCRIPT, true).catch(() => undefined);
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < PANEL_DATA_POLL_ATTEMPTS; attempt += 1) {
      const value = await contents.executeJavaScript("window.__pidesktopData ?? null", true).catch(() => null);
      const parsed = parsePanelDataProbe(value);
      if (parsed) return { ok: true, usage: { origin, ...parsed } };
      await sleep(PANEL_DATA_POLL_MS);
    }
    return { ok: false, message: "数据量测没有回结果（该作品可能拦了脚本或页面未加载）" };
  } finally {
    try {
      opened?.close();
    } catch {
      /* 关窗失败不影响结果 */
    }
  }
}

/** 清空一个作品的数据。只清它自己的 origin（真机探针已验证别的作品不受影响）。 */
export async function clearPanelData(appId: string, deps: PanelDataDeps): Promise<GalleryDataClearResult> {
  const origin = panelStorageOrigin(appId);
  if (!deps.clearOrigin) return { ok: false, message: "当前环境不支持清空作品数据" };
  try {
    await deps.clearOrigin(origin, PANEL_DATA_STORAGES);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: `清空失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function byteCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}
