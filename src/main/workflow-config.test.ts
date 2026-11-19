import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentProfile, BuiltinToolName, SubagentDefinition, ThinkingLevel } from "../shared/protocol.js";
import type { WorkflowDefinition, WorkflowModelRef, WorkflowNode } from "../shared/workflow.js";
import {
  WORKFLOW_AGENTS_MD_INSTRUCTION,
  WORKFLOW_GATE_SYSTEM_RULE,
  resolveWorkflowNodeConfigs,
  type WorkflowNodeConfigDeps,
  type WorkflowNodeConfigInput
} from "./workflow-config.js";
import { BUILTIN_TOOLS } from "./settings.js";

/**
 * 节点配置解析的纯函数单测：钉死 §6.1 的继承口径——来源 agent/subagent、模型
 * 优先级与停用回落、思考等级 off 保真、工具交集、浏览器能力三道闸门、访问上限
 * 原样保留、静态系统提示（gate 固定 JSON 规则），以及「全部节点一次预检 + 冻结」。
 * 真实会话创建与 SDK 钳制由 workflow-child / workflow-pi-integration 覆盖。
 */

// ── 测试数据 ─────────────────────────────────────────────────────────────

function catalogModel(provider: string, id: string): Model<Api> {
  return { provider, id, name: `${provider}/${id}`, input: ["text"] } as unknown as Model<Api>;
}

function agent(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: "owner",
    name: "owner",
    description: "",
    systemPrompt: "你是 owner 角色。",
    divMode: "auto",
    defaultThinkingLevel: "medium",
    tools: { read: true, bash: true, powershell: false, edit: false, write: false, grep: true, find: true, ls: true },
    ...overrides
  };
}

function subagentDefinition(overrides: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    id: "sa-1",
    name: "reviewer",
    description: "审查",
    systemPrompt: "你是审查者。",
    tools: "inherit",
    scope: "project",
    ...overrides
  };
}

function node(
  id: string,
  exec: WorkflowNode["exec"] = { kind: "agent" },
  extra: Partial<WorkflowNode> = {}
): WorkflowNode {
  return { id, title: id, kind: "task", prompt: "执行 {{input}}", position: { x: 0, y: 0 }, exec, ...extra };
}

function input(nodes: WorkflowNode[], overrides: Partial<WorkflowNodeConfigInput> = {}): WorkflowNodeConfigInput {
  return {
    definition: { nodes } as Pick<WorkflowDefinition, "nodes">,
    agent: agent(),
    model: { provider: "p", id: "owner" },
    thinkingLevel: "medium",
    subagents: [],
    ...overrides
  };
}

interface DepsOptions {
  available?: string[];
  isModelEnabled?: (provider: string, modelId: string) => boolean;
  isProviderConfigured?: (provider: string) => boolean;
  transformModel?: (model: Model<Api>) => Model<Api>;
  isBrowserEnabled?: () => boolean;
}

function makeDeps(options: DepsOptions = {}): {
  deps: WorkflowNodeConfigDeps;
  getModel: ReturnType<typeof vi.fn>;
  transformModel: ReturnType<typeof vi.fn>;
} {
  const available = new Map((options.available ?? ["p/owner", "p/node", "p/def"]).map((key) => {
    const [provider, id] = key.split("/");
    return [key, catalogModel(provider!, id!)] as const;
  }));
  const getModel = vi.fn((provider: string, id: string) => available.get(`${provider}/${id}`));
  const transformModel = vi.fn((model: Model<Api>) => model);
  return {
    deps: {
      modelRuntime: { getModel },
      transformModel: options.transformModel ?? transformModel,
      ...(options.isModelEnabled ? { isModelEnabled: options.isModelEnabled } : {}),
      ...(options.isProviderConfigured ? { isProviderConfigured: options.isProviderConfigured } : {}),
      ...(options.isBrowserEnabled ? { isBrowserEnabled: options.isBrowserEnabled } : {})
    },
    getModel,
    transformModel
  };
}

function failure(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("预期解析失败，但调用成功返回");
}

// ── agent 来源 ───────────────────────────────────────────────────────────

describe("workflow node config: agent 来源", () => {
  it("继承 owner 角色的提示词、已启用原生工具、当前模型与思考等级，并冻结配置", () => {
    const { deps, getModel, transformModel } = makeDeps();
    const [config] = resolveWorkflowNodeConfigs(
      input([node("n1", { kind: "agent" }, { title: "实施", role: "实施者" })], { thinkingLevel: "high" }),
      deps
    );
    expect(config).toMatchObject({
      nodeId: "n1",
      source: "agent",
      model: { provider: "p", id: "owner" },
      thinkingLevel: "high",
      // 内置工具固定顺序，不读对象键顺序；powershell/edit/write 在 owner 角色里未启用。
      tools: ["read", "bash", "grep", "find", "ls"],
      browserTools: false
    });
    expect(config!.subagent).toBeUndefined();
    expect(config!.injectAgentsMd).toBeUndefined();
    expect(config!.accessModeCap).toBeUndefined();
    expect(config!.systemPrompt).toContain("工作流节点「实施」");
    expect(config!.systemPrompt).toContain("职责：实施者");
    expect(config!.systemPrompt).toContain("你是 owner 角色。");
    expect(config!.systemPrompt).not.toContain(WORKFLOW_GATE_SYSTEM_RULE);
    expect(getModel).toHaveBeenCalledWith("p", "owner");
    expect(transformModel).toHaveBeenCalledTimes(1);
    // 冻结：对象、模型引用与工具数组都不允许调用方事后改写。
    expect(Object.isFrozen(config!)).toBe(true);
    expect(Object.isFrozen(config!.model)).toBe(true);
    expect(Object.isFrozen(config!.tools)).toBe(true);
    expect(() => { (config!.tools as BuiltinToolName[]).push("write"); }).toThrow(TypeError);
    expect(() => { config!.model.id = "other"; }).toThrow(TypeError);
  });

  it("节点 tools 白名单只在来源启用集内收窄，空数组表示不启用任何工具", () => {
    const { deps } = makeDeps();
    const [whitelisted, empty] = resolveWorkflowNodeConfigs(
      input([
        node("n1", { kind: "agent", tools: ["ls", "read"] }),
        node("n2", { kind: "agent", tools: [] })
      ]),
      deps
    );
    expect(whitelisted!.tools).toEqual(["read", "ls"]);
    expect(empty!.tools).toEqual([]);
  });

  it("白名单要求来源未启用的工具时直接预检失败（不静默丢弃）", () => {
    const message = failure(() => resolveWorkflowNodeConfigs(
      input([node("n1", { kind: "agent", tools: ["read", "write"] }, { title: "越权节点" })]),
      makeDeps().deps
    ));
    expect(message).toContain("节点「越权节点」（n1）");
    expect(message).toContain("节点工具 write 不在来源工具集内");
  });
});

// ── subagent 来源 ────────────────────────────────────────────────────────

describe("workflow node config: subagent 来源", () => {
  it("按已合并目录的 id（优先）/名称精确匹配，并继承定义提示词、工具启停表、思考等级与 AGENTS.md", () => {
    const definition = subagentDefinition({
      id: "sa-1",
      name: "reviewer",
      systemPrompt: "你是审查者。",
      tools: { read: true, bash: false, powershell: false, edit: false, write: false, grep: true, find: false, ls: true },
      thinkingLevel: "off",
      model: { provider: "p", id: "def" },
      injectAgentsMd: true
    });
    const configs = resolveWorkflowNodeConfigs(
      input([
        node("a", { kind: "subagent", subagent: "sa-1" }, { title: "审查" }),
        node("b", { kind: "subagent", subagent: "reviewer" }, { title: "复核" })
      ], { subagents: [definition] }),
      makeDeps().deps
    );
    expect(configs).toHaveLength(2);
    for (const config of configs) {
      expect(config).toMatchObject({
        source: "subagent",
        subagent: "sa-1",
        model: { provider: "p", id: "def" },
        thinkingLevel: "off",
        tools: ["read", "grep", "ls"],
        injectAgentsMd: true,
        browserTools: false
      });
      expect(config.systemPrompt).toContain("你是审查者。");
      expect(config.systemPrompt).toContain("子智能体「reviewer」");
      expect(config.systemPrompt).toContain(WORKFLOW_AGENTS_MD_INSTRUCTION);
    }
    // 冻结的是配置自己的副本：目录里的定义对象不能被就地冻结/改写。
    expect(Object.isFrozen(definition.model)).toBe(false);
    expect(definition.model).toEqual({ provider: "p", id: "def" });
  });

  it("tools=inherit 继承 owner 角色启用项，节点白名单再与之取交集", () => {
    const definition = subagentDefinition({ id: "sa-2", name: "implementer", tools: "inherit" });
    const { deps } = makeDeps();
    const [config] = resolveWorkflowNodeConfigs(
      input(
        [node("n", { kind: "subagent", subagent: "sa-2", tools: ["edit", "read"] })],
        { agent: agent({ tools: { read: true, bash: false, powershell: false, edit: true, write: false, grep: false, find: false, ls: false } }), subagents: [definition] }
      ),
      deps
    );
    expect(config!.tools).toEqual(["read", "edit"]);
  });

  it("找不到定义就拒绝，不回落通用角色，且把所有节点问题一次报全", () => {
    const message = failure(() => resolveWorkflowNodeConfigs(
      input([
        node("ghost", { kind: "subagent", subagent: "ghost" }, { title: "幽灵节点" }),
        node("bad-tool", { kind: "agent", tools: ["write"] }, { title: "越界工具" })
      ], { subagents: [subagentDefinition()] }),
      makeDeps().deps
    ));
    expect(message).toContain("工作流节点配置预检失败");
    expect(message).toContain("节点「幽灵节点」（ghost）");
    expect(message).toContain("找不到子智能体「ghost」");
    expect(message).toContain("不会回落到通用角色");
    expect(message).toContain("reviewer（sa-1）");
    expect(message).toContain("节点「越界工具」（bad-tool）");
    expect(message).toContain("节点工具 write 不在来源工具集内");
  });

  it("来源是 subagent 但没填名称时直接失败", () => {
    const message = failure(() => resolveWorkflowNodeConfigs(
      input([node("n", { kind: "subagent" })]),
      makeDeps().deps
    ));
    expect(message).toContain("没有指定子智能体");
  });
});

// ── 模型解析 ─────────────────────────────────────────────────────────────

describe("workflow node config: 模型优先级与可用性", () => {
  const definition = subagentDefinition({ id: "sa", name: "sa", model: { provider: "p", id: "def" } });

  it("节点 model > 定义 model > owner 当前模型", () => {
    const { deps } = makeDeps();
    const [withNode, withDefinition, withOwner] = resolveWorkflowNodeConfigs(
      input([
        node("a", { kind: "subagent", subagent: "sa", model: { provider: "p", id: "node" } }),
        node("b", { kind: "subagent", subagent: "sa" }),
        node("c", { kind: "agent" })
      ], { subagents: [definition] }),
      deps
    );
    expect(withNode!.model).toEqual({ provider: "p", id: "node" });
    expect(withDefinition!.model).toEqual({ provider: "p", id: "def" });
    expect(withOwner!.model).toEqual({ provider: "p", id: "owner" });
  });

  it("停用模型按既有委派回落规则回到 owner（不试探定义里的次级候选）", () => {
    const { deps } = makeDeps({ isModelEnabled: (_provider, id) => id !== "node" });
    const [config] = resolveWorkflowNodeConfigs(
      input([node("a", { kind: "subagent", subagent: "sa", model: { provider: "p", id: "node" } })], {
        subagents: [definition]
      }),
      deps
    );
    expect(config!.model).toEqual({ provider: "p", id: "owner" });
  });

  it("owner 自己也被停用时没有可用回退模型，直接失败", () => {
    const { deps } = makeDeps({ isModelEnabled: () => false });
    const message = failure(() => resolveWorkflowNodeConfigs(
      input([node("a", { kind: "agent", model: { provider: "p", id: "node" } })]),
      deps
    ));
    expect(message).toContain("模型已停用且没有可用的回退模型：p/owner");
  });

  it("节点模型不存在于目录时不静默回退，明确失败", () => {
    const message = failure(() => resolveWorkflowNodeConfigs(
      input([node("a", { kind: "agent", model: { provider: "p", id: "missing" } })]),
      makeDeps().deps
    ));
    expect(message).toContain("模型不可用：p/missing");
  });

  it("服务商未配置鉴权、覆盖链报错时都在受理前收口", () => {
    const { deps } = makeDeps({
      available: ["p/owner", "q/node"],
      isProviderConfigured: (provider) => provider !== "q"
    });
    const message = failure(() => resolveWorkflowNodeConfigs(
      input([node("a", { kind: "agent", model: { provider: "q", id: "node" } })]),
      deps
    ));
    expect(message).toContain("模型服务商未配置鉴权：q");

    const transformFailure = failure(() => resolveWorkflowNodeConfigs(
      input([node("a", { kind: "agent" })]),
      makeDeps({ transformModel: () => { throw new Error("override boom"); } }).deps
    ));
    expect(transformFailure).toContain("应用模型覆盖失败：override boom");
  });

  it("未提供启用/鉴权判定时按既有委派口径视为可用", () => {
    const [config] = resolveWorkflowNodeConfigs(
      input([node("a", { kind: "agent", model: { provider: "p", id: "node" } })]),
      makeDeps().deps
    );
    expect(config!.model).toEqual({ provider: "p", id: "node" });
  });
});

// ── 思考等级 / 访问上限 ─────────────────────────────────────────────────

describe("workflow node config: 思考等级与访问上限", () => {
  it("思考等级 节点 > 定义 > owner，off 作为显式档位保真", () => {
    const definition = subagentDefinition({ id: "sa", name: "sa", thinkingLevel: "high" });
    const { deps } = makeDeps();
    const [nodeOff, definitionOff, ownerLevel] = resolveWorkflowNodeConfigs(
      input([
        node("a", { kind: "subagent", subagent: "sa", thinkingLevel: "off" }),
        node("b", { kind: "subagent", subagent: "sa" }),
        node("c", { kind: "agent" })
      ], {
        thinkingLevel: "max",
        subagents: [definition, subagentDefinition({ id: "sa-off", name: "sa-off", thinkingLevel: "off" })]
      }),
      deps
    );
    expect(nodeOff!.thinkingLevel).toBe("off");
    expect(definitionOff!.thinkingLevel).toBe("high");
    expect(ownerLevel!.thinkingLevel).toBe("max");

    const [definitionOffConfig] = resolveWorkflowNodeConfigs(
      input([node("a", { kind: "subagent", subagent: "sa-off" })], {
        thinkingLevel: "high",
        subagents: [subagentDefinition({ id: "sa-off", name: "sa-off", thinkingLevel: "off" })]
      }),
      deps
    );
    expect(definitionOffConfig!.thinkingLevel).toBe("off");
  });

  it("无效的 owner 思考等级在预检里报错，而不是把坏值冻进配置", () => {
    const message = failure(() => resolveWorkflowNodeConfigs(
      input([node("a")], { thinkingLevel: "turbo" as ThinkingLevel }),
      makeDeps().deps
    ));
    expect(message).toContain("owner 当前思考等级无效");
  });

  it("accessModeCap 原样保留，解析期不做权限等级排序或合成", () => {
    const { deps } = makeDeps();
    const [readOnly, full] = resolveWorkflowNodeConfigs(
      input([
        node("a", { kind: "agent", accessModeCap: "read-only" }),
        node("b", { kind: "agent", accessModeCap: "full" })
      ]),
      deps
    );
    expect(readOnly!.accessModeCap).toBe("read-only");
    expect(full!.accessModeCap).toBe("full");
    // 有效权限由 runtime-permissions 每次工具调用取严；配置里不存在合并后的 accessMode。
    expect("accessMode" in full!).toBe(false);
  });
});

// ── 浏览器能力与递归限制 ─────────────────────────────────────────────────

describe("workflow node config: 浏览器 customTools 与递归限制", () => {
  const declared = subagentDefinition({ id: "sa-browser", name: "browser-user", browserTools: true });

  it("只有定义声明 + owner 角色允许 + 总闸允许三者同时成立才挂载", () => {
    const target = () => input([node("n", { kind: "subagent", subagent: "sa-browser" })], { subagents: [declared] });
    expect(resolveWorkflowNodeConfigs(target(), makeDeps().deps)[0]!.browserTools).toBe(true);
    expect(resolveWorkflowNodeConfigs(
      input([node("n", { kind: "subagent", subagent: "sa-browser" })], {
        subagents: [declared],
        agent: agent({ toolOverrides: { browser: false } })
      }),
      makeDeps().deps
    )[0]!.browserTools).toBe(false);
    expect(resolveWorkflowNodeConfigs(target(), makeDeps({ isBrowserEnabled: () => false }).deps)[0]!.browserTools).toBe(false);
    const notDeclared = subagentDefinition({ id: "sa-plain", name: "plain" });
    expect(resolveWorkflowNodeConfigs(
      input([node("n", { kind: "subagent", subagent: "sa-plain" })], { subagents: [notDeclared] }),
      makeDeps().deps
    )[0]!.browserTools).toBe(false);
    // agent 来源没有子智能体定义，永远不挂浏览器 customTools。
    expect(resolveWorkflowNodeConfigs(input([node("a")]), makeDeps().deps)[0]!.browserTools).toBe(false);
  });

  it("配置只带内置原生工具名，不携带任何可递归编排的 customTools", () => {
    const [config] = resolveWorkflowNodeConfigs(
      input([node("n", { kind: "subagent", subagent: "sa-browser" })], { subagents: [declared] }),
      makeDeps().deps
    );
    expect("customTools" in config!).toBe(false);
    expect(config!.tools.every((tool) => BUILTIN_TOOLS.includes(tool))).toBe(true);
    expect(config!.tools).not.toContain("delegate_agent");
  });
});

// ── 系统提示词与整体行为 ─────────────────────────────────────────────────

describe("workflow node config: 静态系统提示与整体预检", () => {
  it("系统提示只含静态身份、来源提示与 gate 固定 JSON 规则；动态输入/轮号/反馈不进提示词", () => {
    const gate = node(
      "gate",
      { kind: "agent" },
      { title: "验收", kind: "gate", prompt: "请判定 {{input}} 第 {{attempt}} 轮，反馈：{{retry_feedback}}" }
    );
    const { deps } = makeDeps();
    const [config] = resolveWorkflowNodeConfigs(input([gate]), deps);
    expect(config!.systemPrompt).toContain(WORKFLOW_GATE_SYSTEM_RULE);
    expect(config!.systemPrompt).toContain('"verdict":"pass"');
    expect(config!.systemPrompt).toContain("retry");
    expect(config!.systemPrompt).toContain("最多 2000 字");
    expect(config!.systemPrompt).not.toContain("{{input}}");
    expect(config!.systemPrompt).not.toContain("{{attempt}}");
    expect(config!.systemPrompt).not.toContain("{{retry_feedback}}");
    expect(config!.systemPrompt).not.toContain(gate.prompt);
    // 提示词逐字节稳定（同一输入两次解析相同）。
    const [again] = resolveWorkflowNodeConfigs(input([gate]), makeDeps().deps);
    expect(again!.systemPrompt).toBe(config!.systemPrompt);
    // 非 gate 节点不带 gate 规则。
    const [task] = resolveWorkflowNodeConfigs(input([node("task")]), deps);
    expect(task!.systemPrompt).not.toContain(WORKFLOW_GATE_SYSTEM_RULE);
  });

  it("按定义顺序返回全部节点配置；空定义返回空数组", () => {
    const { deps } = makeDeps();
    const configs = resolveWorkflowNodeConfigs(input([node("a"), node("b"), node("c")]), deps);
    expect(configs.map((config) => config.nodeId)).toEqual(["a", "b", "c"]);
    expect(resolveWorkflowNodeConfigs(input([]), deps)).toEqual([]);
  });

  it("冻结配置只保留 provider/id，不携带凭据或 SDK 模型对象", () => {
    const [config] = resolveWorkflowNodeConfigs(input([node("a")]), makeDeps().deps);
    expect(Object.keys(config!.model).sort()).toEqual(["id", "provider"]);
    const serialized = JSON.stringify(config);
    expect(serialized).not.toMatch(/apiKey|api_key|secret|credential/i);
    expect("input" in config!.model).toBe(false);
  });

  it("任何节点失败都不返回部分配置（一次性预检）", () => {
    const { deps } = makeDeps();
    const configs = input([
      node("ok", { kind: "agent" }),
      node("bad", { kind: "subagent", subagent: "ghost" })
    ]);
    expect(() => resolveWorkflowNodeConfigs(configs, deps)).toThrow(/工作流节点配置预检失败/);
    // 修复后同一输入才返回完整结果。
    const fixed = input([
      node("ok", { kind: "agent" }),
      node("bad", { kind: "subagent", subagent: "reviewer" })
    ], { subagents: [subagentDefinition()] });
    expect(resolveWorkflowNodeConfigs(fixed, deps).map((config) => config.nodeId)).toEqual(["ok", "bad"]);
  });

  it("owner 模型引用不完整时明确报错", () => {
    const message = failure(() => resolveWorkflowNodeConfigs(
      input([node("a")], { model: { provider: " ", id: "owner" } as WorkflowModelRef }),
      makeDeps().deps
    ));
    expect(message).toContain("owner 当前模型不完整");
  });
});
