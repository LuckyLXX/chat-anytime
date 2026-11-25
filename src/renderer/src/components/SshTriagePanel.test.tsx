// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { SshCommand, SshCommandResult, SshHostSummary } from "../../../shared/protocol";
import { sshEndpointKey, type SshTriageBatchSummary } from "../../../shared/ssh-triage";
import { SshPanel } from "./SshPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

it("shows retained evidence as text and saves an editable case on its host card", async () => {
  const host: SshHostSummary = { id: "node-4", name: "测试节点 4", host: "192.0.2.24", username: "ops", port: 22, hasPassword: true };
  const endpoint = sshEndpointKey(host);
  const row = { hostId: host.id, displayName: host.name, endpoint, status: "interrupted" as const, checksDone: 1, checksTotal: 1 };
  const batch: SshTriageBatchSummary = { id: "batch", title: "测试 API 排查", status: "finished", createdAt: 1, checks: [{ kind: "journal", unit: "test-api.service" }], checkLabels: ["日志"], hosts: [row] };
  const card = { hostId: host.id, endpoint, revision: 0, updatedAt: 0, directories: [{ id: "srv", label: "应用目录", path: "/srv/test-api" }], summaries: [] };
  const ssh = vi.fn(async (command: SshCommand): Promise<SshCommandResult> => {
    switch (command.type) {
      case "hosts": return { kind: "hosts", hosts: [host], groups: [], connectedHostIds: [] };
      case "triage.list": return { kind: "triage-batches", batches: [batch] };
      case "triage.detail": return { kind: "triage-detail", detail: { summary: batch, logHostId: host.id, hosts: [{ ...row, checks: [{ kind: "journal", label: "近期错误日志", status: "error", failure: "disconnected", reason: "已保存断线前输出", exitCode: null, outputChars: 44, output: "<strong>日志按原文显示</strong>" }] }] } };
      case "triage.card.get": return { kind: "triage-card", view: { card } };
      case "triage.card.save": return { kind: "triage-card-saved", view: { card: { ...card, revision: 1, summaries: command.summaries } } };
      default: return { kind: "void" };
    }
  });
  vi.stubGlobal("piDesktop", { ssh, onSshHostsChanged: () => () => {}, onSshTriageChanged: () => () => {} });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onConnect = vi.fn();
  try {
    await act(async () => { root.render(<SshPanel onConnect={onConnect} />); });
    const click = async (label: string) => {
      const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === label);
      expect(button).toBeDefined();
      await act(async () => { button!.click(); });
    };
    await click("任务");
    expect(container.textContent).toContain("采集中断");
    expect(container.querySelector("pre")?.textContent).toBe("<strong>日志按原文显示</strong>");
    expect(container.querySelector("pre strong")).toBeNull();
    expect(onConnect).not.toHaveBeenCalled();
    await click("打开终端");
    expect(onConnect).toHaveBeenCalledWith(host);
    await click("记入排查摘要");
    expect(container.querySelector("input[value='测试 API 排查']")).not.toBeNull();
    expect(ssh.mock.calls.some(([command]) => command.type === "triage.card.save")).toBe(false);
    const textarea = container.querySelector("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => { setValue?.call(textarea, "重连并补采日志"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { textarea.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(ssh).toHaveBeenCalledWith(expect.objectContaining({ type: "triage.card.save", summaries: [expect.objectContaining({ batchId: "batch", body: "重连并补采日志" })] }));
    await click("应用目录");
    expect(onConnect).toHaveBeenCalledWith(host, "/srv/test-api");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
