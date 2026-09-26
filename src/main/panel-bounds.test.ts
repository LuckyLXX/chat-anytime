import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PANEL_BOUNDS, boundsAreReachable, normalizePanelBounds, panelBoundsPathFor, pickPanelBounds, readPanelBounds, writePanelBounds, type PanelBounds } from "./panel-bounds.js";

const primary: PanelBounds = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary: PanelBounds = { x: 1920, y: 0, width: 1280, height: 1024 };

describe("normalizePanelBounds", () => {
  it("接受完整矩形并取整", () => {
    expect(normalizePanelBounds({ x: 10.4, y: -20.6, width: 420.5, height: 560.4 })).toEqual({ x: 10, y: -21, width: 421, height: 560 });
  });

  it("夹取尺寸（写了 0 宽或 99999 高的作品不应当造出点不动的窗口）", () => {
    expect(normalizePanelBounds({ x: 0, y: 0, width: 10, height: 99999 })).toEqual({ x: 0, y: 0, width: 240, height: 1400 });
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
