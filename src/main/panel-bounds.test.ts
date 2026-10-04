import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchoredPanelBounds, DRAWER_HANDLE_SPAN, DRAWER_HANDLE_THICKNESS, MAX_PANEL_BOUNDS, PANEL_SCALE_STEP, boundsAreReachable, drawerBounds, normalizePanelBounds, panelBoundsPathFor, pickPanelBounds, readPanelBounds, scaledPanelBounds, writePanelBounds, type PanelBounds } from "./panel-bounds.js";

const primary: PanelBounds = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary: PanelBounds = { x: 1920, y: 0, width: 1280, height: 1024 };

describe("normalizePanelBounds", () => {
  it("接受完整矩形并取整", () => {
    expect(normalizePanelBounds({ x: 10.4, y: -20.6, width: 420.5, height: 560.4 })).toEqual({ x: 10, y: -21, width: 421, height: 560 });
  });

  it("夹取尺寸（写了 0 宽或 99999 高的作品不应当造出点不动的窗口）", () => {
    expect(normalizePanelBounds({ x: 0, y: 0, width: 10, height: 99999 })).toEqual({ x: 0, y: 0, width: 140, height: 1400 });
  });

  it("缺字段/非对象一律丢弃（宁可回到屏幕居中，也不要把窗口放到不知道哪里）", () => {
    expect(normalizePanelBounds(undefined)).toBeUndefined();
    expect(normalizePanelBounds([1, 2, 3, 4])).toBeUndefined();
    expect(normalizePanelBounds({ x: 1, y: 2, width: 3 })).toBeUndefined();
    expect(normalizePanelBounds({ x: Number.NaN, y: 0, width: 420, height: 560 })).toBeUndefined();
  });
});

describe("boundsAreReachable", () => {
  it("两个轴都要有足够重叠", () => {
    expect(boundsAreReachable({ x: 100, y: 100, width: 420, height: 560 }, primary)).toBe(true);
    // 只露出 20px 宽：算不可达（用户点不到，等于丢窗口）
    expect(boundsAreReachable({ x: primary.width - 20, y: 100, width: 420, height: 560 }, primary)).toBe(false);
    expect(boundsAreReachable({ x: 100, y: primary.height - 20, width: 420, height: 560 }, primary)).toBe(false);
  });
});

describe("pickPanelBounds", () => {
  it("没存过 → 按作品声明尺寸在主屏居中", () => {
    expect(pickPanelBounds(undefined, { width: 400, height: 500 }, [primary])).toEqual({ x: 760, y: 270, width: 400, height: 500 });
  });

  it("没存过也没声明 → 缺省 420×560", () => {
    expect(pickPanelBounds(undefined, undefined, [primary])).toEqual({ x: 750, y: 240, width: 420, height: 560 });
  });

  it("存过且仍落在某个显示器上 → 位置与尺寸都听用户的（手动拉过的窗口不该被作品声明改回去）", () => {
    const stored: PanelBounds = { x: 120, y: 240, width: 500, height: 700 };
    expect(pickPanelBounds(stored, { width: 420, height: 560 }, [primary])).toEqual(stored);
    expect(pickPanelBounds({ ...stored, x: 2000 }, { width: 420, height: 560 }, [primary, secondary])).toEqual({ ...stored, x: 2000 });
  });

  it("存过但显示器没了（拔掉外接屏）→ 回主屏居中，不把窗口丢到看不见的地方", () => {
    const stored: PanelBounds = { x: 2200, y: 300, width: 420, height: 560 };
    expect(pickPanelBounds(stored, undefined, [primary])).toEqual({ x: 750, y: 240, width: 420, height: 560 });
  });

  it("没有任何可用显示器信息时也要给出一个有限矩形", () => {
    const bounds = pickPanelBounds(undefined, { width: 420, height: 560 }, []);
    expect(bounds.width).toBe(420);
    expect(Number.isFinite(bounds.x)).toBe(true);
    expect(Number.isFinite(bounds.y)).toBe(true);
  });
});

describe("readPanelBounds / writePanelBounds", () => {
  it("roundtrip 后读回同一份表", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pidesktop-panels-"));
    const file = panelBoundsPathFor(dir);
    writePanelBounds(file, { g1: { x: 1, y: 2, width: 420, height: 560 } });
    expect(readPanelBounds(file)).toEqual({ g1: { x: 1, y: 2, width: 420, height: 560 } });
  });

  it("文件不存在/坏 JSON/非法条目都降级为空表（记不住坐标不是错误）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pidesktop-panels-"));
    const file = panelBoundsPathFor(dir);
    expect(readPanelBounds(file)).toEqual({});
    await writeFile(file, "{ not json");
    expect(readPanelBounds(file)).toEqual({});
    await writeFile(file, JSON.stringify({ good: { x: 0, y: 0, width: 420, height: 560 }, bad: { x: 1 } }));
    expect(readPanelBounds(file)).toEqual({ good: { x: 0, y: 0, width: 420, height: 560 } });
  });

  it("超上限时丢最先进表的（坐标表不该无限增长）", () => {
    const dir = "D:/ws";
    const map: Record<string, PanelBounds> = {};
    for (let index = 0; index < MAX_PANEL_BOUNDS + 5; index += 1) map[`g${index}`] = { x: 0, y: 0, width: 420, height: 560 };
    const file = join(tmpdir(), `pidesktop-panels-${Date.now()}.json`);
    writePanelBounds(file, map);
    const read = readPanelBounds(file);
    expect(Object.keys(read)).toHaveLength(MAX_PANEL_BOUNDS);
    expect(read.g0).toBeUndefined();
    expect(read[`g${MAX_PANEL_BOUNDS + 4}`]).toBeDefined();
    expect(panelBoundsPathFor(dir)).toBe(join(dir, "pidesktop-panels.json"));
  });
});

/**
 * 贴边抽屉的两态几何（drawerBounds 纯函数）。
 *
 * 契约：收起态是贴边窄把手（厚 DRAWER_HANDLE_THICKNESS、沿边长不超过
 * DRAWER_HANDLE_SPAN），展开态是贴边对齐、沿边居中的完整面板；两态都必须完整
 * 落在工作区内（不然抽屉会开到屏幕外，点也点不到）。
 */
const DRAWER_AREA: PanelBounds = { x: 0, y: 0, width: 1920, height: 1040 };

describe("scaledPanelBounds / anchoredPanelBounds（桌宠缩放）", () => {
  const current: PanelBounds = { x: 800, y: 600, width: 360, height: 320 };

  it("放大：等比放大并按底部中心锚点落位（猫不会浮起来）", () => {
    const next = scaledPanelBounds(current, PANEL_SCALE_STEP, DRAWER_AREA);
    expect(next.width).toBe(Math.round(360 * PANEL_SCALE_STEP));
    expect(next.height).toBe(Math.round(320 * PANEL_SCALE_STEP));
    // 中心不变（取整误差 ≤ 1px），底边不动
    expect(Math.abs(next.x + next.width / 2 - (current.x + current.width / 2))).toBeLessThanOrEqual(1);
    expect(next.y + next.height).toBe(current.y + current.height);
  });

  it("缩小：同上，且中心与底边保持", () => {
    const next = scaledPanelBounds(current, 1 / PANEL_SCALE_STEP, DRAWER_AREA);
    expect(next.width).toBe(Math.round(360 / PANEL_SCALE_STEP));
    expect(Math.abs(next.x + next.width / 2 - (current.x + current.width / 2))).toBeLessThanOrEqual(1);
    expect(next.y + next.height).toBe(current.y + current.height);
  });

  it("夹到尺寸上下限（桌宠能缩到 140×120，也放不到 1600 以上）", () => {
    const tiny = scaledPanelBounds({ x: 100, y: 100, width: 145, height: 125 }, 0.5, DRAWER_AREA);
    expect(tiny).toMatchObject({ width: 140, height: 120 });
    const huge = scaledPanelBounds({ x: 100, y: 100, width: 1500, height: 1300 }, 2, DRAWER_AREA);
    expect(huge).toMatchObject({ width: 1600, height: 1400 });
  });

  it("锚点不会把窗口推出工作区（贴边的猫放大后仍在屏内）", () => {
    const atEdge: PanelBounds = { x: 1919, y: 1039, width: 300, height: 200 };
    const next = scaledPanelBounds(atEdge, 1.5, DRAWER_AREA);
    expect(next.x + next.width).toBeLessThanOrEqual(DRAWER_AREA.width);
    expect(next.y + next.height).toBeLessThanOrEqual(DRAWER_AREA.height);
    expect(next.x).toBeGreaterThanOrEqual(0);
    expect(next.y).toBeGreaterThanOrEqual(0);
  });

  it("非法倍率当 1（不缩放，也不产生 NaN 坐标）", () => {
    expect(scaledPanelBounds(current, Number.NaN, DRAWER_AREA)).toMatchObject({ width: current.width, height: current.height });
    expect(scaledPanelBounds(current, 0, DRAWER_AREA)).toMatchObject({ width: current.width, height: current.height });
  });

  it("anchoredPanelBounds 用于重置尺寸：回到作品声明的尺寸，位置仍按底部中心对齐", () => {
    const next = anchoredPanelBounds(current, { width: 420, height: 560 }, DRAWER_AREA);
    expect(next).toMatchObject({ width: 420, height: 560 });
    expect(Math.abs(next.x + next.width / 2 - (current.x + current.width / 2))).toBeLessThanOrEqual(1);
    expect(next.y + next.height).toBe(current.y + current.height);
  });
});

describe("drawerBounds", () => {
  it("右缘：展开贴右、收起是右缘竖把手，两态沿边居中", () => {
    const { collapsed, expanded } = drawerBounds("right", { width: 320, height: 520 }, DRAWER_AREA);
    expect(expanded).toEqual({ x: 1920 - 320, y: (1040 - 520) / 2, width: 320, height: 520 });
    expect(collapsed).toEqual({ x: 1920 - DRAWER_HANDLE_THICKNESS, y: (1040 - DRAWER_HANDLE_SPAN) / 2, width: DRAWER_HANDLE_THICKNESS, height: DRAWER_HANDLE_SPAN });
  });

  it("左缘：两态都贴左缘（把手在左，面板从左缘展开）", () => {
    const { collapsed, expanded } = drawerBounds("left", { width: 320, height: 520 }, DRAWER_AREA);
    expect(expanded.x).toBe(DRAWER_AREA.x);
    expect(collapsed).toEqual({ x: 0, y: (1040 - DRAWER_HANDLE_SPAN) / 2, width: DRAWER_HANDLE_THICKNESS, height: DRAWER_HANDLE_SPAN });
  });

  it("顶缘/底缘：横向把手（厚度落在 Y 轴，沿边长度落在 X 轴）", () => {
    const top = drawerBounds("top", { width: 480, height: 400 }, DRAWER_AREA);
    expect(top.collapsed).toEqual({ x: (1920 - DRAWER_HANDLE_SPAN) / 2, y: 0, width: DRAWER_HANDLE_SPAN, height: DRAWER_HANDLE_THICKNESS });
    expect(top.expanded).toEqual({ x: (1920 - 480) / 2, y: 0, width: 480, height: 400 });
    const bottom = drawerBounds("bottom", { width: 480, height: 400 }, DRAWER_AREA);
    expect(bottom.collapsed.y).toBe(1040 - DRAWER_HANDLE_THICKNESS);
    expect(bottom.expanded.y).toBe(1040 - 400);
  });

  it("声明尺寸大过工作区时夹取（面板完整落在屏内），把手沿边长跟展开尺寸走", () => {
    const { collapsed, expanded } = drawerBounds("right", { width: 9999, height: 9999 }, DRAWER_AREA);
    expect(expanded).toEqual({ x: 0, y: 0, width: 1920, height: 1040 });
    expect(collapsed.height).toBe(DRAWER_HANDLE_SPAN);
  });

  it("未声明尺寸时用缺省面板尺寸（420×560）", () => {
    const { expanded } = drawerBounds("right", undefined, DRAWER_AREA);
    expect(expanded.width).toBe(420);
    expect(expanded.height).toBe(560);
  });

  it("工作区带偏移（副屏/任务栏）时贴边与居中都相对工作区而非原点", () => {
    const area: PanelBounds = { x: 1920, y: 100, width: 1280, height: 720 };
    const { collapsed, expanded } = drawerBounds("right", { width: 300, height: 400 }, area);
    expect(expanded.x).toBe(1920 + 1280 - 300);
    expect(expanded.y).toBe(100 + (720 - 400) / 2);
    expect(collapsed.x).toBe(1920 + 1280 - DRAWER_HANDLE_THICKNESS);
    expect(collapsed.y).toBe(100 + (720 - DRAWER_HANDLE_SPAN) / 2);
  });
});
