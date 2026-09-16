import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { applyModelOverrides } from "./model-catalog.js";
import { supportedThinkingLevels } from "../shared/thinking-levels.js";
import type { ProviderSettings } from "../shared/protocol.js";

/**
 * 真会话探针：钉住用户报的「模型不支持思考等级时切不过去」这条链路，以及修复
 * 依赖的两条 Pi 事实（2026-09-16）。
 *
 * 单测里对 Pi 的对照用的是纯函数（models.js 的 getSupportedThinkingLevels），
 * 但用户真正踩到的是**会话层**：`AgentSession.setThinkingLevel` 会把不支持的
 * 档位静默 clamp 回可用的那一档，菜单却没有任何反馈。这个探针用真实
 * AgentSession 把「声明前 → 声明后」的差别摆出来，防止将来 Pi 改了行为而
 * 我们只是照着旧假设写代码。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function model(thinkingLevelMap?: Record<string, string | null>): Model<Api> {
  return {
    id: "qwen3.8-27b",
    name: "qwen3.8-27b",
    api: "openai-completions",
    provider: "wong-proxy",
    baseUrl: "https://wzw.pp.ua/v1",
    reasoning: true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 65536
  };
}

async function makeSession(sessionModel: Model<Api>) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-thinking-levels-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const result = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, model: sessionModel });
  await result.session.bindExtensions({ onError: () => {} });
  return result.session;
}

describe("thinking level selection against a real AgentSession", () => {
  it("clamps undeclared high tiers silently — the exact bug the user hit", async () => {
    const session = await makeSession(model());
    try {
      // 未声明映射：Pi 只给 关闭…高，「很高」根本不在可选集里。
      expect(session.getAvailableThinkingLevels()).toEqual(["off", "minimal", "low", "medium", "high"]);
      session.setThinkingLevel("xhigh");
      // 请求被静默接受但实际落回 high —— 菜单点了没反应，随后请求带 high 打出去。
      expect(session.thinkingLevel).toBe("high");
      expect(session.supportsThinking()).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it("honors high tiers once the model declares them (what the settings editor writes)", async () => {
    const declared = model({ off: null, minimal: null, low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh", max: null });
    const session = await makeSession(declared);
    try {
      expect(session.getAvailableThinkingLevels()).toEqual(["low", "medium", "high", "xhigh"]);
      session.setThinkingLevel("xhigh");
      expect(session.thinkingLevel).toBe("xhigh");
      // 不支持的档位依旧被钳制（回归网：声明不是「全部放开」）。
      session.setThinkingLevel("max");
      expect(session.thinkingLevel).toBe("xhigh");
    } finally {
      session.dispose();
    }
  });

  it("honors a declaration that lands after the session already fell back to a lower level", async () => {
    // 用户的真实时序：会话先落在未声明的模型上（档位被钳到 high），随后在设置里
    // 声明支持「很高」。修复后必须不经切模型就能切到 xhigh——这条探针钉住
    // 「声明 → 会话模型元数据同步 → setThinkingLevel 不再被钳」整条链路。
    const session = await makeSession(model());
    try {
      session.setThinkingLevel("xhigh");
      expect(session.thinkingLevel).toBe("high");

      const providers: ProviderSettings[] = [{
        id: "wong-proxy",
        name: "Wong 中转站",
        baseUrl: "https://wzw.pp.ua/v1",
        models: [{ id: "qwen3.8-27b", name: "qwen3.8-27b", thinkingLevelMap: { low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh" } }]
      }];
      // ① 元数据纠偏（pi-runtime.syncSessionModelMetadata 的同款动作）。
      const corrected = applyModelOverrides(session.model as Model<Api>, providers);
      session.agent.state.model = corrected;
      // ② 重新请求「很高」：这次不再被钳制。
      session.setThinkingLevel("xhigh");
      expect(session.thinkingLevel).toBe("xhigh");
    } finally {
      session.dispose();
    }
  });

  it("lets the settings-declared map reach a session model through applyModelOverrides", async () => {
    // 与用户场景同序：会话先落在未声明的模型上，用户在设置里声明后，overrides
    // 把声明叠进模型对象；把它交给 setModel 之后高档位才可选。
    const session = await makeSession(model());
    try {
      const providers: ProviderSettings[] = [{
        id: "wong-proxy",
        name: "Wong 中转站",
        baseUrl: "https://wzw.pp.ua/v1",
        models: [{ id: "qwen3.8-27b", name: "qwen3.8-27b", thinkingLevelMap: { low: "low", medium: "medium", high: "xhigh", xhigh: "xhigh" } }]
      }];
      const corrected = applyModelOverrides(session.model as Model<Api>, providers);
      expect(corrected).not.toBe(session.model);
      expect(supportedThinkingLevels(corrected.thinkingLevelMap, corrected.reasoning)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
      // applyModelOverrides 只做浅克隆，不触碰共享的会话模型对象。
      expect(session.model?.thinkingLevelMap).toBeUndefined();
    } finally {
      session.dispose();
    }
  });
});
