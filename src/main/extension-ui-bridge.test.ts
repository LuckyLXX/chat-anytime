import { describe, expect, it, vi } from "vitest";
import type { ExtensionUiDialogRequest } from "../shared/protocol.js";
import { DesktopExtensionUiBridge } from "./extension-ui-bridge.js";

function createFixture(): {
  bridge: DesktopExtensionUiBridge;
  requests: ExtensionUiDialogRequest[];
  dismissed: string[];
  states: ReturnType<DesktopExtensionUiBridge["snapshot"]>[];
} {
  const requests: ExtensionUiDialogRequest[] = [];
  const dismissed: string[] = [];
  const states: ReturnType<DesktopExtensionUiBridge["snapshot"]>[] = [];
  const bridge = new DesktopExtensionUiBridge({
    request: (request) => requests.push(request),
    dismiss: (id) => dismissed.push(id),
    notify: () => undefined,
    stateChanged: (state) => states.push(state)
  });
  return { bridge, requests, dismissed, states };
}

describe("DesktopExtensionUiBridge", () => {
  it("translates extension confirmation into a desktop request", async () => {
    const { bridge, requests, dismissed } = createFixture();
    const confirmation = bridge.context.confirm("运行项目 Agent？", "项目配置可以执行工具");

    expect(requests[0]).toMatchObject({ method: "confirm", title: "运行项目 Agent？" });
    bridge.resolve({ id: requests[0]!.id, confirmed: true });

    await expect(confirmation).resolves.toBe(true);
    expect(dismissed).toEqual([requests[0]!.id]);
  });

  it("returns the default value when a dialog is aborted", async () => {
    const { bridge, requests, dismissed } = createFixture();
    const controller = new AbortController();
    const selection = bridge.context.select("选择 Agent", ["scout", "worker"], { signal: controller.signal });

    controller.abort();

    await expect(selection).resolves.toBeUndefined();
    expect(dismissed).toEqual([requests[0]!.id]);
  });

  it("forwards notifications without creating a pending dialog", () => {
    const notify = vi.fn();
    const bridge = new DesktopExtensionUiBridge({ request: () => undefined, dismiss: () => undefined, notify });

    bridge.context.notify("扩展已加载", "info");

    expect(notify).toHaveBeenCalledWith("扩展已加载", "info");
  });

  it("records terminal input as unsupported without warning on registration", () => {
    const notify = vi.fn();
    const bridge = new DesktopExtensionUiBridge({ request: () => undefined, dismiss: () => undefined, notify });

    const unsubscribe = bridge.context.onTerminalInput(() => undefined);
    unsubscribe();

    expect(bridge.snapshot().unsupported).toContain("raw-terminal-input");
    expect(notify).not.toHaveBeenCalled();
  });

  it("still warns for active unsupported UI requests", () => {
    const notify = vi.fn();
    const bridge = new DesktopExtensionUiBridge({ request: () => undefined, dismiss: () => undefined, notify });

    bridge.context.setTheme("missing-theme");

    expect(notify).toHaveBeenCalledWith("扩展请求了 PiDesktop 暂不支持的 TUI 能力：tui-theme-switching", "warning");
  });

  it("publishes RPC-compatible status and string widget state", () => {
    const { bridge, states } = createFixture();

    bridge.context.setStatus("worker", "正在索引");
    bridge.context.setWidget("summary", ["任务 3/5", "等待 worker"], { placement: "belowEditor" });
    bridge.context.setTitle("Pi - current project");

    expect(bridge.snapshot()).toMatchObject({
      statuses: { worker: "正在索引" },
      title: "Pi - current project",
      widgets: [{ key: "summary", lines: ["任务 3/5", "等待 worker"], placement: "belowEditor" }]
    });
    expect(states).toHaveLength(3);
  });

  it("keeps a synchronous editor cache and cancels all dialogs", async () => {
    const composer = vi.fn();
    const requests: ExtensionUiDialogRequest[] = [];
    const bridge = new DesktopExtensionUiBridge({ request: (request) => requests.push(request), dismiss: () => undefined, notify: () => undefined, composer });
    bridge.syncEditorText("draft");
    bridge.context.pasteToEditor(" text");
    expect(bridge.context.getEditorText()).toBe("draft text");
    expect(composer).toHaveBeenCalledWith(expect.objectContaining({ method: "pasteToEditor", text: " text" }));

    const first = bridge.context.input("one");
    const second = bridge.context.confirm("two", "continue");
    bridge.cancelPendingDialogs();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBe(false);
    expect(requests).toHaveLength(2);
  });
});
