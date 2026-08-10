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

  it("returns a typed workspace file preview", async () => {
    const preview = await createDemoApi().readWorkspaceFile("src/runtime.ts");

    expect(preview).toMatchObject({ kind: "code", language: "typescript", relativePath: "src/runtime.ts" });
  });
});
