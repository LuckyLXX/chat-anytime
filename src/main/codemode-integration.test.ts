import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SettingsManager,
  type AgentSession,
  defineTool,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/**
 * codemode / tool_search（实验分支 feat/codemode-toolsearch）的**真实会话**集成验证。
 * 源码断言（codemode-activation.test.ts）只能钉接线；这里压住三件读源码容易看错、
 * 错了会静默失效的事，全部跑在真实 AgentSession + 进程内 faux provider（零网络）：
 *
 * 1. 两个内建扩展真实装载且激活后进 state.tools（模型可见）；
 * 2. codemode 脚本真的在 QuickJS WASM 沙箱里执行，脚本内 tools.<name>() 经
 *    ctx.executeTool 走真实工具管线（本环境 WASM 可用性的硬验证）；
 * 3. deferred 工具初始不声明，tool_search 命中后经活动集声明（下一次请求可见）。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir) await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }
});

const executed: Array<Record<string, unknown>> = [];

function makeEchoTool(exposure?: "deferred"): ToolDefinition {
  return defineTool({
    name: "echo_probe",
    label: "回声探针",
    ...(exposure ? { exposure } : {}),
    description: "Echo the value back for the codemode integration probe.",
    parameters: Type.Object({ value: Type.String() }),
    async execute(_id, params) {
      executed.push({ ...params });
      return { content: [{ type: "text" as const, text: `echo:${params.value}` }], details: {} };
    }
  });
}

function makeDeferredTool(): ToolDefinition {
  return defineTool({
    name: "screen_probe",
    label: "屏幕探针",
    exposure: "deferred",
    description: "Take a screenshot of the desktop for the search integration probe.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text" as const, text: "shot" }], details: {} };
    }
  });
}

async function makeSession(customTools: ToolDefinition[], activeNames: string[]): Promise<AgentSession> {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-codemode-"));
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
    extensionFactories: [createCodemodeExtension(), createToolSearchExtension()]
  });
  await resourceLoader.reload();

  const faux = fauxProvider();
  const result = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    customTools,
    model: faux.getModel()
  });
  const session = result.session;
  await session.bindExtensions({ onError: () => {} });
  session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof session.agent.streamFunction;
  session.modelRuntime.registerNativeProvider(faux.provider);
  await session.modelRuntime.refresh({ allowNetwork: false });
  // 对齐生产形态（pi-runtime 的 applyActiveToolNames）：不传 tools 允许列表，
  // 注册后整组设置活动集——deferred 工具因「不自动激活」语义留在注册集。
  session.setActiveToolsByName(activeNames);
  return session;
}

describe("codemode / tool_search（真实 AgentSession + faux provider）", () => {
  it("两个内建扩展装载成功，激活后模型可见；deferred 工具初始不声明", async () => {
    const session = await makeSession([makeEchoTool(), makeDeferredTool()], ["echo_probe", "codemode", "tool_search"]);
    try {
      const registered = session.getAllTools().map((tool) => tool.name);
      expect(registered).toContain("codemode");
      expect(registered).toContain("tool_search");
      expect(registered).toContain("screen_probe");
      // 声明给模型的工具集：codemode/tool_search 在，deferred 的 screen_probe 不在。
      const declared = session.state.tools.map((tool) => tool.name);
      expect(declared).toContain("codemode");
      expect(declared).toContain("tool_search");
      expect(declared).not.toContain("screen_probe");
    } finally {
      session.dispose();
    }
  });

  it("codemode 脚本在 QuickJS 沙箱执行，脚本内工具调用走真实管线", async () => {
    executed.length = 0;
    const session = await makeSession([makeEchoTool()], ["echo_probe", "codemode", "tool_search"]);
    try {
      const faux = fauxProvider();
      session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof session.agent.streamFunction;
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("codemode", { code: "const r = await tools.echo_probe({ value: \"from-sandbox\" });\nreturn r;" })]),
        fauxAssistantMessage("done")
      ]);
      await session.prompt("go");
      // 沙箱里的调用真的到了工具执行层
      expect(executed).toEqual([{ value: "from-sandbox" }]);
    } finally {
      session.dispose();
    }
  });

  it("tool_search 命中后，deferred 工具经活动集声明（后续请求可见）", async () => {
    const session = await makeSession([makeDeferredTool()], ["codemode", "tool_search"]);
    try {
      const faux = fauxProvider();
      session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof session.agent.streamFunction;
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "screenshot desktop screen" })]),
        fauxAssistantMessage("done")
      ]);
      await session.prompt("find a screen tool");
      expect(session.getActiveToolNames()).toContain("screen_probe");
      expect(session.state.tools.map((tool) => tool.name)).toContain("screen_probe");
    } finally {
      session.dispose();
    }
  });
});
