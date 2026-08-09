import { describe, expect, it, vi } from "vitest";
import type { ExtensionUiDialogRequest } from "../shared/protocol.js";
import { DesktopExtensionUiBridge } from "./extension-ui-bridge.js";

function createFixture(): {
  bridge: DesktopExtensionUiBridge;
  requests: ExtensionUiDialogRequest[];
  dismissed: string[];
} {
  const requests: ExtensionUiDialogRequest[] = [];
  const dismissed: string[] = [];
  const bridge = new DesktopExtensionUiBridge({
    request: (request) => requests.push(request),
    dismiss: (id) => dismissed.push(id),
    notify: () => undefined
  });
  return { bridge, requests, dismissed };
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
});
