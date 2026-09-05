import { describe, expect, it } from "vitest";
import { createDesignDoc, type DesignDoc, type DesignNode } from "./design-schema.js";
import { contrastRatio, inspectDesignQuality, parseColor, summarizeDesignLayout } from "./design-quality.js";

function docWith(nodes: DesignNode[], canvas: { width: number; height: number; background?: string }): DesignDoc {
  return { ...createDesignDoc("质检", canvas.width, canvas.height), canvas, nodes };
}

describe("颜色解析与对比度", () => {
  it("parseColor 支持 #rgb/#rrggbb/#rrggbbaa、rgb()/rgba()、命名色", () => {
    expect(parseColor("#fff")).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    expect(parseColor("#1C1917")).toMatchObject({ r: 28, g: 25, b: 23, a: 255 });
    expect(parseColor("#11223344")?.a).toBe(0x44);
    expect(parseColor("rgba(255, 0, 0, 0.5)")).toMatchObject({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(parseColor("white")).toMatchObject({ r: 255, g: 255, b: 255, a: 255 });
    expect(parseColor("not-a-color")).toBeUndefined();
  });

  it("contrastRatio：黑白 21:1；rgba 前景与背景合成后计算", () => {
    const white = parseColor("#ffffff")!;
    const black = parseColor("#000000")!;
    expect(contrastRatio(white, black)).toBeCloseTo(21, 0);
    // 半透明白叠在黑底上 ≈ 灰，对比度远小于 21。
    const translucent = { r: 255, g: 255, b: 255, a: 0.4 };
    expect(contrastRatio(translucent, black)).toBeLessThan(10);
  });
});

describe("inspectDesignQuality", () => {
  it("flex 容器装不下子内容 → container-overflow + 放大容器的 repairTarget", () => {
    const doc = docWith([
      {
        type: "frame", id: "rail", name: "卡轨道", x: 0, y: 0, w: 300, h: 200,
        layout: { direction: "row", gap: 20, padding: 16 },
        children: [
          { type: "rect", id: "c1", x: 0, y: 0, w: 150, h: 100 },
          { type: "rect", id: "c2", x: 0, y: 0, w: 150, h: 100 }
        ]
      }
    ], { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    expect(report.diagnostics.join("\n")).toContain("container-overflow");
    // 需要 16+150+20+150+16 = 352 宽；交叉轴 100+32=132 < 200 不触发。
    const repair = report.repairTargets.find((op) => op.op === "update" && op.id === "rail");
    expect(repair).toMatchObject({ op: "update", patch: { w: 352 } });
    expect(report.repairTargets.every((op) => op.op !== "resize")).toBe(true);
  });

  it("column 容器交叉轴溢出也报，主轴不重报", () => {
    const doc = docWith([
      {
        type: "frame", id: "col", name: "纵向", x: 0, y: 0, w: 400, h: 100,
        layout: { direction: "column", gap: 10 },
        children: [
          { type: "rect", id: "a", x: 0, y: 0, w: 360, h: 80 },
          { type: "rect", id: "b", x: 0, y: 0, w: 300, h: 80 }
        ]
      }
    ], { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    const repair = report.repairTargets.find((op) => op.op === "update" && op.id === "col");
    // 主轴 80+10+80=170 > 100 → h:170；交叉轴 max(360) < 400 不动 w。
    expect(repair).toMatchObject({ op: "update", patch: { h: 170 } });
    expect((repair as { patch: { w?: number } }).patch.w).toBeUndefined();
  });

  it("空结构容器（无子内容无外观）→ 不可自动修复诊断", () => {
    const doc = docWith([
      { type: "frame", id: "shell", name: "空壳", x: 0, y: 0, w: 200, h: 100 },
      { type: "frame", id: "block", name: "色块", x: 0, y: 0, w: 200, h: 100, fill: "#fff" }
    ], { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    expect(report.diagnostics.join("\n")).toContain("empty-container");
    expect(report.diagnostics.join("\n")).toContain("空壳");
    expect(report.diagnostics.join("\n")).not.toContain("色块");
    expect(report.unrepairableCount).toBeGreaterThanOrEqual(1);
    expect(report.repairTargets).toHaveLength(0);
  });

  it("文字对比度不足 AA → repairTarget 换可读色；已达标不报", () => {
    const doc = docWith([
      {
        type: "frame", id: "card", name: "卡", x: 0, y: 0, w: 400, h: 200, fill: "#1c1917",
        children: [
          { type: "text", id: "dim", name: "暗字", text: "看不清", x: 10, y: 10, w: 200, h: 30, fontSize: 14, color: "#71717a" },
          { type: "text", id: "fine", name: "亮字", text: "看得清", x: 10, y: 50, w: 200, h: 30, fontSize: 14, color: "#ffffff" }
        ]
      }
    ], { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    expect(report.diagnostics.join("\n")).toContain("text-contrast");
    expect(report.diagnostics.join("\n")).toContain("暗字");
    expect(report.diagnostics.join("\n")).not.toContain("亮字");
    const repair = report.repairTargets.find((op) => op.op === "update" && op.id === "dim");
    expect(repair).toMatchObject({ op: "update", patch: { color: "#ffffff" } });
  });

  it("大字号（≥24px）按 3:1 门槛", () => {
    const doc = docWith([
      { type: "text", id: "hero", name: "标题", text: "标题", x: 0, y: 0, w: 400, h: 60, fontSize: 32, fontWeight: 700, color: "#6b7280" }
    ], { width: 800, height: 600, background: "#ffffff" });
    const report = inspectDesignQuality(doc);
    // 4.6:1 左右——普通文本 4.5 过、大字 3 也过，这里验证它确实不报。
    expect(report.diagnostics.join("\n")).not.toContain("hero");
  });

  it("内容超出画布 → out-of-canvas + resize repairTarget 排首位 + suggestCanvas", () => {
    const doc = docWith([
      { type: "rect", id: "s1", name: "屏一", x: 0, y: 0, w: 1440, h: 900 },
      { type: "rect", id: "s2", name: "屏二", x: 1520, y: 0, w: 1440, h: 900 }
    ], { width: 1440, height: 900 });
    const report = inspectDesignQuality(doc);
    expect(report.diagnostics.join("\n")).toContain("out-of-canvas");
    expect(report.repairTargets[0]).toMatchObject({ op: "resize", width: 3040, height: 980 });
    expect(report.suggestCanvas).toEqual({ width: 3040, height: 980 });
  });

  it("无问题时报告为空", () => {
    const doc = docWith([
      {
        type: "frame", id: "ok", name: "正常", x: 10, y: 10, w: 300, h: 100, fill: "#ffffff",
        layout: { direction: "row", gap: 8, padding: 8 },
        children: [{ type: "text", id: "t", name: "文", text: "你好", x: 0, y: 0, w: 100, h: 24, fontSize: 16, color: "#111111" }]
      }
    ], { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    expect(report.diagnostics).toHaveLength(0);
    expect(report.repairTargets).toHaveLength(0);
    expect(report.omitted).toBe(0);
  });
});

describe("summarizeDesignLayout", () => {
  it("画布行 + 顶层逐行 + frame 下钻一层 + 隐藏节点跳过", () => {
    const doc = docWith([
      {
        type: "frame", id: "login", name: "登录屏", x: 0, y: 0, w: 375, h: 812, fill: "#ffffff",
        layout: { direction: "column", gap: 12 },
        children: [
          { type: "text", id: "title", name: "标题", text: "登录账户继续", x: 0, y: 0, w: 200, h: 32, fontSize: 24 },
          { type: "frame", id: "deep", name: "深层", x: 0, y: 0, w: 10, h: 10, children: [{ type: "rect", id: "leaf", name: "不应出现", x: 0, y: 0, w: 5, h: 5 }] }
        ]
      },
      { type: "rect", id: "s2", name: "第二屏", x: 455, y: 0, w: 375, h: 812 },
      { type: "rect", id: "gone", name: "隐藏", x: 0, y: 0, w: 10, h: 10, visible: false }
    ], { width: 900, height: 900 });
    const digest = summarizeDesignLayout(doc);
    expect(digest).toContain("画布 900×900");
    expect(digest).toContain("登录屏 frame 375×812 @(0,0) layout:column/12");
    expect(digest).toContain("标题 text");
    expect(digest).toContain("第二屏 rect 375×812 @(455,0)");
    expect(digest).not.toContain("不应出现");
    expect(digest).not.toContain("隐藏");
    // 只下钻一层：deep 的子节点不出现。
    expect(digest).not.toContain("leaf");
  });

  it("超 30 行截断并提示 design_read", () => {
    const nodes = Array.from({ length: 40 }, (_, index): DesignNode => ({ type: "rect", id: `r${index}`, name: `块${index}`, x: index * 10, y: 0, w: 10, h: 10 }));
    const digest = summarizeDesignLayout(docWith(nodes, { width: 800, height: 600 }));
    expect(digest.split("\n").length).toBeLessThanOrEqual(31);
    expect(digest).toContain("design_read");
  });
});
