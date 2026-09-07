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

interface CreateSpec { type: "frame" | "rect" | "text"; parentId: string | null; x: number; y: number; w: number; h: number }

function render(doc: DesignDoc, onSelect = (id: string | undefined): void => undefined, options: { tool?: "select" | "frame" | "rect" | "text"; onCreateNode?: (spec: CreateSpec) => void; selectedId?: string } = {}): void {
  act(() => {
    root?.render(
      <DesignCanvas
        doc={doc}
        zoom={1}
        pan={{ x: 0, y: 0 }}
        onPanChange={noop}
        onZoomChange={noop}
        selectedId={options.selectedId ?? "btn"}
        onSelect={onSelect}
        onNodePatch={noop}
        onGestureEnd={noop}
        tool={options.tool}
        onCreateNode={options.onCreateNode}
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

  it("rect 工具拖拽创建：坐标相对落点命中的父 frame", () => {
    const created: CreateSpec[] = [];
    render(sampleDoc(), noop, { tool: "rect", onCreateNode: (spec) => created.push(spec) });
    const canvas = container!.querySelector(".design-canvas") as HTMLElement;
    const pointer = (type: string, x: number, y: number): void => {
      act(() => {
        canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
      });
    };
    // happy-dom 的容器矩形为 0，world ≈ client 坐标。按下点 (200,150) 落在 card
    // (40,30,320,200) 内 → 父容器 card；拖到 (260,190) → 相对 card 的 (160,120) 60×40。
    pointer("pointerdown", 200, 150);
    pointer("pointermove", 260, 190);
    pointer("pointerup", 260, 190);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: "rect", parentId: "card", x: 160, y: 120, w: 60, h: 40 });
  });

  it("rect 工具点击（未拖过阈值）→ 缺省尺寸落在按下点", () => {
    const created: CreateSpec[] = [];
    render(sampleDoc(), noop, { tool: "rect", onCreateNode: (spec) => created.push(spec) });
    const canvas = container!.querySelector(".design-canvas") as HTMLElement;
    const pointer = (type: string, x: number, y: number): void => {
      act(() => {
        canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
      });
    };
    // 空白处 (600,500)：无父 frame → parentId null、画布坐标、缺省 160×120。
    pointer("pointerdown", 600, 500);
    pointer("pointerup", 600, 500);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: "rect", parentId: null, x: 600, y: 500, w: 160, h: 120 });
  });

  it("锁定节点仍可选中但进入不了拖动手势（pointerdown 不报错、选中生效）", () => {
    const doc = sampleDoc();
    doc.nodes[0]!.locked = true;
    const selections: (string | undefined)[] = [];
    render(doc, (id) => selections.push(id));
    const card = container!.querySelector('[data-node-id="card"]') as HTMLElement;
    act(() => {
      card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 100, clientY: 100 }));
    });
    expect(selections.at(-1)).toBe("card");
    // 选中态落到锁定节点：选择框还在（只选中），但缩放手柄不渲染。
    render(doc, noop, { selectedId: "card" });
    expect(container!.querySelector(".design-selection")).toBeDefined();
    expect(container!.querySelectorAll(".design-handle")).toHaveLength(0);
  });
});

describe("DesignCanvas 滚轮语义", () => {
  interface ZoomCall { zoom: number; anchor?: { x: number; y: number } }

  function renderWith(zoom: number, pan: { x: number; y: number }, handlers: { onPanChange: (pan: { x: number; y: number }) => void; onZoomChange: (zoom: number, anchor?: { x: number; y: number }) => void }): HTMLElement {
    act(() => {
      root?.render(
        <DesignCanvas
          doc={sampleDoc()}
          zoom={zoom}
          pan={pan}
          onPanChange={handlers.onPanChange}
          onZoomChange={handlers.onZoomChange}
          selectedId={undefined}
          onSelect={noop}
          onNodePatch={noop}
          onGestureEnd={noop}
        />
      );
    });
    return container!.querySelector(".design-canvas") as HTMLElement;
  }

  function wheel(target: HTMLElement, init: WheelEventInit & { ctrlKey?: boolean; shiftKey?: boolean; clientX?: number; clientY?: number }): void {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: init.deltaX, deltaY: init.deltaY });
    // happy-dom 的 WheelEvent 继承 UIEvent，构造器会丢弃修饰键与坐标，手动补上。
    if (init.shiftKey !== undefined) Object.defineProperty(event, "shiftKey", { value: init.shiftKey });
    if (init.ctrlKey !== undefined) Object.defineProperty(event, "ctrlKey", { value: init.ctrlKey });
    if (init.clientX !== undefined) Object.defineProperty(event, "clientX", { value: init.clientX });
    if (init.clientY !== undefined) Object.defineProperty(event, "clientY", { value: init.clientY });
    act(() => {
      target.dispatchEvent(event);
    });
  }

  it("普通滚轮纵向滚动：pan.y 随 deltaY 平移，不触发缩放", () => {
    const pans: { x: number; y: number }[] = [];
    const zooms: ZoomCall[] = [];
    const canvas = renderWith(1, { x: 10, y: 20 }, { onPanChange: (pan) => pans.push(pan), onZoomChange: (zoom, anchor) => zooms.push({ zoom, anchor }) });
    wheel(canvas, { deltaY: 120 });
    expect(pans).toEqual([{ x: 10, y: -100 }]);
    expect(zooms).toHaveLength(0);
  });

  it("Shift+滚轮横向滚动：deltaY 兜底转横向，原生 deltaX 直接生效", () => {
    const pans: { x: number; y: number }[] = [];
    const canvas = renderWith(1, { x: 10, y: 20 }, { onPanChange: (pan) => pans.push(pan), onZoomChange: noop });
    wheel(canvas, { deltaY: 120, shiftKey: true });
    expect(pans).toEqual([{ x: -110, y: 20 }]);
    wheel(canvas, { deltaX: 80, deltaY: 0, shiftKey: true });
    expect(pans[1]).toEqual({ x: -70, y: 20 });
  });

  it("Ctrl+滚轮以光标为锚缩放，且不触发平移", () => {
    const pans: { x: number; y: number }[] = [];
    const zooms: ZoomCall[] = [];
    const canvas = renderWith(1, { x: 0, y: 0 }, { onPanChange: (pan) => pans.push(pan), onZoomChange: (zoom, anchor) => zooms.push({ zoom, anchor }) });
    wheel(canvas, { deltaY: -100, ctrlKey: true, clientX: 50, clientY: 60 });
    expect(pans).toHaveLength(0);
    expect(zooms).toHaveLength(1);
    expect(zooms[0]!.zoom).toBeCloseTo(Math.exp(0.1), 5);
    expect(zooms[0]!.anchor).toEqual({ x: 50, y: 60 });
  });
});
