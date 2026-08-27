import { THEME_PRESET_IDS } from "../shared/protocol.js";
import type {
  AccessMode,
  AgentProfile,
  AppearanceSettings,
  BrowserSettings,
  BuiltinToolName,
  CustomThemeDefinition,
  DesktopSettings,
  HooksSettings,
  MemorySettings,
  ProviderModelSettings,
  ProviderSettings,
  ThemeAssetMap,
  ThemePresetId,
  ThinkingLevel,
  VisionSettings,
  WallpaperOpacityOverrides
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
    showThinking: true
  };
}

function clampOpacity(value: unknown): number | undefined {
  const raw = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : undefined;
}

/**
 * Accepts the current { light: 0.4 } shape and, for migration, the legacy
 * themeOverrides shape { light: { wallpaperOpacity: 0.4, ...colors } }.
 */
export function normalizeWallpaperOpacity(value: unknown): WallpaperOpacityOverrides | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const result: WallpaperOpacityOverrides = {};
  for (const mode of ["light", "dark"] as const) {
    const modeSource = source[mode];
    const direct = clampOpacity(modeSource);
    const nested = modeSource && typeof modeSource === "object"
      ? clampOpacity((modeSource as Record<string, unknown>).wallpaperOpacity)
      : undefined;
    const opacity = direct ?? nested;
    if (opacity !== undefined) result[mode] = opacity;
  }
  return Object.keys(result).length > 0 ? result : undefined;
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

const THEME_ASSET_DATA_PATTERN = /^data:(?:image|font)\/|application\/(?:font-woff|x-font-woff|vnd\.ms-fontobject)\//iu;

/** 用户手动修正的 token 限额只接受正整数（既当存储过滤，也当运行时防线）。 */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
}

export function normalizeThemeAssets(value: unknown): ThemeAssetMap {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([path, data]) => {
    const normalizedPath = path.trim().replaceAll("\\", "/").replace(/^\.\/+?/u, "").toLowerCase();
    return normalizedPath && typeof data === "string" && THEME_ASSET_DATA_PATTERN.test(data) ? [[normalizedPath, data]] : [];
  }));
}

export function normalizeSkillOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([rawId, enabled]) => {
    const id = rawId.trim();
    return id.startsWith("skill:") && id.length <= 256 && typeof enabled === "boolean" ? [[id, enabled]] : [];
  }));
}

export function normalizeAgent(agent: Partial<AgentProfile> | undefined): AgentProfile {
  const fallback = createDefaultAgent();
  const sourceTools = (agent?.tools ?? {}) as Partial<Record<BuiltinToolName, boolean>>;
  const skillOverrides = normalizeSkillOverrides(agent?.skillOverrides);
  return {
    id: String(agent?.id || fallback.id),
    name: String(agent?.name || fallback.name),
    description: String(agent?.description ?? ""),
    systemPrompt: String(agent?.systemPrompt ?? (agent?.id === DEFAULT_AGENT_ID ? fallback.systemPrompt : "")),
    divMode: agent?.divMode === true,
    defaultModel: agent?.defaultModel,
    defaultThinkingLevel: agent?.defaultThinkingLevel ?? fallback.defaultThinkingLevel,
    tools: Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool, sourceTools[tool] !== false])) as Record<BuiltinToolName, boolean>,
    ...(Object.keys(skillOverrides).length > 0 ? { skillOverrides } : {}),
    archived: Boolean(agent?.archived)
  };
}

export function normalizeProvider(provider: Partial<ProviderSettings>): ProviderSettings {
  const models = Array.isArray(provider.models)
    ? provider.models
      .filter((model) => model && typeof model.id === "string" && model.id.trim())
      .map((model) => ({
        id: model.id.trim(),
        name: String(model.name || model.id).trim() || model.id.trim(),
        imageInput: model.imageInput,
        // 用户手动修正的 token 限额：仅保留合法正整数，避免非法值流入运行时。
        ...(isPositiveInt(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
        ...(isPositiveInt(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
        enabled: model.enabled !== false
      }))
    : [];
  return {
    id: String(provider.id || CUSTOM_PROVIDER_ID),
    name: String(provider.name || "自定义 OpenAI 服务"),
    baseUrl: String(provider.baseUrl || "").trim().replace(/\/+$/u, ""),
    models,
    ...(provider.custom === false ? { custom: false as const } : {})
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
      // 用户手动修正过的限额在上游刷新后保持不变。
      contextWindow: old?.contextWindow ?? model.contextWindow,
      maxTokens: old?.maxTokens ?? model.maxTokens,
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

export function normalizeVision(value: unknown): VisionSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const provider = typeof source.provider === "string" ? source.provider.trim() : "";
  const model = typeof source.model === "string" ? source.model.trim() : "";
  const prompt = typeof source.prompt === "string" && source.prompt.trim() ? source.prompt.trim() : undefined;
  const normalized = { enabled: source.enabled === true, provider, model, ...(prompt ? { prompt } : {}) };
  return normalized.enabled || provider || model ? normalized : undefined;
}

/** 字段缺省视为启用；消费方统一用 `settings.memory?.enabled !== false` 判断。 */
export function normalizeMemory(value: unknown): MemorySettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  return { enabled: (value as Record<string, unknown>).enabled !== false };
}

/** 钩子总开关，语义与 memory 相同：缺省视为启用。 */
export function normalizeHooks(value: unknown): HooksSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  return { enabled: (value as Record<string, unknown>).enabled !== false };
}

/** 浏览器自动化总开关，语义与 memory/hooks 相同：缺省视为启用。 */
export function normalizeBrowser(value: unknown): BrowserSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  return { enabled: (value as Record<string, unknown>).enabled !== false };
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
  const wallpaperOpacity = normalizeWallpaperOpacity(appearanceSource.wallpaperOpacity)
    ?? normalizeWallpaperOpacity(appearanceSource.themeOverrides);
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
    appearance: { theme, themePreset, customCss, ...(Object.keys(customCssAssets).length > 0 ? { customCssAssets } : {}), customThemes, ...(wallpaperOpacity ? { wallpaperOpacity } : {}), showThinking: appearanceSource.showThinking !== false },
    vision: normalizeVision(source.vision),
    memory: normalizeMemory(source.memory),
    hooks: normalizeHooks(source.hooks),
    browser: normalizeBrowser(source.browser)
  };
  const legacyApiKey = typeof source.customProviderApiKey === "string" ? source.customProviderApiKey : undefined;
  return { settings, legacyApiKey };
}
