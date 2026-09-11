import { describe, expect, it } from "vitest";
import { createDesignDoc, type DesignDoc, type DesignNode } from "./design-schema.js";
import { contrastRatio, inspectDesignQuality, inspectDesignScale, parseColor, summarizeDesignLayout } from "./design-quality.js";

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
    // hex8 的 alpha 量程是 0–255，同样要先归一再合成（#88 ≈ 0.53）。
    expect(contrastRatio(parseColor("#ffffff88")!, black)).toBeLessThan(10);
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

  it("祖先 opacity 链纳入对比度——容器级透明度压暗子文字（玻璃卡片案例）", () => {
    // 真会话案例：卡片用元素级 opacity 0.5 做玻璃拟态，整组（含文字）被压淡；
    // 旧实现只看卡片 fill 原色，放行了实际发灰的小字。
    const doc = docWith([
      { type: "rect", id: "bg", name: "深空底色", x: 0, y: 0, w: 1440, h: 900, fill: "#0A0F22" },
      {
        type: "frame", id: "card", name: "玻璃卡", x: 800, y: 150, w: 420, h: 600,
        fill: "#121830", opacity: 0.5,
        children: [
          { type: "text", id: "sub", name: "副标题", text: "登录 Aurora，继续你的创作之旅", x: 40, y: 86, w: 330, h: 24, fontSize: 14, color: "#9AA4C7" },
          { type: "text", id: "title", name: "欢迎标题", text: "欢迎回来 👋", x: 40, y: 42, w: 330, h: 40, fontSize: 30, fontWeight: 800, color: "#FFFFFF" }
        ]
      }
    ], { width: 1440, height: 900 });
    const report = inspectDesignQuality(doc);
    const text = report.diagnostics.join("\n");
    // 14px 副标题合成后 ≈2.8:1 → 报；30px 粗体标题 ≈5:1 > 3:1 大字门槛 → 不误报。
    expect(text).toContain("text-contrast");
    expect(text).toContain("sub");
    expect(text).not.toContain("title");
    expect(text).toContain("透明度链");
    const repair = report.repairTargets.find((op) => op.op === "update" && op.id === "sub");
    expect(repair).toMatchObject({ op: "update", patch: { color: "#ffffff" } });
  });

  it("满幅底色 rect 当画布背景 → 根级背景板参与合成（深底白字不误报）", () => {
    // 无 canvas.background、AI 用满幅 rect 铺底的常见画法：底色参与合成，
    // 白字实际 ≈19:1——若按白底计算会误报。
    const doc = docWith([
      { type: "rect", id: "bg", name: "底色", x: 0, y: 0, w: 800, h: 600, fill: "#0A0F22" },
      { type: "text", id: "hero", name: "白字", text: "Aurora", x: 40, y: 40, w: 300, h: 40, fontSize: 24, color: "#ffffff" }
    ], { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    expect(report.diagnostics.join("\n")).not.toContain("text-contrast");
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

describe("审美标尺规则（off-scale-*）", () => {
  it("圆角不在标尺上 → 聚合诊断一条 + 逐节点吸附修复", () => {
    const doc = docWith([
      { type: "rect", id: "a", name: "卡一", x: 0, y: 0, w: 100, h: 100, radius: 14 },
      { type: "rect", id: "b", name: "卡二", x: 200, y: 0, w: 100, h: 100, radius: 29 },
      { type: "rect", id: "ok", name: "合规", x: 400, y: 0, w: 100, h: 100, radius: 12 }
    ], { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    const lines = report.diagnostics.filter((line) => line.includes("off-scale-radius"));
    // 聚合：一条诊断（不是逐节点刷屏）。
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 个节点圆角不在标尺上");
    expect(report.repairTargets).toContainEqual({ op: "update", id: "a", patch: { radius: 12 } });
    expect(report.repairTargets).toContainEqual({ op: "update", id: "b", patch: { radius: 24 } });
    // 已在标尺上的节点不产修复。
    expect(report.repairTargets.some((op) => op.op === "update" && op.id === "ok")).toBe(false);
  });

  it("胶囊半径（≥100）不被拉回，也不误报", () => {
    const doc = docWith([
      { type: "rect", id: "pill", name: "胶囊", x: 0, y: 0, w: 200, h: 40, radius: 9999 },
      { type: "rect", id: "big", name: "超大", x: 300, y: 0, w: 200, h: 200, radius: 220 }
    ], { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    expect(report.diagnostics.join("\n")).not.toContain("off-scale-radius");
  });

  it("字号不在标尺上 → 聚合诊断 + 吸附修复；半档值（12.5/13.5/19）被抓出", () => {
    const doc = docWith([
      { type: "text", id: "t1", name: "甲", text: "a", x: 0, y: 0, w: 100, h: 20, fontSize: 13.5, color: "#111111" },
      { type: "text", id: "t2", name: "乙", text: "b", x: 0, y: 40, w: 100, h: 20, fontSize: 19, color: "#111111" },
      { type: "text", id: "ok", name: "丙", text: "c", x: 0, y: 80, w: 100, h: 20, fontSize: 16, color: "#111111" }
    ], { width: 800, height: 600, background: "#ffffff" });
    const report = inspectDesignQuality(doc);
    const line = report.diagnostics.find((entry) => entry.includes("off-scale-font-size"));
    expect(line).toBeDefined();
    expect(line).toContain("2 个文本字号不在标尺上");
    // 13.5 与 13/14 等距 → 确定性取较小档（升序首个），同输入同结果。
    expect(report.repairTargets).toContainEqual({ op: "update", id: "t1", patch: { fontSize: 13 } });
    expect(report.repairTargets).toContainEqual({ op: "update", id: "t2", patch: { fontSize: 18 } });
  });

  it("同级纵向叠放的间隙不在标尺上 → off-scale-spacing + 上移 y 的修复", () => {
    const doc = docWith([
      {
        type: "frame", id: "form", name: "表单", x: 0, y: 0, w: 320, h: 400,
        children: [
          { type: "rect", id: "f1", name: "输入一", x: 20, y: 20, w: 280, h: 40 },
          // 间隙 5（标尺外）→ 应吸附到 4，y 从 65 变 64。
          { type: "rect", id: "f2", name: "输入二", x: 20, y: 65, w: 280, h: 40 },
          // 间隙 (125-109)=16，标尺上 → 不报。
          { type: "rect", id: "f3", name: "输入三", x: 20, y: 125, w: 280, h: 40 }
        ]
      }
    ], { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    const line = report.diagnostics.find((entry) => entry.includes("off-scale-spacing"));
    expect(line).toBeDefined();
    expect(line).toContain("1 处同级间隙不在标尺上");
    expect(report.repairTargets).toContainEqual({ op: "update", id: "f2", patch: { y: 64 } });
    expect(report.repairTargets.some((op) => op.op === "update" && op.id === "f3")).toBe(false);
  });

  it("横向并排内容不被当成间距节奏误报", () => {
    const doc = docWith([
      {
        type: "frame", id: "rail", name: "横排", x: 0, y: 0, w: 800, h: 200,
        children: [
          { type: "rect", id: "c1", name: "卡一", x: 0, y: 0, w: 200, h: 120 },
          { type: "rect", id: "c2", name: "卡二", x: 233, y: 0, w: 200, h: 120 },
          { type: "rect", id: "c3", name: "卡三", x: 461, y: 0, w: 200, h: 120 }
        ]
      }
    ], { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    // y 完全一致（间隙 0）→ 不触发间距规则（重曠不问）。
    expect(report.diagnostics.join("\n")).not.toContain("off-scale-spacing");
  });

  it("风格指南自带标尺：tokens 参数覆盖默认（指南的档位说了算）", () => {
    const doc = docWith([
      { type: "rect", id: "a", name: "卡", x: 0, y: 0, w: 100, h: 100, radius: 14 },
      { type: "text", id: "t", name: "字", text: "a", x: 200, y: 0, w: 100, h: 20, fontSize: 17, color: "#111111" }
    ], { width: 800, height: 600, background: "#ffffff" });
    // 指南认为 14 与 17 是合法档位 → 不报。
    const guide = inspectDesignQuality(doc, { tokens: { radius: [0, 14, 16], fontSize: [13, 17, 24], spacing: [4, 8] } });
    expect(guide.diagnostics.join("\n")).not.toContain("off-scale-radius");
    expect(guide.diagnostics.join("\n")).not.toContain("off-scale-font-size");
    // 默认标尺下同样一份稿子两个都报（证明 tokens 真的生效而不是被忽略）。
    const fallback = inspectDesignQuality(doc);
    expect(fallback.diagnostics.join("\n")).toContain("off-scale-radius");
    expect(fallback.diagnostics.join("\n")).toContain("off-scale-font-size");
  });

  it("审美规则不得刷屏：聚合为一条诊断、修复按上限截断", () => {
    const nodes: DesignNode[] = Array.from({ length: 40 }, (_, index) => ({ type: "rect", id: `r${index}`, name: `块${index}`, x: 0, y: index * 30, w: 100, h: 20, radius: 14 }));
    const doc = docWith(nodes, { width: 800, height: 600 });
    const report = inspectDesignQuality(doc);
    const radiusLines = report.diagnostics.filter((line) => line.includes("off-scale-radius"));
    expect(radiusLines).toHaveLength(1);
    expect(radiusLines[0]).toContain("40 个节点圆角不在标尺上");
    // 诊断总数远小于节点数（聚合生效，不是 40 行刷屏）。
    expect(report.diagnostics.length).toBeLessThanOrEqual(3);
    // 修复 op 按 MAX_AESTHETIC_REPAIR_TARGETS（24）截断。
    expect(report.repairTargets.filter((op) => op.op === "update" && (op.patch as { radius?: number }).radius !== undefined)).toHaveLength(24);
  });

  it("修复预算轮转分配：数量最多的规则不把额度占满（三条规则都能拿到）", () => {
    // 圆角越标 30 个（数量最多）+ 字号 3 个 + 间距 2 处：轮转后后两者不被挤光。
    const cards: DesignNode[] = Array.from({ length: 30 }, (_, index) => ({ type: "rect", id: `c${index}`, name: `卡${index}`, x: 0, y: index * 30, w: 100, h: 20, radius: 14 }));
    const texts: DesignNode[] = Array.from({ length: 3 }, (_, index) => ({ type: "text", id: `t${index}`, name: `字${index}`, text: "a", x: 200, y: index * 30, w: 100, h: 20, fontSize: 19, color: "#111111" }));
    const doc = docWith([...cards, ...texts], { width: 800, height: 1200, background: "#ffffff" });
    const report = inspectDesignQuality(doc);
    const radiusRepairs = report.repairTargets.filter((op) => op.op === "update" && (op.patch as { radius?: number }).radius !== undefined);
    const fontRepairs = report.repairTargets.filter((op) => op.op === "update" && (op.patch as { fontSize?: number }).fontSize !== undefined);
    expect(radiusRepairs.length + fontRepairs.length).toBe(24);
    expect(fontRepairs).toHaveLength(3);
    expect(radiusRepairs).toHaveLength(21);
  });

  it("现有四条规则行为不变（回归锁定）：同一稿子的结构诊断与修复原样保留", () => {
    // 同时含旧规则（容器溢出/空容器/对比度/出界）与新规则（标尺）的稿子：
    // 新规则只能追加，不得改变旧规则诊断文本与修复 ops 的语义。
    const doc = docWith([
      {
        type: "frame", id: "rail", name: "轨道", x: 0, y: 0, w: 300, h: 200, radius: 14,
        layout: { direction: "row", gap: 20, padding: 16 },
        children: [
          { type: "rect", id: "c1", name: "卡一", x: 0, y: 0, w: 150, h: 100 },
          { type: "rect", id: "c2", name: "卡二", x: 0, y: 0, w: 150, h: 100 }
        ]
      },
      { type: "frame", id: "empty", name: "空壳", x: 0, y: 300, w: 200, h: 100 },
      { type: "text", id: "dim", name: "暗字", text: "看不清", x: 0, y: 420, w: 200, h: 30, fontSize: 14, color: "#71717a" }
    ], { width: 400, height: 320, background: "#1c1917" });
    const report = inspectDesignQuality(doc);
    const text = report.diagnostics.join("\n");
    expect(text).toContain("container-overflow");
    expect(text).toContain("empty-container");
    expect(text).toContain("text-contrast");
    expect(text).toContain("out-of-canvas");
    // 旧规则的修复 ops 一个不少。
    expect(report.repairTargets).toContainEqual({ op: "update", id: "rail", patch: { w: 352 } });
    expect(report.repairTargets[0]).toMatchObject({ op: "resize" });
    expect(report.repairTargets).toContainEqual({ op: "update", id: "dim", patch: { color: "#ffffff" } });
    expect(report.unrepairableCount).toBeGreaterThanOrEqual(1);
  });
});

describe("inspectDesignScale（可单独调用：风格指南标尺注入用）", () => {
  it("返回聚合后的 rule/message/repairs，同一节点只产一条修复", () => {
    const doc = docWith([
      { type: "rect", id: "a", name: "卡", x: 0, y: 0, w: 100, h: 100, radius: 14 },
      { type: "text", id: "t", name: "字", text: "a", x: 0, y: 200, w: 100, h: 20, fontSize: 19, color: "#111111" }
    ], { width: 800, height: 600, background: "#ffffff" });
    const issues = inspectDesignScale(doc);
    expect(issues.map((issue) => issue.rule).sort()).toEqual(["off-scale-font-size", "off-scale-radius"]);
    expect(issues.every((issue) => issue.repairs.length === 1)).toBe(true);
    expect(issues.every((issue) => issue.message.length > 0)).toBe(true);
  });

  it("合规稿子返回空数组", () => {
    const doc = docWith([
      { type: "rect", id: "a", name: "卡", x: 0, y: 0, w: 100, h: 100, radius: 12 },
      { type: "text", id: "t", name: "字", text: "a", x: 0, y: 200, w: 100, h: 20, fontSize: 16, color: "#111111" }
    ], { width: 800, height: 600, background: "#ffffff" });
    expect(inspectDesignScale(doc)).toHaveLength(0);
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
