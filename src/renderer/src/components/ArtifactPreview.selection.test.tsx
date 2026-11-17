// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactPreview } from "./ArtifactPreview";

vi.mock("./RichContent", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
  MarkdownPreviewContent: ({ content }: { content: string }) => <p>{content}</p>
}));
vi.mock("./MemoryPreview", () => ({ MemoryPreviewContent: () => null }));
vi.mock("./MarkdownOutline", () => ({ MarkdownOutline: () => null }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const onSelectionSubmit = vi.fn(async () => undefined);

beforeEach(() => {
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [{ left: 120, top: 160, right: 200, bottom: 180, width: 80, height: 20 }] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 120, top: 160, right: 200, bottom: 180, width: 80, height: 20 }) });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onSelectionSubmit.mockClear();
  act(() => root.render(<ArtifactPreview
    tabs={[{ id: "p1", target: { type: "plan", title: "计划 A", content: "要修改的内容" } }]}
    activeTabId="p1" onSelectTab={vi.fn()} onCloseTab={vi.fn()} onOpenArtifact={vi.fn()}
    onSelectionSubmit={onSelectionSubmit}
  />));
  vi.spyOn(container.querySelector(".content-preview-body")!, "getBoundingClientRect").mockReturnValue({ left: 100, top: 50, right: 500, bottom: 450, width: 400, height: 400 } as DOMRect);
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("预览内容选区", () => {
  it("选中后出现按钮，输入意见提交时带上来源与原文", async () => {
    const paragraph = container.querySelector(".preview-markdown p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    act(() => paragraph.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 })));
    act(() => document.querySelector<HTMLButtonElement>(".preview-selection-trigger")!.click());
    const input = document.querySelector<HTMLInputElement>(".preview-selection-popover input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setter.call(input, "修改"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(onSelectionSubmit).toHaveBeenCalledWith({ source: "计划 A", text: "要修改的内容" }, "修改");
  });

  it("普通右键不被拦截", () => {
    const paragraph = container.querySelector(".preview-markdown p")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => paragraph.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });
});
