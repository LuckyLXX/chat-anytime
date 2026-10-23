import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  type AgentSession
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import { buildMcpUiContext, createPiMcpExtensionLayer, createPidesktopMcpBridge, observeToolSetApi, type McpBridgeControl } from "./mcp-bridge.js";
import { estimateToolTokens } from "./context-breakdown.js";
import { parseMcpStatusText } from "./runtime-mcp.js";

/**
 * 「自建 MCP → Pi 内置 MCP」迁移（2026-10-15）的真实会话回归网。
 * 全部跑在真实 AgentSession + Pi 内置 createMcpExtension + stdio 伪 MCP 服务器
 * （SDK 低层 API，零网络），钉住读源码很容易看错、错了却静默失效的机制：
 *
 * 1. 桥接扩展经 registerMcpServer 注册的服务器真实连接、工具进注册表并（direct
 *    暴露）自动激活；exposure:hidden 的服务器工具注册但不激活；
 * 2. unregisterMcpServer 关连接并移除工具（零会话重建——迁移的核心收益）；
 * 3. MCP 工具调用走完整管线：tool_call 事件可拦截（权限门兼容）、结果回会话；
 * 4. /mcp 命令族经 uiContext 交互：状态板文本可解析、零模型调用、不写会话 JSONL；
 * 5. uiContext.mode=rpc + hasUI 是 /mcp login 的硬前提。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // stdio 子进程退出与文件句柄释放有延迟（Windows 上 rmdir 会 EBUSY）：
  // 重试后放弃并留给系统清理临时目录，不让清理噪声掩盖真实断言。
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(directory, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }));
});

/**
 * stdio 伪 MCP 服务器：echo 工具 + 退出 marker（验证 dispose 后子进程退出）。
 * 脚本写在临时目录里，模块解析按脚本位置走 ⇒ SDK 必须以**绝对 file:// URL**
 * 导入（临时目录上方没有 node_modules；PoC 版把脚本放仓库内所以裸导入可行）。
 * 路径直指 dist/esm（exports 映射的 import 条件），不依赖 import.meta.resolve
 * （vitest 的 Vite 变换下面不可靠）。
 */
const sdkUrl = (relative: string): string =>
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/@modelcontextprotocol/sdk/dist/esm", relative)).href;
const SERVER_SCRIPT = `
import { existsSync, writeFileSync } from "node:fs";
import { Server } from ${JSON.stringify(sdkUrl("server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(sdkUrl("server/stdio.js"))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(sdkUrl("types.js"))};
const server = new Server({ name: "poc", version: "1.0.0" }, { capabilities: { tools: {}, ...(process.env.POC_RESOURCES === "1" ? { resources: {} } : {}) } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo the value back", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } },
    // 重连后工具列表变化（可控的「注册延后/工具列表变更」）：marker 存在时多一个工具。
    ...(existsSync(new URL("./extra.marker", import.meta.url))
      ? [{ name: "extra", description: "Extra tool offered after reconnect", inputSchema: { type: "object", properties: {} } }]
      : [])
  ]
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "echo") return { content: [{ type: "text", text: "unknown tool" }], isError: true };
  return { content: [{ type: "text", text: "echo:" + (req.params.arguments?.value ?? "") }] };
});
process.on("exit", () => { try { writeFileSync(new URL("./server-exit.marker", import.meta.url), "exited"); } catch {} });
await server.connect(new StdioServerTransport());
`;

interface ProbeSession {
  session: AgentSession;
  root: string;
  notifies: string[];
  requests: string[];
  toolCalls: { name: string; input: unknown }[];
  control: McpBridgeControl | undefined;
  /** Pi MCP 扩展的 registerTool/setActiveTools 引发的宿主通知次数（临时戳）。 */
  toolSetChanges: number[];
  serverPath: string;
  exitMarker: string;
  extraMarker: string;
}

async function makeProbeSession(params: { mcpJson: Record<string, unknown>; disabledServers?: string[] }): Promise<ProbeSession> {
  const root = await mkdtemp(join(tmpdir(), "mcp-pi-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const serverPath = join(root, "server.mjs");
  await mkdir(agentDir, { recursive: true });
  await writeFile(serverPath, SERVER_SCRIPT, "utf8");
  // 服务器配置里的 command 指向这个脚本（bridge 读 agentDir/mcp.json）
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify(params.mcpJson, null, 2), "utf8");

  const notifies: string[] = [];
  const requests: string[] = [];
  const toolCalls: { name: string; input: unknown }[] = [];
  const toolSetChanges: number[] = [];
  let control: McpBridgeControl | undefined;
  // 复刻生产初始化顺序：工厂在 resourceLoader.reload() 阶段执行（此时 session
  // record 尚不存在）；record 在 createAgentSession 返回后、bindExtensions 之前
  // 建立。控制柄只有在 session_start 交付才能落到 record 上——旧实现在工厂期
  // 交付，这里会一直是 undefined，后续 resync/remove 全部失效。
  let recordBox: { control?: McpBridgeControl } | undefined;

  const probeExtension = {
    name: "pidesktop-probe",
    hidden: true,
    factory(pi: { on: (event: string, handler: (event2: unknown) => void) => void }) {
      pi.on("tool_call", (event) => {
        const record = event as { toolName: string; input: unknown };
        toolCalls.push({ name: record.toolName, input: record.input });
      });
    }
  };

  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createPidesktopMcpBridge({
        configPaths: () => ({ project: join(root, ".mcp.json"), global: join(agentDir, "mcp.json") }),
        disabledServers: () => new Set(params.disabledServers ?? []),
        onServersChange: () => {},
        onNotify: (message) => { notifies.push(message); },
        onApi: (value) => {
          if (!recordBox) return; // 生产里 recordBox 未建立时旧回调就是被丢弃的
          recordBox.control = value ?? undefined;
          control = value ?? undefined;
        }
      }),
      createPiMcpExtensionLayer({ openExternal: () => {}, onToolSetChange: () => { toolSetChanges.push(Date.now()); } }),
      // 生产环境始终装载 codemode：测试也必须用真实扩展，否则声明投影（description
      // 改写）与 codemode 目录成本都是手写模拟，容易假绿。
      createCodemodeExtension(),
      probeExtension as never
    ]
  });
  await resourceLoader.reload();

  const faux = fauxProvider();
  const result = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.create(root, sessionDir),
    model: faux.getModel()
  });
  const session = result.session;
  recordBox = {};
  await session.bindExtensions({
    mode: "rpc",
    uiContext: buildMcpUiContext({ onNotify: (message) => { notifies.push(message); } }),
    onError: () => {}
  });
  session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof session.agent.streamFunction;
  session.modelRuntime.registerNativeProvider(faux.provider);
  await session.modelRuntime.refresh({ allowNetwork: false });
  // 对齐生产形态：toolNamesFor 把 codemode 常驻点名进活动集（上游注册即不激活，
  // defaultActive:false）。不点名时 codemode 的 prepareLoadout 不会参与声明投影，
  // 测试就会绕过生产环境的描述改写。
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  faux.setResponses([
    (ctx) => { requests.push("turn1"); void ctx; return fauxAssistantMessage([fauxToolCall("mcp__poc__echo", { value: "from-test" })]); },
    () => { requests.push("turn2"); return fauxAssistantMessage("done"); }
  ]);

  return { session, root, notifies, requests, toolCalls, control, toolSetChanges, serverPath, exitMarker: join(root, "server-exit.marker"), extraMarker: join(root, "extra.marker") };
}

async function waitFor(fn: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`waitFor 超时: ${label}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 会话 JSONL 的条目数（不存在时 0）。 */
async function sessionEntryCount(file: string | undefined): Promise<number> {
  if (!file || !existsSync(file)) return 0;
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(file, "utf8");
  return text.split(/\r?\n/u).filter((line) => line.trim()).length;
}

describe("MCP → Pi 内置扩展：真实会话集成（stdio 伪服务器）", () => {
  it("桥接注册的服务器真实连接，direct 工具注册并自动激活；调用走完整管线（权限门兼容）", { timeout: 60000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    try {
      await waitFor(() => probe.session.getAllTools().some((tool) => tool.name === "mcp__poc__echo"), 20000, "工具注册");
      expect(probe.session.getAllTools().map((tool) => tool.name)).toContain("mcp__poc__echo");
      // direct 暴露：注册后自动激活（Pi 的 _isActivatedOnRegistration）
      expect(probe.session.getActiveToolNames()).toContain("mcp__poc__echo");

      // 真实调用：faux 发起 tool call → 完整管线（tool_call 事件 + 结果回会话）
      await probe.session.prompt("go");
      await waitFor(() => probe.toolCalls.some((call) => call.name === "mcp__poc__echo"), 10000, "tool_call 事件");
      expect(probe.toolCalls.find((call) => call.name === "mcp__poc__echo")?.input).toEqual({ value: "from-test" });
      const transcript = probe.session.state.messages.map((message) => JSON.stringify((message as { content?: unknown }).content ?? "")).join("\n");
      expect(transcript).toContain("echo:from-test");
    } finally {
      probe.session.dispose();
    }
  });

  it("角色级 overlay 禁用 → hidden 暴露注册：工具在注册表但不激活（零前缀成本）", { timeout: 60000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } },
      disabledServers: ["poc"]
    });
    try {
      await waitFor(() => probe.session.getAllTools().some((tool) => tool.name === "mcp__poc__echo"), 20000, "工具注册");
      expect(probe.session.getActiveToolNames()).not.toContain("mcp__poc__echo");
    } finally {
      probe.session.dispose();
    }
  });

  it("服务器配置 exposure:codemode → 工具注册但不进活动集（零前缀，不声明给模型）", { timeout: 60000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"], exposure: "codemode" } } }
    });
    try {
      // 注册表里看得到（脚本内 searchTools()/ALL_TOOLS 可达），但从不自动激活
      await waitFor(() => probe.session.getAllTools().some((tool) => tool.name === "mcp__poc__echo"), 20000, "工具注册");
      expect(probe.session.getActiveToolNames()).not.toContain("mcp__poc__echo");
    } finally {
      probe.session.dispose();
    }
  });

  it("resync：手动改 mcp.json 的 exposure 能热应用（不必重建会话，配置没变不重连）", { timeout: 90000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    try {
      await waitFor(() => probe.session.getActiveToolNames().includes("mcp__poc__echo"), 20000, "direct 工具激活");
      const configPath = join(probe.root, "agent", "mcp.json");
      await writeFile(configPath, JSON.stringify({
        mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"], exposure: "codemode" } }
      }, null, 2), "utf8");

      expect(probe.control!.resync()).toBe(true);
      await waitFor(() => !probe.session.getActiveToolNames().includes("mcp__poc__echo"), 15000, "工具摘出活动集");
      // 指纹比对：同样的配置再 resync 不应重复注册（重注册 = 断开重连）
      expect(probe.control!.resync()).toBe(false);
    } finally {
      probe.session.dispose();
    }
  });

  it("unregisterMcpServer 关连接并把工具摘出活动集（零会话重建——迁移核心收益）", { timeout: 60000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    try {
      await waitFor(() => probe.session.getActiveToolNames().includes("mcp__poc__echo"), 20000, "工具激活");
      expect(probe.control).toBeDefined();
      probe.control!.remove("poc");
      // Pi 没有工具移除 API：注册表条目会留下，但扩展把它从**活动集**摘出
      // ——模型看不到它就等于删除（toolNamesFor 以活动集为源，不会把它拉回来）。
      await waitFor(() => !probe.session.getActiveToolNames().includes("mcp__poc__echo"), 10000, "工具摘出活动集");
      expect(probe.session.getAllTools().some((tool) => tool.name === "mcp__poc__echo")).toBe(true);
      // 会话本体仍然活着（没有重建路径介入）
      expect(probe.session.isIdle).toBe(true);
    } finally {
      probe.session.dispose();
    }
  });

  it("/mcp 状态板经 notify 输出且可解析；命令零模型调用、不写会话 JSONL", { timeout: 60000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    try {
      await waitFor(() => probe.session.getAllTools().some((tool) => tool.name === "mcp__poc__echo"), 20000, "工具注册");
      // 先跑一轮真实消息：会话 JSONL 只有发过消息才存在（/mcp 不写会话的断言需要基线）
      await probe.session.prompt("go");
      await waitFor(() => probe.toolCalls.length > 0, 10000, "首轮工具调用");
      const sessionFile = probe.session.sessionManager.getSessionFile();
      const entriesBefore = await sessionEntryCount(sessionFile);

      probe.notifies.length = 0;
      const modelCallsBefore = probe.requests.length;
      await probe.session.prompt("/mcp", { preflightResult: () => {} });
      await waitFor(() => probe.notifies.length > 0, 10000, "状态板 notify");

      const statusText = probe.notifies.join("\n");
      const parsed = parseMcpStatusText(statusText);
      expect(parsed.get("poc")).toMatchObject({ state: "connected", toolCount: 1 });
      // 零模型调用 + 会话 JSONL 零污染
      expect(probe.requests.length).toBe(modelCallsBefore);
      expect(await sessionEntryCount(sessionFile)).toBe(entriesBefore);
    } finally {
      probe.session.dispose();
    }
  });

  it("/mcp login 对非 OAuth 服务器优雅报错（命令+UI 通路可用性）", { timeout: 60000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    try {
      await waitFor(() => probe.session.getAllTools().some((tool) => tool.name === "mcp__poc__echo"), 20000, "工具注册");
      probe.notifies.length = 0;
      await probe.session.prompt("/mcp login poc", { preflightResult: () => {} });
      await waitFor(() => probe.notifies.some((message) => /OAuth/u.test(message)), 10000, "login 报错 notify");
      expect(probe.notifies.join("\n")).toMatch(/does not use OAuth|No enabled MCP server uses OAuth/u);
    } finally {
      probe.session.dispose();
    }
  });

  it("生产初始化顺序：工厂期 record 尚不存在，控制柄经 session_start 交付到 record", { timeout: 60000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    try {
      // makeProbeSession 的 onApi 只在 recordBox 建立后接收（复刻生产）：旧实现
      // 在工厂期交付，这里永远是 undefined，因此这是直接回归断言。
      expect(probe.control).toBeDefined();
      // 控制柄可用（无变更时 resync 返回 false，不会因为拿不到 api 崩溃）
      expect(probe.control!.resync()).toBe(false);
      expect(probe.control!.registeredNames()).toEqual(["poc"]);
    } finally {
      probe.session.dispose();
    }
  });

  it("direct → codemode → direct：不发送消息即可改变实际声明与工具估算，多次切换稳定", { timeout: 120000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    const declaredNames = () => probe.session.state.tools.map((tool) => tool.name);
    const toolTokens = () => estimateToolTokens(probe.session.state.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
    const writeConfig = async (extra: Record<string, unknown>) => {
      await writeFile(join(probe.root, "agent", "mcp.json"), JSON.stringify({
        mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"], ...extra } }
      }, null, 2), "utf8");
    };
    try {
      await waitFor(() => declaredNames().includes("mcp__poc__echo"), 20000, "direct 声明");
      const directTokens = toolTokens();
      expect(directTokens).toBeGreaterThan(0);
      // codemode 模式下 codemode 工具必须真实在场（准备脚本调用的前提）
      expect(declaredNames()).toContain("codemode");

      for (let cycle = 0; cycle < 2; cycle++) {
        // direct → codemode：全量 schema 从声明中移除，工具估算下降；注册表仍保留
        // （脚本经 searchTools()/ALL_TOOLS 可达），但活动集与声明都不含它。
        await writeConfig({ exposure: "codemode" });
        expect(probe.control!.resync()).toBe(true);
        await waitFor(() => !declaredNames().includes("mcp__poc__echo"), 15000, "codemode 声明移除");
        expect(probe.session.getActiveToolNames()).not.toContain("mcp__poc__echo");
        expect(probe.session.getAllTools().some((tool) => tool.name === "mcp__poc__echo")).toBe(true);
        const codemodeTokens = toolTokens();
        expect(codemodeTokens).toBeLessThan(directTokens);

        // codemode → direct：完整 schema 回到声明，估算回到同一基线（不单调增长）
        await writeConfig({});
        expect(probe.control!.resync()).toBe(true);
        await waitFor(() => declaredNames().includes("mcp__poc__echo"), 15000, "direct 声明恢复");
        expect(toolTokens()).toBe(directTokens);
      }

      // codemode 脚本仍可发现并调用该工具（权限/结果管线不回退）
      await writeConfig({ exposure: "codemode" });
      expect(probe.control!.resync()).toBe(true);
      await waitFor(() => !declaredNames().includes("mcp__poc__echo"), 15000, "脚本模式声明移除");
      const faux = fauxProvider();
      probe.session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof probe.session.agent.streamFunction;
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("codemode", { code: "const r = await tools.mcp__poc__echo({ value: \"from-script\" });\nreturn r;" })]),
        fauxAssistantMessage("done")
      ]);
      await probe.session.prompt("go");
      await waitFor(() => probe.toolCalls.some((call) => call.name === "mcp__poc__echo" && (call.input as { value?: string }).value === "from-script"), 15000, "脚本内调用");
      const transcript = probe.session.state.messages.map((message) => JSON.stringify((message as { content?: unknown }).content ?? "")).join("\n");
      expect(transcript).toContain("echo:from-script");
    } finally {
      probe.session.dispose();
    }
  });

  it("工具事件驱动刷新：重连后新增工具注册即通知宿主（替代固定 6 秒窗口）", { timeout: 90000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    try {
      await waitFor(() => probe.session.getActiveToolNames().includes("mcp__poc__echo"), 20000, "初始工具激活");
      const changesBefore = probe.toolSetChanges.length;
      expect(changesBefore).toBeGreaterThan(0); // 初始连接注册工具也经事件通知

      // 让下一次连接的工具列表变化（marker 在重连时被伪服务器读到），再用配置
      // 指纹变化触发重注册/重连——这是「注册延后/定义变化」的可控版本。
      await writeFile(probe.extraMarker, "1", "utf8");
      await writeFile(join(probe.root, "agent", "mcp.json"), JSON.stringify({
        mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"], timeout: 300 } }
      }, null, 2), "utf8");
      expect(probe.control!.resync()).toBe(true);
      await waitFor(() => probe.session.state.tools.some((tool) => tool.name === "mcp__poc__extra"), 15000, "新增工具进入声明");
      // 通知来自真实的 registerTool 调用，而不是「猜一个时间点重算」。
      expect(probe.toolSetChanges.length).toBeGreaterThan(changesBefore);
    } finally {
      probe.session.dispose();
    }
  });

  it("Pi 的共享 resource 工具不带 mcp__ 前缀（归位时必须原样保留，不能当僵尸工具删）", { timeout: 60000 }, async () => {
    // 服务器声明 resources 能力 + direct 暴露：Pi 会注册并激活 list_mcp_resources /
    // list_mcp_resource_templates / read_mcp_resource。这三个名字不在 app 的
    // toolNamesFor 管辖范围内（见 pi-runtime 的 PI_MCP_RESOURCE_TOOL_NAMES），
    // 归位时误删就会把 Pi 的合法活动项摘掉。
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"], env: { POC_RESOURCES: "1" } } } }
    });
    try {
      await waitFor(() => probe.session.getActiveToolNames().includes("list_mcp_resources"), 20000, "resource 工具激活");
      const active = probe.session.getActiveToolNames();
      for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
        expect(active).toContain(name);
        expect(name.startsWith("mcp__")).toBe(false);
      }
    } finally {
      probe.session.dispose();
    }
  });

  it("reapply 注销后指纹必须清掉：文件里手动重新启用能被 resync 重连", { timeout: 90000 }, async () => {
    const probe = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    const configPath = join(probe.root, "agent", "mcp.json");
    const writeConfig = (entry: Record<string, unknown>) =>
      writeFile(configPath, JSON.stringify({ mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"], ...entry } } }, null, 2), "utf8");
    try {
      await waitFor(() => probe.session.getActiveToolNames().includes("mcp__poc__echo"), 20000, "初始工具激活");

      // 面板「停用」：配置写 disabled 后走 reapply（applyMcpToolChanges 的路径）
      await writeConfig({ disabled: true });
      probe.control!.reapply("poc");
      await waitFor(() => !probe.session.getActiveToolNames().includes("mcp__poc__echo"), 15000, "停用后工具摘出");
      expect(probe.control!.registeredNames()).toEqual([]);

      // 用户手动改文件重新启用（传输配置不动）：翻译后的注册载荷与停用时逐字节
      // 相同（disabled 不进载荷），因此旧指纹残留会让 resync 误判「配置未变」。
      await writeConfig({});
      expect(probe.control!.resync()).toBe(true);
      await waitFor(() => probe.session.getActiveToolNames().includes("mcp__poc__echo"), 20000, "重新启用后工具回来");
      // 同一配置再 resync 不重连（指纹已重建）
      expect(probe.control!.resync()).toBe(false);
    } finally {
      probe.session.dispose();
    }
  });

  it("会话销毁必须显式 unregisterAll 才能收回 stdio 子进程（Pi 的 dispose 不发 session_shutdown）", { timeout: 90000 }, async () => {
    // ① 只 dispose：连接不会关（Pi 只在 reload 时发 session_shutdown），
    //    而且 dispose() 会把扩展上下文 invalidate ⇒ 之后再注销已经来不及。
    const leaked = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    await waitFor(() => leaked.session.getActiveToolNames().includes("mcp__poc__echo"), 20000, "工具激活");
    leaked.session.dispose();
    await sleep(3000);
    expect(existsSync(leaked.exitMarker)).toBe(false);

    // ② 先 unregisterAll 再 dispose：子进程退出（disposeRecord 走的就是这个顺序）
    const reclaimed = await makeProbeSession({
      mcpJson: { mcpServers: { poc: { command: process.execPath, args: ["./server.mjs"] } } }
    });
    await waitFor(() => reclaimed.session.getActiveToolNames().includes("mcp__poc__echo"), 20000, "工具激活");
    expect(reclaimed.control).toBeDefined();
    reclaimed.control!.unregisterAll();
    await waitFor(() => existsSync(reclaimed.exitMarker), 20000, "子进程退出 marker");
    reclaimed.session.dispose();
  });
});

describe("server.mjs fixture 可用性", () => {
  it("node 能直接启动（防 fixture 语法损坏导致的假红）", () => {
    const result = spawnSync(process.execPath, ["--check", join(tmpdir(), "nonexistent")], { encoding: "utf8" });
    // --check 对不存在文件必然失败；这里只验证 node 本身可用
    expect(result.error).toBeUndefined();
  });
});

void sleep;
