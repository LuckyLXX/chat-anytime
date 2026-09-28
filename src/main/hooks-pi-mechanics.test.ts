import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SettingsManager,
  createAgentSession,
  defineTool,
  type AgentSession,
  type ExtensionAPI,
  type InlineExtension,
  type InputEventResult,
  type ToolDefinition,
  type ToolResultEventResult
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/**
 * 钩子统一输出协议（P4）依赖的四项 Pi 机制，全部压在一个**真实 AgentSession** 上验证——
 * 这些行为只读源码容易看错，而它们错了的话 updatedInput / userInput / toolResult /
 * additionalContext 会在真机上静默失效。模型用进程内 faux provider（零网络）。
 *
 * 与实施计划的一处出入（实测为准）：计划断言「tool_result 只回 {content} 会清空 details」，
 * 但 Pi 0.87.1 的实际语义是**漏传 = 保留原 details**（agent-loop 有 `?? result.details` 兜底），
 * 只有非 nullish 的 details 才覆盖。测试按实测写。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface Probe {
  executed: Record<string, unknown>[];
  endDetails: unknown[];
  modelUserTexts: string[];
}

interface ProbeHooks {
  onInput?: (text: string) => InputEventResult | undefined;
  onToolCall?: (event: { toolName: string; input: Record<string, unknown> }, pi: ExtensionAPI) => void;
  onToolResult?: (details: unknown) => ToolResultEventResult | undefined;
}

function makeProbeTool(probe: Probe): ToolDefinition {
  return defineTool({
    name: "probe_tool",
    label: "probe_tool",
    description: "probe",
    promptSnippet: "probe_tool: probe",
    parameters: Type.Object({ value: Type.String() }),
    execute: async (_id, params) => {
      probe.executed.push(params as Record<string, unknown>);
      return { content: [{ type: "text", text: "orig-content" }], details: { secret: "orig" } };
    }
  });
}

function probeExtension(probe: Probe, hooks: ProbeHooks): InlineExtension {
  return {
    name: "probe-extension",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("input", (event) => hooks.onInput?.(event.text));
      pi.on("tool_call", (event) => { hooks.onToolCall?.(event as unknown as { toolName: string; input: Record<string, unknown> }, pi); });
      pi.on("tool_result", (event) => hooks.onToolResult?.((event as { details: unknown }).details));
      pi.on("tool_execution_end", (event) => { probe.endDetails.push((event as { result?: { details?: unknown } }).result?.details); });
    }
  };
}

async function makeSession(probe: Probe, hooks: ProbeHooks): Promise<{ session: AgentSession; faux: ReturnType<typeof fauxProvider> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-hook-mechanics-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [probeExtension(probe, hooks)]
  });
  await resourceLoader.reload();

  const faux = fauxProvider();
  const result = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    customTools: [makeProbeTool(probe)],
    model: faux.getModel(),
    tools: ["probe_tool"]
  });
  const session = result.session;
  await session.bindExtensions({ onError: () => {} });
  // 进程内假模型：覆盖 agent 的 stream 入口，彻底不触网。
  session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof session.agent.streamFunction;
  // 让 session.prompt 的模型/鉴权校验通过（faux provider 自带 auth.resolve）。
  session.modelRuntime.registerNativeProvider(faux.provider);
  await session.modelRuntime.refresh({ allowNetwork: false });
  return { session, faux };
}

function branchKinds(session: AgentSession): string[] {
  return session.sessionManager.getBranch().map((entry) => {
    if (entry.type !== "message") return entry.type;
    const role = (entry.message as { role?: string }).role;
    return role === "toolResult" ? "toolResult" : role ?? "unknown";
  });
}

describe("hook command output mechanics (real AgentSession)", () => {
  it("在 tool_call 里原地改 event.input，工具真的收到改写后的参数", async () => {
    const probe: Probe = { executed: [], endDetails: [], modelUserTexts: [] };
    const { session, faux } = await makeSession(probe, {
      onToolCall: (event) => { if (event.toolName === "probe_tool") event.input.value = "mutated"; }
    });
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("probe_tool", { value: "original" })]),
        fauxAssistantMessage("done")
      ]);
      await session.prompt("go");
      expect(probe.executed).toEqual([{ value: "mutated" }]);
    } finally {
      session.dispose();
    }
  });

  it("tool_result 漏传 details 会保留原值，回传非 nullish 才覆盖", async () => {
    const kept: Probe = { executed: [], endDetails: [], modelUserTexts: [] };
    const first = await makeSession(kept, { onToolResult: () => ({ content: [{ type: "text", text: "patched" }] }) });
    try {
      first.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("probe_tool", { value: "v" })]),
        fauxAssistantMessage("done")
      ]);
      await first.session.prompt("go");
      // content 被替换，details 原样保留（漏传不会清空）。
      expect(kept.endDetails.at(-1)).toEqual({ secret: "orig" });
    } finally {
      first.session.dispose();
    }

    const replaced: Probe = { executed: [], endDetails: [], modelUserTexts: [] };
    const second = await makeSession(replaced, {
      onToolResult: () => ({ content: [{ type: "text", text: "patched" }], details: { secret: "new" } })
    });
    try {
      second.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("probe_tool", { value: "v" })]),
        fauxAssistantMessage("done")
      ]);
      await second.session.prompt("go");
      expect(replaced.endDetails.at(-1)).toEqual({ secret: "new" });
    } finally {
      second.session.dispose();
    }
  });

  it("input 返回 handled 会吞掉这次输入：不触达模型、不入对话", async () => {
    const probe: Probe = { executed: [], endDetails: [], modelUserTexts: [] };
    const { session, faux } = await makeSession(probe, {
      onInput: (text) => text === "swallow" ? { action: "handled" } : undefined
    });
    try {
      faux.setResponses([fauxAssistantMessage("should-not-run")]);
      await session.prompt("swallow");
      expect(faux.state.callCount).toBe(0);
      expect(faux.getPendingResponseCount()).toBe(1);
      expect(branchKinds(session).filter((kind) => kind === "user")).toHaveLength(0);
    } finally {
      session.dispose();
    }
  });

  it("input 返回 transform 会改写模型看到的用户文本", async () => {
    const probe: Probe = { executed: [], endDetails: [], modelUserTexts: [] };
    const { session, faux } = await makeSession(probe, {
      onInput: (text) => text === "shout" ? { action: "transform", text: "shout!!!" } : undefined
    });
    try {
      const original = session.agent.streamFunction;
      session.agent.streamFunction = ((model, context, options) => {
        probe.modelUserTexts.push(JSON.stringify(context.messages));
        return original(model, context, options);
      }) as typeof session.agent.streamFunction;
      faux.setResponses([fauxAssistantMessage("done")]);
      await session.prompt("shout");
      expect(probe.modelUserTexts.at(-1)).toContain("shout!!!");
    } finally {
      session.dispose();
    }
  });

  it("pi.sendMessage(triggerTurn:false) 在 turn_end 后 flush，不落在 tool call 与 result 之间", async () => {
    const probe: Probe = { executed: [], endDetails: [], modelUserTexts: [] };
    const { session, faux } = await makeSession(probe, {
      onToolCall: (event, pi) => {
        if (event.toolName !== "probe_tool") return;
        pi.sendMessage({
          customType: "pidesktop-hook-context",
          content: "injected",
          display: true,
          details: { rule: "probe", event: "tool_call" }
        }, { triggerTurn: false });
      }
    });
    try {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("probe_tool", { value: "v" })]),
        fauxAssistantMessage("done")
      ]);
      await session.prompt("go");

      const kinds = branchKinds(session);
      const injected = kinds.indexOf("custom_message");
      const toolResult = kinds.indexOf("toolResult");
      expect(toolResult).toBeGreaterThanOrEqual(0);
      expect(injected).toBe(toolResult + 1); // 紧跟 tool result，且排在收尾 assistant 之前
      expect(kinds.at(-1)).toBe("assistant");

      const entry = session.sessionManager.getBranch().find((item) => item.type === "custom_message");
      expect(entry).toMatchObject({
        customType: "pidesktop-hook-context",
        content: "injected",
        display: true,
        details: { rule: "probe", event: "tool_call" }
      });
    } finally {
      session.dispose();
    }
  });
});
