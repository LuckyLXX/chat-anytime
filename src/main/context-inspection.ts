import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ContextInspection,
  ContextPromptSection,
  ContextToolDeclaration,
  ContextTurnInjection,
  ContextUsage,
  DivBubbleMode,
  ThinkingLevel
} from "../shared/protocol.js";
import { estimateToolTokens } from "./context-breakdown.js";
import { segmentPromptBlocks, type PromptBlockInput } from "./prompt-composition.js";

/**
 * 上下文中心（会话成分页）的数据组装（2026-11-13）。
 *
 * 纯函数：输入全部显式传入（会话投影、活动/注册工具、当前配置的注入文本、运行参数），
 * 不读全局、不碰 Pi 的私有字段，便于单测与「真实会话机制测试」各自钉住一半。
 *
 * 三条口径（页面必须照实展示）：
 * 1. 提示词/工具取**会话实况**（session.systemPrompt / state.tools），不按当前配置重算；
 *    重算文本只用于「本会话未注入」的对照，present=false 明确标注。
 * 2. 消息段复用 Pi 的 estimateTokens（与压缩阈值同口径）。首条系统消息携带系统提示词，
 *    在 Pi 的现有折算里同时计入消息段——本模块不二次扣减，只把事实摆在页面上。
 * 3. 不返回任何密钥：MCP 的 headers/env、凭据、图片 base64 都不进这份投影。
 */

/** 单工具 schema 的展示上限：声明本身可能很长（浏览器/团队工具），页面只需要可读。 */
const DEFAULT_MAX_TOOL_SCHEMA_CHARS = 6000;
/** 「谁在吃上下文」预览长度。 */
const MESSAGE_PREVIEW_CHARS = 120;
/** 追加系统消息的预览长度。 */
const EXTRA_SYSTEM_PREVIEW_CHARS = 200;

export interface InspectionDeclaredTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface InspectionRegistryTool {
  name: string;
  exposure?: "direct" | "codemode" | "deferred" | string;
  sourceInfo?: { path?: string };
  promptGuidelines?: readonly string[];
}

export interface ContextInspectionSource {
  at: number;
  sessionId: string;
  agent: { id: string; name: string; systemPrompt: string; divMode: DivBubbleMode };
  model?: { provider: string; id: string; contextWindow?: number; maxTokens?: number };
  thinkingLevel: ThinkingLevel;
  usage?: ContextUsage;
  systemPrompt: string;
  messages: readonly AgentMessage[];
  declaredTools: readonly InspectionDeclaredTool[];
  registryTools: readonly InspectionRegistryTool[];
  /**
   * 当前配置下会生成的块文本（用于标记定位与「本会话未注入」对照）。
   * 注意这与冻结的 preamble 可能不同：技能/记忆在会话创建时冻结。
   */
  currentBlocks: {
    skills: string;
    orchestration: string;
    output: string;
    subagents: string;
    memory: string;
    div: string;
  };
  /** 下一回合会追加到系统提示词尾部的注入（不含 inactive 项时由 text 缺省表达）。 */
  turnInjections: readonly { label: string; origin: string; text?: string }[];
  runtime: readonly { label: string; value: string; note?: string; frozen?: boolean }[];
  maxToolSchemaChars?: number;
}

/** 折叠后的系统提示词状态：preamble + 其余 XML 分段 + 运行中追加的 system 消息。 */
export interface FoldedSystemPrompt {
  preamble: string;
  sections: { name: string; text: string }[];
  /** 首条之外的 system 消息里带正文的部分（工具集变化等）。 */
  extraSystemMessages: string[];
}

/**
 * 从转录里折叠 system 消息的 sections：后出现的同名 section 覆盖先前的，
 * `null` 表示删除；保持第一次出现时的顺序（Pi 的渲染顺序）。
 *
 * 为什么要折叠而不是读 session.systemPrompt：后者只有整段文本，页面需要逐段
 * 归属与字数；sections 是 Pi 自己存的结构化投影，最接近「模型看到的分段」。
 */
export function foldSystemPromptSections(messages: readonly AgentMessage[]): FoldedSystemPrompt {
  const sectionMap = new Map<string, string>();
  const extraSystemMessages: string[] = [];
  let systemMessages = 0;
  for (const message of messages) {
    if (message.role !== "system") continue;
    systemMessages += 1;
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sectionMap.delete(name);
      else sectionMap.set(name, value);
    }
    const text = messageText(message);
    if (systemMessages > 1 && text.trim().length > 0) extraSystemMessages.push(text);
  }
  const preamble = sectionMap.get("preamble") ?? "";
  const sections = [...sectionMap.entries()]
    .filter(([name]) => name !== "preamble")
    .map(([name, text]) => ({ name, text }));
  return { preamble, sections, extraSystemMessages };
}

/** 分段来源说明（页面上的「谁写的」）。 */
export function promptSectionOrigin(name: string): string {
  switch (name) {
    case "cwd":
      return "Pi 固定追加的工作目录";
    case "mcp_servers":
      return "MCP 扩展写入的自定义分段";
    case "skills":
      return "Pi 的技能清单分段（自定义 preamble 时通常不出现）";
    case "project_context":
      return "项目上下文文件（本应用 noContextFiles，通常不出现）";
    case "addendum":
      return "appendSystemPrompt";
    case "tools":
    case "rules":
    case "docs":
      return "Pi 默认提示词分段（存在自定义 preamble 时不出现）";
    default:
      return "扩展写入的自定义分段";
  }
}

/** 构建 7 个应用注入块的候选输入（标记只用于定位；文本用于未命中时的对照）。 */
export function promptBlockInputs(agent: { name: string; systemPrompt: string }, current: ContextInspectionSource["currentBlocks"]): PromptBlockInput[] {
  return [
    {
      id: "agent",
      label: "助手人设",
      origin: `助手「${agent.name}」的 systemPrompt`,
      text: agent.systemPrompt
    },
    {
      id: "skills",
      label: "技能清单",
      origin: "buildSkillsSystemPromptBlock · 会话创建时冻结",
      text: current.skills,
      marker: "以下 Skill 可用"
    },
    {
      id: "orchestration",
      label: "工具编排",
      origin: "TOOL_ORCHESTRATION_PROMPT_BLOCK · 静态规范",
      text: current.orchestration,
      marker: "【工具编排】"
    },
    {
      id: "output",
      label: "输出格式",
      origin: "OUTPUT_FORMAT_PROMPT_BLOCK · 静态规范",
      text: current.output,
      marker: "【输出格式】"
    },
    {
      id: "subagents",
      label: "子智能体清单",
      origin: "buildSubagentPromptBlock · 会话创建时冻结",
      text: current.subagents,
      marker: "以下自定义子智能体是 delegate_agent 的唯一委派对象"
    },
    {
      id: "memory",
      label: "记忆索引",
      origin: "记忆治理块 + 双库快照 · 会话创建时冻结",
      text: current.memory,
      marker: "【长期记忆"
    },
    {
      id: "div",
      label: "Div 气泡规范",
      origin: "buildDivModePrompt · 按会话的 Div 档位冻结",
      text: current.div,
      marker: "【Div 气泡模式："
    }
  ];
}

/** 工具来源分类：内置 / 应用注入 / MCP / 其它（磁盘扩展等）。 */
export function toolSourceOf(name: string, registry: InspectionRegistryTool | undefined): ContextToolDeclaration["source"] {
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) return "mcp";
  const path = registry?.sourceInfo?.path ?? "";
  if (path.startsWith("builtin:")) return "builtin";
  if (path.startsWith("<inline:") || path.startsWith("<app:")) return "app";
  if (path) return "other";
  return "other";
}

function normalizeExposure(value: string | undefined): ContextToolDeclaration["exposure"] {
  return value === "direct" || value === "codemode" || value === "deferred" ? value : "unknown";
}

function safeJson(value: unknown, maxChars: number): string {
  if (value === undefined) return "";
  try {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n…（schema 过长，已截断）`;
  } catch {
    return "";
  }
}

/** AgentMessage 的正文（字符串或 TextContent 数组）；不含图片。 */
export function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function previewOf(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

function countImages(messages: readonly AgentMessage[]): number {
  let images = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") images += 1;
    }
  }
  return images;
}

interface RoleTotals {
  role: "user" | "assistant" | "toolResult" | "system";
  count: number;
  tokens: number;
}

function collectMessageStats(messages: readonly AgentMessage[]): {
  total: number;
  byRole: RoleTotals[];
  top: { role: string; tokens: number; preview: string }[];
  images: number;
} {
  const roles: RoleTotals[] = [
    { role: "user", count: 0, tokens: 0 },
    { role: "assistant", count: 0, tokens: 0 },
    { role: "toolResult", count: 0, tokens: 0 },
    { role: "system", count: 0, tokens: 0 }
  ];
  const byRole = new Map(roles.map((entry) => [entry.role, entry]));
  const ranked: { role: string; tokens: number; preview: string }[] = [];
  for (const message of messages) {
    const role = message.role as RoleTotals["role"];
    const row = byRole.get(role);
    const tokens = estimateTokens(message);
    if (row) {
      row.count += 1;
      row.tokens += tokens;
    }
    ranked.push({ role, tokens, preview: previewOf(messageText(message), MESSAGE_PREVIEW_CHARS) || "（无文本）" });
  }
  ranked.sort((left, right) => right.tokens - left.tokens);
  return {
    total: messages.length,
    byRole: roles,
    top: ranked.slice(0, 5),
    images: countImages(messages)
  };
}

/** 组装会话成分快照。异常只会来自调用方传入的畸形数据，此处全部兜底为可展示的空值。 */
export function buildContextInspection(source: ContextInspectionSource): ContextInspection {
  const folded = foldSystemPromptSections(source.messages);
  // 没有 sections 的会话（旧版本/强投影）退回整段文本；有 sections 但 preamble 为空时，
  // 只在确实没有任何分段的情况下才把整段文本当作 preamble，避免把 cwd 段也算进去。
  const preambleSource = folded.preamble || (folded.sections.length === 0 ? source.systemPrompt : "");
  const segmented = segmentPromptBlocks(preambleSource, promptBlockInputs(source.agent, source.currentBlocks));

  const registryByName = new Map(source.registryTools.map((tool) => [tool.name, tool]));
  const maxSchema = source.maxToolSchemaChars ?? DEFAULT_MAX_TOOL_SCHEMA_CHARS;
  const declared: ContextToolDeclaration[] = source.declaredTools.map((tool) => {
    const registry = registryByName.get(tool.name);
    const guidelines = (registry?.promptGuidelines ?? []).filter((entry) => entry.trim().length > 0);
    return {
      name: tool.name,
      description: tool.description ?? "",
      parameters: safeJson(tool.parameters, maxSchema),
      tokens: estimateToolTokens([{ name: tool.name, description: tool.description, parameters: tool.parameters }]),
      exposure: normalizeExposure(registry?.exposure),
      source: toolSourceOf(tool.name, registry),
      ...(guidelines.length > 0 ? { guideline: guidelines.slice(0, 2).join(" · ") } : {})
    };
  });
  const declaredNames = new Set(declared.map((tool) => tool.name));
  const undeclared = source.registryTools
    .filter((tool) => !declaredNames.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      exposure: normalizeExposure(tool.exposure),
      source: toolSourceOf(tool.name, tool)
    }));

  const sections: ContextPromptSection[] = folded.sections.map((section) => ({
    name: section.name,
    origin: promptSectionOrigin(section.name),
    chars: section.text.length,
    text: section.text
  }));

  const turnInjections: ContextTurnInjection[] = source.turnInjections.map((entry) => ({
    label: entry.label,
    origin: entry.origin,
    active: Boolean(entry.text),
    chars: entry.text?.length ?? 0,
    ...(entry.text ? { text: entry.text } : {})
  }));

  const stats = collectMessageStats(source.messages);
  return {
    at: source.at,
    sessionId: source.sessionId,
    agentId: source.agent.id,
    agentName: source.agent.name,
    ...(source.model ? { model: source.model } : {}),
    thinkingLevel: source.thinkingLevel,
    ...(source.usage ? { usage: source.usage } : {}),
    prompt: {
      text: source.systemPrompt,
      blocks: segmented.blocks,
      ...(segmented.leading ? { leading: segmented.leading } : {}),
      sections,
      extraSystemMessages: folded.extraSystemMessages.map((text) => ({
        chars: text.length,
        preview: previewOf(text, EXTRA_SYSTEM_PREVIEW_CHARS)
      })),
      turnInjections
    },
    tools: { declared, undeclared },
    messages: stats,
    runtime: source.runtime.map((row) => ({ ...row }))
  };
}
