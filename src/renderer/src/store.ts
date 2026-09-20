import { create } from "zustand";
import type {
  AutomationRunRecord,
  AutomationTask,
  ChatMessage,
  CheckpointRollbackResult,
  CustomProviderModel,
  DesignCanvasInfo,
  DesignDocSummary,
  DesignNode,
  DesktopSettings,
  GalleryApp,
  MemoryTopic,
  ModelOption,
  PermissionRequest,
  ProviderOption,
  ProviderSettings,
  QuestionRequest,
  ResourceCatalog,
  RuntimeMessage,
  RuntimeSnapshot,
  SessionPaneSnapshot,
  Todo,
  ToolExecution,
  UsageStats
} from "../../shared/protocol";

/** 面板“测试”按钮最近一次钩子试跑的结果（hooks.run → hook-run 推送）。 */
export interface HookRunResult {
  name: string;
  scope: "project" | "global";
  ok: boolean;
  blocked?: boolean;
  detail: string;
  durationMs: number;
  at: number;
}

/** 最近一次 checkpoint 回滚结果（checkpoint-result 推送）；App 据此 toast + 刷新工作区树。 */
export interface CheckpointResultInfo {
  sessionId: string;
  results: CheckpointRollbackResult[];
  message?: string;
  at: number;
}

/** 最近一次自动化任务运行结果（automation-run 推送）；App 据此 toast。running=开始（置顶运行中条目），ok/error/aborted=终态。 */
export interface AutomationRunInfo {
  id: string;
  status: "ok" | "error" | "aborted" | "running";
  taskName?: string;
  /** 终态推送携带的运行记录 id（toast「查看结果」直达寻址）。 */
  runId?: string;
  message?: string;
  at: number;
}

/** 当前激活会话绑定的设计文档（design.state 推送的全量投影；画布组件据此渲染）。 */
export interface DesignDocState {
  docId: string;
  name: string;
  canvas: DesignCanvasInfo;
  nodes: DesignNode[];
  revision: number;
  dirty: boolean;
}

/** 设计导出完成（design.exported 推送）；App 据此 toast。 */
export interface DesignExportedInfo {
  relativePath: string;
  at: number;
}

function queuedMessagesEqual(left: RuntimeSnapshot["queuedMessages"], right: RuntimeSnapshot["queuedMessages"]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other && item.kind === other.kind && item.index === other.index && item.text === other.text && item.imageCount === other.imageCount;
  });
}

/**
 * delegation 进度的轻量指纹：步骤变化（长度/末步状态/label）都会改变签名。
 * 当前 delegation 与 output（tracker.logText）同源，output 已驱动数组替换；
 * 这里做防御性比较，防止未来 output 与进度解耦后委托步骤视图陈旧。
 */
function delegationSignature(delegation: ToolExecution["delegation"] | undefined): string {
  if (!delegation) return "";
  const last = delegation.steps.at(-1);
  return `${delegation.childSessionId}:${delegation.steps.length}:${last?.status ?? ""}:${last?.label ?? ""}`;
}

/**
 * 单条 execution 的内容等价判定：快照合并逐项保留身份的比较依据。
 * args 在 tool_execution_start 后内容恒定，不参与比较（深度比较大且无必要）；
 * output 已由主进程截断到 60K，字符串比较有界。changedFiles 逐项比 relativePath
 * （artifact backfill 异步回填时列表会变化，需据此判定为新对象）。
 */
function executionIdentityEqual(item: ToolExecution, other: ToolExecution): boolean {
  if (item.id !== other.id || item.name !== other.name || item.status !== other.status
    || item.startedAt !== other.startedAt || item.completedAt !== other.completedAt
    || item.output !== other.output || item.patch !== other.patch
    || item.changedFile?.relativePath !== other.changedFile?.relativePath) return false;
  if (item.delegation !== other.delegation && delegationSignature(item.delegation) !== delegationSignature(other.delegation)) return false;
  const leftFiles = item.changedFiles ?? [];
  const rightFiles = other.changedFiles ?? [];
  return leftFiles.length === rightFiles.length && leftFiles.every((file, fileIndex) => file.relativePath === rightFiles[fileIndex]?.relativePath);
}

/**
 * 快照合并的 executions 身份保留（逐项）：主进程每帧 spread 出新数组且经结构化
 * 克隆，若直接透传，订阅 executions 的选择器与 memo 化气泡在流式期间会每帧全量
 * 重渲染。这里逐项比较：内容未变的 execution 复用上一帧的对象身份，仅变化的项
 * （通常是正在流式输出 output 的那一条）取新引用；全部未变时返回原数组，命中
 * “无变化早退”。这样历史气泡引用的已完成 execution 身份跨帧稳定，配合按消息
 * 派生的执行子集，MessageView 的 memo 才能在流式期间真正跳过历史气泡。
 * 长度变化（新增/移除 execution）是低频事件，直接取 incoming。
 */
function mergeExecutionsPreservingIdentity(previous: RuntimeSnapshot["executions"], incoming: RuntimeSnapshot["executions"]): RuntimeSnapshot["executions"] {
  if (previous === incoming) return previous;
  if (previous.length !== incoming.length) return incoming;
  let changed = false;
  const merged = incoming.map((item, index) => {
    const prev = previous[index];
    if (prev && executionIdentityEqual(prev, item)) return prev;
    changed = true;
    return item;
  });
  return changed ? merged : previous;
}

/**
 * sessions 列表的身份保留：utility 进程经结构化克隆推送，每帧的 sessions 都是
 * 新数组引用；直接透传会让订阅它的选择器（侧栏分组、分屏校验）在流式期间每帧
 * 触发。SessionSummary 全部是原始值字段，逐项浅比较即可。
 */
function mergeSessionsPreservingIdentity(previous: RuntimeSnapshot["sessions"], incoming: RuntimeSnapshot["sessions"]): RuntimeSnapshot["sessions"] {
  if (previous === incoming) return previous;
  if (previous.length !== incoming.length) return incoming;
  const equal = previous.every((item, index) => {
    const other = incoming[index];
    return other !== undefined && item.id === other.id && item.path === other.path && item.workspace === other.workspace
      && item.title === other.title && item.modifiedAt === other.modifiedAt && item.messageCount === other.messageCount
      && item.pinned === other.pinned && item.runStatus === other.runStatus;
  });
  return equal ? previous : incoming;
}

/** recentWorkspaces 的身份保留：与 sessions 同理，字段全为原始值。 */
function mergeRecentWorkspacesPreservingIdentity(previous: RuntimeSnapshot["recentWorkspaces"], incoming: RuntimeSnapshot["recentWorkspaces"]): RuntimeSnapshot["recentWorkspaces"] {
  if (previous === incoming) return previous;
  if (previous.length !== incoming.length) return incoming;
  const equal = previous.every((item, index) => {
    const other = incoming[index];
    return other !== undefined && item.path === other.path && item.openedAt === other.openedAt;
  });
  return equal ? previous : incoming;
}

/**
 * 当前激活会话应展示的权限请求。store 的 permissions 是跨会话累积的全局数组，
 * 若不做会话过滤，切换到新会话时仍会取出上一个（后台/parked）会话待决的权限弹窗。
 * 这里按请求携带的 principal.sessionId 匹配 snapshot.sessionId；非激活会话的请求
 * 保留在数组里（等切回对应会话时再浮出），仅不向当前视图冒泡。
 */
export function currentPermissionRequest(permissions: PermissionRequest[], sessionId: string | undefined): PermissionRequest | undefined {
  if (!sessionId) return undefined;
  return permissions.find((request) => request.principal.sessionId === sessionId);
}

/** 当前激活会话应展示的提问（ask_question）请求；与非激活会话的权限弹窗同理做会话过滤。 */
export function currentQuestionRequest(questions: QuestionRequest[], sessionId: string | undefined): QuestionRequest | undefined {
  if (!sessionId) return undefined;
  return questions.find((request) => request.sessionId === sessionId);
}

/**
 * 分屏格子集合应展示的权限请求：焦点格（激活会话）优先，其余按格子顺序取
 * 第一个命中的——多个格子同时待决时一次只弹一个，处理完自动轮到下一个。
 * 单窗口调用方传 [activeSessionId]，行为与 currentPermissionRequest 一致。
 */
export function panePermissionRequest(permissions: PermissionRequest[], sessionIds: string[]): PermissionRequest | undefined {
  for (const sessionId of sessionIds) {
    const found = currentPermissionRequest(permissions, sessionId);
    if (found) return found;
  }
  return undefined;
}

/** 分屏格子集合应展示的提问请求；与 panePermissionRequest 同理，焦点格优先。 */
export function paneQuestionRequest(questions: QuestionRequest[], sessionIds: string[]): QuestionRequest | undefined {
  for (const sessionId of sessionIds) {
    const found = currentQuestionRequest(questions, sessionId);
    if (found) return found;
  }
  return undefined;
}

interface DesktopState {
  ready: boolean;
  snapshot: RuntimeSnapshot;
  /** 分屏格子（watched 非激活会话）的会话级快照，按 sessionId 键控。 */
  paneStates: Record<string, SessionPaneSnapshot>;
  /**
   * 焦点切换留档的多槽缓存：旧激活会话刚变成 parked 格子时，主进程的
   * session.state 水合帧还在路上（watch 补发需要一个 IPC 往返），先用切换
   * 前最后一份完整快照渲染该格子，避免闪“正在载入会话”。真实的
   * session.state 到达后写入 paneStates 接管。
   * 用多槽而非单槽：三分屏下焦点在多个格子间切换，非“上一任”的格子也必须
   * 兜得住，否则会一直被误渲染成“正在载入会话”（parkedSeed 旧实现只保
   * 上一次被切走的格子，多格场景必然有格子漏兜）。key = sessionId，值 = 最近
   * 一次完整快照；格子数上限 MAX_SPLIT_PANES(=4)，内存恒定有界，格子移除
   * 时随 dropPaneStates 一并清理。
   */
  parkedPanels: Record<string, SessionPaneSnapshot>;
  models: ModelOption[];
  providers: ProviderOption[];
  resources: ResourceCatalog;
  todos: Todo[];
  memory: MemoryTopic[];
  /** 全部角色的自动化定时任务列表（automation 推送/目录下发维护，设置页按角色分组）。 */
  automation: AutomationTask[];
  /** 全角色自动化运行历史（automation-runs 推送全量替换；设置页「运行记录」子页）。 */
  automationRuns: AutomationRunRecord[];
  /** 最近一次自动化任务运行结果；App 监听变化弹 toast。 */
  automationRun?: AutomationRunInfo;
  /** toast「查看结果」直达信号：AutomationSettings 监听后切「运行记录」子页并高亮该条。 */
  automationRunsSignal?: { runId: string; at: number };
  settings: DesktopSettings;
  customProvider?: ProviderSettings;
  customProviderKeyConfigured: boolean;
  customModels: CustomProviderModel[];
  customModelFetchStatus: "idle" | "loading" | "success" | "error";
  customModelFetchError?: string;
  modelRefreshStatus: "idle" | "loading" | "success" | "error";
  modelRefreshError?: string;
  modelRefreshProvider?: string;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  /** 最近一次钩子测试结果；面板按 name+scope 匹配展示。 */
  hookRun?: HookRunResult;
  /** 最近一次 checkpoint 回滚结果；App 监听变化弹 toast 并刷新工作区树。 */
  checkpointResult?: CheckpointResultInfo;
  /** 当前激活会话绑定的设计文档（design.state 推送；未绑定=undefined）。 */
  designDoc?: DesignDocState;
  /** 工作区设计文档列表（design.docs 推送全量替换）。 */
  designDocs: DesignDocSummary[];
  /** 作品清单（gallery.apps 推送全量替换）；全局跨工作区，启动时由 initialize 推一次。 */
  galleryApps: GalleryApp[];
  /** 每文档已见推送 revision：≤ 该值的重复/乱序推送直接跳过（防回环重渲）。 */
  seenDesignRevisions: Record<string, number>;
  /** 最近一次设计导出结果；App 监听变化弹 toast。 */
  designExported?: DesignExportedInfo;
  /** 最近一次作品发布结果（gallery.notice 推送）；App 监听变化弹 toast（含缩略图降级说明）。 */
  galleryNotice?: { kind: "ok" | "warn"; message: string; at: number };
  /** 用量统计（设置页「用量统计」tab，按需拉取）；undefined=尚未请求。 */
  usageStats?: UsageStats;
  /** 用量统计请求中（面板显示载入态）。 */
  usageStatsLoading: boolean;
  /**
   * 已回滚标记：key = `${sessionId}:${toolCallId}`，值 = 回滚动作。产物行内
   * 任一调用 id 命中即显示「已回滚/已删除」徽标（新回复的新调用 id 不受影响）。
   * 内存态：应用重启后消失，重复回滚无害（幂等恢复同一内容）。
   */
  rollbacks: Record<string, "restored" | "deleted">;
  /** 子代理完整记录缓存：childSessionId → ChatMessage[]（响应 subagent.transcript）。 */
  transcripts: Record<string, ChatMessage[]>;
  /** 子代理完整记录读取失败：childSessionId → 错误文案。 */
  transcriptErrors: Record<string, string>;
  error?: string;
  initialize(): Promise<() => void>;
  handleRuntimeMessage(message: RuntimeMessage): void;
  clearError(): void;
  requestUsageStats(agentId?: string): void;
}

const emptySnapshot: RuntimeSnapshot = {
  agentId: "default",
  agentName: "默认助手",
  thinkingLevel: "medium",
  busy: false,
  status: "正在启动 Pi 运行时",
  messages: [],
  executions: [],
  backgroundProcesses: [],
  sessions: [],
  recentWorkspaces: [],
  queuedMessages: []
};
const emptySettings: DesktopSettings = { version: 2, thinkingLevel: "medium", accessMode: "ask", providers: [], agents: [], currentAgentId: "default", appearance: { theme: "system", themePreset: "default", customCss: "", customThemes: [], showThinking: true } };
const emptyResources: ResourceCatalog = { skills: [], commands: [], mcpServers: [], todos: [], memory: [], subagents: [], hooks: [], hooksEnabled: true, automation: [], automationRuns: [], gallery: [], diagnostics: [] };

/**
 * 高频流式推送的消息数组按 uuid 复用旧对象引用：内容未变的消息保持同一
 * ChatMessage 引用，让 memo 化的气泡在只影响别的气泡的流式更新中跳过重渲染。
 */
function mergeMessagesPreservingIdentity(previous: RuntimeSnapshot["messages"], incoming: RuntimeSnapshot["messages"]): { messages: RuntimeSnapshot["messages"]; changed: boolean } {
  const prevByUuid = new Map(previous.map((msg) => [msg.uuid, msg]));
  let changed = previous.length !== incoming.length;
  const messages = incoming.map((msg) => {
    const prev = msg.uuid !== undefined ? prevByUuid.get(msg.uuid) : undefined;
    // Skip streaming messages when reusing the identity: a streaming
    // bubble keeps the same uuid while its content grows token by
    // token, so we must take the fresh reference to render new tokens.
    // aborted 与 error 一样参与判定：中止帧若沿用旧引用，中性提示就永不出场。
    if (prev && !msg.streaming && prev.streaming === msg.streaming && prev.error === msg.error && prev.aborted === msg.aborted) return prev;
    changed = true;
    return msg;
  });
  return { messages, changed };
}

export function handleRuntimeMessage(message: RuntimeMessage): void {
  useDesktopStore.getState().handleRuntimeMessage(message);
}

/** 分屏格子移除（关闭/布局裁剪）后丢弃对应的 paneStates 与 parkedPanels 缓存；再次 watch 会重新水合。 */
export function dropPaneStates(sessionIds: string[]): void {
  useDesktopStore.setState((state) => {
    let changed = false;
    const next = { ...state.paneStates };
    const nextParked = { ...state.parkedPanels };
    for (const id of sessionIds) {
      if (next[id]) {
        delete next[id];
        changed = true;
      }
      if (nextParked[id]) {
        delete nextParked[id];
        changed = true;
      }
    }
    return changed ? { paneStates: next, parkedPanels: nextParked } : state;
  });
}

/**
 * 修剪 parkedPanels 留档：state 通道在每次焦点切换时无条件写入旧会话的完整
 * 快照（防分屏格子闪烁），但单窗口模式下切过的会话永远不会再被读取——没有
 * 这道修剪，切 N 个话题就永久保留 N 份完整消息数组（含 base64 图片）。
 * 由 App 的 watch 同步 effect 在格子集合稳定后调用，keep = 当前格子集合。
 */
export function pruneParkedPanels(keepIds: ReadonlySet<string>): void {
  useDesktopStore.setState((state) => {
    const stale = Object.keys(state.parkedPanels).filter((id) => !keepIds.has(id));
    if (stale.length === 0) return state;
    const nextParked = { ...state.parkedPanels };
    for (const id of stale) delete nextParked[id];
    return { parkedPanels: nextParked };
  });
}

export const useDesktopStore = create<DesktopState>((set, get) => ({
  ready: false,
  snapshot: emptySnapshot,
  paneStates: {},
  parkedPanels: {},
  models: [],
  providers: [],
  resources: emptyResources,
  todos: [],
  memory: [],
  automation: [],
  automationRuns: [],
  permissions: [],
  questions: [],
  rollbacks: {},
  transcripts: {},
  transcriptErrors: {},
  designDocs: [],
  galleryApps: [],
  seenDesignRevisions: {},
  usageStatsLoading: false,
  settings: emptySettings,
  customProviderKeyConfigured: false,
  customModels: [],
  customModelFetchStatus: "idle",
  modelRefreshStatus: "idle",
  async initialize() {
    const unsubscribe = window.piDesktop.onRuntimeMessage((message) => get().handleRuntimeMessage(message));
    const bootstrap = await window.piDesktop.bootstrap();
    set({
      ready: true,
      error: bootstrap.securityWarning,
      settings: bootstrap.settings,
      snapshot: bootstrap.runtime ?? get().snapshot,
      models: bootstrap.catalog?.models ?? [],
      providers: bootstrap.catalog?.providers ?? [],
      resources: bootstrap.resources ?? get().resources,
      todos: bootstrap.resources?.todos ?? get().todos,
      memory: bootstrap.resources?.memory ?? get().memory,
      automation: bootstrap.resources?.automation ?? [],
      automationRuns: bootstrap.resources?.automationRuns ?? [],
      // 作品清单必须从 bootstrap 水合一帧：utility 的启动推送早于本订阅（main 先
      // fork runtime 再建窗口），只靠推送则冷启动后作品墙一直空到下一次变更。
      galleryApps: bootstrap.resources?.gallery ?? get().galleryApps,
      customProvider: bootstrap.settings.providers.find((provider) => provider.id === "chatanytime-openai-compatible"),
      customProviderKeyConfigured: Boolean(bootstrap.settings.providers.find((provider) => provider.id === "chatanytime-openai-compatible")?.keyConfigured),
      customModels: bootstrap.settings.providers.find((provider) => provider.id === "chatanytime-openai-compatible")?.models ?? []
    });
    return unsubscribe;
  },
  handleRuntimeMessage(message) {
    switch (message.type) {
      case "state":
        set((state) => {
          const incoming = message.snapshot;
          const previous = state.snapshot;
          const { messages: mergedMessages, changed } = mergeMessagesPreservingIdentity(previous.messages, incoming.messages);
          const mergedExecutions = mergeExecutionsPreservingIdentity(previous.executions, incoming.executions);
          // sessions/recentWorkspaces 经结构化克隆每帧都是新引用，必须走内容
          // 比较的身份保留合并，否则“无变化早退”永远不命中、订阅方每帧重渲染。
          const mergedSessions = mergeSessionsPreservingIdentity(previous.sessions, incoming.sessions);
          const mergedRecentWorkspaces = mergeRecentWorkspacesPreservingIdentity(previous.recentWorkspaces, incoming.recentWorkspaces);
          // 会话级布尔标志（计划模式/设计模式）必须入比较：两者都可能整帧只有自己
          // 变化（其余字段与上帧恒等，如 model/speedStats 同为 undefined 时），漏比
          // 会让本次切换被早退吐掉——画布/计划横幅不响应。
          if (!changed && previous.busy === incoming.busy && previous.status === incoming.status &&
              previous.turnTiming === incoming.turnTiming && previous.executions === mergedExecutions &&
              previous.sessions === mergedSessions && previous.recentWorkspaces === mergedRecentWorkspaces &&
              previous.model === incoming.model &&
              previous.planMode === incoming.planMode && previous.computerMode === incoming.computerMode && previous.designMode === incoming.designMode &&
              previous.sessionId === incoming.sessionId && previous.sessionFile === incoming.sessionFile &&
              queuedMessagesEqual(previous.queuedMessages, incoming.queuedMessages) &&
              previous.thinkingLevel === incoming.thinkingLevel) {
            // Nothing changed at all — keep the exact same snapshot reference
            // so downstream useMemo/useEffect dependency checks stay no-ops.
            return state;
          }
          // 焦点切换留档：旧激活会话的完整数据就在手上，写入 parkedPanels[旧格]，
          // 它若是分屏格子则立刻有内容可渲染（水合帧随后写入 paneStates 接管）。
          // 多槽而非单槽：三分屏焦点在多格间切换时，非“上一任”的格子也有数据可
          // 兜住，不会误显示“正在载入会话”。
          const parkedPanels = previous.sessionId && previous.sessionId !== incoming.sessionId
            ? { ...state.parkedPanels, [previous.sessionId]: previous satisfies SessionPaneSnapshot }
            : state.parkedPanels;
          return { snapshot: { ...incoming, messages: mergedMessages, executions: mergedExecutions, sessions: mergedSessions, recentWorkspaces: mergedRecentWorkspaces }, parkedPanels };
        });
        break;
      case "session.state":
        set((state) => {
          const incoming = message.snapshot;
          const sessionId = incoming.sessionId;
          // 激活会话的更新走 state 通道：这里只接收分屏格子（parked）的快照；
          // 会话在格子间切换焦点的瞬间可能收到迟到的 session.state，直接跳过
          // （下一帧 state 快照已携带最新内容）。
          if (!sessionId || sessionId === state.snapshot.sessionId) return state;
          const previous = state.paneStates[sessionId];
          if (previous) {
            const { messages: mergedMessages, changed } = mergeMessagesPreservingIdentity(previous.messages, incoming.messages);
            const mergedExecutions = mergeExecutionsPreservingIdentity(previous.executions, incoming.executions);
            if (!changed && previous.busy === incoming.busy && previous.status === incoming.status &&
                previous.turnTiming === incoming.turnTiming && previous.executions === mergedExecutions &&
                previous.model === incoming.model && previous.workspace === incoming.workspace &&
                queuedMessagesEqual(previous.queuedMessages, incoming.queuedMessages) &&
                previous.thinkingLevel === incoming.thinkingLevel && previous.planMode === incoming.planMode &&
                previous.computerMode === incoming.computerMode &&
                previous.designMode === incoming.designMode &&
                previous.contextUsage === incoming.contextUsage) {
              return state;
            }
            return { paneStates: { ...state.paneStates, [sessionId]: { ...incoming, messages: mergedMessages, executions: mergedExecutions } } };
          }
          return { paneStates: { ...state.paneStates, [sessionId]: incoming } };
        });
        break;
      case "resources":
        set({ resources: message.resources });
        break;
      case "automation":
        set({ automation: message.tasks });
        break;
      case "automation-runs":
        set({ automationRuns: message.runs });
        break;
      case "automation-run":
        set({ automationRun: { id: message.id, status: message.status, taskName: message.taskName, runId: message.runId, message: message.message, at: Date.now() } });
        break;
      case "todos":
        set({ todos: message.todos });
        break;
      case "memory":
        set({ memory: message.memory });
        break;
      case "catalog":
        set({ models: message.models, providers: message.providers });
        break;
      case "custom-models":
        set((state) => {
          const providers = state.settings.providers.map((provider) => provider.id === message.providerId ? { ...provider, models: message.models } : provider);
          return {
            customModels: message.models,
            customModelFetchStatus: "success",
            customModelFetchError: undefined,
            customProvider: providers.find((provider) => provider.id === message.providerId),
            settings: { ...state.settings, providers }
          };
        });
        break;
      case "custom-model-error":
        set({ customModelFetchStatus: "error", customModelFetchError: message.message });
        break;
      case "models-refreshed":
        set({ modelRefreshStatus: "success", modelRefreshError: undefined, modelRefreshProvider: message.providerId });
        break;
      case "models-refresh-error":
        set({ modelRefreshStatus: "error", modelRefreshError: message.message, modelRefreshProvider: message.providerId });
        break;
      case "permission":
        set((state) => state.permissions.some((request) => request.id === message.request.id)
          ? state
          : { permissions: [...state.permissions, message.request] });
        break;
      case "permission.dismiss":
        set((state) => ({ permissions: state.permissions.filter((request) => request.id !== message.id) }));
        break;
      case "question":
        set((state) => state.questions.some((request) => request.id === message.request.id)
          ? state
          : { questions: [...state.questions, message.request] });
        break;
      case "question.dismiss":
        set((state) => ({ questions: state.questions.filter((request) => request.id !== message.id) }));
        break;
      case "hook-run":
        set({
          hookRun: {
            name: message.name,
            scope: message.scope,
            ok: message.ok,
            blocked: message.blocked,
            detail: message.detail,
            durationMs: message.durationMs,
            at: Date.now()
          }
        });
        break;
      case "checkpoint-result":
        set((state) => {
          const rollbacks = { ...state.rollbacks };
          for (const result of message.results) {
            if (result.action === "skipped") continue;
            for (const toolCallId of result.toolCallIds ?? []) {
              rollbacks[`${message.sessionId}:${toolCallId}`] = result.action;
            }
          }
          return {
            rollbacks,
            checkpointResult: { sessionId: message.sessionId, results: message.results, message: message.message, at: Date.now() }
          };
        });
        break;
      case "subagent.transcript-result":
        set((state) => ({ transcripts: { ...state.transcripts, [message.childSessionId]: message.messages } }));
        break;
      case "subagent.transcript-error":
        set((state) => ({ transcriptErrors: { ...state.transcriptErrors, [message.childSessionId]: message.message } }));
        break;
      case "design.state":
        set((state) => {
          // 画布只跟激活会话：后台/驻留会话的 design_* 推送不顶掉当前画布。
          if (message.sessionId !== state.snapshot.sessionId) return state;
          if (!message.docId) return { designDoc: undefined };
          const seen = state.seenDesignRevisions[message.docId] ?? 0;
          if (message.revision <= seen) return state;
          return {
            designDoc: {
              docId: message.docId,
              name: message.name ?? "",
              canvas: message.canvas ?? { width: 1440, height: 1024 },
              nodes: message.nodes ?? [],
              revision: message.revision,
              dirty: message.dirty ?? false
            },
            seenDesignRevisions: { ...state.seenDesignRevisions, [message.docId]: message.revision }
          };
        });
        break;
      case "design.docs":
        set({ designDocs: message.docs });
        break;
      case "gallery.apps":
        // 全量替换（清单在主进程；渲染端只做投影）。
        set({ galleryApps: message.apps });
        break;
      case "gallery.notice":
        set({ galleryNotice: { kind: message.kind, message: message.message, at: Date.now() } });
        break;
      case "design.exported":
        set({ designExported: { relativePath: message.relativePath, at: Date.now() } });
        break;
      case "usage-stats-result":
        set({ usageStats: message.stats, usageStatsLoading: false });
        break;
      case "error":
        set({ error: message.message });
        break;
      case "log":
        if (message.level === "warn") console.warn(message.message);
        break;
    }
  },
  clearError() {
    set({ error: undefined });
  },
  /** 拉取用量统计（设置页「用量统计」tab 进入/切筛选时调）；重复点击防抖由 loading 门闸承担。 */
  requestUsageStats(agentId?: string) {
    if (get().usageStatsLoading) return;
    set({ usageStatsLoading: true });
    void window.piDesktop.send({ type: "usage.stats.request", ...(agentId ? { agentId } : {}) });
  }
}));
