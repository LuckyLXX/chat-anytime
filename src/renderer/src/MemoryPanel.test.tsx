// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DesktopSettings, MemoryTopicSummary } from "../../shared/protocol";
import { MemoryPanelContent, formatMemoryChars } from "./MemoryPanel";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const topics: MemoryTopicSummary[] = [
  {
    id: "small",
    title: "小主题",
    description: "一句话描述",
    contentChars: 500,
    contentRevision: 1,
    createdAt: "2026-10-18",
    updatedAt: "2026-10-18"
  },
  {
    id: "large",
    title: "大主题",
    description: "偏大的主题",
    contentChars: 18_000,
    contentRevision: 2,
    createdAt: "2026-10-17",
    updatedAt: "2026-10-17"
  },
  {
    id: "workspace",
    title: "本工作区主题",
    description: "绑定工作区",
    workspace: "D:\\项目A",
    contentChars: 1_200,
    contentRevision: 3,
    createdAt: "2026-10-16",
    updatedAt: "2026-10-16"
  }
];

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
  useDesktopStore.setState({ memory: [] });
});

function setPanelState(): void {
  const current = useDesktopStore.getState();
  useDesktopStore.setState({
    memory: topics,
    snapshot: { ...current.snapshot, workspace: "D:\\项目A", agentId: "agent-a", agentName: "测试助手" },
    settings: {
      ...current.settings,
      memory: { enabled: true },
      currentAgentId: "someone-else",
      agents: [{ id: "agent-a", name: "测试助手" }]
    } as unknown as DesktopSettings
  });
}

describe("MemoryPanel v3", () => {
  it("shows total/per-topic size, the large badge and the filter without body content", async () => {
    setPanelState();
    await act(async () => {
      root.render(<MemoryPanelContent onOpenTopic={() => {}} />);
    });
    const markup = container.innerHTML;
    expect(markup).toContain('data-pane="memory-panel"');
    expect(container.textContent).toContain("3 个主题 · 19.7k 字");
    expect(container.textContent).toContain("500 字");
    expect(container.textContent).toContain("18k 字");
    expect(container.textContent).toContain("偏大");
    expect(markup).toContain("筛选标题或描述");
    expect(container.textContent).toContain("本工作区");
    expect(container.textContent).toContain("全局");
    expect(container.textContent).toContain("测试助手");
    expect(container.textContent).not.toContain("当前助手");
    expect(container.textContent).not.toContain("正文内容");
  });

  it("formats small and large sizes", () => {
    expect(formatMemoryChars(500)).toBe("500 字");
    expect(formatMemoryChars(1_500)).toBe("1.5k 字");
    expect(formatMemoryChars(12_000)).toBe("12k 字");
    expect(formatMemoryChars(120_000)).toBe("120k 字");
  });
});
