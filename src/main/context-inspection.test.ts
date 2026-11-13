import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildContextInspection,
  foldSystemPromptSections,
  messageText,
  promptSectionOrigin,
  toolSourceOf,
  type ContextInspectionSource
} from "./context-inspection.js";

/**
 * 上下文中心的数据组装。钉住：sections 折叠（覆盖/删除）、真实块切分与未注入对照、
 * 工具声明/未声明与来源、消息统计与排行、尾部注入、schema 截断。
 * 真实 Pi 的形状由 context-inspection-pi-mechanics.test.ts 单独钉住。
 */

const persona = "你是黑鱼河，PiDesktop 的更新维护者。只改源码，不重启宿主应用。";
const skills = "以下 Skill 可用，需要时先用 read 工具读取对应 SKILL.md 再按其中说明执行：\n- /skill:电脑控制 — 操作桌面窗口";
const orchestration = "【工具编排】批量读时优先用 codemode。";
const output = "【输出格式】所有围栏都必须写语言标注。";
const subagents = "以下自定义子智能体是 delegate_agent 的唯一委派对象：\n- code-reviewer（amber）";
const memory = "【长期记忆（memory_* 工具）】\n索引是存在性索引。";
const div = "【Div 气泡模式：输出优先级】\n最终回复必须是一页气泡。";

function systemMessage(sections: Record<string, string | null>, content = "", timestamp = 1): AgentMessage {
  return { role: "system", content, sections, timestamp } as unknown as AgentMessage;
}

function userMessage(text: string, timestamp = 2): AgentMessage {
  return { role: "user", content: text, timestamp } as unknown as AgentMessage;
}

function assistantMessage(text: string, timestamp = 3): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp } as unknown as AgentMessage;
}

function toolResult(text: string, timestamp = 4, image = false): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call-${timestamp}`,
    toolName: "bash",
    content: [{ type: "text", text }, ...(image ? [{ type: "image", data: "x", mimeType: "image/png" }] : [])],
    isError: false,
    timestamp
  } as unknown as AgentMessage;
}

function source(overrides: Partial<ContextInspectionSource> = {}): ContextInspectionSource {
  const preamble = [persona, skills, orchestration, output, subagents, memory, div].join("\n\n");
  return {
    at: 1_760_000_000_000,
    sessionId: "session-1",
    agent: { id: "agent-1", name: "黑鱼河", systemPrompt: persona, divMode: "always" },
    model: { provider: "deepseek", id: "deepseek-v4.1-flash", contextWindow: 200_000, maxTokens: 32_000 },
    thinkingLevel: "max",
    usage: { tokens: 118_600, contextWindow: 200_000, percent: 59.3, cacheHitRate: 94.2 },
    systemPrompt: `${preamble}\n\n<cwd>\nD:/PiDesktop\n</cwd>`,
    messages: [systemMessage({ preamble, cwd: "<cwd>\nD:/PiDesktop\n</cwd>" }), userMessage("你好"), assistantMessage("先看一下仓库结构"), toolResult("npm test 全部通过")],
    declaredTools: [
      { name: "bash", description: "执行 shell 命令", parameters: { type: "object", properties: { command: { type: "string" } } } },
      { name: "mcp__exa__web_search_exa", description: "搜索网页", parameters: { type: "object" } },
      { name: "codemode", description: "脚本编排", parameters: { type: "object" } }
    ],
    registryTools: [
      { name: "bash", exposure: "direct", sourceInfo: { path: "builtin:bash" }, promptGuidelines: ["Use bash for file operations"] },
      { name: "mcp__exa__web_search_exa", exposure: "direct", sourceInfo: { path: "builtin:mcp" } },
      { name: "codemode", exposure: "direct", sourceInfo: { path: "<inline:pidesktop-codemode>" } },
      { name: "mcp__dbx__query", exposure: "codemode", sourceInfo: { path: "builtin:mcp" } },
      { name: "mcp__dbx__list_connections", exposure: "codemode", sourceInfo: { path: "builtin:mcp" } }
    ],
    currentBlocks: { skills, orchestration, output, subagents, memory, div },
    turnInjections: [
      { label: "界面主题（一行）", origin: "runtime-ui-theme", text: "当前界面主题：深色模式｜聊天区背景：壁纸图片" },
      { label: "Div 气泡合规重申", origin: "runtime-div-mode", text: "最终回复必须是且只输出一页气泡。" },
      { label: "计划模式叙事", origin: "runtime-plan-tools" }
    ],
    runtime: [
      { label: "模型", value: "deepseek-v4.1-flash", note: "DeepSeek" },
      { label: "技能注入", value: "6 个", frozen: true }
    ],
    ...overrides
  };
}

describe("foldSystemPromptSections", () => {
  it("按序折叠 sections：后写覆盖、null 删除、保持首次出现顺序", () => {
    const folded = foldSystemPromptSections([
      systemMessage({ preamble: "P1", cwd: "C1", mcp_servers: "M1" }),
      systemMessage({ preamble: "P2", cwd: null, extra: "E1" }),
      systemMessage({ cwd: "C2" })
    ]);
    expect(folded.preamble).toBe("P2");
    expect(folded.sections).toEqual([
      { name: "mcp_servers", text: "M1" },
      { name: "extra", text: "E1" },
      { name: "cwd", text: "C2" }
    ]);
  });

  it("首条之外的带正文 system 消息单独收进 extraSystemMessages", () => {
    const folded = foldSystemPromptSections([
      systemMessage({ preamble: "P" }, "不该收：这是首条"),
      systemMessage({}, "工具集变化：新增 browser_click"),
      systemMessage({}, "   ")
    ]);
    expect(folded.extraSystemMessages).toEqual(["工具集变化：新增 browser_click"]);
  });
});

describe("messageText / toolSourceOf / promptSectionOrigin", () => {
  it("只拼接 text 块，忽略图片", () => {
    expect(messageText(toolResult("a", 1, true))).toBe("a");
    expect(messageText(userMessage("hi"))).toBe("hi");
  });

  it("工具来源按前缀与路径分类", () => {
    expect(toolSourceOf("bash", { name: "bash", sourceInfo: { path: "builtin:bash" } })).toBe("builtin");
    expect(toolSourceOf("codemode", { name: "codemode", sourceInfo: { path: "<inline:pidesktop-codemode>" } })).toBe("app");
    expect(toolSourceOf("mcp__exa__web_search_exa", { name: "mcp__exa__web_search_exa" })).toBe("mcp");
    expect(toolSourceOf("x", { name: "x", sourceInfo: { path: "C:/ext/tool.js" } })).toBe("other");
    expect(toolSourceOf("x", undefined)).toBe("other");
  });

  it("分段来源说明覆盖常见名字并有兜底", () => {
    expect(promptSectionOrigin("cwd")).toContain("工作目录");
    expect(promptSectionOrigin("mcp_servers")).toContain("MCP");
    expect(promptSectionOrigin("whatever")).toContain("自定义分段");
  });
});

describe("buildContextInspection", () => {
  it("切出 7 个块，命中真实文本；sections 与尾部注入齐全", () => {
    const inspection = buildContextInspection(source());
    expect(inspection.sessionId).toBe("session-1");
    expect(inspection.agentName).toBe("黑鱼河");
    expect(inspection.prompt.text).toContain("【工具编排】");
    const byId = Object.fromEntries(inspection.prompt.blocks.map((block) => [block.id, block]));
    expect(byId.agent!.present).toBe(true);
    expect(byId.agent!.text).toBe(persona);
    expect(byId.div!.present).toBe(true);
    expect(byId.div!.text).toBe(div);
    expect(inspection.prompt.leading).toBeUndefined();
    expect(inspection.prompt.sections.map((section) => section.name)).toEqual(["cwd"]);
    expect(inspection.prompt.sections[0]!.origin).toContain("工作目录");
    expect(inspection.prompt.turnInjections.map((entry) => entry.active)).toEqual([true, true, false]);
    expect(inspection.prompt.extraSystemMessages).toEqual([]);
  });

  it("缺少的块标记 present=false，用当前配置文本作对照，且不破坏相邻块", () => {
    // 会话创建时记忆与 Div 关闭：preamble 只有前 5 块。
    const preamble = [persona, skills, orchestration, output, subagents].join("\n\n");
    const inspection = buildContextInspection(source({ messages: [systemMessage({ preamble })] }));
    const byId = Object.fromEntries(inspection.prompt.blocks.map((block) => [block.id, block]));
    expect(byId.memory!.present).toBe(false);
    expect(byId.memory!.text).toBe(memory);
    expect(byId.div!.present).toBe(false);
    expect(byId.subagents!.text).toBe(subagents);
  });

  it("没有 sections 的会话退回整段文本；有自定义基础提示词时形成 leading", () => {
    const noSections = buildContextInspection(source({ messages: [systemMessage({}), userMessage("hi")] }));
    // 没有 preamble 也没有其它分段 → 整段 systemPrompt 参与切分（标记仍能命中）
    expect(noSections.prompt.blocks.find((block) => block.id === "skills")?.present).toBe(true);

    const withBase = buildContextInspection(source({ messages: [systemMessage({ preamble: `BASE\n\n${persona}\n\n${skills}` })] }));
    expect(withBase.prompt.leading?.text.trim()).toBe("BASE");
    expect(withBase.prompt.blocks.find((block) => block.id === "agent")?.present).toBe(true);
  });

  it("工具：声明按 state.tools 顺序、带 exposure/source/guideline；未声明单列", () => {
    const inspection = buildContextInspection(source());
    expect(inspection.tools.declared.map((tool) => tool.name)).toEqual(["bash", "mcp__exa__web_search_exa", "codemode"]);
    const bash = inspection.tools.declared[0]!;
    expect(bash.source).toBe("builtin");
    expect(bash.exposure).toBe("direct");
    expect(bash.guideline).toContain("file operations");
    expect(bash.parameters).toContain("\"command\"");
    expect(bash.tokens).toBeGreaterThan(0);
    expect(inspection.tools.declared[1]!.source).toBe("mcp");
    expect(inspection.tools.declared[2]!.source).toBe("app");
    expect(inspection.tools.undeclared.map((tool) => tool.name)).toEqual(["mcp__dbx__query", "mcp__dbx__list_connections"]);
    expect(inspection.tools.undeclared[0]!.exposure).toBe("codemode");
  });

  it("schema 超过上限时截断并注明", () => {
    const huge = { type: "object", properties: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [`k${index}`, { type: "string", description: "x".repeat(20) }])) };
    const inspection = buildContextInspection(source({ declaredTools: [{ name: "bash", description: "d", parameters: huge }], maxToolSchemaChars: 200 }));
    expect(inspection.tools.declared[0]!.parameters.length).toBeLessThan(400);
    expect(inspection.tools.declared[0]!.parameters).toContain("已截断");
  });

  it("消息统计：四角色计数、图片数、按 token 排行", () => {
    const long = "很长的工具输出 ".repeat(400);
    const inspection = buildContextInspection(source({ messages: [
      systemMessage({ preamble: persona }),
      userMessage("短问题"),
      assistantMessage("回答"),
      toolResult(long, 5, true)
    ] }));
    expect(inspection.messages.total).toBe(4);
    expect(inspection.messages.byRole.map((row) => [row.role, row.count])).toEqual([
      ["user", 1],
      ["assistant", 1],
      ["toolResult", 1],
      ["system", 1]
    ]);
    expect(inspection.messages.images).toBe(1);
    expect(inspection.messages.top[0]!.role).toBe("toolResult");
    expect(inspection.messages.top[0]!.preview.length).toBeLessThanOrEqual(121);
    expect(inspection.messages.top[0]!.tokens).toBeGreaterThan(inspection.messages.top[1]!.tokens);
  });

  it("运行参数与 usage 原样透传", () => {
    const inspection = buildContextInspection(source());
    expect(inspection.runtime.map((row) => row.label)).toEqual(["模型", "技能注入"]);
    expect(inspection.runtime[1]!.frozen).toBe(true);
    expect(inspection.usage?.percent).toBe(59.3);
    expect(inspection.model?.contextWindow).toBe(200_000);
  });
});
