// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureBrowserSelection, resolveBrowserSelectionReply, setBrowserSelectionAutomation, setBrowserSelectionPickMode } from "./browser-selection-ui.js";

let shadow: ShadowRoot;
const send = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  setBrowserSelectionPickMode(false);
  setBrowserSelectionAutomation(false);
  vi.advanceTimersByTime(250);
  document.body.innerHTML = '<p id="content">  原文</p><input id="input">';
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [{ left: 40, top: 80, right: 120, bottom: 100, width: 80, height: 20 }] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => ({ left: 40, top: 80, right: 120, bottom: 100, width: 80, height: 20 }) });
  const original = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, init) { shadow = original.call(this, init); return shadow; });
  send.mockReset();
});
afterEach(() => {
  document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function eventFor(target: Element, trusted = true): Event {
  return { isTrusted: trusted, composedPath: () => [target, document.body, document, window] } as unknown as Event;
}
function select(): Element {
  const target = document.querySelector("#content")!;
  const range = document.createRange();
  range.selectNodeContents(target);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
  return target;
}

describe("网页选区就地浮层", () => {
  it("选中后显示按钮，输入提交并按请求 ID 接收回执", () => {
    const target = select();
    captureBrowserSelection(document, eventFor(target), send);
    expect(shadow.querySelector("button")?.textContent).toBe("AI优化");
    shadow.querySelector("button")!.click();
    const input = shadow.querySelector("input")!;
    input.value = "更简洁";
    shadow.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ text: "  原文", note: "更简洁", requestId: expect.any(String) });
    expect(input.disabled).toBe(true);
    resolveBrowserSelectionReply({ requestId: "wrong", ok: true });
    expect(input.disabled).toBe(true);
    const requestId = send.mock.calls[0]![0].requestId;
    resolveBrowserSelectionReply({ requestId, ok: false, error: "会话不可用" });
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("更简洁");
    expect(shadow.querySelector('[role="alert"]')?.textContent).toContain("会话不可用");
    resolveBrowserSelectionReply({ requestId, ok: true });
    expect(document.querySelector("[data-pi-selection]")).toBeNull();
  });

  it("自动化期间隐藏现有浮层，结束后的保护窗口届满才恢复", () => {
    const target = select();
    captureBrowserSelection(document, eventFor(target), send);
    const host = document.querySelector<HTMLElement>("[data-pi-selection]")!;
    setBrowserSelectionAutomation(true);
    expect(host.style.display).toBe("none");
    setBrowserSelectionAutomation(false);
    vi.advanceTimersByTime(249);
    expect(host.style.display).toBe("none");
    vi.advanceTimersByTime(1);
    expect(host.style.display).toBe("");
  });

  it("回执超时提示状态不确定并保留原意见", () => {
    captureBrowserSelection(document, eventFor(select()), send);
    shadow.querySelector("button")!.click();
    const input = shadow.querySelector("input")!;
    input.value = "继续修改";
    shadow.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    vi.advanceTimersByTime(15_000);
    expect(input.value).toBe("继续修改");
    expect(input.disabled).toBe(false);
    expect(shadow.querySelector('[role="alert"]')?.textContent).toContain("状态未确认");
  });

  it("自动化、页面伪造事件与输入控件不显示按钮", () => {
    const target = select();
    setBrowserSelectionAutomation(true);
    captureBrowserSelection(document, eventFor(target), send);
    expect(document.querySelector("[data-pi-selection]")).toBeNull();
    setBrowserSelectionAutomation(false);
    vi.advanceTimersByTime(250);
    captureBrowserSelection(document, eventFor(target, false), send);
    captureBrowserSelection(document, eventFor(document.querySelector("input")!), send);
    expect(document.querySelector("[data-pi-selection]")).toBeNull();
  });
});
