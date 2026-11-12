// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings, ImChannelConfig, RuntimeCommand } from "../../shared/protocol";
import { ImChannelSettings, parseAllowFromInput } from "./ImChannelSettings";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 设置页「消息通道」的回归网。
 *
 * 钉住四类静默失效：保存载荷里混进明文 secret（会写进 settings.json）、白名单
 * 逗号/换行没解析（保存成一条垃圾 open_id）、测试连接命令没带草稿值（用户改了
 * App ID 却测的是旧配置）、状态徽标不跟 imStatus（连上了仍显示未连接）。
 */

/** 最小可用设置（只填本页会读的字段；其它字段用类型占位）。 */
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

const FEISHU: ImChannelConfig = {
  id: "feishu",
  kind: "feishu",
  enabled: true,
  appId: "cli_saved",
  appSecretConfigured: true,
  allowFrom: ["ou_owner"],
  accessMode: "workspace",
  approvalTimeoutMs: 600_000
};

let container: HTMLDivElement;
let root: Root;
let sent: RuntimeCommand[];

function seed(overrides: { im?: DesktopSettings["im"]; imStatus?: unknown; imTest?: unknown } = {}): void {
  const settings: DesktopSettings = {
    ...baseSettings(),
    ...(overrides.im !== undefined ? { im: overrides.im } : {})
  };
  useDesktopStore.setState({
    settings,
    imStatus: overrides.imStatus as never,
    imTest: overrides.imTest as never,
    snapshot: { ...useDesktopStore.getState().snapshot, workspace: "D:/ws" }
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sent = [];
  vi.stubGlobal("piDesktop", {
    send: async (command: RuntimeCommand) => { sent.push(command); }
  });
  seed({ im: { enabled: true, channels: [FEISHU] } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(): void {
  act(() => root.render(<ImChannelSettings />));
}

function input(control: string): HTMLInputElement {
  const element = container.querySelector(`[data-control="${control}"]`);
  if (!element) throw new Error(`找不到控件 ${control}`);
  return element as HTMLInputElement;
}

/** 模拟主进程回执（im.save-result）：面板只认这条来显示「已保存」。 */
function ackSave(result: { ok: boolean; channel?: ImChannelConfig; enabled?: boolean; error?: string } = { ok: true }): void {
  const save = [...sent].reverse().find((command) => command.type === "im.channel.save");
  if (!save || save.type !== "im.channel.save") throw new Error("还没有发出 im.channel.save");
  act(() => {
    useDesktopStore.getState().handleRuntimeMessage({
      type: "im.save-result",
      requestId: save.requestId,
      ok: result.ok,
      ...(result.channel ? { channel: result.channel } : {}),
      ...(result.enabled !== undefined ? { enabled: result.enabled } : {}),
      ...(result.error ? { error: result.error } : {})
    });
  });
}

function change(element: HTMLElement, value: string): void {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value");
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("parseAllowFromInput", () => {
  it("splits on commas/newlines/semicolons, trims and de-duplicates", () => {
    expect(parseAllowFromInput("ou_a, ou_b\nou_c；ou_a\n\n ou_d ")).toEqual(["ou_a", "ou_b", "ou_c", "ou_d"]);
    expect(parseAllowFromInput("   ")).toEqual([]);
  });
});

describe("ImChannelSettings", () => {
  it("renders the saved channel into the form and exposes the theme hooks", () => {
    render();
    expect(container.querySelector('[data-pane="im-channel-settings"]')).toBeTruthy();
    expect(input("im-feishu-appid").value).toBe("cli_saved");
    expect(input("im-channel-enable").checked).toBe(true);
    expect(input("im-feishu-enabled").checked).toBe(true);
    expect((container.querySelector('[data-control="im-feishu-allowfrom"]') as HTMLTextAreaElement).value).toContain("ou_owner");
    expect((container.querySelector('[data-control="im-feishu-access"]') as HTMLSelectElement).value).toBe("workspace");
  });

  it("saves the channel without the plaintext secret and parses the allowlist", () => {
    render();
    change(container.querySelector('[data-control="im-feishu-allowfrom"]') as HTMLTextAreaElement, "ou_a\nou_b, ou_a");
    change(input("im-feishu-secret"), "s3cret");
    act(() => input("im-feishu-save").click());
    const save = sent.find((command) => command.type === "im.channel.save");
    expect(save).toBeTruthy();
    if (save?.type !== "im.channel.save") throw new Error("not a save command");
    expect(save.appSecret).toBe("s3cret");
    expect(save.enabled).toBe(true);
    expect(save.channel.allowFrom).toEqual(["ou_a", "ou_b"]);
    expect(save.channel).not.toHaveProperty("appSecret");
    expect(save.channel.appSecretConfigured).toBe(true);
    expect(save.channel.id).toBe("feishu");
    expect(save.channel.kind).toBe("feishu");
    // 保存后输入框清空（明文不在渲染端驻留）。
    expect(input("im-feishu-secret").value).toBe("");

    // 回执之前不能出现「已保存」（旧实现靠 300ms 计时器假装成功）。
    expect(container.querySelector(".im-channel-saved")).toBeNull();
    ackSave({ ok: true, channel: { ...save.channel, appSecretConfigured: true }, enabled: true });
    expect(container.querySelector(".im-channel-saved")).toBeTruthy();
    // 认证状态由回执里的权威配置回填：密钥输入框的占位提示恢复「已保存」。
    expect((container.querySelector('[data-control="im-feishu-secret"]') as HTMLInputElement).placeholder).toContain("已保存");
    expect(container.querySelector(".im-channel-save-error")).toBeNull();
  });

  it("shows the main process error instead of claiming success", () => {
    render();
    act(() => input("im-feishu-save").click());
    ackSave({ ok: false, error: "系统加密存储不可用，App Secret 未保存（重启后需要重新填写）" });
    expect(container.querySelector(".im-channel-saved")).toBeNull();
    expect(container.querySelector(".im-channel-save-error")?.textContent).toContain("App Secret 未保存");
  });

  it("asks for the current status on mount (badge may be stale after a renderer reload)", () => {
    render();
    expect(sent.some((command) => command.type === "im.status")).toBe(true);
  });

  it("warns when the saved allowlist is empty (the bot would refuse every message)", () => {
    seed({ im: { enabled: true, channels: [{ ...FEISHU, allowFrom: [] }] } });
    render();
    expect(container.querySelector(".im-channel-warning")?.textContent).toContain("白名单还空着");
  });

  it("sends the master switch state with the save", () => {
    render();
    act(() => input("im-channel-enable").click());
    act(() => input("im-feishu-save").click());
    const save = sent.find((command) => command.type === "im.channel.save");
    expect(save?.type === "im.channel.save" && save.enabled).toBe(false);
    ackSave({ ok: true, channel: FEISHU, enabled: false });
  });

  it("tests the connection with the draft App ID (not the stale saved one)", () => {
    render();
    change(input("im-feishu-appid"), "cli_draft");
    act(() => input("im-feishu-test").click());
    const test = sent.find((command) => command.type === "im.channel.test");
    expect(test?.type === "im.channel.test" && test.appId).toBe("cli_draft");
    expect(test?.type === "im.channel.test" && test.channelId).toBe("feishu");
  });

  it("shows the live status badge (connected + bot name) and the last test result", () => {
    seed({
      im: { enabled: true, channels: [FEISHU] },
      imStatus: { enabled: true, channels: [{ channelId: "feishu", state: "connected", botName: "值班机器人", updatedAt: 1 }] },
      imTest: { requestId: "r1", ok: true, message: "已连接机器人「值班机器人」", latencyMs: 42, at: 1 }
    });
    render();
    const badge = container.querySelector(".im-channel-badge");
    expect(badge?.textContent).toContain("已连接");
    expect(badge?.textContent).toContain("值班机器人");
    expect(container.querySelector(".im-channel-test-ok")?.textContent).toContain("42ms");
  });

  it("surfaces a connection error and the exact platform message", () => {
    seed({
      im: { enabled: true, channels: [FEISHU] },
      imStatus: { enabled: true, channels: [{ channelId: "feishu", state: "error", message: "握手失败（code 10003）", updatedAt: 1 }] }
    });
    render();
    expect(container.querySelector(".im-channel-badge-error")?.textContent).toContain("连接失败");
    expect(container.querySelector(".im-channel-status-error")?.textContent).toContain("code 10003");
  });

  it("shows 未启用 when the master switch is off (regardless of channel state)", () => {
    seed({ im: { enabled: false, channels: [{ ...FEISHU, enabled: true }] }, imStatus: { enabled: false, channels: [{ channelId: "feishu", state: "connected", updatedAt: 1 }] } });
    render();
    expect(container.querySelector(".im-channel-badge")?.textContent).toContain("未启用");
  });

  it("starts from an empty draft when nothing is configured", () => {
    seed({ im: undefined });
    render();
    expect(input("im-channel-enable").checked).toBe(false);
    expect(input("im-feishu-enabled").checked).toBe(false);
    expect(input("im-feishu-appid").value).toBe("");
    expect((container.querySelector('[data-control="im-feishu-access"]') as HTMLSelectElement).value).toBe("workspace");
    expect(container.querySelector(".im-channel-badge")?.textContent).toContain("未启用");
  });
});
