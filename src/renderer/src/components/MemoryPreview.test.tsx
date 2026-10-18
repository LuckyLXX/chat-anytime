// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryTopic, MemoryTopicSummary } from "../../../shared/protocol";
import { MemoryPreviewContent } from "./MemoryPreview";
import { useDesktopStore } from "../store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const summary: MemoryTopicSummary = {
  id: "topic-1",
  title: "测试主题",
  description: "一句话",
  contentChars: 6,
  contentRevision: 7,
  createdAt: "2026-10-18",
  updatedAt: "2026-10-18"
};

const fullTopic: MemoryTopic = {
  ...summary,
  content: "正文内容"
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
  useDesktopStore.setState({ memory: [summary], memoryContents: {}, memoryTopicErrors: {} });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useDesktopStore.setState({ memory: [], memoryContents: {}, memoryTopicErrors: {} });
});

describe("MemoryPreview v3 lazy content", () => {
  it("requests the body on open, then renders it after memory.topic", async () => {
    await act(async () => {
      root.render(<MemoryPreviewContent topicId="topic-1" tabId="tab-1" showSource={false} onOpenArtifact={() => {}} />);
    });
    expect(send).toHaveBeenCalledWith({ type: "memory.read", topicId: "topic-1" });
    expect(container.textContent).toContain("正在读取记忆正文");

    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({ type: "memory.topic", topic: fullTopic });
    });
    expect(container.textContent).toContain("正文内容");
    expect(container.textContent).not.toContain("正在读取记忆正文");
  });

  it("does not reuse the previous topic body when the preview switches topics", async () => {
    await act(async () => {
      root.render(<MemoryPreviewContent topicId="topic-1" tabId="tab-1" showSource={false} onOpenArtifact={() => {}} />);
    });
    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({ type: "memory.topic", topic: fullTopic });
    });
    expect(container.textContent).toContain("正文内容");

    const second: MemoryTopicSummary = { ...summary, id: "topic-2", title: "第二个主题", contentRevision: 8 };
    await act(async () => { useDesktopStore.setState({ memory: [second] }); });
    send.mockClear();
    await act(async () => {
      root.render(<MemoryPreviewContent topicId="topic-2" tabId="tab-2" showSource={false} onOpenArtifact={() => {}} />);
    });
    expect(container.textContent).not.toContain("正文内容");
    expect(container.textContent).toContain("正在读取记忆正文");
    expect(send).toHaveBeenCalledWith({ type: "memory.read", topicId: "topic-2" });
  });

  it("shows a retryable error when the read fails", async () => {
    await act(async () => {
      root.render(<MemoryPreviewContent topicId="topic-1" tabId="tab-1" showSource={false} onOpenArtifact={() => {}} />);
    });
    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({ type: "memory.topic-error", topicId: "topic-1", message: "读取失败" });
    });
    expect(container.textContent).toContain("记忆正文读取失败");
    expect(container.textContent).toContain("读取失败");
    expect(container.textContent).toContain("重试");

    send.mockClear();
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("重试"));
    expect(retry).toBeTruthy();
    await act(async () => retry?.click());
    expect(send).toHaveBeenCalledWith({ type: "memory.read", topicId: "topic-1" });
  });
});
