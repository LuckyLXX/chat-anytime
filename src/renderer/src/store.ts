import { create } from "zustand";
import type {
  DesktopSettings,
  ProviderSettings,
  CustomProviderModel,
  ModelOption,
  PermissionRequest,
  ProviderOption,
  RuntimeMessage,
  RuntimeSnapshot,
  ResourceCatalog
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
  permission?: PermissionRequest;
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
  sessions: []
};
const emptySettings: DesktopSettings = { version: 2, thinkingLevel: "medium", accessMode: "ask", providers: [], agents: [], currentAgentId: "default", appearance: { theme: "system", themePreset: "default", customCss: "", customThemes: [], themeOverrides: { light: {}, dark: {} }, showThinking: true } };
const emptyResources: ResourceCatalog = { skills: [], extensions: [], packages: [], mcpServers: [], mcpAdapterLoaded: false, diagnostics: [] };

export const useDesktopStore = create<DesktopState>((set, get) => ({
  ready: false,
  snapshot: emptySnapshot,
  models: [],
  providers: [],
  resources: emptyResources,
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
        set({ snapshot: message.snapshot });
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
        set({ permission: message.request });
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
