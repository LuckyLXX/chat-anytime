// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AutomationTask, DesktopSettings, RecentWorkspace, SessionSummary } from "../../shared/protocol";
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
  useDesktopStore.setState({ automation: [], automationRunsSignal: undefined, snapshot: { ...useDesktopStore.getState().snapshot, sessions: [] } });
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
    schedule: { kind: "cron", cron: "0 9 * * *" },
    prompt: "汇总今日新闻",
    agentId: "default",
    accessMode: "full",
    enabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides
  };
}

function render(tasks: AutomationTask[], options: { workspacePath?: string; activeAgentId?: string; recentWorkspaces?: RecentWorkspace[] } = {}): void {
  useDesktopStore.setState({ automation: tasks, automationRunsSignal: undefined, snapshot: { ...useDesktopStore.getState().snapshot, recentWorkspaces: options.recentWorkspaces ?? [] } });
  act(() => {
    root.render(
      <AutomationSettings
        models={[]}
        providers={[]}
        settings={settings}
        workspaceConfigured
        workspacePath={options.workspacePath}
        activeAgentId={options.activeAgentId}
        onCreateInSession={() => {}}
        onOpenRunSession={() => {}}
      />
    );
  });
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function selectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`button not found: ${text}`);
  return button as HTMLButtonElement;
}

/** 空间下拉的稳定入口：结构钩子比「label 里找 select」耐改（label 已改用 htmlFor 关联）。 */
function workspaceSelect(): HTMLSelectElement {
  const select = container.querySelector<HTMLSelectElement>('[data-control="automation-workspace"]');
  if (!select) throw new Error("workspace select not found");
  return select;
}

function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function session(id: string, agentId: string, title: string): SessionSummary {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    workspace: "D:\\projects\\A",
    agentId,
    title,
    modifiedAt: 1,
    messageCount: 1
  };
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

describe("AutomationSettings one-shot + session binding", () => {
  it("renders a one-shot task with its session chip and completed badge", () => {
    render([task({
      schedule: { kind: "after", afterSeconds: 300, scheduledAt: Date.now() + 300_000 },
      sessionId: "sess-1",
      sessionTitle: "后台分析任务",
      completedAt: Date.now(),
      enabled: false
    })]);
    const text = container.textContent ?? "";
    expect(text).toContain("仅一次");
    expect(text).toContain("已完成");
    expect(text).toContain("后台分析任务");
    expect(container.querySelector(".automation-session-link")).not.toBeNull();
  });

  it("keeps the session chip absent for background tasks", () => {
    render([task()]);
    expect(container.querySelector(".automation-session-link")).toBeNull();
  });
});

describe("AutomationSettings workspace-first", () => {
  it("marks workspaceIssue tasks and blocks enabling/running them", () => {
    render([task({ workspaceIssue: "工作区目录不存在", enabled: false })]);
    expect(container.textContent).toContain("需重新选择工作区");
    const toggle = container.querySelector<HTMLButtonElement>('[data-control="automation-toggle"]')!;
    const run = container.querySelector<HTMLButtonElement>('[data-control="automation-run"]')!;
    expect(toggle.disabled).toBe(true);
    expect(run.disabled).toBe(true);
    expect(toggle.title).toContain("需重新选择工作区");
  });

  it("stores the full workspace path and removes the metadata-only option", () => {
    render([], { workspacePath: "D:\\projects\\A" });
    click(buttonByText("创建定时任务"));
    const select = workspaceSelect();
    const values = [...select.options].map((option) => option.value);
    expect(values).toContain("D:\\projects\\A");
    expect(values).not.toContain("current");
    expect(values).not.toContain("other");
    expect(select.value).toBe("D:\\projects\\A");
    expect(container.textContent).not.toContain("其它空间");
  });

  it("clears workspaceIssue after the user reselects a workspace and saves", () => {
    const sent: Array<{ type: string; task?: AutomationTask }> = [];
    (window as unknown as { piDesktop: { send: (command: unknown) => Promise<void> } }).piDesktop = {
      send: (command) => { sent.push(command as { type: string; task?: AutomationTask }); return Promise.resolve(); }
    };
    render([task({ workspaceIssue: "工作区目录不存在", enabled: false })], { workspacePath: "D:\\projects\\A" });
    click(container.querySelector<HTMLButtonElement>('button[aria-label="编辑"]')!);
    const select = workspaceSelect();
    expect(select.value).toBe("");
    selectValue(select, "D:\\projects\\A");
    click(buttonByText("保存"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("automation.save");
    expect(sent[0]!.task?.workspace).toBe("D:\\projects\\A");
    expect(sent[0]!.task?.workspaceIssue).toBeUndefined();
  });

  it("filters session choices to the task owner so another agent's session is not bound silently", () => {
    useDesktopStore.setState({ snapshot: { ...useDesktopStore.getState().snapshot, sessions: [session("sess-a", "agent-a", "A 的会话"), session("sess-b", "agent-b", "B 的会话")] } });
    render([], { workspacePath: "D:\\projects\\A", activeAgentId: "agent-a" });
    click(buttonByText("创建定时任务"));
    const targetLabel = [...container.querySelectorAll("label")].find((label) => label.textContent?.startsWith("执行位置"))!;
    selectValue(targetLabel.querySelector("select")!, "session");
    const sessionLabel = [...container.querySelectorAll("label")].find((label) => label.textContent?.startsWith("关联会话"))!;
    const titles = [...sessionLabel.querySelectorAll("option")].map((option) => option.textContent);
    expect(titles).toContain("A 的会话");
    expect(titles).not.toContain("B 的会话");
  });
});

// 空间候选（2026-10-26）：用户反馈「只能选当前工作区」。下拉要列出所有已知工作区
// （最近打开 + 有会话的），并且能用「浏览…」挑一个从未打开过的任意目录。
describe("AutomationSettings workspace candidates", () => {
  it("lists current, recent and session workspaces, tagging missing directories", () => {
    useDesktopStore.setState({ snapshot: { ...useDesktopStore.getState().snapshot, sessions: [session("sess-a", "default", "A 的会话")] } });
    render([], {
      workspacePath: "D:\\projects\\A",
      recentWorkspaces: [
        { path: "D:\\projects\\B", openedAt: 2 },
        { path: "E:\\gone", openedAt: 1, missing: true }
      ]
    });
    click(buttonByText("创建定时任务"));
    const select = workspaceSelect();
    const options = [...select.options];
    expect(options.map((option) => option.value)).toEqual(["D:\\projects\\A", "D:\\projects\\B", "E:\\gone"]);
    expect(select.value).toBe("D:\\projects\\A");
    expect(options[0]!.textContent).toContain("当前工作区");
    expect(options.find((option) => option.value === "E:\\gone")!.textContent).toContain("目录不存在");
  });

  it("browses any folder through the native picker and submits that path", async () => {
    const sent: Array<{ type: string; task?: AutomationTask }> = [];
    (window as unknown as { piDesktop: Record<string, unknown> }).piDesktop = {
      send: (command: unknown) => { sent.push(command as { type: string; task?: AutomationTask }); return Promise.resolve(); },
      chooseWorkspace: async () => "F:\\brand-new"
    };
    render([], { workspacePath: "D:\\projects\\A" });
    click(buttonByText("创建定时任务"));
    await act(async () => {
      click(container.querySelector('[data-control="automation-choose-workspace"]')!);
      await Promise.resolve();
    });
    const select = workspaceSelect();
    expect(select.value).toBe("F:\\brand-new");
    expect([...select.options].map((option) => option.value)).toContain("F:\\brand-new");

    setInputValue(container.querySelector<HTMLInputElement>('.automation-dialog input[placeholder^="例如"]')!, "每日巡检");
    setInputValue(container.querySelector<HTMLTextAreaElement>(".automation-dialog textarea")!, "检查项目状态");
    click(container.querySelector<HTMLButtonElement>(".automation-dialog > footer .primary-button")!);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe("automation.save");
    expect(sent[0]!.task?.workspace).toBe("F:\\brand-new");
  });
});
