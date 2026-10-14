// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SshEventData } from "../../../shared/protocol";
import { SshTerminalPanel } from "./SshTerminalPanel";

// 只替换 xterm 宿主，连接、密码卡与 IPC 接线使用真实组件。
vi.mock("./XtermView", async () => {
  const { useEffect } = await import("react");
  return {
    XtermView: ({ onReady }: { onReady(api: unknown): void }) => {
      useEffect(() => { onReady({ terminal: { cols: 100, rows: 30 }, write: vi.fn() }); }, []);
      return <div />;
    }
  };
});
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let listener: ((event: SshEventData) => void) | undefined;
const ssh = vi.fn(async () => ({ kind: "connect" }));
const prompt: SshEventData = { type: "password-required", terminalId: "t", hostId: "h", hostName: "test", host: "1.2.3.4", port: 22, username: "root", reason: "missing" };
beforeEach(() => {
  ssh.mockClear();
  listener = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("window", {
    ...globalThis.window,
    piDesktop: { ssh, onSshData: (_id: string, fn: typeof listener) => { listener = fn; return () => { listener = undefined; }; } }
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function mount(): Promise<void> {
  await act(async () => root.render(<SshTerminalPanel terminalId="t" hostId="h" hostName="test" />));
  act(() => listener?.(prompt));
}
it("submits the user's password on the original terminal ID and resumes connecting", async () => {
  await mount();
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
  await act(async () => (container.querySelector('[data-control="ssh-password-cancel"]') as HTMLButtonElement).click());
  expect(ssh).toHaveBeenLastCalledWith({ type: "kill", terminalId: "t" });
  expect(container.textContent).toContain("已取消输入密码");
});
