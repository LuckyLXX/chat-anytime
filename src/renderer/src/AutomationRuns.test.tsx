// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AutomationRunRecord, DesktopSettings } from "../../shared/protocol";
import { AutomationRuns } from "./AutomationRuns";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const sent: unknown[] = [];
let opened = 0;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sent.length = 0;
  opened = 0;
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
    preview: "<assistant_html><div style=\"...\">这段提示词不该出现</div></assistant_html>",
    ...overrides
  };
}

function render(runs: AutomationRunRecord[], compact = false): void {
  act(() => useDesktopStore.setState({ automationRuns: runs }));
  act(() => {
    root.render(<AutomationRuns settings={settings} activeAgentId="default" compact={compact} onOpenSession={() => { opened += 1; }} />);
  });
}

describe("AutomationRuns", () => {
  it("opens the run session on a single click and never shows the prompt/preview text", () => {
    render([run()]);
    expect(container.textContent).not.toContain("这段提示词不该出现");
    expect(container.textContent).toContain("成功 · 用时 12s");
    const row = container.querySelector<HTMLElement>('[data-run-id="run-1"]')!;
    act(() => row.click());
    expect(sent).toEqual([{ type: "automation.run.open", runId: "run-1" }]);
    expect(opened).toBe(1);
  });

  it("keeps skipped rows static (no session to open) and shows only the neutral outcome", () => {
    render([run({ status: "skipped", sessionId: undefined, durationMs: 0, skipReason: "上一轮尚未结束" })]);
    const row = container.querySelector<HTMLElement>('[data-run-id="run-1"]')!;
    expect(row.getAttribute("role")).toBeNull();
    expect(container.textContent).toContain("未运行");
    expect(container.textContent).not.toContain("上一轮尚未结束");
    act(() => row.click());
    expect(sent).toEqual([]);
    expect(opened).toBe(0);
  });

  it("works in the compact panel form too", () => {
    render([run()], true);
    const row = container.querySelector<HTMLElement>('[data-run-id="run-1"]')!;
    act(() => row.click());
    expect(sent).toEqual([{ type: "automation.run.open", runId: "run-1" }]);
  });
});
