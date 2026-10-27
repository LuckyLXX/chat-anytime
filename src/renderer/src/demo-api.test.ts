import { describe, expect, it, vi } from "vitest";
import type { RuntimeMessage } from "../../shared/protocol";
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
  it("serves the gallery pool in demo mode (publish / update / remove / run)", async () => {
    const api = createDemoApi();
    // 订阅即补一帧（模拟真实运行时 initialize 的首次推送）。
    const apps: { id: string; title: string; lastRunAt?: number }[] = [];
    const unsubscribe = api.onRuntimeMessage((message) => {
      if (message.type === "gallery.apps") apps.splice(0, apps.length, ...message.apps);
    });
    await Promise.resolve();
    const seeded = apps.length;
    expect(seeded).toBeGreaterThan(0);

    await api.send({ type: "gallery.publish", draft: { title: "新作品", kind: "file", path: "demo/new.html" } });
    expect(apps.some((app) => app.title === "新作品")).toBe(true);

    // 同入口重复发布 = 更新而非新增（作品墙不出重复卡片）。
    const target = apps.find((app) => app.title === "新作品")!;
    await api.send({ type: "gallery.publish", draft: { title: "新作品改名", kind: "file", path: "demo/new.html" } });
    expect(apps.filter((app) => app.id === target.id)).toHaveLength(1);
    expect(apps.find((app) => app.id === target.id)?.title).toBe("新作品改名");

    await api.send({ type: "gallery.run", id: target.id });
    expect(apps.find((app) => app.id === target.id)?.lastRunAt).toBeGreaterThan(0);

    await api.send({ type: "gallery.remove", id: target.id });
    expect(apps.some((app) => app.id === target.id)).toBe(false);
    unsubscribe();
  });

  it("models project hook trust approval and revocation in demo mode", async () => {
    const api = createDemoApi();
    const name = "demo-hooks-trust-regression";
    const messages: RuntimeMessage[] = [];
    const unsubscribe = api.onRuntimeMessage((message) => messages.push(message));
    const hook = {
      name,
      scope: "project" as const,
      event: "agent_end" as const,
      action: { kind: "notify" as const, title: "演示钩子" }
    };

    await api.send({ type: "hooks.save", hook });
    expect((await api.bootstrap()).resources?.hooks.find((item) => item.name === name)?.trust).toBe("trusted");
    await api.send({ type: "hooks.run", name, scope: "project" });
    expect(messages.find((message) => message.type === "hook-run")).toMatchObject({
      type: "hook-run",
      event: "agent_end",
      source: "test",
      at: expect.any(Number)
    });

    await api.send({ type: "hooks.trust", name, scope: "project", trusted: false });
    expect((await api.bootstrap()).resources?.hooks.find((item) => item.name === name)?.trust).toBe("pending");

    await api.send({ type: "hooks.trust", name, scope: "project", trusted: true });
    expect((await api.bootstrap()).resources?.hooks.find((item) => item.name === name)?.trust).toBe("trusted");
    await api.send({ type: "hooks.delete", name, scope: "project" });
    unsubscribe();
  });
});

describe("demo workspace-first semantics", () => {
  it("gives every demo session an agentId and includes two assistants in one workspace", async () => {
    const runtime = (await createDemoApi().bootstrap()).runtime!;
    expect(runtime.sessions.every((session) => Boolean(session.agentId))).toBe(true);
    const demoWorkspaceSessions = runtime.sessions.filter((session) => session.workspace === "D:\\Projects\\chat-anytime-demo");
    expect(new Set(demoWorkspaceSessions.map((session) => session.agentId))).toEqual(new Set(["default", "heiyuhe"]));
    // 空工作区来自 recentWorkspaces（没有任何会话），侧栏应能显示它。
    expect(runtime.recentWorkspaces.some((workspace) => !runtime.sessions.some((session) => session.workspace === workspace.path))).toBe(true);
  });

  it("workspace.open sets lastWorkspace and opens the workspace's most recent session", async () => {
    const api = createDemoApi();
    await api.send({ type: "workspace.open", path: "D:\\Projects\\WorkspaceOpenTest" });
    const bootstrap = await api.bootstrap();
    expect(bootstrap.settings.lastWorkspace).toBe("D:\\Projects\\WorkspaceOpenTest");
    expect(bootstrap.runtime?.workspace).toBe("D:\\Projects\\WorkspaceOpenTest");
    expect(bootstrap.runtime?.sessionId).toBe("new-demo-session");
  });

  it("agent.select does not switch workspace, and openSession:false only changes the default assistant", async () => {
    const api = createDemoApi();
    await api.send({ type: "workspace.open", path: "D:\\Projects\\AgentSelectTest" });
    const before = await api.bootstrap();
    const beforeSessionId = before.runtime?.sessionId;

    await api.send({ type: "agent.select", agentId: "heiyuhe", openSession: false });
    const passive = await api.bootstrap();
    expect(passive.settings.currentAgentId).toBe("heiyuhe");
    expect(passive.runtime?.workspace).toBe("D:\\Projects\\AgentSelectTest");
    expect(passive.runtime?.sessionId).toBe(beforeSessionId);
    expect(passive.runtime?.agentId).toBe(before.runtime?.agentId);

    await api.send({ type: "agent.select", agentId: "heiyuhe" });
    const active = (await api.bootstrap()).runtime!;
    expect(active.workspace).toBe("D:\\Projects\\AgentSelectTest");
    expect(active.agentId).toBe("heiyuhe");
  });

  it("workspace.forget removes only the recent entry, not the sessions", async () => {
    const api = createDemoApi();
    await api.send({ type: "workspace.open", path: "D:\\Projects\\chat-anytime-demo" });
    const before = await api.bootstrap();
    const sessionCount = before.runtime!.sessions.length;

    await api.send({ type: "workspace.forget", path: "D:\\Projects\\PiDesktop" });
    const after = await api.bootstrap();
    expect(after.runtime?.recentWorkspaces.some((workspace) => workspace.path === "D:\\Projects\\PiDesktop")).toBe(false);
    expect(after.runtime?.sessions.length).toBe(sessionCount);
  });

  it("session.deleteMany removes the requested paths", async () => {
    const api = createDemoApi();
    await api.send({ type: "session.deleteMany", paths: ["older-session.jsonl"] });
    const runtime = (await api.bootstrap()).runtime!;
    expect(runtime.sessions.some((session) => session.path === "older-session.jsonl")).toBe(false);
  });

  it("session.search returns typed hits with the owning agentId", async () => {
    const api = createDemoApi();
    const messages: RuntimeMessage[] = [];
    const unsubscribe = api.onRuntimeMessage((message) => messages.push(message));
    await api.send({ type: "session.search", requestId: "search-1", query: "梳理项目架构" });
    const result = messages.find((message) => message.type === "session.search-result" && message.requestId === "search-1");
    expect(result).toMatchObject({ type: "session.search-result", done: true, scanned: expect.any(Number) });
    if (result?.type === "session.search-result") {
      expect(result.hits[0]).toMatchObject({ sessionId: "demo-session", agentId: "default" });
    }
    unsubscribe();
  });

  it("settings.save changing defaultWorkspace does not switch the current workspace", async () => {
    const api = createDemoApi();
    await api.send({ type: "workspace.open", path: "D:\\Projects\\PiDesktop" });
    const before = (await api.bootstrap()).settings;
    await api.send({
      type: "settings.save",
      settings: {
        model: before.model,
        thinkingLevel: before.thinkingLevel,
        accessMode: before.accessMode,
        appearance: before.appearance,
        browser: before.browser,
        computer: before.computer,
        design: before.design,
        ssh: before.ssh,
        jev: before.jev,
        defaultWorkspace: "D:\\Projects\\另一个默认目录",
        shortcuts: before.shortcuts
      }
    });
    const after = await api.bootstrap();
    expect(after.settings.defaultWorkspace).toBe("D:\\Projects\\另一个默认目录");
    expect(after.runtime?.workspace).toBe("D:\\Projects\\PiDesktop");
  });
});
