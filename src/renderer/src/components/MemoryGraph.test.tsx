// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryLayer, MemoryOverview, MemoryTopicSummary } from "../../../shared/protocol";
import { MemoryGraph } from "./MemoryGraph";

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
        markdown: "[核心 · 每会话在场]\n- 用户偏好 — 中文回复",
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
      topics: [topic("b-global", "值班手册", "standard"), topic("b-ws", "巡检约定", "core", { workspace: "D:\\运维" })],
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
      health: { topics: 2, chars: 2400, layers: { core: 1, standard: 1, archive: 0 }, indexChars: 300, indexBudget: 2000, issues: [], duplicates: [], checkedAt: 1 }
    }
  ]
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(props: Partial<Parameters<typeof MemoryGraph>[0]> = {}, expand = true): Promise<ReturnType<typeof vi.fn>> {
  const onSelect = vi.fn();
  await act(async () => {
    root.render(
      <MemoryGraph
        overview={overview}
        currentAgentId="agent-a"
        agentFilter="all"
        layerFilter="all"
        scopeFilter="all"
        query=""
        onSelect={onSelect}
        {...props}
      />
    );
  });
  if (expand) await expandAll();
  return onSelect;
}

/** 默认只展开当前助手；大多数断言需要看全部节点，先点「全部展开」。 */
async function expandAll(): Promise<void> {
  const button = container.querySelector('.mg-toggle-all') as HTMLButtonElement | null;
  if (button && button.textContent === "全部展开") await act(async () => button.click());
}

describe("MemoryGraph", () => {
  it("renders one block per agent with an index node and three lanes", async () => {
    await render();
    expect(container.querySelectorAll("[data-memory-agent]")).toHaveLength(2);
    expect(container.textContent).toContain("黑鱼河");
    expect(container.textContent).toContain("值班鲸");
    expect(container.textContent).toContain("1,294 / 2,000 字");
    expect(container.textContent).toContain("按「PiDesktop」口径");
    expect(container.querySelectorAll("[data-memory-lane]")).toHaveLength(5);
    expect(container.querySelectorAll("[data-memory-node]")).toHaveLength(5);
  });

  it("marks indexed / compacted / omitted / archived nodes by structure", async () => {
    await render();
    expect(container.querySelector('[data-topic-id="a-core"]')?.getAttribute("data-index-status")).toBe("indexed");
    expect(container.querySelector('[data-topic-id="a-standard"]')?.getAttribute("data-index-status")).toBe("compacted");
    expect(container.querySelector('[data-topic-id="b-global"]')?.getAttribute("data-index-status")).toBe("omitted");
    expect(container.querySelector('[data-topic-id="a-archive"]')?.getAttribute("data-index-status")).toBe("archive");
    expect(container.textContent).toContain("索引省略");
    expect(container.textContent).toContain("索引压缩");
    expect(container.textContent).toContain("偏大");
  });

  it("weights the connector by index characters and hides stubs for archive", async () => {
    await render();
    const core = container.querySelector('[data-topic-id="a-core"]') as HTMLElement;
    const standard = container.querySelector('[data-topic-id="a-standard"]') as HTMLElement;
    const archive = container.querySelector('[data-topic-id="a-archive"]') as HTMLElement;
    expect(core.style.getPropertyValue("--mg-link")).not.toBe("");
    expect(standard.style.getPropertyValue("--mg-link")).not.toBe("");
    expect(archive.style.getPropertyValue("--mg-link")).toBe("");
  });

  it("dims nodes that do not match the query but keeps structure", async () => {
    await render({ query: "踩坑" });
    expect(container.querySelector('[data-topic-id="a-standard"]')?.className).not.toContain("dimmed");
    expect(container.querySelector('[data-topic-id="a-core"]')?.className).toContain("dimmed");
    // 结构不隐藏：不匹配的节点仍然渲染
    expect(container.querySelectorAll("[data-memory-node]")).toHaveLength(5);
  });

  it("filters by layer, scope and agent", async () => {
    await render({ layerFilter: "archive" });
    expect(container.querySelectorAll("[data-memory-node]")).toHaveLength(1);
    expect(container.textContent).toContain("历史结论");

    await render({ scopeFilter: "" });
    expect(container.querySelectorAll("[data-memory-node]")).toHaveLength(2);
    expect(container.textContent).toContain("值班手册");
    expect(container.textContent).toContain("用户偏好");

    await render({ scopeFilter: "D:\\运维" });
    expect(container.querySelectorAll("[data-memory-node]")).toHaveLength(1);
    expect(container.textContent).toContain("巡检约定");

    await render({ agentFilter: "agent-b" });
    expect(container.querySelectorAll("[data-memory-agent]")).toHaveLength(1);
    expect(container.textContent).not.toContain("黑鱼河");
  });

  it("selects a node and marks it active", async () => {
    const onSelect = await render({ selected: { agentId: "agent-b", topicId: "b-ws" } });
    const node = container.querySelector('[data-topic-id="b-ws"]') as HTMLElement;
    expect(node.className).toContain("selected");
    const button = node.querySelector("button") as HTMLButtonElement;
    await act(async () => button.click());
    expect(onSelect).toHaveBeenCalledWith("agent-b", expect.objectContaining({ id: "b-ws" }));
  });

  it("keeps the current agent open and collapses the others by default", async () => {
    await render({}, false);
    const current = container.querySelector('[data-agent-id="agent-a"]') as HTMLElement;
    const other = container.querySelector('[data-agent-id="agent-b"]') as HTMLElement;
    expect(current.querySelectorAll("[data-memory-node]")).toHaveLength(3);
    expect(other.querySelectorAll("[data-memory-node]")).toHaveLength(0);
    expect(other.textContent).toContain("2 个主题");
    expect(other.textContent).toContain("核心 1 · 标准 1 · 归档 0");

    const toggle = container.querySelector('.mg-toggle-all') as HTMLButtonElement;
    expect(toggle.textContent).toBe("全部展开");
    await act(async () => toggle.click());
    expect(other.querySelectorAll("[data-memory-node]")).toHaveLength(2);
    expect((container.querySelector('.mg-toggle-all') as HTMLButtonElement).textContent).toBe("全部收起");
  });

  it("auto-expands every agent while a search or filter is active", async () => {
    await render({ query: "手册" }, false);
    expect(container.querySelector('[data-agent-id="agent-b"]')!.querySelectorAll("[data-memory-node]")).toHaveLength(2);
    await render({ query: "", layerFilter: "core" }, false);
    expect(container.querySelector('[data-agent-id="agent-b"]')!.querySelectorAll("[data-memory-node]")).toHaveLength(1);
    await render({ layerFilter: "all", scopeFilter: "D:\\PiDesktop" }, false);
    expect(container.querySelector('[data-agent-id="agent-a"]')!.querySelectorAll("[data-memory-node]")).toHaveLength(2);
  });

  it("always expands when a single agent is filtered", async () => {
    await render({ agentFilter: "agent-b" }, false);
    expect(container.querySelectorAll("[data-memory-node]")).toHaveLength(2);
    expect(container.querySelector('.mg-toggle-all')).toBeNull();
  });

  it("shows a placeholder while the overview has not arrived", async () => {
    await act(async () => {
      root.render(<MemoryGraph overview={undefined} agentFilter="all" layerFilter="all" scopeFilter="all" query="" onSelect={() => {}} />);
    });
    expect(container.textContent).toContain("正在读取各助手的记忆库");
  });
});
