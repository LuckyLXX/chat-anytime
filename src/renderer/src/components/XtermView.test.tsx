// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XtermView, type XtermApi } from "./XtermView";

/**
 * `XtermView` 的剪贴板 / 选区 / 右键 / Esc 契约（2026-11-23「SSH 终端选区与剪贴板优化」）。
 *
 * 夹具策略：**真 xterm**（happy-dom 里 `new Terminal().open()` 可用）+ 模拟剪贴板。
 * 断言落在「终端收到的字节」上（`onInput`），这正是主进程会转给 shell/远端的东西，
 * 能同时证明「没有重复粘贴」「复制没有退化成 ^C」。
 *
 * 局限（写入迭代记录的实测边界）：happy-dom 没有布局，字符格尺寸为 0，所以
 * 真实鼠标拖选轨迹与远端鼠标报告字节在这里测不出来 —— 拖选用 `terminal.select()`
 * 代替，鼠标路由用「xterm 的 mousedown 处理器有没有跑」（`defaultPrevented`）来判定。
 */
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let api: XtermApi | undefined;
let input: string[];
let clipboard: { readText: ReturnType<typeof vi.fn>; writeText: ReturnType<typeof vi.fn> };

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");

beforeEach(() => {
  input = [];
  api = undefined;
  clipboard = {
    readText: vi.fn(async () => ""),
    writeText: vi.fn(async () => undefined)
  };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
  else Reflect.deleteProperty(navigator, "platform");
  Reflect.deleteProperty(navigator, "clipboard");
  vi.restoreAllMocks();
});

async function flush(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(props: { canPaste?: boolean } = {}): Promise<void> {
  await act(async () => {
    root.render(<XtermView onReady={(next) => { api = next; }} onInput={(data) => input.push(data)} onResize={() => undefined} focus {...props} />);
  });
  await flush();
}

/** 重新挂载一次（模拟切标签后回来）：新容器 + 新 root + 新的 input 收集器。 */
async function remount(props: { canPaste?: boolean } = {}): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  input = [];
  api = undefined;
  await mount(props);
}

/** 让终端进入 mac 分支（XtermView 每次渲染按 navigator.platform 判平台）。 */
async function mountAsMac(props: { canPaste?: boolean } = {}): Promise<void> {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  await mount(props);
}

async function renderTerminal(text: string): Promise<void> {
  await act(async () => {
    api!.terminal.write(text);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function textarea(): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>("textarea")!;
}

function xtermElement(): HTMLElement {
  return container.querySelector<HTMLElement>(".xterm")!;
}

/** 发一个键盘事件到 xterm 的 textarea（xterm 的真实按键入口）。 */
function press(target: EventTarget, type: string, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** 常用和弦：keyCode 必须给，xterm 的键盘求值读 keyCode。 */
function chord(key: string, code: number, init: KeyboardEventInit = {}): KeyboardEventInit {
  return { key, keyCode: code, code: `Key${key.toUpperCase()}`, ...init };
}

async function pasteEvent(text: string): Promise<void> {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData?: unknown };
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : "") } });
  act(() => {
    textarea().dispatchEvent(event);
  });
  await flush(5);
}

function contextMenu(): HTMLElement | null {
  return container.querySelector<HTMLElement>(".context-menu");
}

function menuItems(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(".context-menu-item"));
}

function menuItem(label: string): HTMLButtonElement {
  const found = menuItems().find((item) => item.textContent?.includes(label));
  if (!found) throw new Error(`菜单里没有「${label}」`);
  return found;
}

async function openContextMenu(init: MouseEventInit = {}): Promise<MouseEvent> {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 30, ...init });
  act(() => {
    xtermElement().dispatchEvent(event);
  });
  await flush(5);
  return event;
}

describe("复制：有选区复制，无选区中断", () => {
  it("Ctrl+C 有选区时复制、不发 ^C，并在复制成功后清掉选区", async () => {
    await mount();
    await renderTerminal("hello world\r\n");
    api!.terminal.select(0, 0, 5);
    expect(api!.terminal.getSelection()).toBe("hello");

    press(textarea(), "keydown", chord("c", 67, { ctrlKey: true }));
    await flush(5);

    expect(clipboard.writeText).toHaveBeenCalledWith("hello");
    expect(input).toEqual([]);
    expect(api!.terminal.hasSelection()).toBe(false);
  });

  it("复制失败保留选区，并只显示固定文案（不含剪贴板/选区正文）", async () => {
    clipboard.writeText.mockRejectedValue(new Error("denied"));
    await mount();
    await renderTerminal("secret-token\r\n");
    api!.terminal.select(0, 0, 12);

    press(textarea(), "keydown", chord("c", 67, { ctrlKey: true }));
    await flush(5);

    expect(input).toEqual([]);
    expect(api!.terminal.getSelection()).toBe("secret-token");
    const notice = container.querySelector(".terminal-clipboard-notice");
    expect(notice?.textContent).toBe("复制失败，请重试");
    // 提示条只说固定文案：剪贴板/选区正文（这里可能是密码、token）绝不进 DOM 提示。
    expect(notice?.textContent).not.toContain("secret-token");
  });

  it("无选区时 Ctrl+C 照旧发给 shell（^C）", async () => {
    await mount();
    await renderTerminal("$ \r\n");
    press(textarea(), "keydown", chord("c", 67, { ctrlKey: true }));
    await flush(5);
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(input).toEqual(["\u0003"]);
  });

  it("长按复制键不会在清掉选区后退化成中断", async () => {
    await mount();
    await renderTerminal("hello world\r\n");
    api!.terminal.select(0, 0, 5);

    press(textarea(), "keydown", chord("c", 67, { ctrlKey: true }));
    await flush(5);
    // 按住不放：repeat 事件此时已经没有选区，仍然必须被吞掉。
    press(textarea(), "keydown", chord("c", 67, { ctrlKey: true, repeat: true }));
    press(textarea(), "keydown", chord("c", 67, { ctrlKey: true, repeat: true }));
    await flush(5);

    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(input).toEqual([]);
  });

  it("从一开始就没有选区的长按仍然连发中断", async () => {
    await mount();
    await renderTerminal("$ \r\n");
    press(textarea(), "keydown", chord("c", 67, { ctrlKey: true }));
    press(textarea(), "keydown", chord("c", 67, { ctrlKey: true, repeat: true }));
    await flush(5);
    expect(input).toEqual(["\u0003", "\u0003"]);
  });

  it("Ctrl+Shift+C 与 Ctrl+Insert 也是复制", async () => {
    await mount();
    await renderTerminal("hello world\r\n");
    api!.terminal.select(0, 0, 5);
    press(textarea(), "keydown", chord("C", 67, { ctrlKey: true, shiftKey: true }));
    await flush(5);
    expect(clipboard.writeText).toHaveBeenCalledWith("hello");

    await remount();
    await renderTerminal("again\r\n");
    api!.terminal.select(0, 0, 5);
    expect(api!.terminal.getSelection()).toBe("again");
    press(textarea(), "keydown", { key: "Insert", keyCode: 45, code: "Insert", ctrlKey: true });
    await flush(5);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("again");
    expect(input).toEqual([]);
  });

  it("macOS：Cmd+C 复制，裸 Ctrl+C 仍是 ^C", async () => {
    await mountAsMac();
    await renderTerminal("hello world\r\n");
    api!.terminal.select(0, 0, 5);
    press(textarea(), "keydown", chord("c", 67, { metaKey: true }));
    await flush(5);
    expect(clipboard.writeText).toHaveBeenCalledWith("hello");

    await renderTerminal("$ \r\n");
    press(textarea(), "keydown", chord("c", 67, { ctrlKey: true }));
    await flush(5);
    expect(input).toEqual(["\u0003"]);
  });
});

describe("粘贴入口：快捷键 / 菜单 / 原生 paste 各只粘一次", () => {
  it("Ctrl+V 单行直接粘贴", async () => {
    clipboard.readText.mockResolvedValue("ls -la");
    await mount();
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(10);
    expect(input).toEqual(["ls -la"]);
  });

  it("Ctrl+Shift+V 与 Shift+Insert 也是粘贴", async () => {
    clipboard.readText.mockResolvedValue("first");
    await mount();
    press(textarea(), "keydown", chord("V", 86, { ctrlKey: true, shiftKey: true }));
    await flush(10);
    clipboard.readText.mockResolvedValue("second");
    press(textarea(), "keydown", { key: "Insert", keyCode: 45, code: "Insert", shiftKey: true });
    await flush(10);
    expect(input).toEqual(["first", "second"]);
  });

  it("空剪贴板不粘任何东西", async () => {
    clipboard.readText.mockResolvedValue("");
    await mount();
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(10);
    expect(input).toEqual([]);
    expect(input).toHaveLength(0);
  });

  it("原生 paste 事件被捕获并按纯文本粘贴一次（不被 xterm 自己再发一遍）", async () => {
    await mount();
    await renderTerminal("$ \r\n");
    await pasteEvent("echo hi");
    expect(input).toEqual(["echo hi"]);
  });

  it("原生 paste 的多行文本同样先确认", async () => {
    await mount();
    await pasteEvent("a\nb");
    expect(input).toEqual([]);
    expect(container.querySelector(".terminal-paste-confirm")).not.toBeNull();
    act(() => container.querySelectorAll<HTMLButtonElement>(".terminal-paste-confirm button")[0]!.click());
    await flush(5);
    expect(input).toEqual(["a\rb"]);
  });

  it("右键菜单粘贴走同一个入口（并且只调用一次 terminal.paste）", async () => {
    clipboard.readText.mockResolvedValue("pwd");
    await mount();
    const pasteSpy = vi.spyOn(api!.terminal, "paste");
    await openContextMenu();
    act(() => menuItem("粘贴").click());
    await flush(10);
    expect(pasteSpy).toHaveBeenCalledTimes(1);
    expect(pasteSpy).toHaveBeenCalledWith("pwd");
    expect(input).toEqual(["pwd"]);
  });

  it("菜单和快捷键同时按下的旧读取会被下一次触发作废（不会粘两遍）", async () => {
    let resolveFirst: (text: string) => void = () => undefined;
    clipboard.readText.mockImplementationOnce(() => new Promise<string>((resolve) => { resolveFirst = resolve; }));
    await mount();
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(5);
    clipboard.readText.mockResolvedValue("second");
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(10);
    resolveFirst("first");
    await flush(10);
    expect(input).toEqual(["second"]);
  });

  it("阻止 Ctrl+V 的默认粘贴，长按重复事件也只读取并写入一次", async () => {
    clipboard.readText.mockResolvedValue("once");
    await mount();
    const first = press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(10);
    const repeat = press(textarea(), "keydown", chord("v", 86, { ctrlKey: true, repeat: true }));
    await flush(10);
    expect(first.defaultPrevented && repeat.defaultPrevented).toBe(true);
    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(input).toEqual(["once"]);
  });
});

describe("多行粘贴确认", () => {
  it("LF / CRLF / CR 与末尾换行都先确认，确认后才粘贴", async () => {
    for (const text of ["a\nb", "a\r\nb", "a\rb", "ls\n"]) {
      clipboard.readText.mockResolvedValue(text);
      await mount();
      press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
      await flush(10);
      expect(container.querySelector(".terminal-paste-confirm")).not.toBeNull();
      expect(input).toEqual([]);
      act(() => container.querySelectorAll<HTMLButtonElement>(".terminal-paste-confirm button")[0]!.click());
      await flush(5);
      expect(input).toEqual([text.replace(/\r?\n/g, "\r")]);
      await remount();
    }
  });

  it("取消不写入任何内容，并撤掉待粘贴内容", async () => {
    clipboard.readText.mockResolvedValue("rm -rf /\n");
    await mount();
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(10);
    act(() => container.querySelectorAll<HTMLButtonElement>(".terminal-paste-confirm button")[1]!.click());
    await flush(5);
    expect(container.querySelector(".terminal-paste-confirm")).toBeNull();
    expect(input).toEqual([]);
  });

  it("确认框里 Esc 优先关闭它，不会给终端送 Esc", async () => {
    clipboard.readText.mockResolvedValue("a\nb");
    await mount();
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(10);
    expect(document.activeElement?.textContent).toBe("取消");
    const event = press(document.activeElement ?? container, "keydown", { key: "Escape", keyCode: 27, code: "Escape" });
    await flush(5);
    expect(document.activeElement).toBe(textarea());
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector(".terminal-paste-confirm")).toBeNull();
    expect(input).toEqual([]);
  });

  it("bracketed paste 模式开启时由 xterm 补 \u001b[200~…\u001b[201~", async () => {
    clipboard.readText.mockResolvedValue("echo hi");
    await mount();
    await renderTerminal("\u001b[?2004h");
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(10);
    expect(input).toEqual(["\u001b[200~echo hi\u001b[201~"]);
  });
});

describe("连接状态与竞态", () => {
  it("canPaste=false（断线/重连中）时快捷键与菜单粘贴都不动作", async () => {
    clipboard.readText.mockResolvedValue("nope");
    await mount({ canPaste: false });
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(10);
    await openContextMenu();
    expect(menuItem("粘贴").disabled).toBe(true);
    act(() => menuItem("粘贴").click());
    await flush(10);
    expect(clipboard.readText).not.toHaveBeenCalled();
    expect(input).toEqual([]);
  });

  it("断线时仍可复制最后一段输出", async () => {
    await mount();
    await renderTerminal("traceback ...\r\n");
    api!.terminal.select(0, 0, 9);
    await act(async () => {
      root.render(<XtermView onReady={(next) => { api = next; }} onInput={(data) => input.push(data)} onResize={() => undefined} focus canPaste={false} />);
    });
    await flush(5);
    await openContextMenu();
    expect(menuItem("粘贴").disabled).toBe(true);
    expect(menuItem("复制").disabled).toBe(false);
    act(() => menuItem("复制").click());
    await flush(5);
    expect(clipboard.writeText).toHaveBeenCalledWith("traceback");
  });

  it("读取剪贴板期间断线（canPaste 变 false）则丢弃待粘贴内容", async () => {
    let resolveRead: (text: string) => void = () => undefined;
    clipboard.readText.mockImplementation(() => new Promise<string>((resolve) => { resolveRead = resolve; }));
    await mount();
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(5);
    await act(async () => {
      root.render(<XtermView onReady={(next) => { api = next; }} onInput={(data) => input.push(data)} onResize={() => undefined} focus canPaste={false} />);
    });
    resolveRead("stale");
    await flush(10);
    expect(input).toEqual([]);
  });

  it("读取剪贴板期间确认框里的内容在断线后作废", async () => {
    clipboard.readText.mockResolvedValue("a\nb");
    await mount();
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(10);
    expect(container.querySelector(".terminal-paste-confirm")).not.toBeNull();
    await act(async () => {
      root.render(<XtermView onReady={(next) => { api = next; }} onInput={(data) => input.push(data)} onResize={() => undefined} focus canPaste={false} />);
    });
    await flush(5);
    expect(container.querySelector(".terminal-paste-confirm")).toBeNull();
    expect(input).toEqual([]);
  });

  it("卸载（切标签/关标签）后旧读取不会落到任何终端", async () => {
    let resolveRead: (text: string) => void = () => undefined;
    clipboard.readText.mockImplementation(() => new Promise<string>((resolve) => { resolveRead = resolve; }));
    const firstInput: string[] = [];
    await act(async () => {
      root.render(<XtermView onReady={() => undefined} onInput={(data) => firstInput.push(data)} onResize={() => undefined} focus />);
    });
    await flush();
    press(textarea(), "keydown", chord("v", 86, { ctrlKey: true }));
    await flush(5);
    await act(async () => root.unmount());

    // 换到另一个标签（新实例），旧读取这时才回来。
    input = [];
    root = createRoot(container);
    await mount();
    resolveRead("stale");
    await flush(10);
    expect(firstInput).toEqual([]);
    expect(input).toEqual([]);
  });
});

describe("右键菜单、鼠标报告与 Esc 路由", () => {
  it("没有鼠标报告时普通右键打开本地菜单，并拦住浏览器全局菜单", async () => {
    await mount();
    const event = await openContextMenu();
    expect(event.defaultPrevented).toBe(true);
    expect(contextMenu()).not.toBeNull();
    const labels = menuItems().map((item) => item.textContent ?? "");
    expect(labels.some((label) => label.includes("复制"))).toBe(true);
    expect(labels.some((label) => label.includes("粘贴"))).toBe(true);
    expect(labels.some((label) => label.includes("全选"))).toBe(true);
  });

  it("无选区时「复制」置灰，全选后可用", async () => {
    await mount();
    await renderTerminal("hello world\r\n");
    await openContextMenu();
    expect(menuItem("复制").disabled).toBe(true);
    act(() => menuItem("全选").click());
    await flush(5);
    expect(api!.terminal.getSelection().length).toBeGreaterThan(0);
    await openContextMenu();
    expect(menuItem("复制").disabled).toBe(false);
  });

  it("远端开启鼠标报告后：普通右键交给远端，Shift+右键才出本地菜单且不发右键报告", async () => {
    await mount();
    await renderTerminal("\u001b[?1000h");
    await flush(5);
    // 提示条出现（Shift/Option 拖选的可发现性）
    expect(container.querySelector(".terminal-mouse-hint")?.textContent).toContain("Shift+拖选");

    const plain = await openContextMenu();
    expect(contextMenu()).toBeNull();
    expect(plain.defaultPrevented).toBe(true); // 不弹 Chromium 自带菜单，鼠标字节仍由 xterm 上报。

    // 普通右键的 mousedown 由 xterm 自己处理（它会给远端发报告）：defaultPrevented 即证据。
    const plainDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, buttons: 2, clientX: 10, clientY: 10 });
    act(() => { xtermElement().dispatchEvent(plainDown); });
    expect(plainDown.defaultPrevented).toBe(true);

    // Shift+右键：捕获阶段被挡住，xterm 的 mousedown 拿不到（= 不会发右键报告），菜单照常打开。
    const shiftedDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, buttons: 2, shiftKey: true, clientX: 10, clientY: 10 });
    act(() => { xtermElement().dispatchEvent(shiftedDown); });
    expect(shiftedDown.defaultPrevented).toBe(false);
    const shifted = await openContextMenu({ shiftKey: true });
    expect(shifted.defaultPrevented).toBe(true);
    expect(contextMenu()).not.toBeNull();
  });

  it("Esc 先到 xterm（发给 shell），再阻止冒泡到预览（不关标签）", async () => {
    await mount();
    await renderTerminal("$ \r\n");
    const windowListener = vi.fn();
    window.addEventListener("keydown", windowListener);
    try {
      press(textarea(), "keydown", { key: "Escape", keyCode: 27, code: "Escape" });
      await flush(5);
      expect(input).toEqual(["\u001b"]);
      expect(windowListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowListener);
    }
  });

  it("菜单开着时 Esc 只关菜单，不给终端发 Esc", async () => {
    await mount();
    await openContextMenu();
    expect(contextMenu()).not.toBeNull();
    press(document.activeElement instanceof HTMLElement ? document.activeElement : container, "keydown", { key: "Escape", keyCode: 27, code: "Escape" });
    await flush(5);
    expect(contextMenu()).toBeNull();
    expect(input).toEqual([]);
  });

  it("菜单显示平台快捷键提示", async () => {
    await mountAsMac();
    await openContextMenu();
    expect(menuItem("复制").textContent).toContain("⌘C");
    expect(menuItem("粘贴").textContent).toContain("⌘V");
  });
});
