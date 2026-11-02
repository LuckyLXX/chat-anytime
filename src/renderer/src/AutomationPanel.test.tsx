// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AutomationRunRecord, AutomationTask, DesktopSettings } from "../../shared/protocol";
import { AutomationPanel } from "./AutomationPanel";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const sent: unknown[] = [];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sent.length = 0;
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
    startedAt: 1_700_000_000_000,
    durationMs: 1_000,
    status: "ok",
    trigger: "cron",
    ...overrides
  };
}

function render(tasks: AutomationTask[], options: { live?: { id: string; status: "running" | "ok"; taskName?: string; at: number }; runs?: AutomationRunRecord[] } = {}): void {
  act(() => {
    useDesktopStore.setState({
      automation: tasks,
      automationRuns: options.runs ?? [],
      automationRun: options.live as never
    });
  });
  act(() => {
    root.render(
      <AutomationPanel
        models={[]}
        providers={[]}
        settings={settings}
        activeAgentId="default"
        tab="tasks"
        onTabChange={() => {}}
        onClose={() => {}}
        onManageAll={() => {}}
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

describe("AutomationPanel", () => {
  it("renders the panel hooks, task summary and actions", () => {
    render([task()]);
    expect(container.querySelector('[data-pane="automation-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-control="automation-run"]')).not.toBeNull();
    expect(container.querySelector('[data-control="automation-toggle"]')).not.toBeNull();
    expect(button('[data-control="automation-toggle"]').getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("每日新闻日报");
    expect(container.textContent).toContain("0 9 * * *");
  });

  it("sends run and toggle commands", () => {
    render([task()]);
    act(() => button('[data-control="automation-run"]').click());
    act(() => button('[data-control="automation-toggle"]').click());
    expect(sent).toEqual([
      { type: "automation.run", id: "task-1", agentId: "default" },
      { type: "automation.toggle", id: "task-1", enabled: false, agentId: "default" }
    ]);
  });

  it("shows a stop control for the running background task", () => {
    render([task()], { live: { id: "task-1", status: "running", taskName: "每日新闻日报", at: Date.now() - 5_000 } });
    expect(button('[data-control="automation-stop"]').textContent).toContain("停止本次");
    act(() => button('[data-control="automation-stop"]').click());
    expect(sent).toEqual([{ type: "automation.stop", id: "task-1", agentId: "default" }]);
  });

  it("disables run and toggle for workspaceIssue tasks", () => {
    render([task({ workspaceIssue: "工作区目录不存在", enabled: false })]);
    expect(button('[data-control="automation-run"]').disabled).toBe(true);
    expect(button('[data-control="automation-toggle"]').disabled).toBe(true);
    expect(container.textContent).toContain("需修复");
  });

  it("renders runs in the runs tab and the empty state when there are no tasks", () => {
    render([], { runs: [run()] });
    expect(container.textContent).toContain("还没有定时任务");
    act(() => useDesktopStore.setState({ automationRuns: [run()] }));
    act(() => {
      root.render(
        <AutomationPanel
          models={[]}
          providers={[]}
          settings={settings}
          activeAgentId="default"
          tab="runs"
          onTabChange={() => {}}
          onClose={() => {}}
          onManageAll={() => {}}
          onOpenSession={() => {}}
        />
      );
    });
    expect(container.textContent).toContain("每日新闻日报");
    expect(container.querySelector(".automation-runs.compact")).not.toBeNull();
  });
});
