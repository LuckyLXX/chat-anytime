import { create } from "zustand";
import type {
  CustomProviderModel,
  DesktopSettings,
  ExtensionComposerRequest,
  ExtensionUiDialogRequest,
  ModelOption,
  PermissionRequest,
  PackageProgress,
  ProviderOption,
  ProviderSettings,
  ResourceCatalog,
  RuntimeMessage,
  RuntimeSnapshot
} from "../../shared/protocol";

interface DesktopState {
  ready: boolean;
  snapshot: RuntimeSnapshot;
  models: ModelOption[];
  providers: ProviderOption[];
  resources: ResourceCatalog;
  settings: DesktopSettings;
  customProvider?: ProviderSettings;
  customProviderKeyConfigured: boolean;
  customModels: CustomProviderModel[];
  customModelFetchStatus: "idle" | "loading" | "success" | "error";
  customModelFetchError?: string;
  permissions: PermissionRequest[];
  extensionUiDialogs: ExtensionUiDialogRequest[];
  extensionComposerRequests: ExtensionComposerRequest[];
  extensionNotice?: { message: string; level: "info" | "warning" | "error" };
  packageProgress?: PackageProgress;
  error?: string;
  initialize(): Promise<() => void>;
  handleRuntimeMessage(message: RuntimeMessage): void;
  clearError(): void;
  clearExtensionNotice(): void;
}

const emptySnapshot: RuntimeSnapshot = {
  agentId: "default",
  agentName: "默认助手",
  thinkingLevel: "medium",
  busy: false,
  status: "正在启动 Pi 运行时",
  messages: [],
  executions: [],
  sessions: [],
  extensionCommands: [],
  extensionUi: { statuses: {}, widgets: [], workingVisible: true, unsupported: [] }
};
const emptySettings: DesktopSettings = { version: 2, thinkingLevel: "medium", accessMode: "ask", providers: [], agents: [], currentAgentId: "default", appearance: { theme: "system", themePreset: "default", customCss: "", customThemes: [], themeOverrides: { light: {}, dark: {} }, showThinking: true } };
const emptyResources: ResourceCatalog = { skills: [], extensions: [], packages: [], mcpServers: [], mcpAdapterLoaded: false, diagnostics: [] };

export const useDesktopStore = create<DesktopState>((set, get) => ({
  ready: false,
  snapshot: emptySnapshot,
  models: [],
  providers: [],
  resources: emptyResources,
  permissions: [],
  extensionUiDialogs: [],
  extensionComposerRequests: [],
  settings: emptySettings,
  customProviderKeyConfigured: false,
  customModels: [],
  customModelFetchStatus: "idle",
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
              previous.sessions === incoming.sessions && previous.model === incoming.model &&
              previous.sessionId === incoming.sessionId && previous.sessionFile === incoming.sessionFile &&
              previous.thinkingLevel === incoming.thinkingLevel && previous.extensionCommands === incoming.extensionCommands &&
              previous.extensionUi === incoming.extensionUi) {
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
      case "permission":
        set((state) => state.permissions.some((request) => request.id === message.request.id)
          ? state
          : { permissions: [...state.permissions, message.request] });
        break;
      case "permission.dismiss":
        set((state) => ({ permissions: state.permissions.filter((request) => request.id !== message.id) }));
        break;
      case "extension-ui.request":
        set((state) => state.extensionUiDialogs.some((request) => request.id === message.request.id)
          ? state
          : { extensionUiDialogs: [...state.extensionUiDialogs, message.request] });
        break;
      case "extension-ui.dismiss":
        set((state) => ({ extensionUiDialogs: state.extensionUiDialogs.filter((request) => request.id !== message.id) }));
        break;
      case "extension-ui.notify":
        set({ extensionNotice: { message: message.message, level: message.level } });
        break;
      case "extension-ui.composer":
        set((state) => state.extensionComposerRequests.some((request) => request.id === message.request.id)
          ? state
          : { extensionComposerRequests: [...state.extensionComposerRequests, message.request] });
        break;
      case "package-progress":
        set({ packageProgress: message.progress });
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
  clearExtensionNotice() {
    set({ extensionNotice: undefined });
  }
}));
