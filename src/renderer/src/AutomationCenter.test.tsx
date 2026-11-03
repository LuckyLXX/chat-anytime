// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AutomationRunRecord, AutomationTask, DesktopSettings } from "../../shared/protocol";
import { AutomationCenter } from "./AutomationCenter";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const sent: unknown[] = [];
let closed = 0;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sent.length = 0;
  closed = 0;
  (window as unknown as { piDesktop: { send: (command: unknown) => Promise<void> } }).piDesktop = {
    send: (command) => { sent.push(command); return Promise.resolve(); }
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDesktopStore.setState({ automation: [], automationRuns: [], automationRun: undefined });
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

function run(overrides: Partial<AutomationRunRecord> = {}): AutomationRunRecord {
  return {
    id: "run-1",
    taskId: "task-1",
    taskName: "每日新闻日报",
    agentId: "default",
    agentName: "默认助手",
    sessionId: "sess-1",
    startedAt: Date.now() - 60_000,
    durationMs: 12_000,
    status: "ok",
    trigger: "cron",
    preview: "8 条要闻已生成",
    ...overrides
  };
}

function render(tasks: AutomationTask[], runs: AutomationRunRecord[] = [], initialTaskId?: string): void {
  act(() => {
    useDesktopStore.setState({ automation: tasks, automationRuns: runs, automationRun: undefined });
  });
  act(() => {
    root.render(
      <AutomationCenter
        models={[]}
        providers={[]}
        settings={settings}
        activeAgentId="default"
        initialTaskId={initialTaskId}
        onClose={() => { closed += 1; }}
        onOpenSession={() => {}}
      />
    );
  });
}

function button(selector: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`button not found: ${selector}`);
  return element;
}

describe("AutomationCenter", () => {
  it("renders the management pane, task list, detail and run history", () => {
    render([task(), task({ id: "task-2", name: "项目巡检" })], [run()]);
    expect(container.querySelector('[data-pane="automation-center"]')).not.toBeNull();
    expect(container.textContent).toContain("自动化中心");
    expect(container.textContent).toContain("每日新闻日报");
    expect(container.textContent).toContain("项目巡检");
    expect(container.textContent).toContain("成功 · 用时 12s");
    expect(container.textContent).toContain("近 7 天运行");
    expect(container.textContent).toContain("任务参数");
    expect(container.querySelector('[data-control="automation-run"]')).not.toBeNull();
    expect(container.querySelector('[data-control="automation-toggle"]')).not.toBeNull();
  });

  it("switches detail when another task is selected", () => {
    render([task(), task({ id: "task-2", name: "项目巡检", prompt: "巡检工作区" })], [run()]);
    const second = [...container.querySelectorAll<HTMLButtonElement>(".automation-center-task")].find((element) => element.textContent?.includes("项目巡检"));
    if (!second) throw new Error("second task not found");
    act(() => second.click());
    expect(container.textContent).toContain("巡检工作区");
  });

  it("sends run/toggle commands and closes from the back button", () => {
    render([task()], [run()]);
    act(() => button('[data-control="automation-run"]').click());
    act(() => button('[data-control="automation-toggle"]').click());
    expect(sent).toEqual([
      { type: "automation.run", id: "task-1", agentId: "default" },
      { type: "automation.toggle", id: "task-1", enabled: false, agentId: "default" }
    ]);
    act(() => button('[data-control="automation-center-back"]').click());
    expect(closed).toBe(1);
  });

  it("honours initialTaskId and shows the empty state when there are no tasks", () => {
    render([task(), task({ id: "task-2", name: "项目巡检", prompt: "巡检工作区" })], [], "task-2");
    expect(container.textContent).toContain("巡检工作区");

    act(() => useDesktopStore.setState({ automation: [], automationRuns: [] }));
    act(() => {
      root.render(
        <AutomationCenter key="empty" models={[]} providers={[]} settings={settings} activeAgentId="default" onClose={() => {}} onOpenSession={() => {}} />
      );
    });
    expect(container.textContent).toContain("还没有定时任务");
  });
});
