// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProfile, ChatMessage, RuntimeSnapshot } from "../../shared/protocol";
import { ConversationPane } from "./ConversationPane";
import { useDesktopStore } from "./store";

/**
 * 输入框快捷角色切换（2026-10-26 用户反馈：新建话题要先切角色→切回工作区→点新建，
 * 路径太绕）。契约：
 * - composer 里始终显示当前助手；
 * - 点助手名打开菜单，主行切换角色（发 agent.select）；
 * - 行尾 + 直接以该角色在当前工作区新建话题（发 session.new + agentId）。
 */

const noop = (): void => undefined;

const tools: AgentProfile["tools"] = { read: true, bash: true, powershell: false, edit: true, write: true, grep: true, find: true, ls: true };
const agents: AgentProfile[] = [
  { id: "default", name: "默认助手", description: "通用任务", systemPrompt: "你是默认助手。", divMode: "auto", defaultThinkingLevel: "medium", tools },
  { id: "reviewer", name: "审查助手", description: "审查代码变更", systemPrompt: "你是审查助手。", divMode: "auto", defaultThinkingLevel: "high", tools }
];

function message(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, uuid: id, role, timestamp: 0, blocks: [{ type: "text", text }] };
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agentId: "default",
    agentName: "默认助手",
    thinkingLevel: "medium",
    busy: false,
    status: "",
    sessionId: "session-a",
    workspace: "D:/w",
    messages: [message("u1", "user", "帮我看看这个仓库")],
    executions: [],
    queuedMessages: [],
    backgroundProcesses: [],
    sessions: [],
    recentWorkspaces: [],
    ...overrides
  };
}

let container: HTMLDivElement;
let send: ReturnType<typeof vi.fn>;

function renderPane(): void {
  act(() => {
    createRoot(container).render(
      <ConversationPane
        sessionId="session-a"
        focused
        onNewSession={noop}
        onOpenArtifact={noop}
        onOpenFile={noop}
        onOpenDiff={noop}
        onOpenPlanDetail={noop}
        onOpenMemoryTopic={noop}
        onActionError={noop}
      />
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (Element.prototype as unknown as { scrollTo: unknown }).scrollTo = vi.fn();
  const host = globalThis as unknown as { ResizeObserver?: unknown; IntersectionObserver?: unknown; window: unknown };
  host.ResizeObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} };
  host.IntersectionObserver ??= class { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): [] { return []; } };
  host.window ??= host;
  send = vi.fn(async () => undefined);
  (host as { piDesktop?: unknown }).piDesktop = {
    send,
    searchWorkspaceFiles: async () => ({ entries: [] }),
    onRuntimeMessage: () => () => undefined
  };
  const settings = useDesktopStore.getState().settings;
  useDesktopStore.setState({
    ready: true,
    settings: { ...settings, agents, currentAgentId: "default" },
    snapshot: snapshot(),
    paneStates: {},
    parkedPanels: {},
    error: undefined,
    commandError: undefined
  });
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

describe("composer agent quick switch", () => {
  it("shows the current assistant and switches role from the composer", async () => {
    renderPane();
    const trigger = container.querySelector<HTMLButtonElement>('button[data-control="agent-switch"]');
    expect(trigger?.textContent).toContain("默认助手");
    await act(async () => { trigger!.click(); });
    const reviewer = [...container.querySelectorAll<HTMLButtonElement>(".agent-select-main")].find((button) => button.textContent?.includes("审查助手"));
    expect(reviewer).toBeTruthy();
    await act(async () => { reviewer!.click(); });
    expect(send).toHaveBeenCalledWith({ type: "agent.select", agentId: "reviewer" });
  });

  it("creates a new topic under the chosen assistant from the same menu", async () => {
    renderPane();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[data-control="agent-switch"]')!.click(); });
    const newButton = [...container.querySelectorAll<HTMLButtonElement>('.agent-select-new')].find((button) => button.getAttribute("aria-label") === "在 审查助手 下新建话题");
    expect(newButton).toBeTruthy();
    await act(async () => { newButton!.click(); });
    expect(send).toHaveBeenCalledWith({ type: "session.new", workspace: "D:/w", agentId: "reviewer" });
  });
});
