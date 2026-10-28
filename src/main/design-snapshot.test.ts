import { describe, expect, it } from "vitest";
import { fitViewport, resolveDesignSnapshotInput } from "./design-snapshot.js";

describe("fitViewport（设计导出缩略图视口适配）", () => {
  it("内容不超上限时 1:1 视口", () => {
    expect(fitViewport(1440, 900)).toEqual({ width: 1440, height: 900, zoom: 1 });
    expect(fitViewport(1600, 1600)).toEqual({ width: 1600, height: 1600, zoom: 1 });
  });

  it("超宽多画板按比例缩进上限，zoom < 1", () => {
    expect(fitViewport(3200, 1000)).toEqual({ width: 1600, height: 500, zoom: 0.5 });
    // 高度是约束边时同理。
    const fit = fitViewport(1000, 3200);
    expect(fit.zoom).toBe(0.5);
    expect(fit.height).toBe(1600);
    expect(fit.width).toBe(500);
  });

  it("非法尺寸回落缺省画布并夹取最小视口", () => {
    expect(fitViewport(0, -5)).toEqual({ width: 1440, height: 900, zoom: 1 });
    expect(fitViewport(Number.NaN, Number.POSITIVE_INFINITY).width).toBeGreaterThanOrEqual(320);
    const tiny = fitViewport(1, 1);
    expect(tiny.width).toBeGreaterThanOrEqual(320);
    expect(tiny.height).toBeGreaterThanOrEqual(240);
  });
});

describe("resolveDesignSnapshotInput（缩略图三输入）", () => {
  it("url 优先（server 页面 / 占位封面的 data URL）", () => {
    expect(resolveDesignSnapshotInput({ url: "http://localhost:5173", htmlPath: "C:/ws/a.html" })).toEqual({ kind: "page", url: "http://localhost:5173" });
  });

  it("htmlPath → file:// URL（design 导出与作品入口的旧路径保持不变）", () => {
    expect(resolveDesignSnapshotInput({ htmlPath: "C:/ws/a.html" })).toEqual({ kind: "page", url: "file:///C:/ws/a.html" });
  });

  it("imagePath → 直接图片（显式封面 / 入口图）", () => {
    expect(resolveDesignSnapshotInput({ imagePath: "C:/ws/cover.png" })).toEqual({ kind: "image", path: "C:/ws/cover.png" });
  });

  it("三选一全空 → undefined（调用方回 ok:false，而不是把空路径丢给 loadURL）", () => {
    expect(resolveDesignSnapshotInput({})).toBeUndefined();
    expect(resolveDesignSnapshotInput({ url: "  ", htmlPath: "", imagePath: " " })).toBeUndefined();
  });
});
