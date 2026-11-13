// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings, ImChannelConfig, RuntimeCommand } from "../../shared/protocol";
import { ImCustomChannelSettings } from "./ImCustomChannelSettings";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 自定义通道详情面板（2026-11-13，随「消息通道」两段式布局改造）。
 *
 * 列表（飞书 + 自定义通道）搬到父级左栏之后，本组件的契约变成「只编辑当前选中的那条」，
 * 这里钉住四类会静默出事的地方：Token 只在这一次 IPC 里出现（明文不能留在渲染端状态里）、
 * 保存载荷的 kind/id（写错就变成一条飞书通道）、切换选中项必须按 store 的权威配置重置
 * （否则上一条的字段串到这一条）、保存成功不关表单且删除走后级回调。
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

const OTHER: ImChannelConfig = {
  ...CUSTOM,
  id: "custom-ef34gh",
  label: "另一个通道",
  port: 8788
};

let container: HTMLDivElement;
let root: Root;
let sent: RuntimeCommand[];
let nav: { deleted: string[]; canceled: string[] };

function seed(overrides: { channels?: ImChannelConfig[]; enabled?: boolean; imStatus?: unknown; imTest?: unknown } = {}): void {
  const settings: DesktopSettings = {
    ...baseSettings(),
    im: { enabled: overrides.enabled ?? true, channels: overrides.channels ?? [CUSTOM] }
  };
  useDesktopStore.setState({
    settings,
    imStatus: overrides.imStatus as never,
    imTest: overrides.imTest as never,
    imSave: undefined,
    snapshot: { ...useDesktopStore.getState().snapshot, workspace: "D:/ws" }
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sent = [];
  nav = { deleted: [], canceled: [] };
  vi.stubGlobal("piDesktop", { send: async (command: RuntimeCommand) => { sent.push(command); } });
  vi.stubGlobal("confirm", () => true);
  seed();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: {
  channelId?: string;
  channel?: ImChannelConfig;
  initialToken?: string;
  masterEnabled?: boolean;
} = {}): void {
  act(() => root.render(
    <ImCustomChannelSettings
      channelId={"channelId" in props ? props.channelId : CUSTOM.id}
      channel={"channel" in props ? props.channel : CUSTOM}
      initialToken={props.initialToken}
      masterEnabled={props.masterEnabled ?? true}
      onDeleted={(id) => nav.deleted.push(id)}
      onCancelCreate={(id) => nav.canceled.push(id)}
    />
  ));
}

function change(element: HTMLElement, value: string): void {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function input(control: string): HTMLInputElement {
  const element = container.querySelector(`[data-control="${control}"]`);
  if (!element) throw new Error(`找不到控件 ${control}`);
  return element as HTMLInputElement;
}

/** 模拟主进程回执（im.save-result，requestId 取自刚才那条保存命令）。 */
function ackSave(result: { ok: boolean; channel?: ImChannelConfig; error?: string } = { ok: true }): void {
  const save = [...sent].reverse().find((command) => command.type === "im.channel.save");
  if (!save || save.type !== "im.channel.save") throw new Error("还没有发出 im.channel.save");
  act(() => {
    useDesktopStore.getState().handleRuntimeMessage({
      type: "im.save-result",
      requestId: save.requestId,
      ok: result.ok,
      ...(result.channel ? { channel: result.channel } : {}),
      ...(result.error ? { error: result.error } : {})
    });
  });
}

describe("ImCustomChannelSettings", () => {
  it("没有选中通道时给空态（不渲染空气表单）", () => {
    render({ channelId: undefined, channel: undefined });
    expect(container.textContent).toContain("还没有选中通道");
    expect(container.querySelector('[data-control="im-custom-save"]')).toBeNull();
  });

  it("已保存通道：表单回填、显示运行地址，检查与删除的载荷带 channelId", () => {
    seed({
      imStatus: { enabled: true, channels: [{ channelId: CUSTOM.id, state: "connected", updatedAt: 1, endpoint: "http://127.0.0.1:8787/v1" }] }
    });
    render();
    expect(input("im-custom-label").value).toBe("内网工单");
    expect(input("im-custom-port").value).toBe("8787");
    expect(input("im-custom-enabled").checked).toBe(true);
    expect((container.querySelector('[data-control="im-custom-allowfrom"]') as HTMLTextAreaElement).value).toContain("zhangsan");
    expect(container.textContent).toContain("http://127.0.0.1:8787/v1");
    expect(container.textContent).toContain("运行中");

    act(() => [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("检查"))!.click());
    const test = sent.find((command) => command.type === "im.channel.test");
    expect(test?.type === "im.channel.test" && test.channelId).toBe(CUSTOM.id);

    act(() => (container.querySelector('[data-control="im-custom-delete"]') as HTMLButtonElement).click());
    const remove = sent.find((command) => command.type === "im.channel.delete");
    expect(remove?.type === "im.channel.delete" && remove.channelId).toBe(CUSTOM.id);
    // 删除后的导航交给父级（它负责把选中项挪回飞书）。
    expect(nav.deleted).toEqual([CUSTOM.id]);
  });

  it("新建草稿：Token 预填，保存载荷是 kind=custom 且 Token 只在这一条 IPC 里；成功后不关表单", () => {
    render({ channelId: "custom-new1", channel: undefined, initialToken: "generated-token-123456" });
    expect(input("im-custom-token").value).toBe("generated-token-123456");
    expect(container.querySelector('[data-control="im-custom-delete"]')).toBeNull();
    // 新建时给「取消」，由父级丢掉草稿。
    act(() => [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === "取消")!.click());
    expect(nav.canceled).toEqual(["custom-new1"]);

    change(input("im-custom-port"), "8790");
    change(container.querySelector('[data-control="im-custom-allowfrom"]') as HTMLTextAreaElement, "zhangsan, lisi");
    act(() => input("im-custom-enabled").click());
    act(() => (container.querySelector('[data-control="im-custom-save"]') as HTMLButtonElement).click());

    const save = [...sent].reverse().find((command) => command.type === "im.channel.save");
    expect(save?.type).toBe("im.channel.save");
    if (save?.type !== "im.channel.save") throw new Error("没有发出保存命令");
    expect(save.channel).toMatchObject({ kind: "custom", id: "custom-new1", enabled: true, port: 8790, host: "127.0.0.1", allowFrom: ["zhangsan", "lisi"] });
    expect(save.appSecret).toBe("generated-token-123456");
    expect(save.enabled).toBe(true);

    ackSave({ ok: true, channel: { ...save.channel, appSecretConfigured: true } });
    // 两段式布局里保存成功不关表单：详情常驻、显示已保存、明文输入框清空。
    expect(container.querySelector('[data-control="im-custom-save"]')).not.toBeNull();
    expect(container.querySelector(".im-channel-saved")).toBeTruthy();
    expect(input("im-custom-token").value).toBe("");
  });

  it("切换选中项时按 store 里的权威配置重置草稿（上一条的字段不串进来）", () => {
    render();
    change(input("im-custom-label"), "改了但不保存");
    expect(input("im-custom-label").value).toBe("改了但不保存");

    render({ channelId: OTHER.id, channel: OTHER });
    expect(input("im-custom-label").value).toBe("另一个通道");
    expect(input("im-custom-port").value).toBe("8788");
  });

  it("总开关关着时明确提示「保存也不会监听」", () => {
    render({ masterEnabled: false });
    expect(container.textContent).toContain("总开关没开");
  });

  it("主进程错误如实显示在表单里（不假装保存成功）", () => {
    render();
    act(() => (container.querySelector('[data-control="im-custom-save"]') as HTMLButtonElement).click());
    ackSave({ ok: false, error: "系统加密存储不可用，接入 Token 未保存（重启后需要重新填写）" });
    expect(container.querySelector(".im-channel-save-error")?.textContent).toContain("接入 Token 未保存");
    expect(container.querySelector(".im-channel-saved")).toBeNull();
  });
});
