// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuestionItem, QuestionRequest } from "../../../shared/protocol";
import { QuestionPanel } from "./QuestionPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function request(id = "q1"): QuestionRequest {
  const question: QuestionItem = { text: "下一步怎么走？", type: "single", options: ["先做 MVP", "先写方案"] };
  return { id, sessionId: "s1", toolCallId: "t1", questions: [question] };
}

function render(next: QuestionRequest): void {
  act(() => { root.render(<QuestionPanel request={next} />); });
}

function panel(): HTMLElement {
  const element = container.querySelector<HTMLElement>(".question-panel");
  if (!element) throw new Error("question panel not rendered");
  return element;
}

function collapseButton(): HTMLButtonElement {
  const element = panel().querySelector<HTMLButtonElement>(".question-collapse");
  if (!element) throw new Error("collapse button not rendered");
  return element;
}

function click(element: Element): void {
  act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

describe("QuestionPanel collapse toggle", () => {
  it("starts expanded and exposes the collapse affordance", () => {
    render(request());
    expect(panel().dataset.collapsed).toBe("false");
    expect(collapseButton().getAttribute("aria-expanded")).toBe("true");
    expect(collapseButton().getAttribute("aria-label")).toBe("收起问题面板");
    expect(container.querySelector(".question-options")).not.toBeNull();
    expect(container.querySelector(".question-custom-row")).not.toBeNull();
  });

  it("keeps only the header row when collapsed, so the covered text becomes readable", () => {
    render(request());
    click(collapseButton());
    expect(panel().dataset.collapsed).toBe("true");
    expect(collapseButton().getAttribute("aria-expanded")).toBe("false");
    expect(collapseButton().getAttribute("aria-label")).toBe("展开问题面板");
    // 题目与页码仍在（知道有待答问题），正文一律卸载。
    expect(container.querySelector(".question-title")?.textContent).toBe("下一步怎么走？");
    expect(container.querySelector(".question-options")).toBeNull();
    expect(container.querySelector(".question-custom-row")).toBeNull();
    expect(container.querySelector(".question-panel-footer")).toBeNull();
    // 折叠态页码箭头不渲染（选项不可见时翻页没有意义）。
    expect(container.querySelector('[aria-label="上一题"]')).toBeNull();
  });

  it("expands again from the toggle button and from the collapsed header row", () => {
    render(request());
    click(collapseButton());
    click(collapseButton());
    expect(panel().dataset.collapsed).toBe("false");
    expect(container.querySelector(".question-options")).not.toBeNull();

    click(collapseButton());
    click(panel().querySelector(".question-panel-header")!);
    expect(panel().dataset.collapsed).toBe("false");
    expect(container.querySelector(".question-custom-row")).not.toBeNull();
  });

  it("opens the next question expanded", () => {
    render(request("q1"));
    click(collapseButton());
    expect(panel().dataset.collapsed).toBe("true");
    // 新提问（id 变化）必须重新展开，否则用户可能完全看不到新问题。
    render(request("q2"));
    expect(panel().dataset.collapsed).toBe("false");
    expect(container.querySelector(".question-options")).not.toBeNull();
  });
});
