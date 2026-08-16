import { create } from "zustand";
import type {
  CustomProviderModel,
  DesktopSettings,
  ModelOption,
  PermissionRequest,
  ProviderOption,
  ProviderSettings,
  ResourceCatalog,
  RuntimeMessage,
  RuntimeSnapshot,
  Todo
} from "../../shared/protocol";

interface DesktopState {
  ready: boolean;
  snapshot: RuntimeSnapshot;
  models: ModelOption[];
  providers: ProviderOption[];
  resources: ResourceCatalog;
  todos: Todo[];
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
  recentWorkspaces: []
};
const emptySettings: DesktopSettings = { version: 2, thinkingLevel: "medium", accessMode: "ask", providers: [], agents: [], currentAgentId: "default", appearance: { theme: "system", themePreset: "default", customCss: "", customThemes: [], showThinking: true } };
const emptyResources: ResourceCatalog = { skills: [], mcpServers: [], todos: [], diagnostics: [] };

export const useDesktopStore = create<DesktopState>((set, get) => ({
  ready: false,
  snapshot: emptySnapshot,
  models: [],
  providers: [],
  resources: emptyResources,
  todos: [],
  permissions: [],
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
          // Preserve object identity for unchanged messages: match by uuid
          // (stable across streaming/final frames) and reuse the previous
          // ChatMessage reference when no lifecycle field changed. This lets
          // memoized list items skip re-rendering during high-frequency
          // streaming updates that only touch other bubbles.
          const prevByUuid = new Map(previous.messages.map((msg) => [msg.uuid, msg]));
          let changed = previous.messages.length !== incoming.messages.length;
          const mergedMessages = incoming.messages.map((msg) => {
            const prev = msg.uuid !== undefined ? prevByUuid.get(msg.uuid) : undefined;
            // Skip streaming messages when reusing the identity: a streaming
            // bubble keeps the same uuid while its content grows token by
            // token, so we must take the fresh reference to render new tokens.
            if (prev && !msg.streaming && prev.streaming === msg.streaming && prev.error === msg.error) return prev;
            changed = true;
            return msg;
          });
          if (!changed && previous.busy === incoming.busy && previous.status === incoming.status &&
              previous.turnTiming === incoming.turnTiming && previous.executions === incoming.executions &&
              previous.sessions === incoming.sessions && previous.recentWorkspaces === incoming.recentWorkspaces &&
              previous.model === incoming.model &&
              previous.sessionId === incoming.sessionId && previous.sessionFile === incoming.sessionFile &&
              previous.thinkingLevel === incoming.thinkingLevel) {
            // Nothing changed at all — keep the exact same snapshot reference
            // so downstream useMemo/useEffect dependency checks stay no-ops.
            return state;
          }
          return { snapshot: { ...incoming, messages: mergedMessages } };
        });
        break;
      case "resources":
        set({ resources: message.resources });
        break;
      case "todos":
        set({ todos: message.todos });
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
