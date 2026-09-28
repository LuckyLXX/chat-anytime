import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HookRule, RuntimeMessage } from "../shared/protocol.js";
import { createHooksExtension, runHookCommand, testHook, type HooksExtensionDeps } from "./runtime-hooks.js";

interface Harness {
  handlers: Map<string, (event: never) => unknown>;
  posts: RuntimeMessage[];
  setRules: (rules: HookRule[]) => void;
  setTrusted: (trusted: boolean) => void;
  deps: HooksExtensionDeps;
}

function createHarness(initialRules: HookRule[], enabled = true, scope: "project" | "global" = "global"): Harness {
  const posts: RuntimeMessage[] = [];
  const handlers = new Map<string, (event: never) => unknown>();
  const fakePi = { on: (name: string, handler: (event: never) => unknown) => handlers.set(name, handler) };
  let currentRules = initialRules;
  let currentTrusted = false;
  const deps: HooksExtensionDeps = {
    rules: () => currentRules.map((rule) => ({ name: rule.name, rule, scope })),
    enabled: () => enabled,
    trust: (entry) => entry.scope === "global" || currentTrusted,
    workspace: () => process.cwd(),
    agentName: () => "默认助手",
    sessionId: () => "session-1",
    sessionTitle: () => "测试会话",
    post: (message) => { posts.push(message); }
  };
  const extension = createHooksExtension(deps) as { factory: (pi: ExtensionAPI) => void };
  extension.factory(fakePi as unknown as ExtensionAPI);
  return { handlers, posts, deps, setRules: (rules) => { currentRules = rules; }, setTrusted: (trusted) => { currentTrusted = trusted; } };
}

async function callToolCall(harness: Harness, toolName: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined> {
  const handler = harness.handlers.get("tool_call") as unknown as (event: { toolCallId: string; toolName: string; input: Record<string, unknown> }) => Promise<{ block?: boolean; reason?: string } | undefined>;
  return handler({ toolCallId: "t1", toolName, input });
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const blockRule: HookRule = { name: "git防火墙", event: "tool_call", matcher: "bash", action: { kind: "block", deny: ["git\\s+push.*--force"] } };

describe("hooks extension tool_call", () => {
  it("blocks a matching deny pattern on the bash command line", async () => {
    const harness = createHarness([blockRule]);
    const verdict = await callToolCall(harness, "bash", { command: "git push --force origin main" });
    expect(verdict).toMatchObject({ block: true });
    expect(verdict?.reason).toContain("git防火墙");
  });

  it("blocks a matching deny pattern on the powershell command line too", async () => {
    // matcher 按工具名匹配（用户配置维度），deny 正则同样作用于命令行文本。
    const psRule: HookRule = { ...blockRule, name: "git防火墙PS", matcher: "powershell" };
    const harness = createHarness([psRule]);
    const verdict = await callToolCall(harness, "powershell", { command: "git push --force origin main" });
    expect(verdict).toMatchObject({ block: true });
    expect(verdict?.reason).toContain("git防火墙PS");
  });

  it("allows non-matching commands and other tools", async () => {
    const harness = createHarness([blockRule]);
    expect(await callToolCall(harness, "bash", { command: "npm test" })).toBeUndefined();
    expect(await callToolCall(harness, "write", { path: "src/a.ts" })).toBeUndefined();
  });

  it("skips disabled rules and honors the master switch", async () => {
    const harness = createHarness([{ ...blockRule, disabled: true }]);
    expect(await callToolCall(harness, "bash", { command: "git push --force" })).toBeUndefined();

    const disabledHarness = createHarness([blockRule], false);
    expect(await callToolCall(disabledHarness, "bash", { command: "git push --force" })).toBeUndefined();
  });

  it("blocks via a blocking command exiting with code 2", async () => {
    const harness = createHarness([{ name: "守门", event: "tool_call", action: { kind: "command", command: "exit 2", blocking: true } }]);
    const verdict = await callToolCall(harness, "bash", { command: "npm run build" });
    expect(verdict).toMatchObject({ block: true });
    expect(harness.posts.find((message) => message.type === "hook-run")).toMatchObject({ type: "hook-run", event: "tool_call", source: "trigger", ok: true, blocked: true });
  });

  it("blocks via a blocking command printing a block JSON verdict", async () => {
    const harness = createHarness([{ name: "守门", event: "tool_call", action: { kind: "command", command: "echo {\"block\":true}", blocking: true } }]);
    const verdict = await callToolCall(harness, "bash", { command: "npm run build" });
    expect(verdict).toMatchObject({ block: true });
  });

  it("allows when a blocking command succeeds and logs nothing blocking", async () => {
    const harness = createHarness([{ name: "守门", event: "tool_call", action: { kind: "command", command: "exit 0", blocking: true } }]);
    expect(await callToolCall(harness, "bash", { command: "npm run build" })).toBeUndefined();
  });
});

describe("project hook trust gate", () => {
  it("does not execute an untrusted project block command", async () => {
    const harness = createHarness([{ name: "待批准门禁", event: "tool_call", action: { kind: "command", command: "exit 2", blocking: true } }], true, "project");
    expect(await callToolCall(harness, "bash", { command: "npm test" })).toBeUndefined();
    expect(harness.posts.filter((message) => message.type === "hook-notice")).toHaveLength(1);
    expect(harness.posts.filter((message) => message.type === "log" && message.level === "warn")).toHaveLength(1);
  });

  it("executes a trusted project rule", async () => {
    const harness = createHarness([{ name: "已批准门禁", event: "tool_call", action: { kind: "command", command: "exit 2", blocking: true } }], true, "project");
    harness.setTrusted(true);
    expect(await callToolCall(harness, "bash", { command: "npm test" })).toMatchObject({ block: true });
    const notices = harness.posts.filter((message) => message.type === "hook-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "hook-notice", message: expect.stringContaining("已拦截") });
  });

  it("warns once per session and stays silent when the master switch is off", async () => {
    const rule: HookRule = { name: "待批准通知", event: "turn_end", action: { kind: "notify" } };
    const harness = createHarness([rule], true, "project");
    const fire = () => harness.handlers.get("turn_end")?.({ message: { usage: {} }, toolResults: [] } as never);
    fire();
    fire();
    await flushAsync();
    expect(harness.posts.filter((message) => message.type === "hook-notice")).toHaveLength(1);
    expect(harness.posts.filter((message) => message.type === "hook-notify")).toHaveLength(0);

    const disabled = createHarness([rule], false, "project");
    disabled.handlers.get("turn_end")?.({ message: { usage: {} }, toolResults: [] } as never);
    await flushAsync();
    expect(disabled.posts).toHaveLength(0);
  });
});

describe("hooks extension observing events", () => {
  it("fires notify hooks on turn_end with usage context", async () => {
    const harness = createHarness([{ name: "跑完通知", event: "turn_end", action: { kind: "notify" } }]);
    harness.handlers.get("turn_start")?.({ turnIndex: 1, timestamp: Date.now() } as never);
    harness.handlers.get("turn_end")?.({ message: { usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 2, cost: { total: 0.01 } } }, toolResults: [] } as never);
    await flushAsync();
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toMatchObject({ type: "hook-notify", sessionId: "session-1" });
  });

  it("fires agent_end once per reply with summed usage and failure flag", async () => {
    // 同一规则同时挂 turn_end 与 agent_end：一次含两个小轮的回复应触发 2 次单轮 + 1 次整次。
    const harness = createHarness([
      { name: "单轮", event: "turn_end", action: { kind: "notify", title: "turn" } },
      { name: "整次", event: "agent_end", action: { kind: "notify", title: "run" } }
    ]);
    harness.handlers.get("agent_start")?.({} as never);
    harness.handlers.get("turn_end")?.({ message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 100, cost: { total: 0.01 } } }, toolResults: [] } as never);
    harness.handlers.get("turn_end")?.({ message: { role: "assistant", usage: { input: 20, output: 7, cacheRead: 200, cost: { total: 0.02 } } }, toolResults: [] } as never);
    harness.handlers.get("agent_end")?.({ messages: [
      { role: "user" },
      { role: "assistant", usage: { input: 10, output: 5, cacheRead: 100, cost: { total: 0.01 } } },
      { role: "assistant", usage: { input: 20, output: 7, cacheRead: 200, cost: { total: 0.02 } } }
    ] } as never);
    await flushAsync();
    const titles = harness.posts.filter((message) => message.type === "hook-notify").map((message) => message.title);
    expect(titles).toEqual(["turn", "turn", "run"]);
    expect(titles.filter((title) => title === "run")).toHaveLength(1);
  });

  it("fires tool_execution_end hooks with the start event's args, honoring matcher", async () => {
    const harness = createHarness([{ name: "格式化", event: "tool_execution_end", matcher: "^(write|edit)$", action: { kind: "notify" } }]);
    harness.handlers.get("tool_execution_start")?.({ toolCallId: "t1", toolName: "write", args: { path: "src/a.ts" } } as never);
    harness.handlers.get("tool_execution_end")?.({ toolCallId: "t1", toolName: "write", result: "ok", isError: false } as never);
    await flushAsync();
    expect(harness.posts.filter((message) => message.type === "hook-notify")).toHaveLength(1);

    harness.handlers.get("tool_execution_end")?.({ toolCallId: "t2", toolName: "bash", result: "ok", isError: false } as never);
    await flushAsync();
    expect(harness.posts.filter((message) => message.type === "hook-notify")).toHaveLength(1);
  });

  it("does not observe anything when the master switch is off", async () => {
    const harness = createHarness([{ name: "跑完通知", event: "turn_end", action: { kind: "notify" } }], false);
    harness.handlers.get("turn_end")?.({ message: { usage: {} }, toolResults: [] } as never);
    await flushAsync();
    expect(harness.posts).toHaveLength(0);
  });
});

describe("hook run observability", () => {
  it("records trigger outcomes and coalesces recent runs to the latest result", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness([{ name: "延迟观察", event: "turn_end", action: { kind: "notify", title: "{durationMs}" } }]);
      harness.handlers.get("turn_start")?.({ timestamp: Date.now() } as never);
      await vi.advanceTimersByTimeAsync(15);
      harness.handlers.get("turn_end")?.({ message: { usage: {} }, toolResults: [] } as never);
      await vi.advanceTimersByTimeAsync(100);

      harness.handlers.get("turn_start")?.({ timestamp: Date.now() } as never);
      await vi.advanceTimersByTimeAsync(40);
      harness.handlers.get("turn_end")?.({ message: { usage: {} }, toolResults: [] } as never);
      await vi.advanceTimersByTimeAsync(249);
      expect(harness.posts.filter((message) => message.type === "hook-run")).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);

      const results = harness.posts.filter((message) => message.type === "hook-run");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ type: "hook-run", name: "延迟观察", scope: "global", event: "turn_end", source: "trigger", ok: true, detail: "通知：40", at: expect.any(Number) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records awaited session_start actions", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness([{ name: "启动检查", event: "session_start", action: { kind: "notify" } }]);
      harness.handlers.get("session_start")?.({} as never);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.posts.find((message) => message.type === "hook-run")).toMatchObject({ type: "hook-run", event: "session_start", source: "trigger", ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records failed observation outcomes with their output", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    try {
      const harness = createHarness([{ name: "HTTP检查", event: "turn_end", action: { kind: "http", url: "https://example.invalid/hook" } }]);
      harness.handlers.get("turn_end")?.({ message: { usage: {} }, toolResults: [] } as never);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.posts.find((message) => message.type === "hook-run")).toMatchObject({ type: "hook-run", event: "turn_end", source: "trigger", ok: false, detail: expect.stringContaining("offline") });
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("records every blocked run immediately but emits one warning per rule", async () => {
    const harness = createHarness([blockRule]);
    await callToolCall(harness, "bash", { command: "git push --force" });
    await callToolCall(harness, "bash", { command: "git push --force" });

    const results = harness.posts.filter((message) => message.type === "hook-run");
    expect(results).toHaveLength(2);
    expect(results.every((message) => message.type === "hook-run" && message.blocked && message.source === "trigger")).toBe(true);
    expect(harness.posts.filter((message) => message.type === "hook-notice")).toHaveLength(1);
  });
});

describe("runHookCommand", () => {
  it("captures exit code and stdout", async () => {
    const rule: HookRule = { name: "x", event: "tool_call", action: { kind: "command", command: "echo hook-out" } };
    const result = await runHookCommand(rule, { event: "tool_call", sessionId: "s", sessionTitle: "t", agentName: "a" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hook-out");
    expect(result.timedOut).toBe(false);
  });

  it("propagates non-zero exit codes", async () => {
    const rule: HookRule = { name: "x", event: "tool_call", action: { kind: "command", command: "exit 7" } };
    const result = await runHookCommand(rule, { event: "tool_call", sessionId: "s", sessionTitle: "t", agentName: "a" });
    expect(result.exitCode).toBe(7);
  });

  it("kills the command on timeout", async () => {
    const longCommand = process.platform === "win32" ? "ping -n 5 127.0.0.1" : "sleep 5";
    const rule: HookRule = { name: "x", event: "session_start", timeoutMs: 1_000, action: { kind: "command", command: longCommand } };
    const result = await runHookCommand(rule, { event: "session_start", sessionId: "s", sessionTitle: "t", agentName: "a" });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(4_500);
  }, 15_000);
});

describe("testHook", () => {
  it("evaluates block rules against the sample line", async () => {
    const harness = createHarness([]);
    const blocked = await testHook(blockRule, "git push --force origin main", harness.deps);
    expect(blocked.blocked).toBe(true);
    const allowed = await testHook(blockRule, "npm test", harness.deps);
    expect(allowed.blocked).toBeUndefined();
    expect(allowed.detail).toContain("放行");
  });

  it("really posts a notification for notify rules", async () => {
    const harness = createHarness([]);
    const outcome = await testHook({ name: "跑完通知", event: "turn_end", action: { kind: "notify", title: "{sessionTitle} 完成" } }, undefined, harness.deps);
    expect(outcome.ok).toBe(true);
    expect(harness.posts).toHaveLength(1);
    // 测试上下文的 sessionId 是虚构的，永远不等于任何真实激活会话——面板测试按钮总能看到真实弹窗。
    expect(harness.posts[0]).toMatchObject({ type: "hook-notify", title: "钩子测试 完成", sessionId: "test-session" });
  });
});
