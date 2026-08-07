import type {
  AgentProfile,
  DesktopApi,
  DesktopBootstrap,
  DesktopSettings,
  PermissionDecision,
  RuntimeCommand,
  RuntimeMessage,
  RuntimeSnapshot,
  ResourceCatalog
} from "../../shared/protocol";

const listeners = new Set<(message: RuntimeMessage) => void>();

const demoDefaultAgent: AgentProfile = {
  id: "default",
  name: "默认助手",
  description: "",
  systemPrompt: "",
  divMode: false,
  defaultThinkingLevel: "medium",
  tools: { read: true, bash: true, edit: true, write: true, grep: true, find: true, ls: true }
};

const demoSettings: DesktopSettings = {
  version: 2,
  workspace: "D:\\Projects\\chat-anytime-demo",
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  thinkingLevel: "medium",
  accessMode: "ask",
  providers: [],
  agents: [demoDefaultAgent],
  currentAgentId: "default",
  appearance: { theme: "system", themePreset: "default", customCss: "", customThemes: [], themeOverrides: { light: {}, dark: {} }, showThinking: true }
};

const demoSnapshot: RuntimeSnapshot = {
  workspace: "D:\\Projects\\chat-anytime-demo",
  agentId: "default",
  agentName: "默认助手",
  sessionId: "demo-session",
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  thinkingLevel: "medium",
  busy: false,
  status: "就绪",
  sessions: [
    { id: "demo-session", path: "demo-session.jsonl", title: "梳理项目架构", modifiedAt: Date.now(), messageCount: 4 },
    { id: "older-session", path: "older-session.jsonl", title: "检查渲染流程", modifiedAt: Date.now() - 86_400_000, messageCount: 7 }
  ],
  messages: [
    {
      id: "demo-user",
      role: "user",
      timestamp: Date.now() - 18_000,
      blocks: [{ type: "text", text: "检查这个项目并总结运行时架构，再补充一张简图。" }]
    },
    {
      id: "demo-assistant",
      role: "assistant",
      timestamp: Date.now() - 12_000,
      blocks: [
        { type: "thinking", text: "我会先检查项目结构、运行时入口和桌面端边界，再整理结论。" },
        { type: "tool-call", id: "demo-tool-read", name: "read", arguments: { path: "package.json" } },
        {
          type: "text",
          text: `第一版包含三个清晰的进程边界：

- **Electron 主进程**负责窗口与原生对话框。
- **Pi 运行时**负责 Agent 会话、工具与权限。
- **React 渲染进程**接收稳定的应用协议。

事件链路保持精简：$E_{ui} = f(E_{pi})$。

\`\`\`mermaid
flowchart LR
  UI[React 界面] --> IPC[类型化 IPC]
  IPC --> Runtime[Pi 运行时]
  Runtime --> Tools[项目工具]
  Runtime --> Models[模型服务]
\`\`\`

渲染进程还能直接打开完整产物，不需要向 Pi 的系统提示词添加渲染说明。

\`\`\`html
<!doctype html>
<html>
  <body style="font-family:system-ui;margin:32px;color:#202321">
    <h1>运行状态</h1>
    <p>三个应用层已经连接。</p>
    <progress value="82" max="100" style="width:100%"></progress>
  </body>
</html>
\`\`\`

<assistant_html>
<div class="ai-card">
  <h3>渲染摘要</h3>
  <p>Markdown、数学公式、图表和受限 HTML 片段可以在同一条回复里共存。</p>
  <table>
    <thead><tr><th>内容</th><th>状态</th></tr></thead>
    <tbody><tr><td>主题变量</td><td>实时</td></tr><tr><td>HTML 产物</td><td>沙箱</td></tr></tbody>
  </table>
  <details><summary>查看渲染边界</summary><p>完整 HTML 文档只进入沙箱预览，卡片片段经过清洗后展示。</p></details>
</div>
</assistant_html>`
        }
      ]
    }
  ],
  executions: [
    {
      id: "tool-read",
      name: "read",
      args: { path: "package.json" },
      status: "completed",
      startedAt: Date.now() - 16_000,
      completedAt: Date.now() - 15_900,
      output: "已读取 package.json 的 58 行内容"
    },
    {
      id: "tool-edit",
      name: "edit",
      args: { path: "src/runtime.ts", oldText: "status = idle", newText: "status = ready" },
      status: "completed",
      startedAt: Date.now() - 14_000,
      completedAt: Date.now() - 13_400,
      output: "已更新 src/runtime.ts",
      patch: "--- a/src/runtime.ts\n+++ b/src/runtime.ts\n@@ -12,3 +12,3 @@\n-status = idle\n+status = ready\n"
    },
    {
      id: "tool-bash",
      name: "bash",
      args: { command: "npm run build" },
      status: "completed",
      startedAt: Date.now() - 13_000,
      completedAt: Date.now() - 10_800,
      output: "TypeScript 检查通过\nElectron 渲染进程构建成功"
    }
  ]
};

const demoResources: ResourceCatalog = {
  skills: [
    { name: "code-review", description: "审查代码变更并整理风险与建议。", source: "用户资源", scope: "global", disableModelInvocation: false },
    { name: "project-notes", description: "整理项目文档和工作记录。", source: "当前项目", scope: "project", disableModelInvocation: false }
  ],
  extensions: [{ name: "pi-mcp-adapter", source: "PiDesktop 内置", scope: "bundled", loaded: true }],
  packages: [{ source: "pi-mcp-adapter", scope: "bundled", installed: true, removable: false }],
  mcpServers: [
    { name: "docs", status: "connected", toolCount: 8, resourceCount: 2, disabled: false },
    { name: "browser", status: "disabled", toolCount: 0, disabled: true }
  ],
  mcpAdapterLoaded: true,
  diagnostics: []
};

function emit(message: RuntimeMessage): void {
  for (const listener of listeners) listener(message);
}

function updateSnapshot(update: Partial<RuntimeSnapshot>): void {
  Object.assign(demoSnapshot, update);
  emit({ type: "state", snapshot: structuredClone(demoSnapshot) });
}

function activeDemoAgent(): AgentProfile {
  return demoSettings.agents.find((agent) => agent.id === demoSettings.currentAgentId && !agent.archived)
    ?? demoSettings.agents.find((agent) => agent.id === "default")
    ?? demoDefaultAgent;
}

export function createDemoApi(): DesktopApi {
  return {
    async bootstrap(): Promise<DesktopBootstrap> {
      return {
        platform: "browser-demo",
        version: "0.1.0",
        settings: structuredClone(demoSettings),
        runtime: structuredClone(demoSnapshot),
        resources: structuredClone(demoResources),
        catalog: {
          providers: [
            { id: "anthropic", name: "Anthropic", configured: true, authSource: "demo" },
            { id: "openai", name: "OpenAI", configured: false },
            { id: "chatanytime-openai-compatible", name: "自定义 OpenAI 兼容服务", configured: false }
          ],
          models: [
            { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", configured: true, input: ["text"], imageInput: false },
            { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6", configured: true, input: ["text"], imageInput: false }
          ]
        }
      };
    },
    async chooseWorkspace(): Promise<string> {
      return demoSnapshot.workspace ?? "D:\\Projects\\chat-anytime-demo";
    },
    async chooseAttachments(): Promise<import("../../shared/protocol").PromptAttachment[]> { return []; },
    async send(command: RuntimeCommand): Promise<void> {
      switch (command.type) {
        case "thinking.select":
          updateSnapshot({ thinkingLevel: command.level });
          break;
        case "model.select":
          updateSnapshot({ model: { provider: command.provider, id: command.id } });
          break;
        case "agent.select":
          demoSettings.currentAgentId = command.agentId;
          updateSnapshot({ agentId: command.agentId, agentName: activeDemoAgent().name, sessionId: `${command.agentId}-demo-session`, messages: [] });
          break;
        case "agent.save": {
          const index = demoSettings.agents.findIndex((agent) => agent.id === command.agent.id);
          if (index >= 0) demoSettings.agents[index] = structuredClone(command.agent);
          else demoSettings.agents.push(structuredClone(command.agent));
          if (demoSettings.currentAgentId === command.agent.id) updateSnapshot({ agentName: command.agent.name });
          break;
        }
        case "agent.archive": {
          const agent = demoSettings.agents.find((item) => item.id === command.agentId);
          if (agent && agent.id !== "default") agent.archived = command.archived;
          if (demoSettings.currentAgentId === command.agentId) {
            demoSettings.currentAgentId = "default";
            updateSnapshot({ agentId: "default", agentName: demoDefaultAgent.name, sessionId: "default-demo-session", messages: [] });
          }
          break;
        }
        case "settings.save":
          demoSettings.model = command.settings.model;
          demoSettings.thinkingLevel = command.settings.thinkingLevel;
          demoSettings.accessMode = command.settings.accessMode;
          demoSettings.appearance = structuredClone(command.settings.appearance);
          updateSnapshot({ model: command.settings.model, thinkingLevel: command.settings.thinkingLevel });
          break;
        case "appearance.save":
          demoSettings.appearance = structuredClone(command.appearance);
          break;
        case "session.new":
          updateSnapshot({ messages: [], executions: [], sessionId: "new-demo-session" });
          break;
        case "session.compact":
          updateSnapshot({ busy: true, status: "Pi 正在压缩上下文" });
          setTimeout(() => updateSnapshot({
            busy: false,
            status: "就绪",
            messages: [...demoSnapshot.messages, { id: `demo-compacted-${Date.now()}`, role: "assistant", timestamp: Date.now(), blocks: [{ type: "text", text: command.instructions ? `已压缩上下文（${command.instructions}）。` : "已压缩上下文。" }] }]
          }), 80);
          break;
        case "session.prompt":
          updateSnapshot({
            messages: [...demoSnapshot.messages, { id: `user-${Date.now()}`, role: "user", timestamp: Date.now(), blocks: [{ type: "text", text: command.text }] }]
          });
          break;
        case "session.skill": {
          updateSnapshot({
            messages: [...demoSnapshot.messages, { id: `user-${Date.now()}`, role: "user", timestamp: Date.now(), skill: { name: command.name }, blocks: command.instructions ? [{ type: "text", text: command.instructions }] : [] }]
          });
          break;
        }
        case "session.regenerate": {
          const targetIndex = demoSnapshot.messages.findIndex((message) => message.role === "user" && (command.timestamp === undefined || message.timestamp === command.timestamp));
          const editedTimestamp = Date.now();
          const editedMessages = [
            ...(targetIndex >= 0 ? demoSnapshot.messages.slice(0, targetIndex) : demoSnapshot.messages),
            { id: `demo-edited-${editedTimestamp}`, role: "user" as const, timestamp: editedTimestamp, skill: command.skillName ? { name: command.skillName } : undefined, blocks: command.text ? [{ type: "text" as const, text: command.text }] : [] }
          ];
          updateSnapshot({
            busy: true,
            status: "Pi 正在重新生成",
            messages: editedMessages
          });
          setTimeout(() => updateSnapshot({
            busy: false,
            status: "就绪",
            messages: [...demoSnapshot.messages, { id: `demo-regenerated-${Date.now()}`, role: "assistant", timestamp: Date.now(), blocks: [{ type: "text", text: `已重新生成：${command.text}` }] }]
          }), 80);
          break;
        }
        case "permission.resolve": {
          const decision: PermissionDecision = command.decision;
          if (decision === "deny") emit({ type: "log", level: "warn", message: "已拒绝演示工具请求" });
          break;
        }
        case "provider.save":
          demoSettings.providers = demoSettings.providers.some((provider) => provider.id === command.provider.id)
            ? demoSettings.providers.map((provider) => provider.id === command.provider.id ? { ...command.provider, keyConfigured: Boolean(command.apiKey) || provider.keyConfigured } : provider)
            : [...demoSettings.providers, { ...command.provider, keyConfigured: Boolean(command.apiKey) }];
          updateSnapshot({ model: { provider: command.provider.id, id: command.provider.models[0]?.id ?? "" } });
          break;
        case "provider.delete":
          demoSettings.providers = demoSettings.providers.filter((provider) => provider.id !== command.providerId);
          break;
        case "provider.models.fetch":
          emit({
            type: "custom-models",
            providerId: command.providerId,
            models: [
              { id: "gpt-4o-mini", name: "GPT-4o mini", imageInput: true, enabled: false },
              { id: "gpt-4.1", name: "GPT-4.1", imageInput: true, enabled: false }
            ]
          });
          break;
        case "resources.reload":
          emit({ type: "resources", resources: structuredClone(demoResources) });
          break;
        case "resources.package.install":
          if (!demoResources.packages.some((item) => item.source === command.source)) demoResources.packages.push({ source: command.source, scope: "global", installed: true, removable: true });
          emit({ type: "resources", resources: structuredClone(demoResources) });
          break;
        case "resources.package.remove":
          demoResources.packages = demoResources.packages.filter((item) => item.source !== command.source || !item.removable);
          emit({ type: "resources", resources: structuredClone(demoResources) });
          break;
        case "mcp.server.save": {
          const existing = demoResources.mcpServers.find((item) => item.name === command.server.name);
          if (existing) {
            existing.disabled = false;
            existing.status = "not-connected";
          } else {
            demoResources.mcpServers.push({ name: command.server.name, status: "not-connected", toolCount: 0, disabled: false });
          }
          emit({ type: "resources", resources: structuredClone(demoResources) });
          break;
        }
        case "mcp.server.toggle": {
          const server = demoResources.mcpServers.find((item) => item.name === command.name);
          if (server) { server.disabled = !command.enabled; server.status = command.enabled ? "not-connected" : "disabled"; }
          emit({ type: "resources", resources: structuredClone(demoResources) });
          break;
        }
      }
    },
    onRuntimeMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
