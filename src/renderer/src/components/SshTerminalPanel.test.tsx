// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SshEventData } from "../../../shared/protocol";
import { SshTerminalPanel } from "./SshTerminalPanel";

/**
 * SSH 终端面板：连接状态、密码卡、指纹卡、断线提示位置、文件分屏与终端生命周期。
 *
 * 只替换 xterm 宿主（真 xterm 的剪贴板/选区契约在 `XtermView.test.tsx` 里用真实例测），
 * 连接、密码卡、指纹卡、文件分屏都走真实组件，IPC 用模拟实现。
 *
 * 2026-11-23「SSH 终端选区与剪贴板优化」新增的断言：
 * - 可粘贴状态跟着连接状态走（`canPaste`：只有 connected 才允许粘贴，断线保留复制）；
 * - 断线提示从全屏遮罩改成终端**下方**的状态条（遮罩会拦住输出区鼠标，没法选中复制）；
 * - 断线后「重新连接」重建终端、重新发起连接；指纹卡与文件分屏的既有行为不变。
 */
const xtermProbe = vi.hoisted(() => ({ mounts: 0, canPaste: [] as Array<boolean | undefined>, focus: [] as Array<boolean | undefined> }));

vi.mock("./XtermView", async () => {
  const { useEffect } = await import("react");
  return {
    XtermView: (props: { onReady(api: unknown): void; canPaste?: boolean; focus?: boolean }) => {
      xtermProbe.canPaste.push(props.canPaste);
      xtermProbe.focus.push(props.focus);
      useEffect(() => {
        xtermProbe.mounts += 1;
        props.onReady({ terminal: { cols: 100, rows: 30 }, write: vi.fn() });
      }, []);
      return <div data-testid="xterm-host" />;
    }
  };
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let listeners: Array<(event: SshEventData) => void> = [];
/** 面板（终端）那条订阅：始终是第一个注册的。 */
let listener: ((event: SshEventData) => void) | undefined;
const ssh = vi.fn(async () => ({ kind: "connect" }));
const prompt: SshEventData = { type: "password-required", terminalId: "t", hostId: "h", hostName: "test", host: "1.2.3.4", port: 22, username: "root", reason: "missing" };
beforeEach(() => {
  ssh.mockClear();
  listeners = [];
  listener = undefined;
  xtermProbe.mounts = 0;
  xtermProbe.canPaste.length = 0;
  xtermProbe.focus.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("window", {
    ...globalThis.window,
    piDesktop: {
      ssh,
      onSshData: (_id: string, fn: (event: SshEventData) => void) => {
        listeners.push(fn);
        listener ??= fn;
        return () => {
          const index = listeners.indexOf(fn);
          if (index >= 0) listeners.splice(index, 1);
        };
      }
    }
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function mount(): Promise<void> {
  await act(async () => root.render(<SshTerminalPanel terminalId="t" hostId="h" hostName="test" />));
}
function emit(event: SshEventData): void {
  act(() => listener?.(event));
}
function lastCanPaste(): boolean | undefined {
  return xtermProbe.canPaste[xtermProbe.canPaste.length - 1];
}
it("submits the user's password on the original terminal ID and resumes connecting", async () => {
  await mount();
  act(() => listener?.(prompt));
  expect(ssh).toHaveBeenCalledWith({ type: "connect", terminalId: "t", hostId: "h", cols: 100, rows: 30 });
  const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, "typed-password");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(ssh).toHaveBeenLastCalledWith({ type: "connect", terminalId: "t", hostId: "h", cols: 100, rows: 30, password: "typed-password", rememberPassword: false });
  expect(container.textContent).toContain("正在连接");
  act(() => listener?.({ type: "status", terminalId: "t", status: "connected" }));
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.textContent).toContain("远端文件");
});
it("sends kill when the user cancels the password card", async () => {
  await mount();
  act(() => listener?.(prompt));
  await act(async () => (container.querySelector('[data-control="ssh-password-cancel"]') as HTMLButtonElement).click());
  expect(ssh).toHaveBeenLastCalledWith({ type: "kill", terminalId: "t" });
  expect(container.textContent).toContain("已取消输入密码");
});
it("只在连接建立后允许粘贴（canPaste 跟着连接状态走）", async () => {
  await mount();
  expect(lastCanPaste()).toBe(false);
  emit({ type: "status", terminalId: "t", status: "connected" });
  expect(lastCanPaste()).toBe(true);
  emit({ type: "status", terminalId: "t", status: "closed", detail: "连接已断开" });
  expect(lastCanPaste()).toBe(false);
});
it("断线提示在终端下方（不是遮罩），终端本体仍留在页面上以便复制最后输出", async () => {
  await mount();
  emit({ type: "status", terminalId: "t", status: "connected" });
  emit({ type: "status", terminalId: "t", status: "closed", detail: "链路中断" });
  const bar = container.querySelector(".terminal-status-bar");
  expect(bar).not.toBeNull();
  expect(bar!.textContent).toContain("连接已断开");
  expect(bar!.textContent).toContain("链路中断");
  expect(bar!.textContent).toContain("复制");
  // 不能再出现全屏遮罩式的结束页（inset:0 会挡住输出区的鼠标）。
  expect(container.querySelector(".terminal-ended")).toBeNull();
  expect(container.querySelector(".terminal-paste-confirm")).toBeNull();
  expect(container.querySelector('[data-testid="xterm-host"]')).not.toBeNull();
});
it("断线后「重新连接」重建终端并重新发起连接", async () => {
  await mount();
  emit({ type: "status", terminalId: "t", status: "connected" });
  emit({ type: "status", terminalId: "t", status: "closed", detail: "链路中断" });
  const before = xtermProbe.mounts;
  await act(async () => (container.querySelector(".terminal-status-bar .primary-button") as HTMLButtonElement).click());
  expect(xtermProbe.mounts).toBe(before + 1);
  expect(ssh).toHaveBeenLastCalledWith({ type: "connect", terminalId: "t", hostId: "h", cols: 100, rows: 30 });
  expect(container.querySelector(".terminal-status-bar")).toBeNull();
});
it("指纹卡：信任后带 trustFingerprint 重发连接", async () => {
  await mount();
  emit({ type: "fingerprint", terminalId: "t", fingerprint: "SHA256:abcdef" });
  expect(container.textContent).toContain("SHA256:abcdef");
  await act(async () => (container.querySelector('[data-control="ssh-trust-fingerprint"]') as HTMLButtonElement).click());
  expect(ssh).toHaveBeenLastCalledWith({ type: "connect", terminalId: "t", hostId: "h", cols: 100, rows: 30, trustFingerprint: true });
});
it("打开远端文件分屏只压缩终端高度，不重建终端（剪贴板/选区状态不丢）", async () => {
  await mount();
  emit({ type: "status", terminalId: "t", status: "connected" });
  const before = xtermProbe.mounts;
  await act(async () => (container.querySelector('[data-control="ssh-files-toggle"]') as HTMLButtonElement).click());
  expect(container.querySelector(".ssh-files-splitter")).not.toBeNull();
  expect(container.querySelector(".ssh-files-drawer")).not.toBeNull();
  expect(xtermProbe.mounts).toBe(before);
});
it("卸载后不再收到事件（标签生命周期）", async () => {
  await mount();
  const subscribed = listeners[0];
  expect(subscribed).toBeDefined();
  await act(async () => root.unmount());
  expect(listeners).toHaveLength(0);
  container.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // afterEach 仍会 unmount 这个空 root，避免二次卸载报错。
});
