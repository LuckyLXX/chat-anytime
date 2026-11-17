// @vitest-environment happy-dom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PREVIEW_SELECTION_LENGTH } from "../shared/preview-selection.js";

vi.mock("electron", () => ({ ipcRenderer: { on: vi.fn(), send: vi.fn() } }));

let dispatchContextMenu: (event: MouseEvent) => void;
let send: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const add = vi.spyOn(window, "addEventListener");
  await import("./browser-pick.js");
  const registration = add.mock.calls.find(([type, , capture]) => type === "contextmenu" && capture === true);
  expect(registration).toBeDefined();
  dispatchContextMenu = registration![1] as (event: MouseEvent) => void;
  send = vi.mocked((await import("electron")).ipcRenderer.send);
  add.mockRestore();
});

beforeEach(() => {
  send.mockClear();
  document.body.innerHTML = '<p id="content">原文</p><input id="input"><div contenteditable="true">编辑</div>';
});

function eventFor(target: Element, trusted = true): MouseEvent {
  return {
    isTrusted: trusted,
    composedPath: () => [target, document.body, document, window],
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn()
  } as unknown as MouseEvent;
}

function setSelection(text: string): void {
  vi.spyOn(document, "getSelection").mockReturnValue({ toString: () => text } as Selection);
}

describe("网页右键选区捕获", () => {
  it("在 capture 阶段同步抓取原文、截断并阻止页面右键", () => {
    setSelection("  选中\n" + "甲".repeat(MAX_PREVIEW_SELECTION_LENGTH));
    const event = eventFor(document.querySelector("#content")!);
    dispatchContextMenu(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("browser-preview:selection-result", expect.objectContaining({ text: expect.stringMatching(/^  选中\n/) }));
    expect(send.mock.calls[0]![1].text).toHaveLength(MAX_PREVIEW_SELECTION_LENGTH);
    vi.restoreAllMocks();
  });

  it("无选区、页面伪造事件、编辑控件都不拦截", () => {
    const paragraph = document.querySelector("#content")!;
    setSelection("  \n");
    const empty = eventFor(paragraph);
    dispatchContextMenu(empty);
    expect(empty.preventDefault).not.toHaveBeenCalled();
    setSelection("残留选区");
    const synthetic = eventFor(paragraph, false);
    const input = eventFor(document.querySelector("input")!);
    const editable = eventFor(document.querySelector("[contenteditable]")!);
    for (const event of [synthetic, input, editable]) {
      dispatchContextMenu(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(send).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
