// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewSelectionDialog } from "./PreviewSelectionDialog";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const cancel = vi.fn();
const submit = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  cancel.mockClear();
  submit.mockClear();
  act(() => root.render(<PreviewSelectionDialog selection={{ source: "docs/a.md", text: "  原文\n第二行" }} onCancel={cancel} onSubmit={submit} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function input(): HTMLTextAreaElement {
  return container.querySelector("textarea")!;
}

function type(value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("预览选区修改弹窗", () => {
  it("展示来源和选区、自动聚焦，空意见不能提交", () => {
    expect(container.textContent).toContain("docs/a.md");
    expect(container.querySelector("pre")?.textContent).toBe("  原文\n第二行");
    expect(document.activeElement).toBe(input());
    expect(input().maxLength).toBe(2000);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });

  it("Ctrl+Enter 提交意见；普通 Enter 留作多行输入", () => {
    type("第一条\n第二条");
    const plain = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => input().dispatchEvent(plain));
    expect(submit).not.toHaveBeenCalled();
    const shortcut = new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => input().dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(true);
    expect(submit).toHaveBeenCalledWith("第一条\n第二条");
  });

  it("Escape 取消并阻止预览面板的 window 监听器关闭标签", () => {
    const closeTab = vi.fn();
    window.addEventListener("keydown", closeTab);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => input().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
    window.removeEventListener("keydown", closeTab);
  });

  it("点击发送或取消分别调用对应回调", () => {
    type("改短一点");
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(submit).toHaveBeenCalledWith("改短一点");
    act(() => container.querySelector<HTMLButtonElement>('button[type="button"]')!.click());
    expect(cancel).toHaveBeenCalledOnce();
  });
});
