// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalEventData } from "../../../shared/protocol";
import { TerminalPanel } from "./TerminalPanel";

/**
 * 本地 PTY 终端：剪贴板能力与 SSH 远端**共用**同一个 `XtermView`，这里钉住
 * 「复制/粘贴的字节确实经 `onInput` 走上行 IPC」（2026-11-23 起的共享行为），
 * 避免以后有人给本地终端另写一套宿主时把这条通路漏掉。
 *
 * 夹具：真 xterm（happy-dom 可跑）+ 模拟 IPC + 模拟剪贴板。
 */
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let terminalCalls: Array<{ type: string; terminalId: string; data?: string }>;
let emit: ((event: TerminalEventData) => void) | undefined;
let clipboard: { readText: ReturnType<typeof vi.fn>; writeText: ReturnType<typeof vi.fn> };

beforeEach(() => {
  terminalCalls = [];
  emit = undefined;
  clipboard = { readText: vi.fn(async () => ""), writeText: vi.fn(async () => undefined) };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  // 不要整体替换 window（xterm 依赖真实的 window/document）：只挂一条模拟 IPC。
  Object.defineProperty(window, "piDesktop", {
    configurable: true,
    value: {
      terminal: async (command: { type: string; terminalId: string; data?: string }) => {
        terminalCalls.push({ type: command.type, terminalId: command.terminalId, ...(command.data !== undefined ? { data: command.data } : {}) });
        return { kind: command.type };
      },
      onTerminalData: (_id: string, fn: (event: TerminalEventData) => void) => {
        emit = fn;
        return () => { emit = undefined; };
      }
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(window, "piDesktop");
});

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(): Promise<void> {
  await act(async () => root.render(<TerminalPanel terminalId="local-1" />));
  await flush();
}

describe("本地 PTY 终端的剪贴板通路", () => {
  it("Ctrl+V 粘贴的文本经 onInput 走上行 IPC", async () => {
    clipboard.readText.mockResolvedValue("npm test");
    await mount();
    expect(terminalCalls[0]).toMatchObject({ type: "create", terminalId: "local-1" });
    const textarea = container.querySelector("textarea")!;
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "v", keyCode: 86, code: "KeyV", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await flush(10);
    expect(terminalCalls.filter((call) => call.type === "input")).toEqual([{ type: "input", terminalId: "local-1", data: "npm test" }]);
  });

  it("有选区时 Ctrl+C 复制而不是把 ^C 发给本地进程", async () => {
    await mount();
    act(() => emit?.({ type: "data", terminalId: "local-1", data: "hello world\r\n" }));
    await flush(10);
    // 选区用右键菜单的「全选」（happy-dom 没有布局，拖不出真实选区；菜单全选走的就是 terminal.selectAll）。
    const xterm = container.querySelector(".xterm")!;
    act(() => { xterm.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    await flush(5);
    const selectAll = Array.from(container.querySelectorAll<HTMLButtonElement>(".context-menu-item")).find((item) => item.textContent?.includes("全选"))!;
    act(() => selectAll.click());
    await flush(5);
    const textarea = container.querySelector("textarea")!;
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "c", keyCode: 67, code: "KeyC", ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await flush(5);
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(String(clipboard.writeText.mock.calls[0]?.[0])).toContain("hello world");
    // Ctrl+C 没有变成 ^C（上行 IPC 里不应该有任何 input）。
    expect(terminalCalls.filter((call) => call.type === "input")).toEqual([]);
  });
});
