// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keepPreviewSelectionHighlighted } from "./selection-highlight";

class TestHighlight {
  constructor(readonly range: Range) {}
}
class TestSheet {
  rule = "";
  replaceSync(rule: string): void { this.rule = rule; }
}
let registry: Map<string, Highlight>;
let sheets: CSSStyleSheet[];
let cssDescriptor: PropertyDescriptor | undefined;
let highlightDescriptor: PropertyDescriptor | undefined;
let sheetDescriptor: PropertyDescriptor | undefined;
let adoptedDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  registry = new Map();
  sheets = [];
  cssDescriptor = Object.getOwnPropertyDescriptor(window, "CSS");
  highlightDescriptor = Object.getOwnPropertyDescriptor(window, "Highlight");
  sheetDescriptor = Object.getOwnPropertyDescriptor(window, "CSSStyleSheet");
  adoptedDescriptor = Object.getOwnPropertyDescriptor(document, "adoptedStyleSheets");
  Object.defineProperty(window, "CSS", { configurable: true, value: { highlights: registry } });
  Object.defineProperty(window, "Highlight", { configurable: true, value: TestHighlight });
  Object.defineProperty(window, "CSSStyleSheet", { configurable: true, value: TestSheet });
  Object.defineProperty(document, "adoptedStyleSheets", { configurable: true, get: () => sheets, set: (next) => { sheets = next; } });
  document.body.innerHTML = "<p>选中文字</p>";
});

afterEach(() => {
  const restore = (target: object, key: string, descriptor?: PropertyDescriptor): void => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  };
  restore(window, "CSS", cssDescriptor);
  restore(window, "Highlight", highlightDescriptor);
  restore(window, "CSSStyleSheet", sheetDescriptor);
  restore(document, "adoptedStyleSheets", adoptedDescriptor);
  document.body.replaceChildren();
});

describe("输入期间保留预览选区高亮", () => {
  it("保存原 Range、使用主题选区颜色，并只清理自己创建的高亮和样式", () => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    const unrelated = new TestSheet() as unknown as CSSStyleSheet;
    sheets.push(unrelated);
    const release = keepPreviewSelectionHighlighted(document, range, true);
    expect(registry.size).toBe(1);
    expect((Array.from(registry.values())[0] as unknown as TestHighlight).range).toBe(range);
    expect((sheets[1] as unknown as TestSheet).rule).toContain("var(--selection-bg");
    document.getSelection()?.removeAllRanges();
    expect(registry.size).toBe(1);
    release();
    release();
    expect(registry.size).toBe(0);
    expect(sheets).toEqual([unrelated]);
  });

  it("多个高亮互不清理，网页使用独立的透明背景", () => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("p")!);
    const first = keepPreviewSelectionHighlighted(document, range, false);
    const second = keepPreviewSelectionHighlighted(document, range, false);
    expect(registry.size).toBe(2);
    expect((sheets[0] as unknown as TestSheet).rule).toContain("rgba(");
    first();
    expect(registry.size).toBe(1);
    expect(sheets).toHaveLength(1);
    second();
    expect(registry.size).toBe(0);
    expect(sheets).toHaveLength(0);
  });

  it("环境不支持时安全回退，不影响输入或页面", () => {
    Object.defineProperty(window, "CSS", { configurable: true, value: {} });
    const range = document.createRange();
    expect(() => keepPreviewSelectionHighlighted(document, range, true)()).not.toThrow();
    expect(sheets).toHaveLength(0);
  });
});
