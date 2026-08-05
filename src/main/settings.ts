import { THEME_PRESET_IDS } from "../shared/protocol.js";
import type {
  AgentProfile,
  AppearanceSettings,
  BuiltinToolName,
  DesktopSettings,
  ProviderModelSettings,
  ProviderSettings,
  ThemePresetId,
  ThinkingLevel
} from "../shared/protocol.js";

export const BUILTIN_TOOLS: BuiltinToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const DEFAULT_AGENT_ID = "default";
export const CUSTOM_PROVIDER_ID = "chatanytime-openai-compatible";

export function defaultTools(): Record<BuiltinToolName, boolean> {
  return Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool, true])) as Record<BuiltinToolName, boolean>;
}

export function createDefaultAgent(): AgentProfile {
  return {
    id: DEFAULT_AGENT_ID,
    name: "默认助手",
    description: "使用 Pi 工具协助完成项目开发任务",
    systemPrompt: "你是 ChatAnyTime 的默认开发助手。请先理解项目结构，再谨慎地检查、修改和验证代码。",
    defaultThinkingLevel: "medium",
    tools: defaultTools()
  };
}

export function defaultAppearance(): AppearanceSettings {
  return { theme: "system", themePreset: "default", customCss: "", showThinking: true };
}

export function normalizeAgent(agent: Partial<AgentProfile> | undefined): AgentProfile {
  const fallback = createDefaultAgent();
  const sourceTools = (agent?.tools ?? {}) as Partial<Record<BuiltinToolName, boolean>>;
  return {
    id: String(agent?.id || fallback.id),
    name: String(agent?.name || fallback.name),
    description: String(agent?.description ?? ""),
    systemPrompt: String(agent?.systemPrompt ?? (agent?.id === DEFAULT_AGENT_ID ? fallback.systemPrompt : "")),
    defaultModel: agent?.defaultModel,
    defaultThinkingLevel: agent?.defaultThinkingLevel ?? fallback.defaultThinkingLevel,
    tools: Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool, sourceTools[tool] !== false])) as Record<BuiltinToolName, boolean>,
    archived: Boolean(agent?.archived)
  };
}

export function normalizeProvider(provider: Partial<ProviderSettings>): ProviderSettings {
  const models = Array.isArray(provider.models)
    ? provider.models
      .filter((model) => model && typeof model.id === "string" && model.id.trim())
      .map((model) => ({ id: model.id.trim(), name: String(model.name || model.id).trim() || model.id.trim(), imageInput: model.imageInput, enabled: model.enabled !== false }))
    : [];
  return {
    id: String(provider.id || CUSTOM_PROVIDER_ID),
    name: String(provider.name || "自定义 OpenAI 服务"),
    baseUrl: String(provider.baseUrl || "").trim().replace(/\/+$/u, ""),
    models
  };
}

/** Merge an upstream refresh without losing local capability or visibility choices. */
export function mergeProviderModels(existing: ProviderModelSettings[], fetched: ProviderModelSettings[]): ProviderModelSettings[] {
  const previous = new Map(existing.map((model) => [model.id, model]));
  return fetched.map((model) => {
    const old = previous.get(model.id);
    return {
      ...model,
      imageInput: old?.imageInput ?? model.imageInput,
      enabled: old ? old.enabled !== false : model.enabled === true
    };
  });
}

export function normalizeDefaultModel(value: unknown): DesktopSettings["model"] {
  if (!value || typeof value !== "object") return undefined;
  const model = value as Record<string, unknown>;
  if (typeof model.provider !== "string" || typeof model.id !== "string" || !model.provider.trim() || !model.id.trim()) return undefined;
  return { provider: model.provider.trim(), id: model.id.trim() };
}

export function defaultSettings(): DesktopSettings {
  return {
    version: 2,
    thinkingLevel: "medium",
    providers: [],
    agents: [createDefaultAgent()],
    currentAgentId: DEFAULT_AGENT_ID,
    appearance: defaultAppearance()
  };
}

export function migrateSettings(raw: unknown): { settings: DesktopSettings; legacyApiKey?: string } {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const defaults = defaultSettings();
  const legacyProvider = source.customProvider && typeof source.customProvider === "object"
    ? source.customProvider as Record<string, unknown>
    : undefined;
  const legacyModels = Array.isArray(legacyProvider?.models)
    ? legacyProvider.models.map((model) => ({
      id: String((model as Record<string, unknown>)?.id || ""),
      name: String((model as Record<string, unknown>)?.name || "")
    })).filter((model) => model.id)
    : [];
  const legacyProviderId = String(legacyProvider?.id || CUSTOM_PROVIDER_ID);
  const providers = Array.isArray(source.providers)
    ? source.providers.map((provider) => normalizeProvider(provider as Partial<ProviderSettings>))
    : legacyProvider?.baseUrl
      ? [normalizeProvider({
        id: legacyProviderId,
        name: String(legacyProvider.name || "自定义 OpenAI 服务"),
        baseUrl: String(legacyProvider.baseUrl),
        models: legacyModels
      })]
      : [];
  const agents = Array.isArray(source.agents)
    ? source.agents.map((agent) => normalizeAgent(agent as Partial<AgentProfile>))
    : [createDefaultAgent()];
  const normalizedAgents = agents.some((agent) => agent.id === DEFAULT_AGENT_ID) ? agents : [createDefaultAgent(), ...agents];
  const currentAgentId = normalizedAgents.some((agent) => agent.id === String(source.currentAgentId))
    ? String(source.currentAgentId)
    : normalizedAgents[0]!.id;
  const appearanceSource = source.appearance && typeof source.appearance === "object" ? source.appearance as Record<string, unknown> : {};
  const theme = appearanceSource.theme === "light" || appearanceSource.theme === "dark" ? appearanceSource.theme : "system";
  const themePreset = THEME_PRESET_IDS.includes(String(appearanceSource.themePreset) as ThemePresetId)
    ? appearanceSource.themePreset as ThemePresetId
    : defaults.appearance.themePreset;
  const customCss = typeof appearanceSource.customCss === "string" ? appearanceSource.customCss : defaults.appearance.customCss;
  const thinkingLevel = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(source.thinkingLevel))
    ? source.thinkingLevel as ThinkingLevel
    : "medium";
  const settings: DesktopSettings = {
    version: 2,
    workspace: typeof source.workspace === "string" ? source.workspace : undefined,
    model: normalizeDefaultModel(source.model),
    thinkingLevel,
    providers,
    agents: normalizedAgents,
    currentAgentId,
    appearance: { theme, themePreset, customCss, showThinking: appearanceSource.showThinking !== false }
  };
  const legacyApiKey = typeof source.customProviderApiKey === "string" ? source.customProviderApiKey : undefined;
  return { settings, legacyApiKey };
}
