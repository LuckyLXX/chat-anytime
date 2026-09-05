// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { designNodeStyleObject } from "../../../shared/design-export.js";
import { createDesignDoc, type DesignDoc } from "../../../shared/design-schema.js";
import { DesignCanvas } from "./DesignCanvas";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = undefined;
  root = undefined;
});

function sampleDoc(): DesignDoc {
  const base = createDesignDoc("冒烟", 800, 600);
  return {
    ...base,
    canvas: { ...base.canvas, background: "#f3f4f6" },
    nodes: [
      { type: "frame", id: "card", name: "卡片", x: 40, y: 30, w: 320, h: 200, fill: "#ffffff", radius: 12, layout: { direction: "column", gap: 8, padding: 16 }, children: [
        { type: "text", id: "title", name: "标题", x: 0, y: 0, w: 120, h: 32, text: "登录", fontSize: 24, color: "#111111" },
        { type: "rect", id: "btn", name: "按钮", x: 0, y: 0, w: 120, h: 40, fill: "#2563eb" },
        { type: "image", id: "pic", name: "图", x: 0, y: 0, w: 60, h: 60, src: "https://example.com/a.png" }
      ] },
      { type: "rect", id: "hidden", x: 0, y: 0, w: 10, h: 10, visible: false }
    ]
  };
}

const noop = (): void => undefined;

function render(doc: DesignDoc, onSelect = (id: string | undefined): void => undefined): void {
  act(() => {
    root?.render(
      <DesignCanvas
        doc={doc}
        zoom={1}
        pan={{ x: 0, y: 0 }}
        onPanChange={noop}
        onZoomChange={noop}
        selectedId="btn"
        onSelect={onSelect}
        onNodePatch={noop}
        onGestureEnd={noop}
      />
    );
  });
}

describe("DesignCanvas 冒烟", () => {
  it("渲染节点树：可见节点出现在画布，隐藏节点不渲染", () => {
    render(sampleDoc());
    const world = container!.querySelector(".design-canvas-world") as HTMLElement;
    expect(world).toBeDefined();
    expect(world.style.width).toBe("800px");
    expect(world.querySelector('[data-node-id="card"]')).toBeDefined();
    expect(world.querySelector('[data-node-id="title"]')!.textContent).toBe("登录");
    expect((world.querySelector('[data-node-id="pic"]') as HTMLImageElement).src).toContain("example.com");
    expect(world.querySelector('[data-node-id="hidden"]')).toBeNull();
  });

  it("选中节点渲染选择框与 8 个手柄", () => {
    render(sampleDoc());
    expect(container!.querySelector(".design-selection")).toBeDefined();
    expect(container!.querySelectorAll(".design-handle")).toHaveLength(8);
  });

  it("样式对象与导出同源（flex 布局节点）", () => {
    render(sampleDoc());
    const card = container!.querySelector('[data-node-id="card"]') as HTMLElement;
    const style = designNodeStyleObject(sampleDoc().nodes[0]!);
    expect(card.style.display).toBe(style.display);
    expect(card.style.flexDirection).toBe(style.flexDirection);
    expect(card.style.borderRadius).toBe(style.borderRadius);
  });

  it("点击节点触发选中回调", () => {
    const selections: (string | undefined)[] = [];
    render(sampleDoc(), (id) => selections.push(id));
    const btn = container!.querySelector('[data-node-id="btn"]') as HTMLElement;
    const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    act(() => {
      btn.dispatchEvent(event);
    });
    expect(selections.at(-1)).toBe("btn");
  });
});
