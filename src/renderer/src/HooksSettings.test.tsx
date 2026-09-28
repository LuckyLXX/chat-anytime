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

  it("预填模板，并只在观察型事件的命令上暴露「等待完成」", async () => {
    vi.stubGlobal("window", { ...globalThis.window, piDesktop: { send: vi.fn(async () => undefined) } });
    await renderHook(hook);
    await act(async () => { (container.querySelector('[data-control="hooks-add"]') as HTMLButtonElement).click(); });

    const templates = [...container.querySelectorAll('[data-control="hooks-template"]')];
    expect(templates).toHaveLength(6);
    const format = templates.find((item) => item.getAttribute("data-hook-template") === "format-after-edit") as HTMLButtonElement;
    await act(async () => { format.click(); });

    const form = container.querySelector('.hook-form')!;
    const field = (name: string) => [...form.querySelectorAll('label')].find((label) => label.textContent.trim().startsWith(name));
    expect((field("名称")?.querySelector('input') as HTMLInputElement).value).toBe("改完即格式化");
    expect((field("触发事件")?.querySelector('select') as HTMLSelectElement).value).toBe("tool_execution_end");
    expect((field("工具匹配")?.querySelector('input') as HTMLInputElement).value).toBe("write|edit");
    // 观察型事件 + 命令动作：看得到「等待完成」
    const waitBox = [...form.querySelectorAll('.checkbox-setting')].find((item) => item.textContent.includes("等待完成"));
    expect(waitBox).toBeTruthy();
    expect((waitBox?.querySelector('input') as HTMLInputElement).checked).toBe(false);
    expect(form.textContent).toContain("精确工具名集合");

    // 换成「工具调用前」：等待开关消失，阻断型出现（该事件本来就要等结果）
    const eventSelect = field("触发事件")!.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(eventSelect, "tool_call");
      eventSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const checkboxes = [...form.querySelectorAll('.checkbox-setting')];
    expect(checkboxes.some((item) => item.textContent.includes("等待完成"))).toBe(false);
    expect(checkboxes.some((item) => item.textContent.includes("阻断型"))).toBe(true);
  });

  it("shows the trusted state and offers revocation", async () => {
    vi.stubGlobal("window", { ...globalThis.window, piDesktop: { send: vi.fn(async () => undefined) } });
    await renderHook({ ...hook, trust: "trusted" });
    expect(container.querySelector('[data-hook-trust="trusted"]')?.textContent).toBe("已信任");
    expect(container.querySelector('[data-control="hooks-trust"]')?.textContent).toContain("撤销信任");
  });
});
