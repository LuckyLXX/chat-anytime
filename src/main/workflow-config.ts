/**
 * 工作流节点配置解析（实施方案 §6.1「冻结解析后的节点配置」）：运行受理前把
 * **全部**节点一次解析成 `WorkflowChildNodeConfig`，并在返回前冻结。运行期间
 * 节点会话只读这份配置——模型、工具、思考等级、系统提示都不会在返工到一半时
 * 静默变化。
 *
 * 解析口径（与 `subagent.ts` / `team-runtime.ts` 的既有规则逐条对齐）：
 * - 来源 agent：owner 角色捕获的 systemPrompt、已启用原生工具、owner 当前模型与
 *   思考等级。来源 subagent：按**已合并目录**（项目 > 全局 > 内置，由
 *   `readSubagents` 完成）的 id（优先）或 name 精确匹配定义；找不到直接拒绝，
 *   绝不回落通用角色，也不发明名称。
 * - 模型优先级：节点 model → 子智能体定义 model → owner 当前模型。停用模型沿
 *   既有委派回落规则回到 owner 当前模型（不再试探定义里的次级候选），随后用
 *   `getModel` / 已配置鉴权 / `transformModel` 三条既有检查确认实际可用的模型；
 *   冻结配置里只留 provider/id，凭据与 SDK 对象一律不落盘。
 * - 思考等级：节点显式值 → 定义值 → owner 值。`off` 是显式档位，必须原样保留；
 *   最终由 SDK 按模型能力钳制，这里不提前改写。
 * - 原生工具：来源工具集（agent 角色启用项，或子智能体 `inherit` / 显式启停表）
 *   与节点 `tools` 白名单取交集。白名单里的工具不在来源工具集内属于配置错误，
 *   不做静默丢弃；没写 `tools` 也不会因为节点而多启用 write/edit。
 * - 浏览器 customTools：仅当子智能体定义显式声明 `browserTools`、owner 角色
 *   没有关掉 browser 能力、且总闸允许时才挂载。MCP / SSH / team / delegate /
 *   question / automation / workflow 等 customTools 一律不带，节点不能递归编排。
 * - `accessModeCap` 原样保留：有效权限由 runtime-permissions 在**每次工具调用**
 *   上按风险与 owner 当前访问模式取更严格结果，这里不做等级排序或合成。
 * - 系统提示词只含静态身份/职责、来源提示、AGENTS.md 注入语句（按定义的
 *   `injectAgentsMd`，沿用现有文案）与 gate 固定 JSON 规则。用户输入、上游产物、
 *   轮号与返工反馈全部走用户消息，绝不进入系统提示词。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentProfile, BuiltinToolName, SubagentDefinition, ThinkingLevel } from "../shared/protocol.js";
import { normalizeThinkingLevel } from "../shared/thinking-levels.js";
import type { WorkflowDefinition, WorkflowModelRef, WorkflowNode } from "../shared/workflow.js";
import type { WorkflowChildNodeConfig } from "./workflow-child.js";
import { resolveSubagentDefinition } from "./subagent.js";
import { BUILTIN_TOOLS } from "./settings.js";

/** 子智能体定义开启 `injectAgentsMd` 时的固定注入语句（与 `subagent.ts` 同文案）。 */
export const WORKFLOW_AGENTS_MD_INSTRUCTION = "请阅读并遵循当前工作区的 AGENTS.md。";

/**
 * gate 节点的固定输出规则（静态、逐字节稳定）：必须与 `parseGateDecision` 的
 * 严格 JSON 口径一致，不按关键词猜测、不从杂文里截取 JSON。
 */
export const WORKFLOW_GATE_SYSTEM_RULE = [
  "验收 gate 的回合输出有固定格式：只输出一个 JSON 对象，不要在 JSON 之外写任何文字。",
  '格式：{"verdict":"pass","reason":"<通过理由>"} 或 {"verdict":"retry","reason":"<需要返工的具体问题>"}',
  "verdict 只能是 pass 或 retry；reason 必须是非空字符串，最多 2000 字。",
  "允许整个 JSON 被一层 json 代码围栏包裹；围栏外不允许有其他内容，不要用解释文字或关键词替代 JSON。",
  "判定 pass 表示本轮验收通过；判定 retry 时必须在 reason 里写明需要修复的具体问题，供下一轮返工使用。"
].join("\n");

/** 解析输入：owner 角色、owner 当前模型/思考等级、已合并的工作区子智能体目录。 */
export interface WorkflowNodeConfigInput {
  /** 已归一化的工作流定义（只读 nodes；edges/rework 不参与节点配置解析）。 */
  definition: Pick<WorkflowDefinition, "nodes">;
  /** owner 会话的角色档案：来源 agent 节点直接继承它的 systemPrompt 与工具。 */
  agent: AgentProfile;
  /** owner 会话当前模型（回落基准，也是配置里「实际模型」的来源之一）。 */
  model: WorkflowModelRef;
  /** owner 会话当前思考等级；`off` 同样是显式值。 */
  thinkingLevel: ThinkingLevel;
  /**
   * 已合并的子智能体目录（`readSubagents` 的口径：项目 > 全局 > 内置，同 id/同名
   * 后者覆盖前者）。这里不再二次合并，也不做模糊匹配。
   */
  subagents?: SubagentDefinition[];
}

/** 解析依赖：全部显式传入，本模块不读全局设置、不碰会话对象。 */
export interface WorkflowNodeConfigDeps {
  /** 模型目录运行时：与子代理/团队同一取模型口径。 */
  modelRuntime: Pick<ModelRuntime, "getModel">;
  /** 用户勾选状态（settings.providers）；缺省视为启用（同 `delegationModelEnabled`）。 */
  isModelEnabled?: (provider: string, modelId: string) => boolean;
  /** 服务商鉴权是否已配置（settings/目录的 `configured` 口径）；缺省跳过该检查。 */
  isProviderConfigured?: (provider: string) => boolean;
  /** 与主会话/子代理同一条覆盖链（`applyModelOverrides`：contextWindow/maxTokens/图片/思考映射）。 */
  transformModel?: (model: Model<Api>) => Model<Api>;
  /** 浏览器能力总闸（settings.browser.enabled）；缺省视为允许，执行期仍会实时复核。 */
  isBrowserEnabled?: () => boolean;
}

/** 一个节点的来源解析结果（agent 或已命中的子智能体定义）。 */
interface NodeSource {
  source: "agent" | "subagent";
  /** 子智能体定义的规范 id（不是用户填写的别名）。 */
  subagentId?: string;
  subagentName?: string;
  systemPrompt: string;
  tools: BuiltinToolName[];
  /** 子智能体定义里的模型；agent 来源没有。 */
  model?: WorkflowModelRef;
  /** 子智能体定义里的思考等级；agent 来源没有。 */
  thinkingLevel?: ThinkingLevel;
  browserTools: boolean;
  injectAgentsMd: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 模型引用归一化：provider/id 均为非空字符串才有效（不编造缺省值）。 */
function normalizeModelRef(ref: WorkflowModelRef | undefined): WorkflowModelRef | undefined {
  if (!ref || typeof ref.provider !== "string" || typeof ref.id !== "string") return undefined;
  const provider = ref.provider.trim();
  const id = ref.id.trim();
  return provider && id ? { provider, id } : undefined;
}

/** 启用项按内置工具固定顺序输出，避免对象键顺序影响冻结配置的字节稳定性。 */
function enabledTools(tools: Record<BuiltinToolName, boolean> | undefined): BuiltinToolName[] {
  if (!tools) return [];
  return BUILTIN_TOOLS.filter((tool) => tools[tool] === true);
}

function resolveSource(
  node: WorkflowNode,
  input: WorkflowNodeConfigInput,
  browserAllowed: boolean,
  errors: string[]
): NodeSource | undefined {
  if (node.exec.kind === "agent") {
    return {
      source: "agent",
      systemPrompt: input.agent.systemPrompt ?? "",
      tools: enabledTools(input.agent.tools),
      browserTools: false,
      injectAgentsMd: false
    };
  }
  const key = typeof node.exec.subagent === "string" ? node.exec.subagent.trim() : "";
  if (!key) {
    errors.push("节点来源是 subagent，但没有指定子智能体");
    return undefined;
  }
  // 已合并目录的 id（优先）/名称精确匹配；命中不了就拒绝——不做角色回落。
  const definition = resolveSubagentDefinition(input.subagents, key);
  if (!definition) {
    const available = input.subagents && input.subagents.length > 0
      ? `可用：${input.subagents.map((entry) => `${entry.name}（${entry.id}）`).join("、")}`
      : "当前没有可用的子智能体定义";
    errors.push(`找不到子智能体「${key}」（${available}）；不会回落到通用角色`);
    return undefined;
  }
  // 定义里的模型引用先归一化到新对象：冻结配置时不会就地冻结调用方/目录里的共享对象。
  const definitionModel = definition.model === undefined ? undefined : normalizeModelRef(definition.model);
  if (definition.model !== undefined && !definitionModel) errors.push("子智能体定义里的模型引用不完整（provider/id 不能为空）");
  return {
    source: "subagent",
    subagentId: definition.id,
    subagentName: definition.name,
    systemPrompt: definition.systemPrompt,
    // 继承规则与 delegate_agent 一致：inherit = owner 角色已启用项，否则按定义启停表。
    tools: definition.tools === "inherit" ? enabledTools(input.agent.tools) : enabledTools(definition.tools),
    ...(definitionModel ? { model: definitionModel } : {}),
    ...(definition.thinkingLevel !== undefined ? { thinkingLevel: definition.thinkingLevel } : {}),
    // 三道闸门：定义声明 + owner 角色未关浏览器 + 总闸允许；缺一不挂 customTools。
    browserTools: definition.browserTools === true && input.agent.toolOverrides?.browser !== false && browserAllowed,
    injectAgentsMd: definition.injectAgentsMd === true
  };
}

function resolveModel(
  node: WorkflowNode,
  source: NodeSource,
  input: WorkflowNodeConfigInput,
  deps: WorkflowNodeConfigDeps,
  errors: string[]
): WorkflowModelRef | undefined {
  const owner = normalizeModelRef(input.model);
  if (!owner) {
    errors.push("owner 当前模型不完整（provider/id 不能为空）");
    return undefined;
  }
  const nodeModel = node.exec.model === undefined ? undefined : normalizeModelRef(node.exec.model);
  if (node.exec.model !== undefined && !nodeModel) {
    errors.push("节点模型引用不完整（provider/id 不能为空）");
    return undefined;
  }
  const requested = nodeModel ?? source.model ?? owner;
  const enabled = (ref: WorkflowModelRef): boolean => !deps.isModelEnabled || deps.isModelEnabled(ref.provider, ref.id);
  // 停用模型沿既有委派回落规则回到 owner 当前模型（不试探定义里的次级候选）。
  const target = enabled(requested) ? requested : owner;
  if (!enabled(target)) {
    errors.push(`模型已停用且没有可用的回退模型：${target.provider}/${target.id}`);
    return undefined;
  }
  let catalog: Model<Api> | undefined;
  try {
    catalog = deps.modelRuntime.getModel(target.provider, target.id);
  } catch (error) {
    errors.push(`读取模型失败：${errorText(error)}`);
    return undefined;
  }
  if (!catalog) {
    errors.push(`模型不可用：${target.provider}/${target.id}`);
    return undefined;
  }
  if (deps.isProviderConfigured && !deps.isProviderConfigured(target.provider)) {
    errors.push(`模型服务商未配置鉴权：${target.provider}`);
    return undefined;
  }
  if (deps.transformModel) {
    // 与子会话创建共用同一条覆盖链：预检先跑一遍，覆盖层出错在受理前暴露；
    // 返回的 Model 对象不进入冻结配置（只保留 provider/id，凭据不落盘）。
    try {
      deps.transformModel(catalog);
    } catch (error) {
      errors.push(`应用模型覆盖失败：${errorText(error)}`);
      return undefined;
    }
  }
  return target;
}

function resolveTools(
  node: WorkflowNode,
  sourceTools: BuiltinToolName[],
  errors: string[]
): BuiltinToolName[] {
  const whitelist = node.exec.tools;
  if (whitelist === undefined) return [...sourceTools];
  const allowed = new Set(whitelist);
  const missing = [...new Set(whitelist)].filter((tool) => !sourceTools.includes(tool));
  if (missing.length > 0) errors.push(`节点工具 ${missing.join("、")} 不在来源工具集内`);
  return sourceTools.filter((tool) => allowed.has(tool));
}

/** 静态系统提示：身份/职责 + 来源提示 +（可选）AGENTS.md +（gate）固定 JSON 规则。 */
function buildSystemPrompt(node: WorkflowNode, source: NodeSource): string {
  const identity = source.source === "subagent"
    ? `你是 PiDesktop 工作流节点「${node.title}」的执行者，使用子智能体「${source.subagentName ?? source.subagentId ?? ""}」。`
    : `你是 PiDesktop 工作流节点「${node.title}」的执行者。`;
  const parts = [
    identity,
    node.role ? `职责：${node.role}` : undefined,
    source.systemPrompt.trim() ? source.systemPrompt : undefined,
    source.injectAgentsMd ? WORKFLOW_AGENTS_MD_INSTRUCTION : undefined,
    node.kind === "gate" ? WORKFLOW_GATE_SYSTEM_RULE : undefined
  ];
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

function buildNodeConfig(
  node: WorkflowNode,
  source: NodeSource,
  model: WorkflowModelRef,
  thinkingLevel: ThinkingLevel,
  tools: BuiltinToolName[]
): WorkflowChildNodeConfig {
  const config: WorkflowChildNodeConfig = {
    nodeId: node.id,
    source: source.source,
    ...(source.subagentId ? { subagent: source.subagentId } : {}),
    model,
    thinkingLevel,
    tools,
    ...(node.exec.accessModeCap === undefined ? {} : { accessModeCap: node.exec.accessModeCap }),
    browserTools: source.browserTools,
    ...(source.injectAgentsMd ? { injectAgentsMd: true } : {}),
    systemPrompt: buildSystemPrompt(node, source)
  };
  // 冻结配置：对象、模型引用与工具数组都不允许调用方随后修改。
  Object.freeze(config.model);
  Object.freeze(config.tools);
  return Object.freeze(config);
}

/**
 * 一次解析并冻结全部节点配置；任何节点不通过预检都**不返回部分结果**，而是把
 * 所有节点的具体问题聚合后一起抛出（受理前一次性说清，不跑到一半才发现）。
 */
export function resolveWorkflowNodeConfigs(
  input: WorkflowNodeConfigInput,
  deps: WorkflowNodeConfigDeps
): WorkflowChildNodeConfig[] {
  if (!input || typeof input !== "object") throw new Error("工作流节点配置解析需要输入对象");
  if (!input.definition || !Array.isArray(input.definition.nodes)) throw new Error("工作流定义缺少 nodes 数组");
  if (!input.agent || typeof input.agent !== "object") throw new Error("工作流节点配置缺少 owner 角色");
  if (!deps || typeof deps !== "object" || !deps.modelRuntime) throw new Error("工作流节点配置缺少模型运行时依赖");
  const problems: string[] = [];
  const ownerThinking = normalizeThinkingLevel(input.thinkingLevel);
  if (!ownerThinking) problems.push(`owner 当前思考等级无效：${String(input.thinkingLevel)}`);
  const browserAllowed = deps.isBrowserEnabled?.() !== false;
  const configs: WorkflowChildNodeConfig[] = [];
  for (const node of input.definition.nodes) {
    const errors: string[] = [];
    const source = resolveSource(node, input, browserAllowed, errors);
    let config: WorkflowChildNodeConfig | undefined;
    if (source) {
      const model = resolveModel(node, source, input, deps, errors);
      const tools = resolveTools(node, source.tools, errors);
      const thinkingLevel = node.exec.thinkingLevel ?? source.thinkingLevel ?? ownerThinking;
      if (model && thinkingLevel) {
        config = buildNodeConfig(node, source, model, thinkingLevel, tools);
      }
    }
    if (errors.length > 0) {
      for (const error of errors) problems.push(`节点「${node.title || node.id}」（${node.id}）：${error}`);
    } else if (config) {
      configs.push(config);
    }
  }
  if (problems.length > 0) throw new Error(`工作流节点配置预检失败：\n- ${problems.join("\n- ")}`);
  return configs;
}
