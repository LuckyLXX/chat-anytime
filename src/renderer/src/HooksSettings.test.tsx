// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookSummary, ResourceCatalog } from "../../shared/protocol";
import { HooksSettings } from "./HooksSettings";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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
  useDesktopStore.setState({ hookNotice: undefined, hookRuns: {} });
  vi.unstubAllGlobals();
});

const hook: HookSummary = {
  name: "项目检查",
  event: "agent_end",
  actionKind: "notify",
  action: { kind: "notify" },
  actionPreview: "桌面通知",
  blocking: false,
  scope: "project",
  trust: "pending",
  enabled: true
};

async function renderHook(summary: HookSummary): Promise<void> {
  const resources = { hooksEnabled: true, hooks: [summary] } as ResourceCatalog;
  await act(async () => {
    root.render(<HooksSettings resources={resources} workspaceOpen />);
  });
}

describe("HooksSettings trust controls", () => {
  it("shows pending approval and sends hooks.trust when approved", async () => {
    const send = vi.fn(async () => undefined);
    vi.stubGlobal("window", { ...globalThis.window, piDesktop: { send } });
    await renderHook(hook);
    expect(container.querySelector('[data-hook-trust="pending"]')?.textContent).toBe("待批准");
    const button = container.querySelector('[data-control="hooks-trust"]') as HTMLButtonElement;
    expect(button.textContent).toContain("批准执行");
    await act(async () => { button.click(); });
    expect(send).toHaveBeenCalledWith({ type: "hooks.trust", name: hook.name, scope: "project", trusted: true });
  });

  it("shows the latest trigger and expands the recent per-rule history", async () => {
    vi.stubGlobal("window", { ...globalThis.window, piDesktop: { send: vi.fn(async () => undefined) } });
    const at = Date.now() - 5_000;
    useDesktopStore.setState({
      hookRuns: {
        "project/项目检查": [
          { name: hook.name, scope: "project", event: "agent_end", ok: true, detail: "最新触发输出", durationMs: 12, source: "trigger", at },
          { name: hook.name, scope: "project", event: "agent_end", ok: false, detail: "测试失败输出", durationMs: 24, source: "test", at: at - 1_000 },
          { name: hook.name, scope: "project", event: "agent_end", ok: true, blocked: true, detail: "旧拦截输出", durationMs: 3, source: "trigger", at: at - 2_000 }
        ]
      }
    });
    await renderHook(hook);

    expect(container.querySelector(".hook-run-latest")?.textContent).toContain("触发");
    expect(container.querySelector(".hook-run-latest")?.textContent).toContain("最新触发输出");
    expect(container.querySelectorAll(".hook-run-entry")).toHaveLength(0);
    const toggle = container.querySelector('[data-control="hooks-run-log"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll(".hook-run-entry")).toHaveLength(3);
    expect(container.textContent).toContain("测试失败输出");
    expect(container.textContent).toContain("旧拦截输出");
  });

  it("shows the trusted state and offers revocation", async () => {
    vi.stubGlobal("window", { ...globalThis.window, piDesktop: { send: vi.fn(async () => undefined) } });
    await renderHook({ ...hook, trust: "trusted" });
    expect(container.querySelector('[data-hook-trust="trusted"]')?.textContent).toBe("已信任");
    expect(container.querySelector('[data-control="hooks-trust"]')?.textContent).toContain("撤销信任");
  });
});
