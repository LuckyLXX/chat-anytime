// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AutomationTask, DesktopSettings } from "../../shared/protocol";
import { AutomationSettings } from "./AutomationSettings";
import { useDesktopStore } from "./store";

/**
 * 结构钩子契约测试（2026-09-27）。
 *
 * 为什么需要：`docs/theme-guide.md` 一直把 `automation-run`（行内「运行一次」）
 * 与 `automation-toggle`（启停）写成公开主题控件，但源码里这两个按钮**从来
 * 没有** `data-control`（同批的 `ssh-host-delete` 也一样）——文档承诺了不存在
 * 的钩子，主题照文档写会静默失效。本轮把属性补齐，用这里钉住它们：
 * 五处镜像（AGENTS.md / docs/theme-guide.md / skill SKILL.md /
 * references/variables.md / check_theme.py）与源码必须一致。
 *
 * 为什么不能用 SSR（`renderToStaticMarkup`）：zustand v5 的 `useStore` 把
 * `getInitialState` 当 server snapshot，设置好 store 再 SSR 渲染仍会拿到**初始
 * 空状态**（实测：任务列表永远渲染成空态，钩子断言假红）。必须走客户端渲染。
 * 交互行为（automation.toggle / automation.run 命令）由各自的运行时单测覆盖。
 */

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
  useDesktopStore.setState({ automation: [], automationRunsSignal: undefined });
});

const settings: DesktopSettings = {
  version: 2,
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  thinkingLevel: "medium",
  accessMode: "ask",
  providers: [],
  agents: [{ id: "default", name: "默认助手", systemPrompt: "", archived: false } as DesktopSettings["agents"][number]],
  currentAgentId: "default",
  appearance: { theme: "system", themePreset: "default", customCss: "", customThemes: [], showThinking: true, showGalleryWall: true },
  browser: { enabled: true },
  ssh: { enabled: true }
};

function task(overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id: "task-1",
    name: "每日新闻日报",
    schedule: { cron: "0 9 * * *" },
    prompt: "汇总今日新闻",
    agentId: "default",
    accessMode: "full",
    enabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides
  };
}

function render(tasks: AutomationTask[]): void {
  useDesktopStore.setState({ automation: tasks, automationRunsSignal: undefined });
  act(() => {
    root.render(
      <AutomationSettings
        models={[]}
        providers={[]}
        settings={settings}
        workspaceConfigured
        onCreateInSession={() => {}}
        onOpenRunSession={() => {}}
      />
    );
  });
}

describe("AutomationSettings theme hooks", () => {
  it("carries the public theme hooks of the automation tab", () => {
    render([task()]);
    expect(container.querySelector("[data-pane=\"automation-settings\"]")).not.toBeNull();
    expect(container.querySelector("[data-control=\"automation-runs-tab\"]")).not.toBeNull();
  });

  it("marks the per-task run and enable controls as contract hooks", () => {
    render([task()]);
    const toggle = container.querySelector("[data-control=\"automation-toggle\"]");
    expect(toggle).not.toBeNull();
    expect(container.querySelector("[data-control=\"automation-run\"]")).not.toBeNull();
    // 启停是开关语义：主题可据 role / aria-checked 区分两态，别只靠类名
    expect(toggle?.getAttribute("role")).toBe("switch");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
  });

  it("reflects the paused state on the same hook", () => {
    render([task({ enabled: false })]);
    expect(container.querySelector("[data-control=\"automation-toggle\"]")?.getAttribute("aria-checked")).toBe("false");
  });

  it("renders no row hooks for an empty list but keeps the tab hooks", () => {
    render([]);
    expect(container.querySelector("[data-control=\"automation-run\"]")).toBeNull();
    expect(container.querySelector("[data-control=\"automation-toggle\"]")).toBeNull();
    expect(container.querySelector("[data-pane=\"automation-settings\"]")).not.toBeNull();
    expect(container.querySelector("[data-control=\"automation-runs-tab\"]")).not.toBeNull();
  });
});
