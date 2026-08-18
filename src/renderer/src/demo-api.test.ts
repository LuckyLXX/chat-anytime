import { describe, expect, it, vi } from "vitest";
import { createDemoApi } from "./demo-api";

describe("demo session commands", () => {
  it("creates a new session in the requested workspace", async () => {
    const api = createDemoApi();

    await api.send({ type: "session.new", workspace: "D:\\Projects\\PiDesktop" });

    const bootstrap = await api.bootstrap();
    expect(bootstrap.runtime).toBeDefined();
    expect(bootstrap.runtime?.workspace).toBe("D:\\Projects\\PiDesktop");
    expect(bootstrap.runtime?.sessionId).toBe("new-demo-session");
    expect(bootstrap.runtime?.messages).toEqual([]);
  });

  it("keeps Skill enablement isolated between Agents", async () => {
    const api = createDemoApi();
    const bootstrap = await api.bootstrap();
    const defaultAgent = bootstrap.settings.agents.find((agent) => agent.id === "default")!;
    const secondAgent = { ...defaultAgent, id: "reviewer", name: "审查助手", tools: { ...defaultAgent.tools } };
    const skillId = bootstrap.resources!.skills[0]!.id;

    await api.send({ type: "agent.save", agent: secondAgent });
    await api.send({ type: "agent.save", agent: { ...defaultAgent, skillOverrides: { ...defaultAgent.skillOverrides, [skillId]: false } } });
    expect((await api.bootstrap()).resources?.skills[0]?.enabled).toBe(false);

    await api.send({ type: "agent.select", agentId: "reviewer" });
    expect((await api.bootstrap()).resources?.skills[0]?.enabled).toBe(true);

    await api.send({ type: "agent.select", agentId: "default" });
    expect((await api.bootstrap()).resources?.skills[0]?.enabled).toBe(false);
  });

  it("echoes compact commands and completes the busy lifecycle", async () => {
    vi.useFakeTimers();
    try {
      const api = createDemoApi();

      await api.send({ type: "session.compact", instructions: "保留当前修改" });

      const running = (await api.bootstrap()).runtime!;
      expect(running.busy).toBe(true);
      expect(running.messages.at(-1)).toMatchObject({ role: "user", control: "compact", blocks: [{ type: "text", text: "/compact 保留当前修改" }] });

      await vi.runAllTimersAsync();

      const completed = (await api.bootstrap()).runtime!;
      expect(completed.busy).toBe(false);
      expect(completed.status).toBe("就绪");
      expect(completed.messages.at(-1)).toMatchObject({ role: "assistant", control: "compact", blocks: [{ type: "text", text: "已压缩上下文。" }] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks context usage across prompt and compaction", async () => {
    vi.useFakeTimers();
    try {
      const api = createDemoApi();
      // 前面的用例共享模块级状态，先归零到新会话。
      await api.send({ type: "session.new" });
      const fresh = (await api.bootstrap()).runtime!.contextUsage!;
      expect(fresh).toMatchObject({ tokens: 0, percent: 0, cacheHitRate: null });
      expect(fresh.contextWindow).toBeGreaterThan(0);

      await api.send({ type: "session.prompt", text: "检查这个项目的运行时架构" });
      await vi.runAllTimersAsync();
      const grown = (await api.bootstrap()).runtime!.contextUsage!;
      expect(grown.tokens!).toBeGreaterThan(0);
      expect(grown.percent!).toBeGreaterThan(0);
      expect(grown.tokens!).toBeLessThan(grown.contextWindow);
      expect(grown.cacheHitRate).not.toBeNull();

      await api.send({ type: "session.compact" });
      await vi.runAllTimersAsync();
      const compacted = (await api.bootstrap()).runtime!.contextUsage!;
      expect(compacted.tokens).toBeNull();
      expect(compacted.percent).toBeNull();
      expect(compacted.contextWindow).toBe(fresh.contextWindow);

      // 压缩后下一条回复恢复估算。
      await api.send({ type: "session.prompt", text: "继续" });
      await vi.runAllTimersAsync();
      const recovered = (await api.bootstrap()).runtime!.contextUsage!;
      expect(recovered.tokens).not.toBeNull();
      expect(recovered.percent).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a typed workspace file preview", async () => {
    const preview = await createDemoApi().readWorkspaceFile("src/runtime.ts");

    expect(preview).toMatchObject({ kind: "code", language: "typescript", relativePath: "src/runtime.ts" });
  });

  it("previews demo images as inline base64 data", async () => {
    const preview = await createDemoApi().readWorkspaceFile("demo.png");

    expect(preview).toMatchObject({ kind: "image", mimeType: "image/png", relativePath: "demo.png", size: 3775 });
    expect(preview.data).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    expect(preview.data?.length).toBeGreaterThan(1000);
  });

  it("supports manual files and browser preview state events", async () => {
    const api = createDemoApi();
    const states: string[] = [];
    const unsubscribe = api.onBrowserPreviewState(undefined, (state) => states.push(state.url));

    const file = await api.choosePreviewFile();
    const navigated = await api.browserPreview({ type: "navigate", url: "localhost:4173" });
    const closed = await api.browserPreview({ type: "close" });
    unsubscribe();

    expect(file).toMatchObject({ kind: "markdown", relativePath: "README.md" });
    expect(navigated.url).toBe("http://localhost:4173");
    expect(states).toContain("http://localhost:4173");
    expect(closed).toMatchObject({ attached: false, url: "", loading: false });
  });
});
