// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings, ImChannelConfig, RuntimeCommand } from "../../shared/protocol";
import { ImCustomChannelSettings } from "./ImCustomChannelSettings";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 自定义通道面板的回归网（2026-11-12）。
 *
 * 钉住四类会静默出事的地方：保存载荷的 kind/id（写错就变成一条飞书通道）、Token 只在
 * 这一次 IPC 里出现（明文不能留在渲染端状态里）、删除前要有二次确认（删掉等于删密钥）、
 * 以及「总开关没开」必须显式提示（否则用户以为脚本能连上）。
 */

function baseSettings(): DesktopSettings {
  return {
    version: 2,
    thinkingLevel: "medium",
    accessMode: "ask",
    providers: [],
    agents: [],
    currentAgentId: "default",
    appearance: { theme: "system", themePreset: "default", customCss: "", customThemes: [], motion: true, showThinking: true, showGalleryWall: true }
  };
}

const CUSTOM: ImChannelConfig = {
  id: "custom-ab12cd",
  kind: "custom",
  enabled: true,
  label: "内网工单",
  appId: "",
  host: "127.0.0.1",
  port: 8787,
  appSecretConfigured: true,
  allowFrom: ["zhangsan"],
  accessMode: "workspace",
  approvalTimeoutMs: 600_000
};

let container: HTMLDivElement;
let root: Root;
let sent: RuntimeCommand[];

function seed(overrides: { channels?: ImChannelConfig[]; enabled?: boolean; imStatus?: unknown } = {}): void {
  const settings: DesktopSettings = {
    ...baseSettings(),
    im: { enabled: overrides.enabled ?? true, channels: overrides.channels ?? [] }
  };
  useDesktopStore.setState({
    settings,
    imStatus: overrides.imStatus as never,
    imSave: undefined,
    imTest: undefined,
    snapshot: { ...useDesktopStore.getState().snapshot, workspace: "D:/ws" }
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sent = [];
  vi.stubGlobal("piDesktop", { send: async (command: RuntimeCommand) => { sent.push(command); } });
  vi.stubGlobal("confirm", () => true);
  seed();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(masterEnabled = true): void {
  act(() => root.render(<ImCustomChannelSettings masterEnabled={masterEnabled} />));
}

function change(element: HTMLElement, value: string): void {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`找不到按钮：${text}`);
  return found as HTMLButtonElement;
}

describe("ImCustomChannelSettings", () => {
  it("没配置时给空态与「添加通道」入口", () => {
    render();
    expect(container.textContent).toContain("还没有自定义通道");
    expect(container.querySelector('[data-control="im-custom-add"]')).not.toBeNull();
  });

  it("新建并保存：载荷是 kind=custom、带 host/port/白名单，Token 只在这一条 IPC 里", () => {
    render();
    act(() => buttonByText("添加通道").click());
    // 表单出现后：填端口与白名单，再保存
    change(container.querySelector('[data-control="im-custom-port"]') as HTMLInputElement, "8787");
    change(container.querySelector('[data-control="im-custom-allowfrom"]') as HTMLTextAreaElement, "zhangsan, lisi");
    act(() => (container.querySelector('[data-control="im-custom-enabled"]') as HTMLInputElement).click());
    act(() => (container.querySelector('[data-control="im-custom-save"]') as HTMLButtonElement).click());

    const save = sent.find((command) => command.type === "im.channel.save");
    expect(save?.type).toBe("im.channel.save");
    if (save?.type !== "im.channel.save") throw new Error("没有发出保存命令");
    expect(save.channel).toMatchObject({ kind: "custom", enabled: true, port: 8787, host: "127.0.0.1", allowFrom: ["zhangsan", "lisi"] });
    expect(save.channel.id).toMatch(/^custom-[0-9a-z]{6}$/u);
    expect(typeof save.appSecret).toBe("string");
    expect((save.appSecret ?? "").length).toBeGreaterThanOrEqual(16);
    // 明文只出现在这一条 IPC 里：保存不额外发命令，也不把 Token 写进任何本地状态。
    expect(sent).toHaveLength(1);
  });

  it("已配置的通道显示脚本地址与状态；删除要二次确认并带上 channelId", () => {
    seed({
      channels: [CUSTOM],
      imStatus: { enabled: true, channels: [{ channelId: CUSTOM.id, state: "connected", updatedAt: 1, endpoint: "http://127.0.0.1:8787/v1" }] }
    });
    render();
    expect(container.textContent).toContain("内网工单");
    expect(container.textContent).toContain("http://127.0.0.1:8787/v1");
    expect(container.textContent).toContain("运行中");

    act(() => (container.querySelector('[data-control="im-custom-delete"]') as HTMLButtonElement).click());
    const remove = sent.find((command) => command.type === "im.channel.delete");
    expect(remove?.type === "im.channel.delete" && remove.channelId).toBe(CUSTOM.id);
  });

  it("删除后主进程推回 im.settings：列表那一行立刻消失（不是等下次启动）", () => {
    seed({ channels: [CUSTOM] });
    render();
    act(() => (container.querySelector('[data-control="im-custom-delete"]') as HTMLButtonElement).click());
    expect(sent.find((command) => command.type === "im.channel.delete")).toBeTruthy();
    // 主进程删完之后推权威快照（磁盘上已经没有这条通道）。
    act(() => {
      useDesktopStore.getState().handleRuntimeMessage({ type: "im.settings", im: { enabled: true, channels: [] } });
    });
    expect(container.querySelector(".im-custom-row")).toBeNull();
    expect(container.textContent).toContain("还没有自定义通道");
  });

  it("总开关关着时明确提示「保存也不会监听」", () => {
    render(false);
    expect(container.textContent).toContain("总开关没开");
  });

  it("检查按钮走 im.channel.test（自定义通道的「测试」= 看服务在不在）", () => {
    seed({ channels: [CUSTOM] });
    render();
    act(() => buttonByText("检查").click());
    const test = sent.find((command) => command.type === "im.channel.test");
    expect(test?.type === "im.channel.test" && test.channelId).toBe(CUSTOM.id);
  });

  it("主进程回执到达才关表单（不靠本地计时器假装保存成功）", () => {
    render();
    act(() => buttonByText("添加通道").click());
    act(() => (container.querySelector('[data-control="im-custom-save"]') as HTMLButtonElement).click());
    const save = sent.find((command) => command.type === "im.channel.save");
    if (save?.type !== "im.channel.save") throw new Error("没有发出保存命令");
    // 回执没来之前仍在编辑态
    expect(container.querySelector('[data-control="im-custom-save"]')).not.toBeNull();
    seed({ channels: [{ ...CUSTOM, id: save.channel.id }] });
    act(() => {
      useDesktopStore.setState({ imSave: { requestId: save.requestId, ok: true, at: Date.now(), channel: save.channel } as never });
    });
    render();
    expect(container.querySelector('[data-control="im-custom-save"]')).toBeNull();
  });
});
