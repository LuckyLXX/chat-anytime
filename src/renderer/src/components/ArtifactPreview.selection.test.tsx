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
const onSelectionRequest = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  onSelectionRequest.mockClear();
  act(() => root.render(<ArtifactPreview
    tabs={[{ id: "p1", target: { type: "plan", title: "计划 A", content: "要修改的内容" } }]}
    activeTabId="p1" onSelectTab={vi.fn()} onCloseTab={vi.fn()} onOpenArtifact={vi.fn()}
    onSelectionRequest={onSelectionRequest}
  />));
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  act(() => root.unmount());
  container.remove();
});

function select(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
}

describe("预览内容右键", () => {
  it("选中文本右键上报来源、原文和坐标", () => {
    const paragraph = container.querySelector(".preview-markdown p")!;
    select(paragraph);
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 42, clientY: 64 });
    act(() => paragraph.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(onSelectionRequest).toHaveBeenCalledWith({ source: "计划 A", text: "要修改的内容", clientX: 42, clientY: 64 });
  });

  it("没有有效选区时不拦截右键", () => {
    const paragraph = container.querySelector(".preview-markdown p")!;
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => paragraph.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(onSelectionRequest).not.toHaveBeenCalled();
  });
});
