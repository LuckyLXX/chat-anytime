import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SettingsManager,
  createAgentSession,
  type AgentSession
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { HookRule, RuntimeMessage } from "../shared/protocol.js";
import { createHooksExtension, type HooksExtensionDeps } from "./runtime-hooks.js";

/**
 * 「跑完通知」的真实会话集成测试（2026-10-20 用户报：整个会话没完全结束就弹通知）。
 *
 * 单元测试能证明「钩子只在 agent_settled 上触发」，但证明不了 **Pi 真的会在
 * agent_end 之后继续跑**（自动重试 / 溢出压缩恢复 / 排队后续消息）。这一层是
 * Pi 的行为，只能在真实 AgentSession 上验——所以这里用 faux provider（进程内
 * 假模型，零网络）让 Pi 走一遍真实的「失败 → 自动重试 → 成功」流程，
 * 断言通知只在**整次回复真正收尾**时出现一次。
 *
 * 反向验证：把 runtime-hooks.ts 的触发点改回 agent_end，本文件的
 * 「重试期间不弹」断言会立刻转红。
 */

const temporaryDirectories: string[] = [];
const temporaryRestores: (() => void)[] = [];

afterEach(async () => {
  for (const restore of temporaryRestores.splice(0)) restore();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface HookHarness {
  session: AgentSession;
  faux: ReturnType<typeof fauxProvider>;
  posts: RuntimeMessage[];
  /** 通知出现的时间线（相对毫秒），用来断言「只有一次且在最后」。 */
  notifications: { title: string; body: string }[];
  /** http 动作推送出去的上下文（用来验累计 usage）。 */
  captured?: Record<string, unknown>;
}

/**
 * 建一个真实的 AgentSession + 钩子扩展。
 *
 * retrySettings 覆盖 Pi 的自动重试策略：默认 baseDelayMs 是 2000ms（指数退避），
 * 测试里调到 1ms 免得拖慢套件。
 */
async function makeSession(rules: HookRule[], retrySettings?: { enabled: boolean; maxRetries: number; baseDelayMs: number }): Promise<HookHarness> {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-hook-settle-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  if (retrySettings) {
    // 写全局设置：Pi 的 SettingsManager 从 <agentDir>/settings.json 读 retry。
    // 必须在 SettingsManager.create **之前**落盘（它创建时就读一次）。
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: retrySettings }, null, 2), "utf8");
  }
  const settingsManager = SettingsManager.create(root, agentDir);
  const posts: RuntimeMessage[] = [];
  const notifications: { title: string; body: string }[] = [];
  const harness: HookHarness = { session: undefined as unknown as AgentSession, faux: undefined as unknown as ReturnType<typeof fauxProvider>, posts, notifications };
  // 桦住 fetch：http 动作的推送体在这里被捕获（不触网）。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    if (init?.body) {
      try {
        harness.captured = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        // 非 JSON 体不记（不是本用例要验的东西）。
      }
    }
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
  temporaryRestores.push(() => { globalThis.fetch = originalFetch; });
  const deps: HooksExtensionDeps = {
    rules: () => rules.map((rule) => ({ name: rule.name, rule, scope: "global" })),
    enabled: () => true,
    workspace: () => root,
    agentName: () => "测试助手",
    sessionId: () => "session-1",
    sessionTitle: () => "测试会话",
    // 全局作用域的钩子不需要项目审批。
    trust: () => true,
    post: (message) => {
      posts.push(message);
      if (message.type === "hook-notify") notifications.push({ title: message.title, body: message.body });
    }
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createHooksExtension(deps)]
  });
  await resourceLoader.reload();

  const faux = fauxProvider();
  const result = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    model: faux.getModel()
  });
  const session = result.session;
  await session.bindExtensions({ onError: () => {} });
  session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof session.agent.streamFunction;
  session.modelRuntime.registerNativeProvider(faux.provider);
  await session.modelRuntime.refresh({ allowNetwork: false });
  harness.session = session;
  harness.faux = faux;
  return harness;
}

const notifyRule: HookRule = {
  name: "跑完通知",
  event: "agent_end",
  action: { kind: "notify", title: "PiDesktop：任务完成", body: "「{sessionTitle}」已完成本轮回复（{duration}）" }
};

/** http 动作：用来验上下文里的累计 usage（通知只能验标题/正文）。 */
const httpRule: HookRule = {
  name: "整次推送",
  event: "agent_end",
  action: { kind: "http", url: "https://example.test/hook" }
};

describe("跑完通知触发时机（真实 AgentSession）", () => {
  it("正常回复：只弹一次通知", async () => {
    const harness = await makeSession([notifyRule]);
    try {
      harness.faux.setResponses([fauxAssistantMessage("done")]);
      await harness.session.prompt("go");
      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0]?.title).toBe("PiDesktop：任务完成");
      // {duration} 是可读文案，不是裸毫秒。
      expect(harness.notifications[0]?.body).toMatch(/（\d+(\.\d+)? (毫秒|秒)|（\d+ 分 \d{2} 秒）/);
    } finally {
      harness.session.dispose();
    }
  });

  it("自动重试：重试期间不弹，整次回复真正收尾才弹一次", async () => {
    // 这是用户报的原始症状：Pi 第一次尝试失败 → 自动重试 → 成功。
    // 重试发生在 agent_end 之后、agent_settled 之前；旧实现挂在 agent_end 上，
    // 于是「任务完成」在重试刚开始时就弹了出来。
    const harness = await makeSession([notifyRule], { enabled: true, maxRetries: 2, baseDelayMs: 1 });
    try {
      harness.faux.setResponses([
        // 可重试错误（命中 Pi 的 RETRYABLE_PROVIDER_ERROR_PATTERN）。
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 Internal Server Error" }),
        fauxAssistantMessage("recovered")
      ]);
      await harness.session.prompt("go");
      // 前置：重试**真的发生了**（模型被调用两次）——否则本用例是空断言。
      expect(harness.faux.state.callCount).toBe(2);
      // 整次回复（含重试）只弹一次通知——不是「失败一次 + 成功一次」两次。
      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0]?.body).toContain("已完成本轮回复");
    } finally {
      harness.session.dispose();
    }
  });

  it("重试时整次用量累加（第二次 agent_start 不重置累加器）", async () => {
    // Pi 的重试会**再次发 agent_start**（agent.continue() → runAgentLoopContinue）。
    // 如果在 agent_start 里重置累加器，第一次尝试的用量就丢了——
    // 这正是旧实现「取 agent_end 的 messages 求和」想避开的问题，换个方式重犯就白改。
    const harness = await makeSession([httpRule], { enabled: true, maxRetries: 2, baseDelayMs: 1 });
    try {
      harness.faux.setResponses([
        // 失败的那次**也带正文**（partial）：faux provider 按内容长度估 output，
        // 所以两次的 output 分别是 2 和 3（ceil(7/4) / ceil(9/4)）。
        // 若累加器在第二次 agent_start 被重置，output 只会是 3 而不是 5——
        // 这个断言因此能真拦住「重置丢前一段」的回归。
        fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "500 Internal Server Error" }),
        fauxAssistantMessage("recovered")
      ]);
      await harness.session.prompt("go");
      expect(harness.faux.state.callCount).toBe(2);
      const usage = harness.captured?.usage as { input?: number; output?: number } | undefined;
      // 两次尝试的 usage 都在（第一次失败那次的 input 也是有值的）。
      expect(usage?.input).toBeGreaterThan(0);
      // 失败那次 output=2 + 成功那次 output=3 = 5。
      expect(usage?.output).toBe(5);
      expect(harness.captured?.event).toBe("agent_end");
    } finally {
      harness.session.dispose();
    }
  });

  it("重试彻底失败：仍然只弹一次通知（失败收尾也算整次结束）", async () => {
    const harness = await makeSession([notifyRule], { enabled: true, maxRetries: 1, baseDelayMs: 1 });
    try {
      harness.faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 Internal Server Error" }),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 Internal Server Error" })
      ]);
      await harness.session.prompt("go");
      expect(harness.notifications).toHaveLength(1);
    } finally {
      harness.session.dispose();
    }
  });
});
