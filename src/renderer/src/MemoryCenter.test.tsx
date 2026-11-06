// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryLayer, MemoryOverview, MemoryTopicSummary } from "../../shared/protocol";
import { MemoryCenter } from "./MemoryCenter";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function topic(id: string, title: string, layer: MemoryLayer, extra: Partial<MemoryTopicSummary> = {}): MemoryTopicSummary {
  return {
    id,
    title,
    description: `${title} 的描述`,
    layer,
    contentChars: 1200,
    contentRevision: 1,
    createdAt: "2026-10-01",
    updatedAt: "2026-10-20",
    ...extra
  };
}

const overview: MemoryOverview = {
  at: 1,
  agents: [
    {
      agentId: "agent-a",
      agentName: "黑鱼河",
      workspace: "D:\\PiDesktop",
      topics: [
        topic("a-core", "用户偏好", "core", { summaryChars: 12, summaryPreview: "中文回复 · 先给结论" }),
        topic("a-standard", "踩坑记录", "standard", { contentChars: 26_000, workspace: "D:\\PiDesktop" }),
        topic("a-archive", "历史结论", "archive", { workspace: "D:\\PiDesktop" })
      ],
      index: {
        markdown: "[核心 · 每会话在场]\n- 用户偏好 — 中文回复\n[项目知识]\n- 踩坑记录 — 回归与坑",
        characters: 1294,
        budget: 2000,
        omitted: 0,
        compacted: true,
        entries: [
          { topicId: "a-core", title: "用户偏好", layer: "core", placed: true, chars: 46, compacted: false, omitted: false },
          { topicId: "a-standard", title: "踩坑记录", layer: "standard", placed: true, chars: 30, compacted: true, omitted: false },
          { topicId: "a-archive", title: "历史结论", layer: "archive", placed: false, chars: 0, compacted: false, omitted: false }
        ]
      },
      health: { topics: 3, chars: 30_000, layers: { core: 1, standard: 1, archive: 1 }, indexChars: 1294, indexBudget: 2000, issues: [], duplicates: [], checkedAt: 1 }
    },
    {
      agentId: "agent-b",
      agentName: "值班鲸",
      topics: [topic("b-ws", "巡检约定", "core", { workspace: "D:\\运维" }), topic("b-global", "值班手册", "standard")],
      index: {
        markdown: "[核心 · 每会话在场]\n- 巡检约定 — 每两小时轮询",
        characters: 300,
        budget: 2000,
        omitted: 1,
        compacted: false,
        entries: [
          { topicId: "b-ws", title: "巡检约定", layer: "core", placed: true, chars: 52, compacted: false, omitted: false },
          { topicId: "b-global", title: "值班手册", layer: "standard", placed: false, chars: 0, compacted: true, omitted: true }
        ]
      },
      health: {
        topics: 2,
        chars: 2400,
        layers: { core: 1, standard: 1, archive: 0 },
        indexChars: 300,
        indexBudget: 2000,
        issues: [
          { kind: "large", severity: "warn", topicId: "b-global", title: "值班手册", message: "正文 20,000 字，超过 8,000 字提醒线。", suggestion: "拆成子主题或下沉归档。" }
        ],
        duplicates: [],
        checkedAt: 1
      }
    }
  ]
};

let container: HTMLDivElement;
let root: Root;
let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  send = vi.fn(async () => undefined);
  (window as unknown as { piDesktop: unknown }).piDesktop = { send };
  useDesktopStore.setState({
    snapshot: { ...useDesktopStore.getState().snapshot, agentId: "agent-a" },
    memory: overview.agents[0]!.topics,
    memoryContents: {},
    memoryTopicErrors: {},
    memoryOverview: overview,
    settings: { ...useDesktopStore.getState().settings, memory: { enabled: true } }
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useDesktopStore.setState({ memory: [], memoryContents: {}, memoryTopicErrors: {}, memoryOverview: undefined });
});

async function render(): Promise<{ onClose: ReturnType<typeof vi.fn>; onOpenTopic: ReturnType<typeof vi.fn> }> {
  const onClose = vi.fn();
  const onOpenTopic = vi.fn();
  await act(async () => {
    root.render(<MemoryCenter onClose={onClose} onOpenTopic={onOpenTopic} />);
  });
  // 默认只展开当前助手；测试要跨助手断言，先点「全部展开」。
  const toggle = container.querySelector('.mg-toggle-all') as HTMLButtonElement | null;
  if (toggle && toggle.textContent === "全部展开") await act(async () => toggle.click());
  return { onClose, onOpenTopic };
}

function nodeButton(topicId: string): HTMLButtonElement {
  return container.querySelector(`[data-topic-id="${topicId}"] .mg-node-body`) as HTMLButtonElement;
}

async function setInputValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("MemoryCenter v5 graph", () => {
  it("renders the cross-agent overview and requests it on mount", async () => {
    await render();
    expect(container.textContent).toContain("记忆中心");
    expect(container.textContent).toContain("2 个助手");
    expect(container.textContent).toContain("5 个主题");
    expect(container.textContent).toContain("核心 2 / 标准 2 / 归档 1");
    expect(container.textContent).toContain("黑鱼河 索引 1,294/2,000 字");
    expect(container.querySelectorAll("[data-memory-agent]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-memory-node]")).toHaveLength(5);
    expect(send).toHaveBeenCalledWith({ type: "memory.overview" });
  });

  it("filters by layer, scope and query without hiding the structure", async () => {
    await render();
    const layerTab = Array.from(container.querySelectorAll(".memory-center-tabs button")).find((button) => button.textContent === "归档") as HTMLButtonElement;
    await act(async () => layerTab.click());
    expect(container.querySelectorAll("[data-memory-node]")).toHaveLength(1);
    expect(container.textContent).toContain("历史结论");

    const allTab = Array.from(container.querySelectorAll(".memory-center-tabs button")).find((button) => button.textContent === "全部") as HTMLButtonElement;
    await act(async () => allTab.click());
    const scope = container.querySelector('select[aria-label="按归属筛选"]') as HTMLSelectElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(scope, "");
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelectorAll("[data-memory-node]")).toHaveLength(2);
    expect(container.textContent).toContain("值班手册");
    expect(container.textContent).toContain("用户偏好");

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(scope, "all");
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const search = container.querySelector(".memory-center-search input") as HTMLInputElement;
    await setInputValue(search, "踩坑");
    expect(container.querySelectorAll("[data-memory-node]")).toHaveLength(5);
    expect(container.querySelector('[data-topic-id="a-standard"]')!.className).not.toContain("dimmed");
    expect(container.querySelector('[data-topic-id="a-core"]')!.className).toContain("dimmed");
  });

  it("shows the agent name filter and switches the visible agent", async () => {
    await render();
    const agent = container.querySelector('select[aria-label="按助手筛选"]') as HTMLSelectElement;
    expect(agent.textContent).toContain("黑鱼河（3） · 当前");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(agent, "agent-b");
      agent.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelectorAll("[data-memory-agent]")).toHaveLength(1);
    expect(container.textContent).toContain("值班鲸");
    expect(container.textContent).not.toContain("踩坑记录");
  });

  it("reads and saves meta for another agent with its agentId", async () => {
    await render();
    await act(async () => nodeButton("b-ws").click());
    expect(send).toHaveBeenCalledWith({ type: "memory.read", topicId: "b-ws", agentId: "agent-b" });
    expect(container.textContent).toContain("巡检约定");
    expect(container.textContent).toContain("模型索引：占 52 字");

    const save = container.querySelector('[data-control="memory-center-save"]') as HTMLButtonElement;
    await act(async () => save.click());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "memory.update",
      topic: "巡检约定",
      layer: "core",
      agentId: "agent-b"
    }));
  });

  it("archives with the owning agent and requires a second click to delete", async () => {
    await render();
    await act(async () => nodeButton("b-global").click());
    const archive = container.querySelector('[data-control="memory-center-archive"]') as HTMLButtonElement;
    await act(async () => archive.click());
    expect(send).toHaveBeenCalledWith({ type: "memory.update", topic: "值班手册", layer: "archive", agentId: "agent-b" });

    const remove = container.querySelector('[data-control="memory-center-delete"]') as HTMLButtonElement;
    await act(async () => remove.click());
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "memory.delete" }));
    const confirm = Array.from(container.querySelectorAll(".memory-center-actions button")).find((button) => button.textContent?.includes("确认删除")) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(send).toHaveBeenCalledWith({ type: "memory.delete", topic: "值班手册", agentId: "agent-b" });
  });

  it("shows the focus agent's index and health", async () => {
    await render();
    await act(async () => nodeButton("b-global").click());
    const tabs = Array.from(container.querySelectorAll(".memory-center-detail-tabs button")) as HTMLButtonElement[];
    await act(async () => tabs[1]!.click());
    expect(container.textContent).toContain("这是「值班鲸」在新会话里会注入的索引");
    expect(container.textContent).toContain("[核心 · 每会话在场]");
    expect(container.textContent).toContain("300 / 2,000 字");

    await act(async () => tabs[2]!.click());
    expect(container.textContent).toContain("1 条建议（警告 1）");
    expect(container.textContent).toContain("值班手册");
    expect(container.textContent).toContain("拆成子主题或下沉归档");
    const archive = Array.from(container.querySelectorAll(".memory-health-actions button")).find((button) => button.textContent?.includes("归档")) as HTMLButtonElement;
    await act(async () => archive.click());
    expect(send).toHaveBeenCalledWith({ type: "memory.update", topic: "值班手册", layer: "archive", agentId: "agent-b" });
  });

  it("opens the topic body with its agentId", async () => {
    const { onOpenTopic } = await render();
    await act(async () => nodeButton("b-ws").click());
    const open = container.querySelector('[data-control="memory-center-open"]') as HTMLButtonElement;
    await act(async () => open.click());
    expect(onOpenTopic).toHaveBeenCalledWith(expect.objectContaining({ title: "巡检约定" }), "agent-b");
  });
});
