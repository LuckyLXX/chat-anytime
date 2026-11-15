// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionItem, QuestionRequest } from "../../../shared/protocol";
import { QuestionPanel } from "./QuestionPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const FEEDBACK = "不批准，继续完善计划";

let container: HTMLDivElement;
let root: Root;
const send = vi.fn(async (_command: unknown): Promise<void> => undefined);

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  send.mockClear();
  (window as unknown as { piDesktop: { send: typeof send } }).piDesktop = { send };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function planRequest(): QuestionRequest {
  const question: QuestionItem = {
    text: "请审查这份计划",
    type: "single",
    options: ["批准计划，开始实施", "批准计划，移交新会话实施", "保留计划文档，暂不实施", FEEDBACK],
    detail: "# 计划\n\n步骤",
    feedbackOption: FEEDBACK
  };
  return { id: "q1", sessionId: "s1", toolCallId: "t1", questions: [question] };
}

function render(request: QuestionRequest = planRequest()): void {
  act(() => { root.render(<QuestionPanel request={request} />); });
}

function click(element: Element): void {
  act(() => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

function optionButton(label: string): HTMLButtonElement {
  const element = [...container.querySelectorAll<HTMLButtonElement>(".question-option")].find((button) => button.textContent?.includes(label));
  if (!element) throw new Error(`option not rendered: ${label}`);
  return element;
}

function feedbackRow(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".question-feedback-row");
}

function feedbackInput(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>(".question-feedback-input");
  if (!element) throw new Error("feedback input not rendered");
  return element;
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(input: Element, key: string): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("QuestionPanel feedback option", () => {
  it("opens a feedback row on click instead of submitting, and focuses the input", () => {
    render();
    click(optionButton(FEEDBACK));
    expect(feedbackRow()).not.toBeNull();
    expect(container.querySelector(".question-custom-row")).toBeNull();
    expect(optionButton(FEEDBACK).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(feedbackInput());
    expect(send).not.toHaveBeenCalled();
  });

  it("submits the typed opinion as the answer on Enter", async () => {
    render();
    click(optionButton(FEEDBACK));
    type(feedbackInput(), "步骤拆细一点，补上验收方式");
    await press(feedbackInput(), "Enter");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({ type: "question.resolve", id: "q1", answers: ["步骤拆细一点，补上验收方式"] });
  });

  it("submits the option text when the opinion is left blank", async () => {
    render();
    click(optionButton(FEEDBACK));
    await press(feedbackInput(), "Enter");
    expect(send.mock.calls[0]![0]).toEqual({ type: "question.resolve", id: "q1", answers: [FEEDBACK] });
  });

  it("returns to the option list on Escape without submitting", async () => {
    render();
    click(optionButton(FEEDBACK));
    type(feedbackInput(), "先写测试");
    await press(feedbackInput(), "Escape");
    expect(feedbackRow()).toBeNull();
    expect(container.querySelector(".question-custom-row")).not.toBeNull();
    expect(optionButton(FEEDBACK).getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector<HTMLInputElement>(".question-custom-row input")?.value).toBe("");
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps ordinary options one-click (approval still submits immediately)", () => {
    render();
    click(optionButton("批准计划，开始实施"));
    expect(feedbackRow()).toBeNull();
    expect(send.mock.calls[0]![0]).toEqual({ type: "question.resolve", id: "q1", answers: ["批准计划，开始实施"] });
  });
});
