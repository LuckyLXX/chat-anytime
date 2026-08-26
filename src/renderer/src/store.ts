import { create } from "zustand";
import type {
  CustomProviderModel,
  DesktopSettings,
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
  Todo
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

function queuedMessagesEqual(left: RuntimeSnapshot["queuedMessages"], right: RuntimeSnapshot["queuedMessages"]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other && item.kind === other.kind && item.index === other.index && item.text === other.text;
  });
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
   * 焦点切换瞬间的单槽种子：旧激活会话刚变成 parked 格子时，主进程的
   * session.state 水合帧还在路上（watch 补发需要一个 IPC 往返），先用
   * 切换前最后一份完整快照渲染该格子，避免闪“正在载入会话”。真实的
   * session.state 到达后写入 paneStates 接管；下一次切换覆盖本槽。
   */
  parkedSeed?: { sessionId: string; data: SessionPaneSnapshot };
  models: ModelOption[];
  providers: ProviderOption[];
  resources: ResourceCatalog;
  todos: Todo[];
  memory: MemoryTopic[];
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
  error?: string;
  initialize(): Promise<() => void>;
  handleRuntimeMessage(message: RuntimeMessage): void;
  clearError(): void;
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
const emptyResources: ResourceCatalog = { skills: [], mcpServers: [], todos: [], memory: [], hooks: [], hooksEnabled: true, diagnostics: [] };

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
    if (prev && !msg.streaming && prev.streaming === msg.streaming && prev.error === msg.error) return prev;
    changed = true;
    return msg;
  });
  return { messages, changed };
}

export function handleRuntimeMessage(message: RuntimeMessage): void {
  useDesktopStore.getState().handleRuntimeMessage(message);
}

/** 分屏格子移除（关闭/布局裁剪）后丢弃对应的 paneStates 缓存；再次 watch 会重新水合。 */
export function dropPaneStates(sessionIds: string[]): void {
  useDesktopStore.setState((state) => {
    let changed = false;
    const next = { ...state.paneStates };
    for (const id of sessionIds) {
      if (next[id]) {
        delete next[id];
        changed = true;
      }
    }
    return changed ? { paneStates: next } : state;
  });
}

export const useDesktopStore = create<DesktopState>((set, get) => ({
  ready: false,
  snapshot: emptySnapshot,
  paneStates: {},
  models: [],
  providers: [],
  resources: emptyResources,
  todos: [],
  memory: [],
  permissions: [],
  questions: [],
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
          if (!changed && previous.busy === incoming.busy && previous.status === incoming.status &&
              previous.turnTiming === incoming.turnTiming && previous.executions === incoming.executions &&
              previous.sessions === incoming.sessions && previous.recentWorkspaces === incoming.recentWorkspaces &&
              previous.model === incoming.model &&
              previous.sessionId === incoming.sessionId && previous.sessionFile === incoming.sessionFile &&
              queuedMessagesEqual(previous.queuedMessages, incoming.queuedMessages) &&
              previous.thinkingLevel === incoming.thinkingLevel) {
            // Nothing changed at all — keep the exact same snapshot reference
            // so downstream useMemo/useEffect dependency checks stay no-ops.
            return state;
          }
          // 焦点切换种子：旧激活会话的完整数据就在手上，同步转入 parkedSeed，
          // 它若是一个分屏格子则立刻有内容可渲染（水合帧随后接管）。
          const parkedSeed = previous.sessionId && previous.sessionId !== incoming.sessionId
            ? { sessionId: previous.sessionId, data: previous satisfies SessionPaneSnapshot }
            : state.parkedSeed;
          return { snapshot: { ...incoming, messages: mergedMessages }, parkedSeed };
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
            if (!changed && previous.busy === incoming.busy && previous.status === incoming.status &&
                previous.turnTiming === incoming.turnTiming && previous.executions === incoming.executions &&
                previous.model === incoming.model && previous.workspace === incoming.workspace &&
                queuedMessagesEqual(previous.queuedMessages, incoming.queuedMessages) &&
                previous.thinkingLevel === incoming.thinkingLevel && previous.planMode === incoming.planMode &&
                previous.contextUsage === incoming.contextUsage) {
              return state;
            }
            return { paneStates: { ...state.paneStates, [sessionId]: { ...incoming, messages: mergedMessages } } };
          }
          return { paneStates: { ...state.paneStates, [sessionId]: incoming } };
        });
        break;
      case "resources":
        set({ resources: message.resources });
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
  }
}));
