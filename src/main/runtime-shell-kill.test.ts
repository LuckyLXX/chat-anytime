import { afterEach, describe, expect, it, vi } from "vitest";

// 内建工具工厂以可控假件替换：包装逻辑（信号桥接 / 错误改写 / kill 定位）
// 是被测对象，真实 shell 执行链不在单元测试范围。
const harness = vi.hoisted(() => {
  interface FakeResult {
    content: Array<{ type: "text"; text: string }>;
  }
  type Behavior = (toolCallId: string, signal: AbortSignal | undefined) => Promise<FakeResult>;
  const behaviors = new Map<string, Behavior>();
  const calls: Array<{ name: string; toolCallId: string; signal: AbortSignal | undefined }> = [];
  const factoryCalls: Array<{ name: string; cwd: string; options: unknown }> = [];
  function fakeDefinition(name: string, cwd: string, options: unknown) {
    factoryCalls.push({ name, cwd, options });
    return {
      name,
      label: name,
      description: `${name} fake description`,
      parameters: { type: "object" },
      execute(toolCallId: string, _params: unknown, signal: AbortSignal | undefined): Promise<FakeResult> {
        calls.push({ name, toolCallId, signal });
        const behavior = behaviors.get(name);
        if (!behavior) return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
        return behavior(toolCallId, signal);
      }
    };
  }
  return { behaviors, calls, factoryCalls, fakeDefinition };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createBashToolDefinition: (cwd: string, options?: unknown) => harness.fakeDefinition("bash", cwd, options),
  createPowerShellToolDefinition: (cwd: string) => harness.fakeDefinition("powershell", cwd, undefined)
}));

import { buildKillableShellTools, USER_KILL_NOTICE } from "./runtime-shell-kill.js";

afterEach(() => {
  harness.behaviors.clear();
  harness.calls.length = 0;
  harness.factoryCalls.length = 0;
});

/** 等待信号中止后按内建工具的 aborted 路径抛错（前缀输出 + 状态行）。 */
function abortThenThrow(message: string) {
  return (_toolCallId: string, signal: AbortSignal | undefined): Promise<never> => new Promise((_, reject) => {
    if (signal?.aborted) {
      reject(new Error(message));
      return;
    }
    signal?.addEventListener("abort", () => reject(new Error(message)), { once: true });
  });
}

describe("buildKillableShellTools", () => {
  it("生成与内建同名的 bash/powershell 定义并透传工厂选项", () => {
    const tools = buildKillableShellTools({ cwd: "/workspace", commandPrefix: "prefix", shellPath: "/bin/bash" });
    expect(tools.tools.map((tool) => tool.name)).toEqual(["bash", "powershell"]);
    expect(tools.tools.map((tool) => tool.description)).toEqual(["bash fake description", "powershell fake description"]);
    expect(harness.factoryCalls).toEqual([
      { name: "bash", cwd: "/workspace", options: { commandPrefix: "prefix", shellPath: "/bin/bash" } },
      { name: "powershell", cwd: "/workspace", options: undefined }
    ]);
  });

  it("未被终止时直通内建工具的结果，kill 未命中的 id 返回 false", async () => {
    const tools = buildKillableShellTools({ cwd: "/workspace" });
    const result = await tools.tools[0]!.execute("call-1", {}, undefined, undefined, undefined as never);
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(tools.kill("call-1")).toBe(false);
    expect(tools.kill("never-started")).toBe(false);
  });

  it("用户终止：内层信号中止，Command aborted 状态行改写为终止说明", async () => {
    harness.behaviors.set("bash", abortThenThrow("partial output\n\nCommand aborted"));
    const tools = buildKillableShellTools({ cwd: "/workspace" });
    const outer = new AbortController();
    const pending = tools.tools[0]!.execute("call-1", {}, outer.signal, undefined, undefined as never);
    expect(tools.kill("call-1")).toBe(true);
    const error = await pending.then(() => { throw new Error("应当失败"); }, (cause: unknown) => cause as Error);
    expect(error.message).toContain("partial output");
    expect(error.message).toContain(USER_KILL_NOTICE);
    expect(error.message).not.toContain("Command aborted");
    expect(outer.signal.aborted).toBe(false);
  });

  it("整回合适别中止：错误原样透传，不改写为终止说明", async () => {
    harness.behaviors.set("bash", abortThenThrow("out\n\nCommand aborted"));
    const tools = buildKillableShellTools({ cwd: "/workspace" });
    const outer = new AbortController();
    const pending = tools.tools[0]!.execute("call-1", {}, outer.signal, undefined, undefined as never);
    outer.abort();
    const error = await pending.then(() => { throw new Error("应当失败"); }, (cause: unknown) => cause as Error);
    expect(error.message).toBe("out\n\nCommand aborted");
    expect(tools.kill("call-1")).toBe(false);
  });

  it("调用结束后注销 kill 句柄，重复终止无效", async () => {
    let release: (result: { content: Array<{ type: "text"; text: string }> }) => void = () => undefined;
    harness.behaviors.set("powershell", () => new Promise((resolve) => { release = resolve; }));
    const tools = buildKillableShellTools({ cwd: "/workspace" });
    const pending = tools.tools[1]!.execute("call-1", {}, undefined, undefined, undefined as never);
    expect(tools.kill("call-1")).toBe(true);
    release({ content: [{ type: "text", text: "late" }] });
    await pending;
    expect(tools.kill("call-1")).toBe(false);
  });
});
