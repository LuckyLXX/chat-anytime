// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SshHostSummary } from "../../../shared/protocol";
import { SshPanel } from "./SshPanel";

/**
 * 结构钩子契约测试（2026-09-27）。
 *
 * 为什么需要：`docs/theme-guide.md` 与 skill 的检查器一直把
 * `data-control="ssh-host-delete"` 写成公开主题控件，但 `SshPanel` 的删除按钮
 * **从来没有**这个属性（只有 `.ghost-button.ghost-icon.danger` 类名）——文档
 * 承诺了不存在的钩子。本轮补齐属性，并用这里钉住「已有 + 新增」两类钩子：
 * 主机列表是异步拉取的（`ssh { type: "hosts" }`），所以必须桩住 IPC 等它落地，
 * 否则删除按钮根本不在 DOM 里（SSR 首屏只有加载骨架）。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const host: SshHostSummary = {
  id: "host-1",
  name: "测试主机",
  host: "10.0.0.8",
  port: 22,
  username: "root",
  hasPassword: true
};

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
  vi.unstubAllGlobals();
});

async function renderHosts(hosts: SshHostSummary[]): Promise<void> {
  vi.stubGlobal("window", {
    ...globalThis.window,
    piDesktop: {
      ssh: vi.fn(async () => ({ kind: "hosts", hosts, groups: [], connectedHostIds: [] }))
    }
  });
  await act(async () => {
    root.render(<SshPanel onConnect={() => {}} />);
  });
  // 主机清单落地后再刷一帧，避免断言读到加载骨架
  await act(async () => {});
}

describe("SshPanel theme hooks", () => {
  it("carries the public theme hooks of the SSH host panel", async () => {
    await renderHosts([host]);
    expect(container.querySelector("[data-pane=\"ssh\"]")).not.toBeNull();
    // 首屏（列表态）就能看到的钩子
    for (const control of ["ssh-host-create", "ssh-host-connect", "ssh-host-delete", "ssh-group-create"]) {
      expect(container.querySelector(`[data-control="${control}"]`), `${control} 钩子缺失`).not.toBeNull();
    }
  });

  it("keeps the save hook inside the host form (only present while editing)", async () => {
    await renderHosts([host]);
    expect(container.querySelector("[data-control=\"ssh-host-save\"]")).toBeNull();
    const create = container.querySelector("[data-control=\"ssh-host-create\"]") as HTMLButtonElement;
    await act(async () => { create.click(); });
    expect(container.querySelector("[data-control=\"ssh-host-save\"]")).not.toBeNull();
  });

  it("keeps the delete action distinguishable for themes (danger class + aria-label)", async () => {
    await renderHosts([host]);
    const remove = container.querySelector("[data-control=\"ssh-host-delete\"]");
    expect(remove?.getAttribute("aria-label")).toBe(`删除 ${host.name}`);
    expect(remove?.className).toContain("danger");
  });
});
