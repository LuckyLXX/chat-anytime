import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager, createAgentSession, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

/**
 * 「`agent_end` 不是会话终点」这条假设的真实会话验证（2026-11-13 内网用户报：
 * 绘画还没完成、输入框已显示完成，回车却被 Pi 以英文 "Agent is already processing…"
 * 拒收）。
 *
 * `run-state.ts` 的口径（`busy || session.isStreaming`）和 `pi-runtime` 的
 * 「回合同样在 `agent_settled` 才定稿」全都建立在一条 Pi 的行为上：
 * **`agent_end` 事件到达时 `session.isStreaming` 仍为真**（自动重试 / 压缩恢复 /
 * 排队 followUp 之后 Pi 还会继续），只有 `agent_settled` 之后才转假。
 *
 * 单元测试和源码断言都证明不了这条——它是 Pi 的运行时行为。所以这里用 faux
 * provider（进程内假模型、零网络）走一遍真实的「失败 → 自动重试 → 成功」，在
 * 事件回调里同步读 `session.isStreaming`。若哪天 Pi 改了语义（比如 agent_end 就
 * 清 `_isAgentRunActive`），本文件会先红，提醒我们重新审视口径。
 *
 * 反向验证：把 `pi-runtime` 的 `agent_end` 分支改回「立刻 busy=false + 定稿」，
 * `run-active-wiring.test.ts` 转红；把口径写回 `record.busy`，快照断言转红。
 * 本文件只钉 Pi 侧的行为，不依赖我们的实现。
 */
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface BoundaryReading {
  type: "agent_end" | "agent_settled";
  /** 事件到达那一刻的 session.isStreaming（同步读，模拟 runtime 的感知）。 */
  streaming: boolean;
  willRetry?: boolean;
}

async function makeSession(retrySettings: { enabled: boolean; maxRetries: number; baseDelayMs: number }): Promise<AgentSession> {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-run-boundary-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  // Pi 的 SettingsManager 创建时读一次 settings.json：自动重试的退避要在那之前落盘。
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: retrySettings }, null, 2), "utf8");
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true
  });
  await resourceLoader.reload();
  const faux = fauxProvider();
  const result = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, model: faux.getModel() });
  const session = result.session;
  await session.bindExtensions({ onError: () => {} });
  session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof session.agent.streamFunction;
  session.modelRuntime.registerNativeProvider(faux.provider);
  await session.modelRuntime.refresh({ allowNetwork: false });
  // 让测试拿到 faux（响应队列由 dispatcher 关闭前写入）。
  (session as unknown as { __faux?: typeof faux }).__faux = faux;
  return session;
}

function fauxOf(session: AgentSession): ReturnType<typeof fauxProvider> {
  const faux = (session as unknown as { __faux?: ReturnType<typeof fauxProvider> }).__faux;
  if (!faux) throw new Error("faux provider 没有挂上");
  return faux;
}

describe("Pi 的 run 边界（真实 AgentSession + faux provider）", () => {
  it("agent_end 到达时 isStreaming 仍为真；agent_settled 之后才转假", async () => {
    const session = await makeSession({ enabled: true, maxRetries: 2, baseDelayMs: 1 });
    try {
      const readings: BoundaryReading[] = [];
      session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "agent_end") readings.push({ type: "agent_end", streaming: session.isStreaming, willRetry: event.willRetry });
        else if (event.type === "agent_settled") readings.push({ type: "agent_settled", streaming: session.isStreaming });
      });
      const faux = fauxOf(session);
      faux.setResponses([
        // 可重试错误（命中 Pi 的 RETRYABLE_PROVIDER_ERROR_PATTERN），then 成功。
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "500 Internal Server Error" }),
        fauxAssistantMessage("recovered")
      ]);
      await session.prompt("go");

      // 前置：自动重试真的发生了（否则本用例是空断言）。
      expect(faux.state.callCount).toBe(2);
      const ends = readings.filter((reading) => reading.type === "agent_end");
      const settled = readings.filter((reading) => reading.type === "agent_settled");
      expect(ends).toHaveLength(2);
      expect(settled).toHaveLength(1);
      // 第一次 agent_end 声明「还要重试」，这一次到达时 Pi 显然还在跑。
      expect(ends[0]?.willRetry).toBe(true);
      // **核心断言**：每一次 agent_end 的时刻，session.isStreaming 都还是 true。
      // 这就是「收尾窗口」——UI 若在这时把会话当空闲，回车必然被 prompt() 拒收。
      for (const end of ends) expect(end.streaming).toBe(true);
      // 会话级终点：settle 之后 isStreaming 才为假。
      expect(settled[0]?.streaming).toBe(false);
      expect(session.isStreaming).toBe(false);
    } finally {
      session.dispose();
    }
  }, 30_000);

  it("正常回合也满足：agent_end 时仍 streaming，prompt 返回后空闲", async () => {
    const session = await makeSession({ enabled: false, maxRetries: 0, baseDelayMs: 1 });
    try {
      const readings: BoundaryReading[] = [];
      session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "agent_end") readings.push({ type: "agent_end", streaming: session.isStreaming });
        else if (event.type === "agent_settled") readings.push({ type: "agent_settled", streaming: session.isStreaming });
      });
      fauxOf(session).setResponses([fauxAssistantMessage("done")]);
      await session.prompt("go");
      expect(readings).toHaveLength(2);
      expect(readings[0]).toMatchObject({ type: "agent_end", streaming: true });
      expect(readings[1]).toMatchObject({ type: "agent_settled", streaming: false });
    } finally {
      session.dispose();
    }
  }, 30_000);
});
