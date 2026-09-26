/**
 * 面板窗口的位置尺寸记忆（纯逻辑 + 一个 JSON 文件）。
 *
 * 面板是用户天天挂在屏幕角落看的东西，每次打开都跳回屏幕正中央会很烦；但把上次
 * 的坐标无脑恢复也不行——外接屏拔掉后，存下来的 x/y 会落在已经消失的显示器上，
 * 窗口直接不可见。所以命中判定是「与某个现存工作区有足够重叠」，否则退回主屏居中。
 *
 * 落 `<agentDir>/pidesktop-panels.json`（键 = 作品 id，值 = 矩形）。与 gallery 的
 * 清单同级别：都是「用户本机的界面偏好」，不随工作区走。损坏文件降级为空表，
 * 绝不抛错（一个记坐标的文件不值得让打开面板失败）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PANEL_MAX_HEIGHT, PANEL_MAX_WIDTH, PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH, panelWindowSize, type GalleryPanelOptions } from "../shared/gallery.js";
import { writeJsonAtomic } from "./settings-store.js";

export interface PanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 存储表上限：面板作品数量本来就少，超了丢最先进表的那些。 */
export const MAX_PANEL_BOUNDS = 60;

/**
 * 判定「窗口还在屏幕上」的最小重叠：两个轴都要有这么多像素落在某个工作区内，
 * 否则视为不可见（只露出标题栏一角也算点得到，故不必要求整窗可见）。
 */
export const PANEL_MIN_VISIBLE = 48;

export function panelBoundsPathFor(agentDir: string): string {
  return join(agentDir, "pidesktop-panels.json");
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizePanelBounds(value: unknown): PanelBounds | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const x = finite(record.x);
  const y = finite(record.y);
  const width = finite(record.width);
  const height = finite(record.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: clampInt(width, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH),
    height: clampInt(height, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT)
  };
}

/** 两个矩形是否有足够重叠（用于判断存下来的坐标还落在某个现存显示器上）。 */
export function boundsAreReachable(bounds: PanelBounds, workArea: PanelBounds): boolean {
  const overlapX = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
  const overlapY = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
  return overlapX >= PANEL_MIN_VISIBLE && overlapY >= PANEL_MIN_VISIBLE;
}

/**
 * 决定这次打开用哪个矩形：存过的尺寸优先（用户手动拉过就听用户的），位置只在
 * 仍可达时沿用，否则在主显示器居中。
 *
 * `workAreas` 取 `screen.getAllDisplays().map((d) => d.workArea)`；第一个视为主屏。
 */
export function pickPanelBounds(
  stored: PanelBounds | undefined,
  options: GalleryPanelOptions | undefined,
  workAreas: readonly PanelBounds[]
): PanelBounds {
  const fallback = panelWindowSize(options);
  const usable = workAreas.filter((area) => area.width > 0 && area.height > 0);
  const primary = usable[0];
  const width = stored ? clampInt(stored.width, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH) : fallback.width;
  const height = stored ? clampInt(stored.height, PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT) : fallback.height;
  if (stored && usable.some((area) => boundsAreReachable({ ...stored, width, height }, area))) {
    return { x: stored.x, y: stored.y, width, height };
  }
  if (!primary) return { x: 0, y: 0, width, height };
  return {
    x: Math.round(primary.x + (primary.width - width) / 2),
    y: Math.round(primary.y + (primary.height - height) / 2),
    width,
    height
  };
}

/** 读坐标表：任何异常（不存在、坏 JSON、字段非法）都降级为空表。 */
export function readPanelBounds(filePath: string): Record<string, PanelBounds> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, PanelBounds> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const bounds = normalizePanelBounds(value);
    if (bounds) result[key] = bounds;
  }
  return result;
}

/** 写坐标表（原子写；失败只警告，绝不打断关窗流程）。键数超上限时丢最先进表的。 */
export function writePanelBounds(filePath: string, map: Record<string, PanelBounds>): void {
  const keys = Object.keys(map);
  const trimmed = keys.length > MAX_PANEL_BOUNDS ? keys.slice(keys.length - MAX_PANEL_BOUNDS) : keys;
  const payload: Record<string, PanelBounds> = {};
  for (const key of trimmed) payload[key] = map[key]!;
  try {
    writeJsonAtomic(filePath, payload);
  } catch {
    /* 记不住窗口位置不是错误 */
  }
}
