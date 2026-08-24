import type {
  AgentProfile,
  BrowserElementPick,
  BrowserPreviewCommand,
  BrowserPreviewState,
  BrowserTabsEvent,
  ContextUsage,
  DesktopApi,
  DesktopBootstrap,
  DesktopSettings,
  PermissionDecision,
  RecentWorkspace,
  RuntimeCommand,
  RuntimeMessage,
  RuntimeSnapshot,
  ResourceCatalog,
  TerminalCommand,
  TerminalEventData
} from "../../shared/protocol";

const listeners = new Set<(message: RuntimeMessage) => void>();
const browserPreviewListeners = new Set<(state: BrowserPreviewState) => void>();
const terminalListeners = new Map<string, Set<(event: TerminalEventData) => void>>();
let browserPreviewState: BrowserPreviewState = { attached: false, url: "", title: "", loading: false, canGoBack: false, canGoForward: false };

// 64x64 渐变 PNG（浏览器演示模式下的图片预览样例）。
const demoPngData = "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";

// 演示用上下文占用：压缩后置 null（待下一次回复重新估算），与真实运行时语义一致。
// 缓存命中率同样模拟：新会话未发过请求时为 null，第一轮回复后出现。
const DEMO_CONTEXT_WINDOW = 200_000;
let demoContextTokens: number | null = 41_300;
let demoCacheHitRate: number | null = 88.4;

function demoContextUsage(): ContextUsage {
  return {
    tokens: demoContextTokens,
    contextWindow: DEMO_CONTEXT_WINDOW,
    percent: demoContextTokens == null ? null : (demoContextTokens / DEMO_CONTEXT_WINDOW) * 100,
    cacheHitRate: demoCacheHitRate
  };
}

/** 模拟一次回合后的上下文增长：估算 prompt + 回复的 chars/4 token。 */
function growDemoContext(...texts: string[]): void {
  const estimated = texts.reduce((sum, text) => sum + Math.round(text.length / 4), 0);
  demoContextTokens = Math.max(120, (demoContextTokens ?? 0) + estimated + 480);
  // 首轮请求没有可命中缓存（60），多轮后命中前文缓存，命中率小幅爬升。
  if (demoCacheHitRate == null) demoCacheHitRate = 60;
  else if (demoContextTokens > 20_000) demoCacheHitRate = Math.min(97.6, demoCacheHitRate + 3.2);
}

/** 切到新会话：tokens 归零/置 null 时，命中率同步清空（还没发过请求）。 */
function resetDemoContext(tokens: number | null): void {
  demoContextTokens = tokens;
  demoCacheHitRate = tokens == null || tokens === 0 ? null : 85;
}

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
  appearance: { theme: "system", themePreset: "default", customCss: "", customThemes: [], showThinking: true }
};

const demoSnapshot: RuntimeSnapshot = {
  workspace: "D:\\Projects\\chat-anytime-demo",
  gitBranch: "main",
  agentId: "default",
  agentName: "默认助手",
  sessionId: "demo-session",
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  thinkingLevel: "medium",
  busy: false,
  status: "就绪",
  contextUsage: demoContextUsage(),
  queuedMessages: [],
  backgroundProcesses: [],
  recentWorkspaces: [
    { path: "D:\\Projects\\chat-anytime-demo", openedAt: Date.now() },
    { path: "D:\\Projects\\PiDesktop", openedAt: Date.now() - 43_200_000 }
  ],
  sessions: [
    { id: "demo-session", path: "demo-session.jsonl", workspace: "D:\\Projects\\chat-anytime-demo", title: "梳理项目架构", modifiedAt: Date.now(), messageCount: 4, runStatus: "completed" },
    { id: "older-session", path: "older-session.jsonl", workspace: "D:\\Projects\\chat-anytime-demo", title: "检查渲染流程", modifiedAt: Date.now() - 86_400_000, messageCount: 7, runStatus: "failed" },
    { id: "other-session", path: "other-session.jsonl", workspace: "D:\\Projects\\PiDesktop", title: "检查桌面端", modifiedAt: Date.now() - 43_200_000, messageCount: 3 }
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
        { type: "tool-call", id: "tool-read", name: "read", arguments: { path: "package.json" } },
        { type: "tool-call", id: "tool-edit", name: "edit", arguments: { path: "src/runtime.ts" } },
        { type: "tool-call", id: "tool-image", name: "bash", arguments: { command: "python ~/.agents/skills/rolldek-image/rolldek_image.py generate 架构简图 -o demo.png" } },
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
      patch: "--- a/src/runtime.ts\n+++ b/src/runtime.ts\n@@ -12,3 +12,3 @@\n-status = idle\n+status = ready\n",
      changedFile: { relativePath: "src/runtime.ts" }
    },
    {
      id: "tool-bash",
      name: "bash",
      args: { command: "npm run build" },
      status: "completed",
      startedAt: Date.now() - 13_000,
      completedAt: Date.now() - 10_800,
      output: "TypeScript 检查通过\nElectron 渲染进程构建成功"
    },
    {
      id: "tool-image",
      name: "bash",
      args: { command: "python ~/.agents/skills/rolldek-image/rolldek_image.py generate 架构简图 -o demo.png" },
      status: "completed",
      startedAt: Date.now() - 10_000,
      completedAt: Date.now() - 9_200,
      output: "demo.png",
      changedFiles: [{ relativePath: "demo.png" }]
    }
  ]
};

const demoResources: ResourceCatalog = {
  skills: [
    { id: "skill:code-review", name: "code-review", description: "审查代码变更并整理风险与建议。", source: "用户资源", scope: "global", defaultEnabled: true, enabled: true, toggleable: true, disableModelInvocation: false },
    { id: "skill:project-notes", name: "project-notes", description: "整理项目文档和工作记录。", source: "当前项目", scope: "project", defaultEnabled: true, enabled: true, toggleable: true, disableModelInvocation: false }
  ],
  mcpServers: [
    { name: "docs", status: "connected", toolCount: 8, resourceCount: 2, disabled: false },
    { name: "browser", status: "disabled", toolCount: 0, disabled: true }
  ],
  todos: [],
  memory: [],
  hooks: [
    { name: "跑完通知", event: "agent_end", actionKind: "notify", action: { kind: "notify" }, actionPreview: "桌面通知", blocking: false, scope: "global", enabled: true },
    { name: "git防火墙", event: "tool_call", matcher: "bash", actionKind: "block", action: { kind: "block", deny: ["git\\s+push.*--force"] }, actionPreview: "拦截 1 条规则", blocking: true, scope: "project", enabled: true }
  ],
  hooksEnabled: true,
  diagnostics: []
};

function emit(message: RuntimeMessage): void {
  for (const listener of listeners) listener(message);
}

function emitBrowserPreview(update: Partial<BrowserPreviewState>): BrowserPreviewState {
  browserPreviewState = { ...browserPreviewState, ...update };
  for (const listener of browserPreviewListeners) listener(structuredClone(browserPreviewState));
  return structuredClone(browserPreviewState);
}

function emitTerminalData(terminalId: string, event: TerminalEventData): void {
  for (const listener of terminalListeners.get(terminalId) ?? []) listener(event);
}

function normalizeDemoBrowserUrl(input: string): string {
  const value = input.trim();
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/iu.test(value);
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(value) ? value : `${local ? "http" : "https"}://${value}`;
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

function applyDemoAgentSkillOverrides(): void {
  const overrides = activeDemoAgent().skillOverrides;
  demoResources.skills = demoResources.skills.map((skill) => ({
    ...skill,
    enabled: overrides?.[skill.id] ?? skill.defaultEnabled
  }));
}

function recordDemoWorkspace(workspaces: RecentWorkspace[], path: string): RecentWorkspace[] {
  const key = path.replaceAll("\\", "/").toLowerCase();
  return [{ path, openedAt: Date.now() }, ...workspaces.filter((item) => item.path.replaceAll("\\", "/").toLowerCase() !== key)].slice(0, 15);
}

/** 演示队列增删后按 kind 重排下标，保持与真实运行时一致的寻址方式。 */
function reindexDemoQueue(queue: import("../../shared/protocol").QueuedMessage[]): import("../../shared/protocol").QueuedMessage[] {
  const counters: Record<"steering" | "followUp", number> = { steering: 0, followUp: 0 };
  return queue.map((item) => ({ ...item, index: counters[item.kind]++ }));
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
            { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", configured: true, input: ["text", "image"], imageInput: true },
            { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6", configured: true, input: ["text"], imageInput: false }
          ]
        }
      };
    },
    async chooseWorkspace(): Promise<string> {
      return demoSnapshot.workspace ?? "D:\\Projects\\chat-anytime-demo";
    },
    async chooseAttachments(): Promise<import("../../shared/protocol").PromptAttachment[]> { return []; },
    async readClipboardImage(): Promise<{ data: string } | undefined> { return undefined; },
    async choosePreviewFile(): Promise<import("../../shared/protocol").WorkspaceFilePreview> {
      return { relativePath: "README.md", name: "README.md", kind: "markdown", language: "markdown", size: 70, content: "# Pi Desktop\n\n- Electron 主进程\n- Pi 工具进程\n- React 渲染进程\n" };
    },
    async readWorkspaceFile(relativePath: string, _workspace?: string): Promise<import("../../shared/protocol").WorkspaceFilePreview> {
      if (relativePath === "demo.png") {
        return { relativePath, name: "demo.png", kind: "image", mimeType: "image/png", size: 3775, data: demoPngData, workspace: demoSettings.workspace };
      }
      if (relativePath === "src/runtime.ts") {
        return { relativePath, name: "runtime.ts", kind: "code", language: "typescript", size: 96, content: "export const runtime = {\n  status: \"ready\",\n  process: \"utility\"\n};\n" };
      }
      if (relativePath === "README.md") {
        return { relativePath, name: "README.md", kind: "markdown", language: "markdown", size: 70, content: "# Pi Desktop\n\n- Electron 主进程\n- Pi 工具进程\n- React 渲染进程\n" };
      }
      if (relativePath.endsWith(".pdf")) {
        return { relativePath, name: "spec.pdf", kind: "pdf", size: 2048, workspace: demoSettings.workspace };
      }
      throw new Error(`找不到演示文件：${relativePath}`);
    },
    async writeWorkspaceFile(relativePath: string, content: string, _workspace?: string): Promise<import("../../shared/protocol").WorkspaceFileWriteResult> {
      return { saved: true, size: new Blob([content]).size, relativePath };
    },
    async listWorkspaceDirectory(_workspace?: string, _relativePath?: string): Promise<import("../../shared/protocol").WorkspaceDirectoryListing> {
      return { relativePath: "", entries: [{ name: "src", relativePath: "src", kind: "directory" }, { name: "demo.png", relativePath: "demo.png", kind: "file" }, { name: "README.md", relativePath: "README.md", kind: "file" }] };
    },
    async searchWorkspaceFiles(_workspace?: string, query?: string): Promise<import("../../shared/protocol").WorkspaceFileSearchResult> {
      const entries = [
        { name: "src", relativePath: "src", kind: "directory" as const },
        { name: "runtime.ts", relativePath: "src/runtime.ts", kind: "file" as const },
        { name: "demo.png", relativePath: "demo.png", kind: "file" as const },
        { name: "README.md", relativePath: "README.md", kind: "file" as const }
      ];
      const needle = (query ?? "").trim().toLowerCase().replaceAll("\\", "/");
      const matched = needle
        ? entries.filter((entry) => entry.relativePath.toLowerCase().includes(needle))
        : entries;
      return { entries: matched.slice(0, 30) };
    },
    async createWorkspaceFile(_workspace: string, relativePath: string): Promise<import("../../shared/protocol").WorkspaceEntryResult> {
      return { relativePath };
    },
    async createWorkspaceDirectory(_workspace: string, relativePath: string): Promise<import("../../shared/protocol").WorkspaceEntryResult> {
      return { relativePath };
    },
    async deleteWorkspaceEntry(_workspace: string, relativePath: string): Promise<import("../../shared/protocol").WorkspaceEntryResult> {
      return { relativePath };
    },
    async renameWorkspaceEntry(_workspace: string, relativePath: string, newName: string): Promise<import("../../shared/protocol").WorkspaceEntryResult> {
      const parent = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/") + 1) : "";
      return { relativePath: `${parent}${newName}` };
    },
    async browserPreview(command: BrowserPreviewCommand): Promise<BrowserPreviewState> {
      if (command.type === "close") {
        return emitBrowserPreview({ attached: false, url: "", title: "", loading: false, canGoBack: false, canGoForward: false, error: undefined });
      }
      if (command.type === "navigate") {
        const url = normalizeDemoBrowserUrl(command.url);
        return emitBrowserPreview({ attached: false, url, title: "浏览器演示", loading: false, error: "网页内容仅在 Electron 桌面窗口中显示" });
      }
      // pick-mode 在浏览器演示环境无原生视图可点选，静默忽略。
      return structuredClone(browserPreviewState);
    },
      async browserAutomationCancel(_tabId: string): Promise<void> {
        // 浏览器演示环境没有原生自动化操作可取消。
      },
    async terminal(command: TerminalCommand): Promise<void> {
      if (command.type === "create") {
        emitTerminalData(command.terminalId, { type: "error", terminalId: command.terminalId, message: "终端仅在 Electron 桌面窗口中可用" });
      }
    },
    async send(command: RuntimeCommand): Promise<void> {
      switch (command.type) {
        case "thinking.select":
          updateSnapshot({ thinkingLevel: command.level });
          break;
        case "model.select":
          updateSnapshot({ model: { provider: command.provider, id: command.id } });
          break;
        case "workspace.open":
          resetDemoContext(0);
          updateSnapshot({ workspace: command.path, sessionId: undefined, messages: [], executions: [], contextUsage: demoContextUsage(), recentWorkspaces: recordDemoWorkspace(demoSnapshot.recentWorkspaces, command.path) });
          break;
        case "agent.select":
          demoSettings.currentAgentId = command.agentId;
          resetDemoContext(0);
          updateSnapshot({ agentId: command.agentId, agentName: activeDemoAgent().name, sessionId: `${command.agentId}-demo-session`, messages: [], contextUsage: demoContextUsage() });
          applyDemoAgentSkillOverrides();
          emit({ type: "resources", resources: structuredClone(demoResources) });
          break;
        case "agent.save": {
          const index = demoSettings.agents.findIndex((agent) => agent.id === command.agent.id);
          if (index >= 0) demoSettings.agents[index] = structuredClone(command.agent);
          else demoSettings.agents.push(structuredClone(command.agent));
          if (demoSettings.currentAgentId === command.agent.id) {
            updateSnapshot({ agentName: command.agent.name });
            applyDemoAgentSkillOverrides();
            emit({ type: "resources", resources: structuredClone(demoResources) });
          }
          break;
        }
        case "agent.archive": {
          const agent = demoSettings.agents.find((item) => item.id === command.agentId);
          if (agent && agent.id !== "default") agent.archived = command.archived;
          if (demoSettings.currentAgentId === command.agentId) {
            demoSettings.currentAgentId = "default";
            updateSnapshot({ agentId: "default", agentName: demoDefaultAgent.name, sessionId: "default-demo-session", messages: [] });
            applyDemoAgentSkillOverrides();
            emit({ type: "resources", resources: structuredClone(demoResources) });
          }
          break;
        }
        case "settings.save":
          demoSettings.model = command.settings.model;
          demoSettings.thinkingLevel = command.settings.thinkingLevel;
          demoSettings.accessMode = command.settings.accessMode;
          demoSettings.appearance = structuredClone(command.settings.appearance);
            demoSettings.browser = command.settings.browser;
          updateSnapshot({ model: command.settings.model, thinkingLevel: command.settings.thinkingLevel });
          break;
        case "appearance.save":
          demoSettings.appearance = structuredClone(command.appearance);
          break;
        case "session.new": {
          const workspace = command.workspace ?? demoSnapshot.workspace ?? "D:\\Projects\\chat-anytime-demo";
          resetDemoContext(0);
          updateSnapshot({ workspace, messages: [], executions: [], sessionId: "new-demo-session", contextUsage: demoContextUsage(), recentWorkspaces: recordDemoWorkspace(demoSnapshot.recentWorkspaces, workspace) });
          break;
        }
        case "session.open": {
          const workspace = command.workspace ?? demoSnapshot.workspace ?? "D:\\Projects\\chat-anytime-demo";
          resetDemoContext(2_600);
          updateSnapshot({ workspace, sessionId: command.path.replace(/.*[\\/]/u, "").replace(/\.jsonl$/u, ""), messages: [], executions: [], contextUsage: demoContextUsage(), recentWorkspaces: recordDemoWorkspace(demoSnapshot.recentWorkspaces, workspace) });
          break;
        }
        case "session.rename":
          updateSnapshot({ sessions: demoSnapshot.sessions.map((item) => item.path === command.path ? { ...item, title: command.title } : item) });
          break;
        case "session.pin":
          updateSnapshot({ sessions: demoSnapshot.sessions.map((item) => item.path === command.path ? { ...item, pinned: command.pinned || undefined } : item) });
          break;
        case "session.delete":
          updateSnapshot({ sessions: demoSnapshot.sessions.filter((item) => item.path !== command.path) });
          break;
        case "workspace.remove":
          updateSnapshot({
            sessions: demoSnapshot.sessions.filter((item) => item.workspace !== command.workspace),
            recentWorkspaces: demoSnapshot.recentWorkspaces.filter((item) => item.path !== command.workspace)
          });
          break;
        case "session.compact": {
          const timestamp = Date.now();
          updateSnapshot({
            busy: true,
            status: "Pi 正在压缩上下文",
            messages: [...demoSnapshot.messages, { id: `demo-compact-command-${timestamp}`, role: "user", control: "compact", timestamp, blocks: [{ type: "text", text: command.instructions ? `/compact ${command.instructions}` : "/compact" }] }]
          });
          setTimeout(() => {
            demoContextTokens = null;
            updateSnapshot({
              busy: false,
              status: "就绪",
              contextUsage: demoContextUsage(),
              messages: [...demoSnapshot.messages, { id: `demo-compacted-${Date.now()}`, role: "assistant", control: "compact", timestamp: Date.now(), blocks: [{ type: "text", text: "已压缩上下文。" }] }]
            });
          }, 80);
          break;
        }
        case "session.prompt": {
          const activeId = demoSnapshot.sessionId;
          const promptTimestamp = Date.now();
          updateSnapshot({
            busy: true,
            status: "Pi 正在工作",
            messages: [...demoSnapshot.messages, { id: `user-${promptTimestamp}`, role: "user", timestamp: promptTimestamp, blocks: [{ type: "text", text: command.text }] }],
            sessions: demoSnapshot.sessions.map((item) => item.id === activeId ? { ...item, runStatus: "running" as const } : item)
          });
          setTimeout(() => {
            const replyText = `已收到：${command.text}`;
            growDemoContext(command.text, replyText);
            updateSnapshot({
              busy: false,
              status: "就绪",
              contextUsage: demoContextUsage(),
              messages: [...demoSnapshot.messages, { id: `demo-reply-${Date.now()}`, role: "assistant", timestamp: Date.now(), blocks: [{ type: "text", text: replyText }] }],
              sessions: demoSnapshot.sessions.map((item) => item.id === activeId ? { ...item, runStatus: "completed" as const } : item)
            });
          }, 80);
          break;
        }
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
          setTimeout(() => {
            growDemoContext(command.text ?? "");
            updateSnapshot({
              busy: false,
              status: "就绪",
              contextUsage: demoContextUsage(),
              messages: [...demoSnapshot.messages, { id: `demo-regenerated-${Date.now()}`, role: "assistant", timestamp: Date.now(), blocks: [{ type: "text", text: `已重新生成：${command.text}` }] }]
            });
          }, 80);
          break;
        }
        case "session.abort": {
          updateSnapshot({ busy: false, status: "就绪", queuedMessages: [] });
          break;
        }
        case "session.queue.add": {
          const text = command.skillName ? `【Skill：${command.skillName}】${command.text}` : command.text;
          const followUpCount = demoSnapshot.queuedMessages.filter((item) => item.kind === "followUp").length;
          updateSnapshot({ queuedMessages: [...demoSnapshot.queuedMessages, { kind: "followUp", index: followUpCount, text }] });
          break;
        }
        case "session.queue.sendNow": {
          const target = demoSnapshot.queuedMessages.find((item) => item.kind === command.kind && item.index === command.index);
          if (!target || target.text !== command.text) break;
          const rest = demoSnapshot.queuedMessages.filter((item) => item !== target);
          updateSnapshot({ queuedMessages: reindexDemoQueue([{ ...target, kind: "steering" }, ...rest]) });
          break;
        }
        case "session.queue.remove": {
          const target = demoSnapshot.queuedMessages.find((item) => item.kind === command.kind && item.index === command.index);
          if (!target || target.text !== command.text) break;
          updateSnapshot({ queuedMessages: reindexDemoQueue(demoSnapshot.queuedMessages.filter((item) => item !== target)) });
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
        case "provider.models.save":
          demoSettings.providers = demoSettings.providers.some((provider) => provider.id === command.provider.id)
            ? demoSettings.providers.map((provider) => provider.id === command.provider.id ? command.provider : provider)
            : [...demoSettings.providers, command.provider];
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
        case "provider.models.refresh":
          emit({ type: "models-refreshed", providerId: command.providerId });
          break;
        case "vision.save":
          demoSettings.vision = { ...command.vision };
          break;
        case "resources.reload":
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
        case "hooks.save": {
          const draft = command.hook;
          const preview = draft.action.kind === "command"
            ? draft.action.command
            : draft.action.kind === "http"
              ? draft.action.url
              : draft.action.kind === "block"
                ? `拦截 ${draft.action.deny.length} 条规则`
                : draft.action.title || "桌面通知";
          demoResources.hooks = [
            ...demoResources.hooks.filter((item) => !(item.name === draft.name && item.scope === draft.scope)),
            {
              name: draft.name,
              event: draft.event,
              ...(draft.matcher ? { matcher: draft.matcher } : {}),
              actionKind: draft.action.kind,
              action: structuredClone(draft.action),
              actionPreview: preview,
              blocking: draft.action.kind === "block" || (draft.action.kind === "command" && draft.action.blocking === true),
              scope: draft.scope,
              enabled: true
            }
          ];
          emit({ type: "resources", resources: structuredClone(demoResources) });
          break;
        }
        case "hooks.toggle": {
          const hook = demoResources.hooks.find((item) => item.name === command.name && item.scope === command.scope);
          if (hook) hook.enabled = command.enabled;
          emit({ type: "resources", resources: structuredClone(demoResources) });
          break;
        }
        case "hooks.delete": {
          demoResources.hooks = demoResources.hooks.filter((item) => !(item.name === command.name && item.scope === command.scope));
          emit({ type: "resources", resources: structuredClone(demoResources) });
          break;
        }
        case "hooks.settings":
          demoSettings.hooks = { ...command.hooks };
          demoResources.hooksEnabled = command.hooks.enabled;
          emit({ type: "resources", resources: structuredClone(demoResources) });
          break;
        case "hooks.run":
          emit({ type: "hook-run", name: command.name, scope: command.scope, ok: true, detail: "演示环境不会执行钩子动作", durationMs: 0 });
          break;
      }
    },
    onRuntimeMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onBrowserPreviewState(_tabId: string, listener?: (state: BrowserPreviewState) => void) {
      const l = listener ?? (() => {});
      browserPreviewListeners.add(l);
      return () => browserPreviewListeners.delete(l);
    },
    onBrowserTabsChanged(_listener: (event: BrowserTabsEvent) => void) {
      // 浏览器演示环境没有原生标签页生命周期。
      return () => {};
    },
    onBrowserElementPicked(_listener: (pick: BrowserElementPick) => void) {
      // 浏览器演示环境没有原生页面可点选。
      return () => {};
    },
    onTerminalData(terminalId: string, listener: (event: TerminalEventData) => void) {
      const listeners = terminalListeners.get(terminalId) ?? new Set();
      terminalListeners.set(terminalId, listeners);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) terminalListeners.delete(terminalId);
      };
    }
  };
}
