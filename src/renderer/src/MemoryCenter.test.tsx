// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryTopic, MemoryTopicSummary } from "../../shared/protocol";
import { MemoryCenter } from "./MemoryCenter";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const core: MemoryTopicSummary = {
  id: "core",
  title: "用户偏好",
  description: "语言与风格",
  layer: "core",
  summaryChars: 12,
  summaryPreview: "中文回复 · 先给结论",
  contentChars: 500,
  contentRevision: 1,
  createdAt: "2026-11-01",
  updatedAt: "2026-11-03"
};
const standard: MemoryTopicSummary = {
  id: "standard",
  title: "PiDesktop 踩坑记录",
  description: "回归与坑",
  layer: "standard",
  contentChars: 26_000,
  contentRevision: 2,
  createdAt: "2026-10-01",
  updatedAt: "2026-10-20"
};
const archived: MemoryTopicSummary = {
  id: "archived",
  title: "历史结论",
  description: "已解细节",
  layer: "archive",
  contentChars: 2_000,
  contentRevision: 3,
  createdAt: "2026-09-01",
  updatedAt: "2026-09-10"
};
const coreFull: MemoryTopic = { ...core, content: "- 中文回复\n- 先给结论", summary: "中文回复 · 先给结论" };

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
    memory: [core, standard, archived],
    memoryContents: { core: coreFull },
    memoryTopicErrors: {},
    memoryIndexPreview: { markdown: "[核心 · 每会话在场]\n- 用户偏好 — 中文回复", characters: 28, budget: 2000, at: 1 },
    settings: { ...useDesktopStore.getState().settings, memory: { enabled: true } }
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useDesktopStore.setState({ memory: [], memoryContents: {}, memoryTopicErrors: {}, memoryIndexPreview: undefined });
});

async function render(): Promise<{ onClose: ReturnType<typeof vi.fn>; onOpenTopic: ReturnType<typeof vi.fn> }> {
  const onClose = vi.fn();
  const onOpenTopic = vi.fn();
  await act(async () => {
    root.render(<MemoryCenter onClose={onClose} onOpenTopic={onOpenTopic} />);
  });
  return { onClose, onOpenTopic };
}

describe("MemoryCenter", () => {
  it("renders stats, cards and the index request", async () => {
    await render();
    expect(container.textContent).toContain("记忆中心");
    expect(container.textContent).toContain("3 个主题");
    expect(container.textContent).toContain("核心 1 / 标准 1 / 归档 1");
    expect(container.textContent).toContain("索引 28/2,000 字");
    expect(container.querySelectorAll("[data-memory-card]")).toHaveLength(3);
    expect(send).toHaveBeenCalledWith({ type: "memory.indexPreview" });
  });

  it("filters by layer and search", async () => {
    await render();
    const tabs = Array.from(container.querySelectorAll(".memory-center-tabs button")) as HTMLButtonElement[];
    const archiveTab = tabs.find((button) => button.textContent === "归档")!;
    await act(async () => archiveTab.click());
    expect(container.querySelectorAll("[data-memory-card]")).toHaveLength(1);
    expect(container.textContent).toContain("历史结论");

    const input = container.querySelector(".memory-center-search input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "不存在");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).toContain("没有匹配当前筛选的主题");
  });

  it("opens details, saves meta and shows the model index", async () => {
    await render();
    const card = container.querySelector('[data-topic-id="core"] .memory-card-main') as HTMLButtonElement;
    await act(async () => card.click());
    expect(container.textContent).toContain("用户偏好");
    expect(container.textContent).toContain("核心");

    const summary = container.querySelector(".memory-center-field textarea") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(summary, "中文回复 · 先给结论 · 截图核对");
      summary.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const triggers = Array.from(container.querySelectorAll(".memory-center-field input"))[1] as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(triggers, "B站, 账号");
      triggers.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = container.querySelector('[data-control="memory-center-save"]') as HTMLButtonElement;
    await act(async () => save.click());
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "memory.update",
      topic: "用户偏好",
      layer: "core",
      summary: "中文回复 · 先给结论 · 截图核对",
      triggers: ["B站", "账号"]
    }));

    const tabs = Array.from(container.querySelectorAll(".memory-center-detail-tabs button")) as HTMLButtonElement[];
    await act(async () => tabs[1]!.click());
    expect(container.textContent).toContain("新会话");
    expect(container.textContent).toContain("[核心 · 每会话在场]");
  });

  it("archives a topic and requires a second click to delete", async () => {
    await render();
    const card = container.querySelector('[data-topic-id="standard"] .memory-card-main') as HTMLButtonElement;
    await act(async () => card.click());

    const archive = container.querySelector('[data-control="memory-center-archive"]') as HTMLButtonElement;
    await act(async () => archive.click());
    expect(send).toHaveBeenCalledWith({ type: "memory.update", topic: "PiDesktop 踩坑记录", layer: "archive" });

    const remove = container.querySelector('[data-control="memory-center-delete"]') as HTMLButtonElement;
    await act(async () => remove.click());
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "memory.delete" }));
    const confirm = Array.from(container.querySelectorAll(".memory-center-actions button")).find((button) => button.textContent?.includes("确认删除")) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(send).toHaveBeenCalledWith({ type: "memory.delete", topic: "PiDesktop 踩坑记录" });
  });

  it("opens the topic body through the host callback", async () => {
    const { onOpenTopic } = await render();
    const card = container.querySelector('[data-topic-id="core"] .memory-card-main') as HTMLButtonElement;
    await act(async () => card.click());
    const open = container.querySelector('[data-control="memory-center-open"]') as HTMLButtonElement;
    await act(async () => open.click());
    expect(onOpenTopic).toHaveBeenCalledWith(expect.objectContaining({ title: "用户偏好" }));
  });
});
