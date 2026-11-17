// @vitest-environment happy-dom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSelectionPopover } from "./PreviewSelectionPopover";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const send = vi.fn<(selection: { source: string; text: string }, feedback: string) => Promise<void>>();

function Harness(): React.ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref}><div className="preview-scroll"><p>选择的内容</p><input aria-label="编辑控件" /></div><PreviewSelectionPopover rootRef={ref} enabled source="文档.md" onSubmit={send} /></div>;
}

beforeEach(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [{ left: 120, top: 160, right: 200, bottom: 180, width: 80, height: 20 }] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 120, top: 160, right: 200, bottom: 180, width: 80, height: 20 }) });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  send.mockReset();
  send.mockResolvedValue(undefined);
  act(() => root.render(<Harness />));
  vi.spyOn(container.firstElementChild!, "getBoundingClientRect").mockReturnValue({ left: 100, top: 50, right: 500, bottom: 450, width: 400, height: 400 } as DOMRect);
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function selectText(): void {
  const p = container.querySelector("p")!;
  const range = document.createRange();
  range.selectNodeContents(p);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  act(() => p.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 })));
}
function openInput(): HTMLInputElement {
  act(() => document.querySelector<HTMLButtonElement>(".preview-selection-trigger")!.click());
  return document.querySelector<HTMLInputElement>('.preview-selection-popover input')!;
}
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("预览选区浮层", () => {
  it("选中后在原文附近显示按钮，点击后显示紧凑输入框", () => {
    selectText();
    expect(document.querySelector(".preview-selection-trigger")?.textContent).toBe("AI优化");
    const input = openInput();
    expect(document.activeElement).toBe(input);
    expect(document.querySelector(".modal-backdrop")).toBeNull();
  });
  it("输入提交后发送选区快照，不依赖输入时仍有选区", async () => {
    selectText();
    const input = openInput();
    window.getSelection()!.removeAllRanges();
    type(input, "更简洁");
    await act(async () => { input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(send).toHaveBeenCalledWith({ source: "文档.md", text: "选择的内容" }, "更简洁");
    expect(document.querySelector(".preview-selection-popover")).toBeNull();
  });
  it("输入法确认 Enter 不提交，点击外部关闭浮层", () => {
    selectText();
    const input = openInput();
    type(input, "中文");
    const composing = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    act(() => input.dispatchEvent(composing));
    expect(composing.defaultPrevented).toBe(true);
    expect(send).not.toHaveBeenCalled();
    act(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(document.querySelector(".preview-selection-popover")).toBeNull();
  });

  it("失败时保留意见并提示；Esc 不关闭预览标签", async () => {
    send.mockRejectedValue(new Error("会话不可用"));
    selectText();
    const input = openInput();
    type(input, "修改");
    await act(async () => { input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(input.value).toBe("修改");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("会话不可用");
    const close = vi.fn();
    window.addEventListener("keydown", close);
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelector(".preview-selection-popover")).toBeNull();
    window.removeEventListener("keydown", close);
  });
});
