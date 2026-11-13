import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager, createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { buildContextInspection, foldSystemPromptSections } from "./context-inspection.js";

/**
 * 上下文中心依赖的 Pi 形状（真实 AgentSession + faux provider，零网络）。
 *
 * 单测用的是手写对象；这里钉住真实形状：
 * 1. `session.state.messages` 里首条 system 消息带 sections（preamble + cwd），
 *    内容与 `session.systemPrompt` 一致——分块与全文都从这两个来源取；
 * 2. `session.state.tools` 是**声明集**（含 name/description/parameters），
 *    `session.getAllTools()` 带 exposure / sourceInfo / promptGuidelines；
 * 3. 应用的 `systemPromptOverride` 拼接结果确实进 preamble（分块标记可定位）。
 *
 * 若 Pi 改了这些投影，本文件先红，提醒重新审视 context-inspection 的取值口径。
 */

const PERSONA = "你是测试助手，只做只读检查，不改动任何文件。";
const ORCH = "【工具编排】批量读多个文件时优先用 codemode 写一段脚本。";
const OUTPUT = "【输出格式】所有围栏都必须写语言标注。";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeSession(): Promise<AgentSession> {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-context-inspection-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "BASE PROMPT FROM FILE",
    // 与 pi-runtime 的 systemPromptOverride 同形：base + 各块用空行拼接。
    systemPromptOverride: (base) => [base, PERSONA, ORCH, OUTPUT].filter(Boolean).join("\n\n")
  });
  await resourceLoader.reload();
  const faux = fauxProvider();
  const result = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, model: faux.getModel() });
  const session = result.session;
  await session.bindExtensions({ onError: () => {} });
  session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof session.agent.streamFunction;
  session.modelRuntime.registerNativeProvider(faux.provider);
  await session.modelRuntime.refresh({ allowNetwork: false });
  (session as unknown as { __faux?: typeof faux }).__faux = faux;
  return session;
}

function fauxOf(session: AgentSession): ReturnType<typeof fauxProvider> {
  const faux = (session as unknown as { __faux?: ReturnType<typeof fauxProvider> }).__faux;
  if (!faux) throw new Error("faux provider 没有挂上");
  return faux;
}

describe("上下文中心依赖的 Pi 投影（真实会话）", () => {
  it("system messages 的 sections 折叠出 preamble 与 cwd，并与 systemPrompt 同源", async () => {
    const session = await makeSession();
    try {
      fauxOf(session).setResponses([fauxAssistantMessage("完成")]);
      await session.prompt("只读检查一下");
      const folded = foldSystemPromptSections(session.state.messages);
      expect(folded.preamble).toContain("BASE PROMPT FROM FILE");
      expect(folded.preamble).toContain(PERSONA);
      expect(folded.preamble).toContain("【工具编排】");
      expect(folded.preamble).toContain("【输出格式】");
      expect(folded.sections.map((section) => section.name)).toContain("cwd");
      // 全文与分段必须同源（页面同时展示两者，漂移会让数字对不上）
      expect(session.systemPrompt).toContain(folded.preamble.slice(0, 80));
      expect(session.systemPrompt).toContain("<cwd>");
    } finally {
      session.dispose();
    }
  }, 30_000);

  it("inspection 从真实会话投影组装：块可定位、工具声明与注册表都取到", async () => {
    const session = await makeSession();
    try {
      fauxOf(session).setResponses([fauxAssistantMessage("完成")]);
      await session.prompt("只读检查一下");
      const declared = session.state.tools;
      const registry = session.getAllTools();
      expect(declared.length).toBeGreaterThan(0);
      expect(registry.length).toBeGreaterThanOrEqual(declared.length);

      const inspection = buildContextInspection({
        at: Date.now(),
        sessionId: session.sessionId,
        agent: { id: "agent-test", name: "测试助手", systemPrompt: PERSONA, divMode: "off" },
        thinkingLevel: session.thinkingLevel,
        systemPrompt: session.systemPrompt,
        messages: session.state.messages,
        declaredTools: declared.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        registryTools: registry.map((tool) => ({
          name: tool.name,
          exposure: tool.exposure,
          ...(tool.sourceInfo ? { sourceInfo: { path: tool.sourceInfo.path } } : {}),
          ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {})
        })),
        currentBlocks: { skills: "", orchestration: ORCH, output: OUTPUT, subagents: "", memory: "", div: "" },
        turnInjections: [],
        runtime: []
      });

      // 自定义基础提示词形成 leading，人设/编排/输出格式按标记切出来
      expect(inspection.prompt.leading?.text).toContain("BASE PROMPT FROM FILE");
      const blocks = Object.fromEntries(inspection.prompt.blocks.map((block) => [block.id, block]));
      expect(blocks.agent?.present).toBe(true);
      expect(blocks.agent?.text).toContain(PERSONA);
      expect(blocks.orchestration?.present).toBe(true);
      expect(blocks.orchestration?.text).toContain("【工具编排】");
      expect(blocks.output?.present).toBe(true);
      expect(blocks.skills?.present).toBe(false);
      expect(inspection.prompt.sections.some((section) => section.name === "cwd")).toBe(true);

      // 声明清单与 Pi 的活动工具集逐名一致；每个都带来源与曝光
      expect(inspection.tools.declared.map((tool) => tool.name)).toEqual(declared.map((tool) => tool.name));
      for (const tool of inspection.tools.declared) {
        expect(tool.source).toBe("builtin");
        expect(tool.tokens).toBeGreaterThan(0);
        expect(tool.parameters.length).toBeGreaterThan(0);
      }
      // 消息统计覆盖 system + user + assistant
      const roles = Object.fromEntries(inspection.messages.byRole.map((row) => [row.role, row.count]));
      expect(roles.system).toBeGreaterThanOrEqual(1);
      expect(roles.user).toBeGreaterThanOrEqual(1);
      expect(roles.assistant).toBeGreaterThanOrEqual(1);
      expect(inspection.messages.top.length).toBeGreaterThan(0);
    } finally {
      session.dispose();
    }
  }, 30_000);
});
