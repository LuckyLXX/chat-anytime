import { describe, expect, it } from "vitest";
import { PANEL_MEASURE_SCRIPT } from "./panel-protocol.js";
import { PANEL_DATA_STORAGES, clearPanelData, measurePanelData, panelMeasureUrl, panelStorageOrigin, parsePanelDataProbe, type PanelDataDeps } from "./panel-storage.js";

/**
 * 面板数据的 origin / 量测 / 清空（2026-10-10）。
 *
 * 三条不能松的契约：① origin 必须**无端口、由作品 id 唯一决定**（这就是「数据不再
 * 随重启丢」本身）；② 量测失败要降级成 ok:false + 原因，绝不抛错、绝不污染 UI；
 * ③ 清空只传这一个作品的 origin 与白名单存储类型（清错 = 用户数据没了）。
 */

describe("panelStorageOrigin", () => {
  it("无端口、由作品 id 唯一决定", () => {
    expect(panelStorageOrigin("g-0b5c16e7f1e9")).toBe("pidesktop-file://w-g-0b5c16e7f1e9");
    expect(panelStorageOrigin("g-0b5c16e7f1e9")).not.toMatch(/:\d/u);
    expect(panelStorageOrigin("g-0b5c16e7f1e9")).not.toBe(panelStorageOrigin("g-ff05d72161ae"));
    expect(panelMeasureUrl("g-abc")).toBe("pidesktop-file://w-g-abc/__pidesktop_measure.html");
  });
});

describe("parsePanelDataProbe", () => {
  it("归一化合法结果并按占用排序键", () => {
    const usage = parsePanelDataProbe({
      origin: "pidesktop-file://w-g-abc",
      localStorageBytes: 2048,
      keys: [
        { key: "small", bytes: 10 },
        { key: "big", bytes: 2000 }
      ],
      storageBytes: 4096,
      quotaBytes: 1073741824,
      persisted: true,
      databaseNames: ["weave", "kv"]
    });
    expect(usage).toEqual({
      localStorageBytes: 2048,
      keys: [
        { key: "big", bytes: 2000 },
        { key: "small", bytes: 10 }
      ],
      storageBytes: 4096,
      quotaBytes: 1073741824,
      persisted: true,
      databaseNames: ["weave", "kv"]
    });
  });

  it("形状不对一律 undefined（坏数据不进 UI）", () => {
    for (const value of [undefined, null, "x", 42, {}, { localStorageBytes: -1 }, { localStorageBytes: Number.NaN }, { keys: [] }]) {
      expect(parsePanelDataProbe(value)).toBeUndefined();
    }
  });

  it("丢掉坏的键项而不是整份作废，并截到 8 个", () => {
    const keys = Array.from({ length: 12 }, (_, index) => ({ key: `k${index}`, bytes: index + 1 }));
    const usage = parsePanelDataProbe({ localStorageBytes: 100, keys: [...keys, { key: 3, bytes: 1 }, null] });
    expect(usage?.keys).toHaveLength(8);
    expect(usage?.keys[0]).toEqual({ key: "k11", bytes: 12 });
  });
});

describe("measurePanelData", () => {
  function depsWith(value: unknown, overrides: Partial<PanelDataDeps> = {}): PanelDataDeps & { closed: number; urls: string[] } {
    const state = { closed: 0, urls: [] as string[] };
    return {
      ...state,
      createMeasureWindow: async (url) => {
        state.urls.push(url);
        return {
          contents: { executeJavaScript: async () => value },
          close: () => {
            state.closed += 1;
          }
        };
      },
      sleep: async () => {},
      get closed() {
        return state.closed;
      },
      get urls() {
        return state.urls;
      },
      ...overrides
    } as PanelDataDeps & { closed: number; urls: string[] };
  }

  it("优先复用已开着的面板窗口：先注入量测脚本，再读结果（不另开窗）", async () => {
    const codes: string[] = [];
    const result = await measurePanelData("g-abc", {
      openWebContents: () => ({
        executeJavaScript: async (code: string) => {
          codes.push(code);
          // 注入调用返回的是脚本自身的求值结果（被忽略），轮询调用才读回数据。
          return code === PANEL_MEASURE_SCRIPT ? undefined : { localStorageBytes: 12, keys: [] };
        }
      }),
      createMeasureWindow: async () => {
        throw new Error("不该走到这里");
      },
      sleep: async () => {}
    });
    expect(result).toEqual({ ok: true, usage: { origin: "pidesktop-file://w-g-abc", localStorageBytes: 12, keys: [] } });
    expect(codes[0]).toBe(PANEL_MEASURE_SCRIPT);
    expect(codes.length).toBeGreaterThan(1);
  });

  it("注入失败不致命（量测页自己会跑脚本）：继续轮询就能拿到结果", async () => {
    let call = 0;
    const result = await measurePanelData("g-abc", {
      openWebContents: () => ({
        executeJavaScript: async () => {
          call += 1;
          if (call === 1) throw new Error("Cannot execute script");
          return { localStorageBytes: 7, keys: [] };
        }
      }),
      sleep: async () => {}
    });
    expect(result.ok).toBe(true);
  });

  it("没有面板窗口时开隐藏窗口量测，并在结束后关掉它", async () => {
    const deps = depsWith({ localStorageBytes: 5, keys: [{ key: "a", bytes: 5 }] });
    const result = await measurePanelData("g-abc", deps);
    expect(result.ok).toBe(true);
    expect(deps.urls).toEqual(["pidesktop-file://w-g-abc/__pidesktop_measure.html"]);
    expect(deps.closed).toBe(1);
  });

  it("量测页没回结果时 ok:false + 原因（不抛错、也要关窗）", async () => {
    const deps = depsWith(undefined);
    const result = await measurePanelData("g-abc", deps);
    expect(result).toEqual({ ok: false, message: expect.stringContaining("没有回结果") });
    expect(deps.closed).toBe(1);
  });

  it("量测窗口打不开时也为 ok:false（而不是崩掉对话框）", async () => {
    const result = await measurePanelData("g-abc", { createMeasureWindow: async () => undefined, sleep: async () => {} });
    expect(result.ok).toBe(false);
  });

  it("executeJavaScript 抛错同样降级（面板已销毁等场景）", async () => {
    const result = await measurePanelData("g-abc", {
      createMeasureWindow: async () => ({
        contents: {
          executeJavaScript: async () => {
            throw new Error("webContents destroyed");
          }
        },
        close: () => {}
      }),
      sleep: async () => {}
    });
    expect(result.ok).toBe(false);
  });
});

describe("clearPanelData", () => {
  it("只清这一个作品的 origin，且存储类型来自白名单", async () => {
    const calls: { origin: string; storages: readonly string[] }[] = [];
    const result = await clearPanelData("g-abc", {
      clearOrigin: async (origin, storages) => {
        calls.push({ origin, storages });
      }
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ origin: "pidesktop-file://w-g-abc", storages: PANEL_DATA_STORAGES }]);
    expect(PANEL_DATA_STORAGES).toContain("localstorage");
    expect(PANEL_DATA_STORAGES).toContain("indexdb");
  });

  it("失败回 ok:false + 原因；没有清理能力时也如实说", async () => {
    expect(await clearPanelData("g-abc", {})).toEqual({ ok: false, message: expect.stringContaining("不支持") });
    const failed = await clearPanelData("g-abc", {
      clearOrigin: async () => {
        throw new Error("EBUSY");
      }
    });
    expect(failed).toEqual({ ok: false, message: expect.stringContaining("EBUSY") });
  });
});
