import { describe, expect, it } from "vitest";
import { createDesignDoc, type DesignDoc, type DesignNode } from "./design-schema.js";
import { designNodeStyle, designNodeStyleObject, exportDesignHtml } from "./design-export.js";

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

  it("flex 子节点导出为 relative 且省略 left/top，普通节点保持绝对定位", () => {
    const html = exportDesignHtml(cardDoc());
    const cardIndex = html.indexOf('data-name="标题"');
    const titleStyle = html.slice(html.lastIndexOf('<div style="', cardIndex), cardIndex);
    expect(titleStyle).toContain("position:relative;");
    expect(titleStyle).not.toContain("left:");
    // 卡片外的游离矩形仍是绝对定位。
    expect(html).toContain("position:absolute;left:400px;top:30px;");
  });

  it("样式/style 块注入被转义（shadow 双引号、background 断裂 style 均不可行）", () => {
    const doc = cardDoc();
    doc.nodes[0]!.shadow = 'red" onerror="alert(1)';
    doc.canvas.background = 'blue</style><script>alert(2)</script>';
    const html = exportDesignHtml(doc);
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
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

  it("flex 父的子节点发 relative 且省略 left/top（真实 flex 排布）", () => {
    const child = { type: "rect", id: "c", x: 9, y: 9, w: 30, h: 20, fill: "#fff" } as const;
    const style = designNodeStyleObject(child, true);
    expect(style.position).toBe("relative");
    expect(style.left).toBeUndefined();
    expect(style.top).toBeUndefined();
    expect(style.width).toBe("30px");
    const absolute = designNodeStyleObject(child, false);
    expect(absolute.position).toBe("absolute");
    expect(absolute.left).toBe("9px");
  });

  it("样式值中的 HTML 特殊字符被转义（防属性注入）", () => {
    const hostile = designNodeStyle({ type: "rect", id: "r", x: 0, y: 0, w: 5, h: 5, shadow: 'red" onerror="alert(1)' });
    expect(hostile).toContain('box-shadow:red&quot; onerror=&quot;alert(1);');
    expect(hostile).not.toContain('onerror="alert');
  });
});

describe("exportDesignHtml 内容并集（多画板不裁剪）", () => {
  it("内容都在画布内时保持画布矩形输出", () => {
    const html = exportDesignHtml(cardDoc());
    expect(html).toContain(".pi-design-canvas { position: relative; width: 960px; height: 640px; background:#f5f5f5;");
  });

  it("节点超出画布 → 容器放大到并集，画布背景层平移，节点坐标不变", () => {
    const doc = cardDoc();
    doc.canvas = { width: 375, height: 600, background: "#f5f5f5" };
    doc.nodes = [
      { type: "rect", id: "s1", name: "屏一", x: 0, y: 0, w: 375, h: 600, fill: "#fff" },
      { type: "rect", id: "s2", name: "屏二", x: 455, y: 0, w: 375, h: 600, fill: "#fff" }
    ];
    const html = exportDesignHtml(doc);
    // 并集 = (0,0)-(830,600)：容器 830×600，不再写画布原尺寸。
    expect(html).toContain(".pi-design-canvas { position: relative; width: 830px; height: 600px; overflow: hidden; }");
    // 画布背景层平移回 (0,0)（ox=455 被屏二右缘 830 抵消：ox=min(0,0)=0……此处 ox=0，偏移应为 0）。
    expect(html).toContain('<div style="position:absolute;left:0px;top:0px;width:375px;height:600px;background:#f5f5f5;">');
    // 节点保持自身 left（455 > 画布宽 375，不被裁剪）。
    expect(html).toContain('left:455px;top:0px;width:375px;height:600px;');
  });

  it("负坐标节点 → 画布背景层负偏移，包装层承担平移", () => {
    const doc = cardDoc();
    doc.canvas = { width: 375, height: 600, background: "#f5f5f5" };
    doc.nodes = [{ type: "rect", id: "s1", name: "越界", x: -120, y: -40, w: 375, h: 600, fill: "#fff" }];
    const html = exportDesignHtml(doc);
    expect(html).toContain('<div style="position:absolute;left:120px;top:40px;width:375px;height:600px;background:#f5f5f5;">');
    expect(html).toContain('left:120px;top:40px;width:0;height:0');
    expect(html).toContain('left:-120px;top:-40px;width:375px;height:600px;');
  });
});
