import { describe, expect, it } from "vitest";
import { buildAutomationTools, validateCreateInput, type AutomationToolContext } from "./automation-tools.js";
import type { AutomationTask } from "../shared/protocol.js";

function fixture(overrides: Partial<AutomationTask> = {}): AutomationTask {
  return {
    id: "t1",
    name: "巡检",
    schedule: { cron: "0 9 * * *" },
    prompt: "巡检",
    agentId: "default",
    accessMode: "full",
    enabled: true,
    createdAt: 0,
    ...overrides
  };
}

function makeCtx(overrides: Partial<AutomationToolContext> = {}): AutomationToolContext {
  let tasks: AutomationTask[] = [];
  return {
    addTask: (input) => {
      const task = { id: "new", name: input.name, schedule: { cron: input.cron, ...(input.timezone ? { timezone: input.timezone } : {}) }, prompt: input.prompt, agentId: "default", accessMode: input.accessMode ?? "full", enabled: true, createdAt: 0, ...(input.model ? { model: input.model } : {}) };
      tasks = [...tasks, task];
      return { task, tasks };
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
}

describe("validateCreateInput", () => {
  it("requires name, prompt and a valid cron", () => {
    expect(() => validateCreateInput({ name: "", cron: "0 9 * * *", prompt: "x" })).toThrow();
    expect(() => validateCreateInput({ name: "x", cron: "0 9 * * *", prompt: "" })).toThrow();
    expect(() => validateCreateInput({ name: "x", cron: "bad", prompt: "y" })).toThrow();
    expect(validateCreateInput({ name: "x", cron: "0 9 * * *", prompt: "y" }).cron).toBe("0 9 * * *");
  });

  it("normalizes accessMode to full when missing/invalid", () => {
    expect(validateCreateInput({ name: "x", cron: "0 9 * * *", prompt: "y" }).accessMode).toBe("full");
    expect(validateCreateInput({ name: "x", cron: "0 9 * * *", prompt: "y", accessMode: "ask" }).accessMode).toBe("ask");
    expect(validateCreateInput({ name: "x", cron: "0 9 * * *", prompt: "y", accessMode: "banana" }).accessMode).toBe("full");
  });

  it("carries an optional model and trims fields", () => {
    const input = validateCreateInput({ name: " x ", cron: " 0 9 * * * ", prompt: " y ", model: { provider: "p", id: "m" }, timezone: "Asia/Shanghai" });
    expect(input.name).toBe("x");
    expect(input.prompt).toBe("y");
    expect(input.cron).toBe("0 9 * * *");
    expect(input.model).toEqual({ provider: "p", id: "m" });
    expect(input.timezone).toBe("Asia/Shanghai");
  });
});

describe("buildAutomationTools", () => {
  it("creates a task and drops an unavailable model with a note", async () => {
    const ctx = makeCtx({ modelAvailable: () => false });
    const tools = buildAutomationTools(ctx);
    const create = tools.find((tool) => tool.name === "automation.create")!;
    const result = await (create as unknown as { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> }).execute("call", { name: "n", cron: "0 9 * * *", prompt: "p", model: { provider: "p", id: "m" } });
    expect(result.details.count).toBe(1);
    expect(ctx.listTasks()[0]?.model).toBeUndefined();
  });

  it("creates a task with a valid model", async () => {
    const ctx = makeCtx({ modelAvailable: () => true });
    const tools = buildAutomationTools(ctx);
    const create = tools.find((tool) => tool.name === "automation.create")!;
    await (create as unknown as { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> }).execute("call", { name: "n", cron: "0 9 * * *", prompt: "p", model: { provider: "p", id: "m" } });
    expect(ctx.listTasks()[0]?.model).toEqual({ provider: "p", id: "m" });
  });

  it("lists tasks, deletes, toggles and runs", async () => {
    const ctx = makeCtx();
    const tools = buildAutomationTools(ctx);
    const add = tools.find((tool) => tool.name === "automation.create")!;
    const run = async (toolName: string, params: unknown): Promise<{ details: Record<string, unknown> }> =>
      (tools.find((tool) => tool.name === toolName) as unknown as { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> }).execute("call", params);

    await (add as unknown as { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> }).execute("call", { name: "n", cron: "0 9 * * *", prompt: "p" });
    expect((await run("automation.list", {})).details.count).toBe(1);
    expect((await run("automation.toggle", { id: "new", enabled: false })).details.found).toBe(true);
    expect(ctx.listTasks()[0]?.enabled).toBe(false);
    const runNow = await runNowTool(tools, "new");
    expect(runNow).toBe(true);
    expect((await run("automation.delete", { id: "new" })).details.count).toBe(0);
  });
});

async function runNowTool(tools: ReturnType<typeof buildAutomationTools>, id: string): Promise<boolean> {
  const found = tools.find((tool) => tool.name === "automation.run");
  const result = await (found as unknown as { execute: (c: string, p: unknown) => Promise<{ details: Record<string, unknown> }> }).execute("call", { id });
  return result.details.id === id;
}
