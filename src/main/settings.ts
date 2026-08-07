import { THEME_PRESET_IDS } from "../shared/protocol.js";
import type {
  AccessMode,
  AgentProfile,
  AppearanceSettings,
  BuiltinToolName,
  CustomThemeDefinition,
  DesktopSettings,
  ProviderModelSettings,
  ProviderSettings,
  ThemeAssetMap,
  ThemeColorKey,
  ThemeColorOverrides,
  ThemeOverrides,
  ThemePresetId,
  ThinkingLevel
} from "../shared/protocol.js";

export const BUILTIN_TOOLS: BuiltinToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
export const DEFAULT_AGENT_ID = "default";
export const CUSTOM_PROVIDER_ID = "chatanytime-openai-compatible";

export function normalizeAccessMode(value: unknown): AccessMode {
  return value === "read-only" || value === "workspace" || value === "full" ? value : "ask";
}

export function defaultTools(): Record<BuiltinToolName, boolean> {
  return Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool, true])) as Record<BuiltinToolName, boolean>;
}

export function createDefaultAgent(): AgentProfile {
  return {
    id: DEFAULT_AGENT_ID,
    name: "默认助手",
    description: "使用 Pi 工具协助完成项目开发任务",
    systemPrompt: "你是 ChatAnyTime 的默认开发助手。请先理解项目结构，再谨慎地检查、修改和验证代码。",
    divMode: false,
    defaultThinkingLevel: "medium",
    tools: defaultTools()
  };
}

export function defaultAppearance(): AppearanceSettings {
  return {
    theme: "system",
    themePreset: "default",
    customCss: "",
    customThemes: [],
    themeOverrides: { light: {}, dark: {} },
    showThinking: true
  };
}

const THEME_COLOR_KEYS: readonly ThemeColorKey[] = ["accent", "accentHover", "userBubble", "aiBubble"];
const HEX_COLOR_PATTERN = /^#[\da-f]{6}$/iu;

function normalizeThemeColorOverrides(value: unknown): ThemeColorOverrides {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const colors = Object.fromEntries(THEME_COLOR_KEYS.flatMap((key) => {
    const color = typeof source[key] === "string" ? source[key].trim().toLowerCase() : "";
    return HEX_COLOR_PATTERN.test(color) ? [[key, color]] : [];
  })) as ThemeColorOverrides;
  const rawOpacity = typeof source.wallpaperOpacity === "number"
    ? source.wallpaperOpacity
    : typeof source.wallpaperOpacity === "string" && source.wallpaperOpacity.trim()
      ? Number(source.wallpaperOpacity)
      : Number.NaN;
  if (!Number.isFinite(rawOpacity)) return colors;
  return { ...colors, wallpaperOpacity: Math.min(1, Math.max(0, rawOpacity)) };
}

export function normalizeThemeOverrides(value: unknown): ThemeOverrides {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    light: normalizeThemeColorOverrides(source.light),
    dark: normalizeThemeColorOverrides(source.dark)
  };
}

export function normalizeCustomThemes(value: unknown): CustomThemeDefinition[] {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set<string>();
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;
    const css = typeof source.css === "string" ? source.css : "";
    if (!css.trim()) return [];
    const name = typeof source.name === "string" && source.name.trim() ? source.name.trim() : `自定义主题 ${index + 1}`;
    const baseId = typeof source.id === "string" && source.id.trim() ? source.id.trim() : `custom-${index + 1}`;
    const assets = normalizeThemeAssets(source.assets);
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    usedIds.add(id);
    return [{ id, name, css, ...(Object.keys(assets).length > 0 ? { assets } : {}) }];
  });
}

export function normalizeThemeAssets(value: unknown): ThemeAssetMap {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([path, data]) => {
    const normalizedPath = path.trim().replaceAll("\\", "/").replace(/^\.\/+?/u, "").toLowerCase();
    return normalizedPath && typeof data === "string" && data.startsWith("data:image/") ? [[normalizedPath, data]] : [];
  }));
}

export function normalizeAgent(agent: Partial<AgentProfile> | undefined): AgentProfile {
  const fallback = createDefaultAgent();
  const sourceTools = (agent?.tools ?? {}) as Partial<Record<BuiltinToolName, boolean>>;
  return {
    id: String(agent?.id || fallback.id),
    name: String(agent?.name || fallback.name),
    description: String(agent?.description ?? ""),
    systemPrompt: String(agent?.systemPrompt ?? (agent?.id === DEFAULT_AGENT_ID ? fallback.systemPrompt : "")),
    divMode: agent?.divMode === true,
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
    accessMode: "ask",
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
  const customCssAssets = normalizeThemeAssets(appearanceSource.customCssAssets);
  const customThemes = normalizeCustomThemes(appearanceSource.customThemes);
  const themeOverrides = normalizeThemeOverrides(appearanceSource.themeOverrides);
  const thinkingLevel = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(source.thinkingLevel))
    ? source.thinkingLevel as ThinkingLevel
    : "medium";
  const accessMode = normalizeAccessMode(source.accessMode);
  const settings: DesktopSettings = {
    version: 2,
    workspace: typeof source.workspace === "string" ? source.workspace : undefined,
    model: normalizeDefaultModel(source.model),
    thinkingLevel,
    accessMode,
    providers,
    agents: normalizedAgents,
    currentAgentId,
    appearance: { theme, themePreset, customCss, ...(Object.keys(customCssAssets).length > 0 ? { customCssAssets } : {}), customThemes, themeOverrides, showThinking: appearanceSource.showThinking !== false }
  };
  const legacyApiKey = typeof source.customProviderApiKey === "string" ? source.customProviderApiKey : undefined;
  return { settings, legacyApiKey };
}
