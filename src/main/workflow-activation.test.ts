import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, SettingsManager, createAgentSession, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkflowToolSurface } from "./runtime-workflow-commands.js";
import { buildWorkflowTools, shouldActivateWorkflowTools, workflowOverrideEnabled } from "./runtime-workflow.js";

/**
 * 工作流工具「角色开关 + 默认 OFF」的接线回归网（实施方案 §8.3 / 步骤七）。
 *
 * 为什么用源码断言：`pi-runtime.ts` 是 utility 进程入口（顶层 `process.parentPort`
 * 缺失即抛），单测里无法 import；而这三处接线一旦写错，表现全是静默的：
 * - 漏进 `recordCustomTools`：工具根本没注册，开关打开也没用；
 * - 漏进 `toolNamesFor` 或写成无条件展开：默认 OFF 的角色白付 3 个 schema 的前缀，
 *   升级即改变既有角色的请求前缀（AGENTS.md §6「新工具默认 OFF」）；
 * - 回合边界 reconcile 若在每回合偷读全局配置 / 直接重建会话：活跃工作流的 owner
 *   会被销毁（运行被静默终止）。
 *
 * 纯判据与工具行为在 `runtime-workflow.test.ts`；这里钉的是「接线位置」。
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "pi-runtime.ts"), "utf8").replace(/\r\n?/gu, "\n");
const appSource = readFileSync(join(here, "..", "renderer", "src", "App.tsx"), "utf8").replace(/\r\n?/gu, "\n");

function functionBody(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `找不到 ${signature}（重命名了？此测试需要同步更新）`).toBeGreaterThan(-1);
  const bodyStart = source.indexOf("{", start + signature.length);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error(`${signature} 的函数体没闭合`);
}

function require_(snippet: string): void {
  expect(source.includes(snippet), `pi-runtime.ts 缺少接线片段：\n${snippet}`).toBe(true);
}

/** `case "agent.save":` 到下一个顶层 case 之间的分支体。 */
function agentSaveBranch(): string {
  const start = source.indexOf('case "agent.save":');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('    case "', start + 10);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("激活判据：默认 OFF", () => {
  it("只有记录级开关为 true 才进活动集（没有全局总闸，页面运行不受它限制）", () => {
    expect(shouldActivateWorkflowTools({ recordEnabled: true })).toBe(true);
    expect(shouldActivateWorkflowTools({ recordEnabled: false })).toBe(false);
  });

  it("开关归一化只有一处口径：缺省/false 都关闭", () => {
    expect(workflowOverrideEnabled({})).toBe(false);
    expect(workflowOverrideEnabled({ toolOverrides: {} })).toBe(false);
    expect(workflowOverrideEnabled({ toolOverrides: { workflow: false } })).toBe(false);
    expect(workflowOverrideEnabled({ toolOverrides: { browser: true } })).toBe(false);
    expect(workflowOverrideEnabled({ toolOverrides: { workflow: true } })).toBe(true);
  });
});

describe("注册路径（三处都要有，注册是激活的前提）", () => {
  it("建会话时的 recordCustomTools 带上三个定义", () => {
    require_("...teamTools, ...workflowTools];");
  });

  it("buildRecordTools（重建路径）带上三个定义", () => {
    const body = functionBody("function buildRecordTools(");
    expect(body).toContain("...record.workflowTools");
  });

  it("record 上有 workflowTools 字段，开关投影在建会话时从角色配置冻结", () => {
    const recordBody = functionBody("interface SessionRuntimeRecord");
    expect(recordBody).toContain("workflowTools: ToolDefinition[];");
    expect(recordBody).toContain("workflowEnabled: boolean;");
    require_("workflowTools,\n    memoryStore: recordMemoryStore,");
    require_("workflowEnabled: workflowToolEnabled(recordAgent),");
  });

  it("工具闭包绑定**本记录**（惰性 ref），不在构建器里读 activeRuntime", () => {
    const start = source.indexOf("const workflowRef: { record?: SessionRuntimeRecord } = {};");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("const recordCustomTools:", start));
    expect(block).toContain("surface: () => {");
    expect(block).toContain("return workflowToolSurfaceFor(record);");
    // 执行端复核角色能力：读记录的开关投影，不读全局 settings、不读 activeRuntime。
    expect(block).toContain("enabled: () => workflowRef.record?.workflowEnabled === true");
    expect(block).not.toContain("activeRuntime");
    expect(block).not.toContain("settings?.");
    // 记录装配后回填同一引用。
    require_("workflowRef.record = record;");
  });
});

describe("活动集（toolNamesFor）", () => {
  it("workflow 那行是条件展开，且读记录级投影", () => {
    const body = functionBody("function toolNamesFor(");
    expect(body).toContain("shouldActivateWorkflowTools({ recordEnabled: record.workflowEnabled })");
    expect(body).toContain("? record.workflowTools.map((tool) => tool.name)");
    // 无条件展开（默认 OFF 失效）必须不存在。
    expect(body).not.toContain("...record.workflowTools.map((tool) => tool.name),");
    // 活动集是纯函数：不得读全局 settings 里的角色配置来猜开关。
    expect(body).not.toContain("toolOverrides?.workflow");
  });
});

describe("回合边界 reconcile", () => {
  it("agent_settled 分支里应用 busy 期间保存的开关（不重建会话）", () => {
    const start = source.indexOf('case "agent_settled":');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('case "turn_start":', start);
    const branch = source.slice(start, end);
    expect(branch).toContain("syncWorkflowToolProjection(record);");
    expect(branch).not.toContain("createSession(");
  });

  it("reconcile 只改活动集：忙就等 settle、不重建会话、不动工作流运行器", () => {
    const body = functionBody("function syncWorkflowToolProjection(");
    expect(body).toContain("if (runActive(record)) return false;");
    expect(body).toContain("record.workflowEnabled = next;");
    expect(body).toContain("reconcileActiveTools(record);");
    expect(body).not.toContain("createSession");
    expect(body).not.toContain("workflowRuntime");
    expect(body).not.toContain("stop");
  });

  it("agent.save：仅开关变化走短路径（不重建），混合保存保留既有的活跃工作流保护", () => {
    const branch = agentSaveBranch();
    // 判定用的是新模块的纯函数（键序无关、false↔缺省不算变化）。
    expect(branch).toContain("runtimeWorkflow.isWorkflowSwitchOnlyChange(previousProfile, command.agent)");
    // 仅开关变化：不要求会话空闲（busy 留到 settle），逐条 live 记录归位后立即 break。
    const switchBlock = branch.slice(branch.indexOf("if (workflowSwitchOnly) {"), branch.indexOf("if (isCurrent && workspace) {"));
    expect(switchBlock).toContain("syncWorkflowToolProjection(record);");
    expect(switchBlock).toContain("break;");
    expect(switchBlock).not.toContain("createSession");
    expect(switchBlock).not.toContain("activeRuntime?.busy");
    // 混合保存：原有的「正在运行不许保存」与「有活跃工作流则重新加载后生效」原样保留。
    expect(branch).toContain("if (!workflowSwitchOnly && activeRuntime?.busy && activeRuntime.agent.id === command.agent.id) throw new Error(\"当前会话正在运行，请等待完成后再保存当前 Agent\");");
    const guardStart = branch.indexOf("if (recordHasActiveWorkflow(activeRuntime)) {");
    expect(guardStart).toBeGreaterThan(-1);
    // 保护块的终点 = 紧随其后的 `} else {`（重建分支的开头）。
    const guardEnd = branch.slice(guardStart).search(/\n\s*\} else \{/u);
    expect(guardEnd).toBeGreaterThan(-1);
    const guard = branch.slice(guardStart, guardStart + guardEnd);
    expect(guard).toContain("配置已保存；当前会话有工作流在运行，重新加载会话后生效");
    // 保护块必须**不终止运行**：不 stop、不重建。
    expect(guard).not.toContain(".stop(");
    expect(guard).not.toContain("stopAndWait");
    expect(guard).not.toContain("createSession");
  });
});

describe("设置往返（默认 OFF 不能被读回抹掉）", () => {
  it("App 的写回：workflow 启用必须显式写 true（删键等于又关回去）", () => {
    const start = appSource.indexOf("function updateAgentToolOverride(");
    expect(start).toBeGreaterThan(-1);
    const bodyStart = appSource.indexOf("{", start);
    let depth = 0;
    let body = "";
    for (let index = bodyStart; index < appSource.length; index += 1) {
      if (appSource[index] === "{") depth += 1;
      else if (appSource[index] === "}") {
        depth -= 1;
        if (depth === 0) { body = appSource.slice(bodyStart, index + 1); break; }
      }
    }
    expect(body).toContain('if (key === "workflow") {');
    expect(body).toContain("if (enabled) overrides[key] = true;");
    expect(body).toContain("else delete overrides[key];");
    // 原有「启用即删键」只留给缺省开启的族（browser/ssh/mcp）。
    expect(body).toContain("} else if (enabled) delete overrides[key];");
  });
});

/**
 * 真实 AgentSession 上的一句硬事实：**注册 ≠ 激活**。
 * 三个 workflow 定义在建会话时进 customTools，但不在活动集里 ⇒ 不进
 * `session.state.tools`（请求前缀没有它们的 schema）；角色开关打开后可用
 * `setActiveToolsByName` 在**同一会话**里激活，不需要重建（也就不可能销毁
 * 活跃工作流的 owner）。
 */
describe("真实会话：注册常驻、默认不进活动集", () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  function makePlaceholder(name: string): ToolDefinition {
    return defineTool({
      name,
      label: name,
      description: `desc-${name}`,
      promptSnippet: `snippet-${name}`,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} })
    });
  }

  it("开关关着时三个定义已注册但不在请求前缀里；打开后同一会话激活、关掉再撤", async () => {
    const surface: WorkflowToolSurface = {
      list: () => ({ workflows: [], diagnostics: [] }),
      start: async () => ({ runId: "run-1", status: "running", workflowName: "wf" }),
      status: () => ({
        summary: {
          runId: "run-1", workflowId: "wf-1", workflowName: "wf", workspace: "/ws", agentId: "default", ownerSessionId: "s1",
          status: "running", currentAttempt: 1, maxAttempts: 1, nodeStates: {}, pendingPermissionIds: [], startedAt: 1
        },
        decisions: [], artifacts: [], external: false
      })
    };
    const workflowTools = buildWorkflowTools({ surface: () => surface, enabled: () => true });
    const root = await mkdtemp(join(tmpdir(), "pi-desktop-workflow-activation-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const settingsManager = SettingsManager.create(root, agentDir);
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const result = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, customTools: [makePlaceholder("bash_like"), ...workflowTools] });
    await result.session.bindExtensions({ onError: () => {} });
    const session = result.session;
    try {
      // 默认 OFF：注册表里有三个名字，但活动集（= 请求前缀）里一个都没有。
      session.setActiveToolsByName(["bash_like"]);
      expect(session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining(["workflow_list", "workflow_run", "workflow_status"]));
      expect(session.state.tools.map((tool) => tool.name)).toEqual(["bash_like"]);

      // 打开开关：同一会话激活，无重建。
      session.setActiveToolsByName(["bash_like", "workflow_list", "workflow_run", "workflow_status"]);
      expect(session.state.tools.map((tool) => tool.name).sort()).toEqual(["bash_like", "workflow_list", "workflow_run", "workflow_status"]);

      // 关掉：同一会话撤回，运行中的会话不会被销毁。
      session.setActiveToolsByName(["bash_like"]);
      expect(session.state.tools.map((tool) => tool.name)).toEqual(["bash_like"]);
    } finally {
      await session.dispose();
    }
  });
});
