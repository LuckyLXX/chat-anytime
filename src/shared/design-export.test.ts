import { describe, expect, it } from "vitest";
import { createDesignDoc, type DesignDoc, type DesignNode } from "./design-schema.js";
import { designNodeStyle, exportDesignHtml } from "./design-export.js";

function cardDoc(): DesignDoc {
  const inner: DesignNode = { type: "text", id: "t1", name: "标题", x: 0, y: 0, w: 120, h: 32, text: "登录<Title>", fontSize: 24, fontWeight: 700, color: "#111", align: "center" };
  const card: DesignNode = {
    type: "frame",
    id: "card",
    name: "卡片",
    x: 40,
    y: 30,
    w: 320,
    h: 200,
    fill: "#ffffff",
    radius: 12,
    shadow: "0 8px 24px rgba(0,0,0,.12)",
    layout: { direction: "column", gap: 8, padding: 16, justify: "center", align: "stretch" },
    children: [inner]
  };
  return {
    ...createDesignDoc("测试导出", 960, 640),
    canvas: { width: 960, height: 640, background: "#f5f5f5" },
    nodes: [
      card,
      { type: "rect", id: "r1", x: 400, y: 30, w: 80, h: 40, fill: "#2563eb", stroke: "#1d4ed8", strokeWidth: 2, radius: 6, opacity: 0.9 },
      { type: "image", id: "img1", x: 400, y: 100, w: 120, h: 80, src: "https://example.com/a.png", name: "缩略图" },
      { type: "text", id: "hidden", x: 0, y: 0, w: 10, h: 10, text: "隐藏", visible: false }
    ],
    revision: 5
  };
}

describe("exportDesignHtml", () => {
  it("生成完整 HTML：画布尺寸/背景/节点内联样式", () => {
    const html = exportDesignHtml(cardDoc());
    expect(html).toMatch(/^<!DOCTYPE html>/u);
    expect(html).toContain("<title>测试导出</title>");
    expect(html).toContain(".pi-design-canvas { position: relative; width: 960px; height: 640px; background:#f5f5f5;");
    expect(html).toContain('data-name="卡片"');
    expect(html).toContain("left:40px;top:30px;width:320px;height:200px;");
    expect(html).toContain("background:#ffffff;");
    expect(html).toContain("border-radius:12px;");
    expect(html).toContain("box-shadow:0 8px 24px rgba(0,0,0,.12);");
  });

  it("layout frame 导出为 flex（direction/gap/padding/justify）", () => {
    const html = exportDesignHtml(cardDoc());
    expect(html).toContain("display:flex;flex-direction:column;gap:8px;padding:16px;justify-content:center;align-items:stretch;");
  });

  it("text 节点带字体样式且 HTML 转义；image 导出 <img>；隐藏节点不导出", () => {
    const html = exportDesignHtml(cardDoc());
    expect(html).toContain("font-size:24px;font-weight:700;color:#111;text-align:center;");
    expect(html).toContain("登录&lt;Title&gt;");
    expect(html).toContain('<img src="https://example.com/a.png" alt="缩略图"');
    expect(html).not.toContain("隐藏");
  });

  it("rect 的描边与透明度", () => {
    const html = exportDesignHtml(cardDoc());
    expect(html).toContain("border:2px solid #1d4ed8;");
    expect(html).toContain("opacity:0.9;");
  });
});

describe("designNodeStyle", () => {
  it("layout 对象 padding 按边展开", () => {
    const style = designNodeStyle({
      type: "frame",
      id: "f",
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      layout: { direction: "row", padding: { top: 4, left: 2 } }
    });
    expect(style).toContain("padding:4px 0px 0px 2px;");
    expect(style).toContain("flex-direction:row;");
  });

  it("无 layout 的节点不产生 flex 样式", () => {
    const style = designNodeStyle({ type: "rect", id: "r", x: 1, y: 2, w: 3, h: 4 });
    expect(style).not.toContain("flex");
    expect(style).toContain("left:1px;top:2px;");
  });
});
