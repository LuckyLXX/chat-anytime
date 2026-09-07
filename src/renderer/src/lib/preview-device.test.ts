import { describe, expect, it } from "vitest";
import { layoutDeviceFrame, previewDevicePreset } from "./preview-device";

describe("previewDevicePreset", () => {
  it("按 id 取预设，未知 id 回退自适应", () => {
    expect(previewDevicePreset("phone").width).toBe(390);
    expect(previewDevicePreset("desktop").width).toBe(1440);
    expect(previewDevicePreset("responsive").width).toBe(0);
    expect(previewDevicePreset("nope" as never).id).toBe("responsive");
  });
});

describe("layoutDeviceFrame", () => {
  it("自适应填满容器，scale=1", () => {
    const layout = layoutDeviceFrame({ width: 800, height: 600 }, "responsive", { fit: true, clampWidth: true });
    expect(layout).toMatchObject({ frameWidth: 800, frameHeight: 600, contentWidth: 800, contentHeight: 600, scale: 1, offsetX: 0, fitsWidth: true });
  });

  it("适应窗口：设备更宽时按宽比缩小，铺满容器宽，内容高放大", () => {
    const layout = layoutDeviceFrame({ width: 720, height: 500 }, "desktop", { fit: true, clampWidth: true });
    expect(layout.scale).toBeCloseTo(0.5);
    expect(layout.frameWidth).toBe(720);
    expect(layout.frameHeight).toBe(500);
    expect(layout.contentWidth).toBe(1440);
    expect(layout.contentHeight).toBe(1000);
    expect(layout.fitsWidth).toBe(true);
  });

  it("适应窗口：设备更窄时不放大，框在容器内水平居中", () => {
    const layout = layoutDeviceFrame({ width: 900, height: 700 }, "phone", { fit: true, clampWidth: true });
    expect(layout.scale).toBe(1);
    expect(layout.frameWidth).toBe(390);
    expect(layout.offsetX).toBe(255);
    expect(layout.fitsWidth).toBe(true);
  });

  it("原始尺寸 + clampWidth（浏览器）：超宽设备封顶容器宽并居中偏移为 0", () => {
    const layout = layoutDeviceFrame({ width: 800, height: 600 }, "desktop", { fit: false, clampWidth: true });
    expect(layout.scale).toBe(1);
    expect(layout.frameWidth).toBe(800);
    expect(layout.offsetX).toBe(0);
    expect(layout.fitsWidth).toBe(false);
  });

  it("原始尺寸 + 不 clamp（HTML）：保留设备宽交给容器滚动，偏移不越界", () => {
    const layout = layoutDeviceFrame({ width: 800, height: 600 }, "desktop", { fit: false, clampWidth: false });
    expect(layout.frameWidth).toBe(1440);
    expect(layout.offsetX).toBe(0);
    expect(layout.fitsWidth).toBe(false);

    const narrow = layoutDeviceFrame({ width: 900, height: 700 }, "phone", { fit: false, clampWidth: false });
    expect(narrow.frameWidth).toBe(390);
    expect(narrow.offsetX).toBe(255);
  });

  it("未测量容器（0 尺寸）回退到空布局", () => {
    const layout = layoutDeviceFrame({ width: 0, height: 0 }, "phone", { fit: true, clampWidth: true });
    expect(layout).toMatchObject({ frameWidth: 0, frameHeight: 0, scale: 1, offsetX: 0 });
  });

  it("适应窗口 + 自适应：实测内容更宽（多画板导出页）时按内容宽整体缩小", () => {
    const layout = layoutDeviceFrame({ width: 900, height: 800 }, "responsive", { fit: true, clampWidth: true, contentWidth: 2000 });
    expect(layout.scale).toBeCloseTo(0.45);
    expect(layout.frameWidth).toBe(900);
    expect(layout.contentWidth).toBe(2000);
    expect(layout.contentHeight).toBeCloseTo(800 / 0.45);
    expect(layout.fitsWidth).toBe(true);
  });

  it("适应窗口 + 设备预设：内容比预设更宽时进一步缩小到全部可见", () => {
    const layout = layoutDeviceFrame({ width: 900, height: 800 }, "desktop", { fit: true, clampWidth: true, contentWidth: 2000 });
    expect(layout.scale).toBeCloseTo(900 / 2000);
    expect(layout.contentWidth).toBe(2000);
    // 内容不超预设时量测值不影响布局（仍按预设缩放）
    const within = layoutDeviceFrame({ width: 720, height: 500 }, "desktop", { fit: true, clampWidth: true, contentWidth: 1200 });
    expect(within.scale).toBeCloseTo(0.5);
    expect(within.contentWidth).toBe(1440);
  });

  it("原始尺寸忽略实测内容宽（诚实展示溢出）", () => {
    const layout = layoutDeviceFrame({ width: 900, height: 800 }, "responsive", { fit: false, clampWidth: false, contentWidth: 2000 });
    expect(layout.scale).toBe(1);
    expect(layout.contentWidth).toBe(900);
  });

  it("实测内容不宽于容器时布局不变（scale=1）", () => {
    const layout = layoutDeviceFrame({ width: 900, height: 800 }, "responsive", { fit: true, clampWidth: true, contentWidth: 900 });
    expect(layout).toMatchObject({ frameWidth: 900, frameHeight: 800, contentWidth: 900, contentHeight: 800, scale: 1, offsetX: 0 });
  });
});
