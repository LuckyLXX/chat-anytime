// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSearchHit } from "../../../shared/protocol";
import { highlightSnippet, SessionSearchResults } from "./SessionSearchResults";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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

function hit(overrides: Partial<SessionSearchHit> = {}): SessionSearchHit {
  return {
    sessionId: "s1",
    path: "C:/sessions/s1.jsonl",
    title: "部署事故",
    workspace: "C:/work",
    modifiedAt: Date.now(),
    timestamp: 1_000,
    role: "user",
    snippet: "上线部署失败了",
    score: 10,
    ...overrides
  };
}

async function render(props: Partial<Parameters<typeof SessionSearchResults>[0]> = {}): Promise<void> {
  await act(async () => {
    root.render(<SessionSearchResults query="部署" hits={[]} loading={false} onOpen={() => undefined} {...props} />);
  });
}

describe("SessionSearchResults", () => {
  it("renders a hit with the matched term highlighted", async () => {
    const onOpen = vi.fn();
    await render({ hits: [hit()], onOpen });

    expect(container.textContent).toContain("部署事故");
    expect(container.textContent).toContain("你");
    expect(container.querySelectorAll("mark")).toHaveLength(1);
    expect(container.querySelector("mark")?.textContent).toBe("部署");

    await act(async () => {
      container.querySelector<HTMLButtonElement>(".session-search-hit")?.click();
    });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", timestamp: 1_000 }));
  });

  it("shows loading and empty states", async () => {
    await render({ loading: true });
    expect(container.textContent).toContain("搜索中");

    await render({ hits: [] });
    expect(container.textContent).toContain("没有匹配的消息");
  });

  it("shows errors and archived badges", async () => {
    await render({ error: "索引损坏", hits: [] });
    expect(container.textContent).toContain("索引损坏");

    await render({ hits: [hit({ archived: true, role: "assistant" })] });
    expect(container.textContent).toContain("已归档");
    expect(container.textContent).toContain("助手");
  });

  it("renders nothing without a query", async () => {
    await render({ query: "  " });
    expect(container.textContent).toBe("");
  });
});

describe("highlightSnippet", () => {
  it("highlights every term case-insensitively", () => {
    const nodes = highlightSnippet("Deploy 部署 failed", "deploy 部署");
    const elements = nodes as unknown as React.ReactNode[];
    expect(elements.filter((node) => typeof node === "object")).toHaveLength(2);
  });
});
