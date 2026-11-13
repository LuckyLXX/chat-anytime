import { describe, expect, it } from "vitest";
import type { DesktopSettings, ImChannelConfig } from "../../../shared/protocol.js";
import { settingsAfterDialogClose } from "./settings-rollback.js";

/**
 * 设置弹窗关闭时的回滚口径（2026-11-13）。
 *
 * 钉住的是用户实际踩到的那条：自定义通道保存成功（磁盘已生效），关掉设置再打开却
 * 变成「还没有自定义通道 + 总开关没开」。根因是弹窗拿打开时的快照整包回滚，把主进程
 * 已经落盘的 `settings.im` 也还原了。
 */

function settings(patch: Partial<DesktopSettings> = {}): DesktopSettings {
  return {
    version: 2,
    thinkingLevel: "medium",
    accessMode: "ask",
    providers: [],
    agents: [],
    currentAgentId: "default",
    appearance: { theme: "system", themePreset: "default", customCss: "", customThemes: [], motion: true, showThinking: true, showGalleryWall: true },
    ...patch
  };
}

const CUSTOM: ImChannelConfig = {
  id: "custom-ab12cd",
  kind: "custom",
  enabled: true,
  label: "内网工单",
  appId: "",
  host: "127.0.0.1",
  port: 8799,
  allowFrom: ["zhangsan"],
  accessMode: "workspace"
};

describe("settingsAfterDialogClose", () => {
  it("弹窗打开期间主进程保存的 IM 通道不会被回滚掉（本例：基线里没有 im）", () => {
    const baseline = settings();
    const live = settings({ im: { enabled: true, channels: [CUSTOM] } });
    const restored = settingsAfterDialogClose(baseline, live);
    expect(restored.im).toEqual({ enabled: true, channels: [CUSTOM] });
  });

  it("总开关与通道列表都以主进程拼出来的 live 值为准（不是打开时的旧列表）", () => {
    const old: ImChannelConfig = { ...CUSTOM, id: "custom-old", label: "旧通道" };
    const baseline = settings({ im: { enabled: false, channels: [old] } });
    const live = settings({ im: { enabled: true, channels: [CUSTOM] } });
    expect(settingsAfterDialogClose(baseline, live).im).toEqual({ enabled: true, channels: [CUSTOM] });
  });

  it("主进程把最后一条通道删掉（live 没有 im）时，回滚也不会把它复活", () => {
    const baseline = settings({ im: { enabled: true, channels: [CUSTOM] } });
    const restored = settingsAfterDialogClose(baseline, settings());
    expect(restored.im).toBeUndefined();
    expect("im" in restored).toBe(false);
  });

  it("其它草稿键仍然回滚到打开时的值（取消语义不变）", () => {
    const baseline = settings({ accessMode: "ask", thinkingLevel: "medium" });
    const live = settings({ accessMode: "full", thinkingLevel: "high" });
    const restored = settingsAfterDialogClose(baseline, live);
    expect(restored.accessMode).toBe("ask");
    expect(restored.thinkingLevel).toBe("medium");
  });

  it("返回的是新对象：改回滚结果不会污染 live 里的 im", () => {
    const live = settings({ im: { enabled: true, channels: [CUSTOM] } });
    const restored = settingsAfterDialogClose(settings(), live);
    restored.im!.channels[0]!.label = "改坏了";
    expect(live.im?.channels[0]?.label).toBe("内网工单");
  });
});
