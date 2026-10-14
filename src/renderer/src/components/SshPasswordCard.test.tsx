// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SshPasswordCard, type SshPasswordRequest } from "./SshPasswordCard";

/**
 * SSH 密码输入卡的交互 + 结构钩子契约测试。
 *
 * 为什么单独测它：`SshTerminalPanel` 里挂着真 xterm（`XtermView`），在 happy-dom 下
 * 起不来；卡片被抽成纯受控组件就是为了这里能真的敲字、点按钮，验证「提交了什么」。
 * 钩子（`data-pane="ssh"` / `ssh-password-submit` / `ssh-password-cancel`）是公开主题
 * API，五处镜像（AGENTS.md / theme-guide / SKILL.md / variables.md / check_theme.py）
 * 与这里必须一致。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const missingPassword: SshPasswordRequest = { hostName: "生产服务器", host: "10.0.0.8", port: 2222, username: "root", reason: "missing" };
const authFailed: SshPasswordRequest = { ...missingPassword, reason: "auth-failed", detail: "All configured authentication methods failed" };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function renderCard(request: SshPasswordRequest): { onSubmit: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  act(() => {
    root.render(<SshPasswordCard request={request} onSubmit={onSubmit} onCancel={onCancel} />);
  });
  return { onSubmit, onCancel };
}

function passwordInput(): HTMLInputElement {
  return container.querySelector(".ssh-password-field input") as HTMLInputElement;
}

function rememberBox(): HTMLInputElement {
  return container.querySelector(".ssh-password-remember input") as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
  return container.querySelector("[data-control=\"ssh-password-submit\"]") as HTMLButtonElement;
}

/** 模拟真人输入（React 受控输入必须走原生 setter + input 事件）。 */
function type(text: string): void {
  const input = passwordInput();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

describe("SshPasswordCard", () => {
  it("carries the public theme hooks and shows the target host", () => {
    renderCard(missingPassword);
    expect(container.querySelector("[data-pane=\"ssh\"]")).not.toBeNull();
    expect(container.querySelector("[data-control=\"ssh-password-submit\"]")).not.toBeNull();
    expect(container.querySelector("[data-control=\"ssh-password-cancel\"]")).not.toBeNull();
    expect(container.textContent).toContain("root@10.0.0.8:2222");
    expect(container.textContent).toContain("生产服务器");
  });

  it("keeps submit disabled until a password is typed, then reports password + remember", () => {
    const { onSubmit } = renderCard(missingPassword);
    expect(submitButton().disabled).toBe(true); // 空密码不该能提交（会白跑一次认证）
    type("s3cret");
    expect(submitButton().disabled).toBe(false);
    act(() => rememberBox().click()); // 真实点击：勾选框自己翻转，React 从中读出 remember
    expect(rememberBox().checked).toBe(true);
    act(() => submitButton().click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]).toEqual(["s3cret", true]);
    // 输入框必须是 password 类型（屏幕上不显字），且提交后卡片自己不再持有额外副本
    expect(passwordInput().type).toBe("password");
  });

  it("submits through the form (Enter key path) as well", () => {
    const { onSubmit } = renderCard(missingPassword);
    type("pw");
    const form = container.querySelector("form")!;
    act(() => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    expect(onSubmit.mock.calls[0]).toEqual(["pw", false]);
  });

  it("explains an authentication rejection and clears the old draft", () => {
    const { onSubmit } = renderCard(authFailed);
    expect(container.textContent).toContain("密码认证被拒绝");
    expect(container.textContent).toContain("All configured authentication methods failed");
    type("wrong-again");
    act(() => submitButton().click());
    expect(onSubmit.mock.calls[0]).toEqual(["wrong-again", false]);
    // 重新弹出（同一主机 + 同 reason 变化过一次）时草稿要清空：不再测同一份错密码
    act(() => {
      root.render(<SshPasswordCard request={{ ...authFailed, reason: "missing" }} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    });
    expect(passwordInput().value).toBe("");
    expect(rememberBox().checked).toBe(false);
  });

  it("tells the user when remember-password would use plaintext storage", () => {
    renderCard({ ...missingPassword, credentialInsecure: true });
    expect(container.textContent).toContain("当前环境无法加密，将以明文保存在本机");
    expect(rememberBox().checked).toBe(false);
  });

  it("cancels without submitting anything", () => {
    const { onSubmit, onCancel } = renderCard(missingPassword);
    act(() => (container.querySelector("[data-control=\"ssh-password-cancel\"]") as HTMLButtonElement).click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
