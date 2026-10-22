import { describe, expect, it } from "vitest";
import { buildAutomationTools, validateCreateInput, validateUpdateInput, type AutomationToolContext } from "./automation-tools.js";
import type { AutomationTask } from "../shared/protocol.js";

function makeCtx(overrides: Partial<AutomationToolContext> = {}): AutomationToolContext {
  let tasks: AutomationTask[] = [];
  const session = { id: "sess-1", path: "C:/sessions/one.jsonl", title: "当前会话", workspace: "C:/work" };
  const ctx: AutomationToolContext = {
    getSession: () => session,
    addTask: (input) => {
      const task = {
        id: `new-${tasks.length + 1}`,
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        agentId: "default",
        ...(input.target === "session" ? { sessionId: session.id, sessionPath: session.path, sessionTitle: session.title, workspace: session.workspace } : {}),
        accessMode: input.accessMode ?? "full",
        enabled: true,
        createdAt: 0,
        ...(input.model ? { model: input.model } : {})
      } satisfies AutomationTask;
      tasks = [...tasks, task];
      return { task, tasks };
    },
    updateTask: (id, patch) => {
      const existing = tasks.find((item) => item.id === id);
      if (!existing) return undefined;
      const next = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.accessMode !== undefined ? { accessMode: patch.accessMode } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.target === "background" ? { sessionId: undefined, sessionPath: undefined, sessionTitle: undefined } : {}),
        ...(patch.target === "session" ? { sessionId: session.id, sessionPath: session.path, sessionTitle: session.title, workspace: session.workspace } : {})
      } as AutomationTask;
      tasks = tasks.map((item) => (item.id === id ? next : item));
      return { task: next, tasks };
    },
    listTasks: () => tasks,
    removeTask: (id) => {
      tasks = tasks.filter((item) => item.id !== id);
      return tasks;
    },
    setTaskEnabled: (id, enabled) => {
      tasks = tasks.map((item) => (item.id === id ? { ...item, enabled } : item));
      return tasks;
    },
    runTaskNow: async () => ({ ok: true, message: "已触发" }),
    ...overrides
  };
  return ctx;
}

describe("validateCreateInput", () => {
  it("requires name, prompt and exactly one schedule selector", () => {
    expect(() => validateCreateInput({ name: "", cron: "0 9 * * *", prompt: "x" })).toThrow();
    expect(() => validateCreateInput({ name: "x", cron: "0 9 * * *", prompt: "" })).toThrow();
    expect(() => validateCreateInput({ name: "x", cron: "bad", prompt: "y" })).toThrow();
    expect(() => validateCreateInput({ name: "x", prompt: "y" })).toThrow();
    expect(() => validateCreateInput({ name: "x", cron: "0 9 * * *", after_seconds: 300, prompt: "y" })).toThrow();
    expect(validateCreateInput({ name: "x", cron: "0 9 * * *", prompt: "y" }).schedule).toEqual({ kind: "cron", cron: "0 9 * * *" });
  });

  it("builds after/at one-shot schedules", () => {
    const after = validateCreateInput({ name: "x", after_seconds: 300, prompt: "y" });
    expect(after.schedule.kind).toBe("after");
    if (after.schedule.kind === "after") {
      expect(after.schedule.afterSeconds).toBe(300);
      expect(after.schedule.scheduledAt).toBeGreaterThan(Date.now());
    }
    const at = validateCreateInput({ name: "x", at: new Date(Date.now() + 60_000).toISOString(), prompt: "y" });
    expect(at.schedule.kind).toBe("at");
  });

  it("rejects non-future at and invalid timezone", () => {
    expect(() => validateCreateInput({ name: "x", at: new Date(Date.now() - 60_000).toISOString(), prompt: "y" })).toThrow();
    expect(() => validateCreateInput({ name: "x", cron: "0 9 * * *", timezone: "Bad/Zone", prompt: "y" })).toThrow();
  });

  it("defaults target to session and normalizes accessMode", () => {
    const input = validateCreateInput({ name: "x", after_seconds: 300, prompt: "y" });
    expect(input.target).toBe("session");
    expect(input.accessMode).toBe("full");
    expect(validateCreateInput({ name: "x", after_seconds: 300, prompt: "y", target: "background", accessMode: "ask" }).accessMode).toBe("ask");
  });
});

describe("validateUpdateInput", () => {
  it("accepts partial fields and at most one timing selector", () => {
    expect(validateUpdateInput({ name: " 新名字 " })).toEqual({ name: "新名字" });
    expect(validateUpdateInput({ after_seconds: 60 }).schedule?.kind).toBe("after");
    expect(() => validateUpdateInput({ cron: "0 9 * * *", at: new Date(Date.now() + 60_000).toISOString() })).toThrow();
    expect(validateUpdateInput({ target: "background" })).toEqual({ target: "background" });
  });
});

describe("buildAutomationTools", () => {
  it("names every tool within the OpenAI-compatible [a-zA-Z0-9_-] charset", () => {
    const tools = buildAutomationTools(makeCtx());
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/u);
    }
  });

  it("creates a session-bound after task by default", async () => {
    const ctx = makeCtx();
    const create = buildAutomationTools(ctx).find((tool) => tool.name === "automation_create")!;
    const result = await (create as unknown as { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> }).execute("call", { name: "检查后台任务", after_seconds: 300, prompt: "看看跑完没" });
    expect(result.details.sessionId).toBe("sess-1");
    expect(ctx.listTasks()[0]?.sessionId).toBe("sess-1");
    expect(ctx.listTasks()[0]?.sessionTitle).toBe("当前会话");
    expect(ctx.listTasks()[0]?.schedule.kind).toBe("after");
  });

  it("keeps target:background free of session fields", async () => {
    const ctx = makeCtx();
    const create = buildAutomationTools(ctx).find((tool) => tool.name === "automation_create")!;
    await (create as unknown as { execute: (id: string, params: unknown) => Promise<unknown> }).execute("call", { name: "后台巡检", cron: "0 9 * * *", prompt: "跑", target: "background" });
    expect(ctx.listTasks()[0]?.sessionId).toBeUndefined();
  });

  it("drops an unavailable model with no error", async () => {
    const ctx = makeCtx({ modelAvailable: () => false });
    const create = buildAutomationTools(ctx).find((tool) => tool.name === "automation_create")!;
    const result = await (create as unknown as { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> }).execute("call", { name: "n", cron: "0 9 * * *", prompt: "p", model: { provider: "p", id: "m" } });
    expect(result.details.count).toBe(1);
    expect(ctx.listTasks()[0]?.model).toBeUndefined();
  });

  it("creates, updates, lists, deletes, toggles and runs", async () => {
    const ctx = makeCtx();
    const tools = buildAutomationTools(ctx);
    const run = async (toolName: string, params: unknown): Promise<{ details: Record<string, unknown> }> =>
      (tools.find((tool) => tool.name === toolName) as unknown as { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> }).execute("call", params);

    await run("automation_create", { name: "n", cron: "0 9 * * *", prompt: "p" });
    expect((await run("automation_list", {})).details.count).toBe(1);
    const updated = await run("automation_update", { id: "new-1", name: "改名", after_seconds: 600 });
    expect(updated.details.id).toBe("new-1");
    expect(ctx.listTasks()[0]?.name).toBe("改名");
    expect(ctx.listTasks()[0]?.schedule.kind).toBe("after");
    expect((await run("automation_toggle", { id: "new-1", enabled: false })).details.found).toBe(true);
    expect(ctx.listTasks()[0]?.enabled).toBe(false);
    const runNow = await run("automation_run", { id: "new-1" });
    expect(runNow.details.id).toBe("new-1");
    expect((await run("automation_delete", { id: "new-1" })).details.count).toBe(0);
  });
});
