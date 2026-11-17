// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { readPreviewDomSelection } from "./preview-selection";

function select(start: Node, end: Node): Selection {
  const range = document.createRange();
  range.setStart(start, 0);
  range.setEnd(end, end.textContent?.length ?? 0);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("DOM 预览右键选区", () => {
  it("只读取当前预览文本区的有效选区", () => {
    document.body.innerHTML = '<div id="root"><div class="preview-scroll"><p>  第一行</p><p>第二行</p></div></div>';
    const root = document.querySelector<HTMLElement>("#root")!;
    const paragraphs = root.querySelectorAll("p");
    const selection = select(paragraphs[0]!.firstChild!, paragraphs[1]!.firstChild!);
    const result = readPreviewDomSelection(root, paragraphs[0]!, selection);
    expect(result).toContain("第一行");
    expect(result).toContain("第二行");
  });

  it("拒绝空选区、跨预览区选区与预览外目标", () => {
    document.body.innerHTML = '<div id="root"><div class="preview-scroll"><p>正文</p></div><div class="preview-scroll"><p>其他</p></div></div><p id="outside">外部</p>';
    const root = document.querySelector<HTMLElement>("#root")!;
    const [first, second] = root.querySelectorAll("p");
    expect(readPreviewDomSelection(root, first!, null)).toBeUndefined();
    expect(readPreviewDomSelection(root, first!, select(first!.firstChild!, second!.firstChild!))).toBeUndefined();
    expect(readPreviewDomSelection(root, document.querySelector("#outside"), select(first!.firstChild!, first!.firstChild!))).toBeUndefined();
  });

  it("不拦截编辑器、按钮或输入框，即使仍有旧选区", () => {
    document.body.innerHTML = '<div id="root"><div class="preview-scroll"><p>正文</p><button>复制</button><input><div contenteditable="true">编辑</div></div></div>';
    const root = document.querySelector<HTMLElement>("#root")!;
    const paragraph = root.querySelector("p")!;
    const selection = select(paragraph.firstChild!, paragraph.firstChild!);
    for (const control of root.querySelectorAll("button, input, [contenteditable]")) {
      expect(readPreviewDomSelection(root, control, selection)).toBeUndefined();
    }
    const editText = root.querySelector("[contenteditable]")!.firstChild!;
    expect(readPreviewDomSelection(root, paragraph, select(editText, editText))).toBeUndefined();
  });
});
