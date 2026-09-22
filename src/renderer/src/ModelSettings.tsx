import { Brain, Pencil, Plus, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { thinkingLevelLabels } from "../../shared/locale";
import type {
  CustomProviderModel,
  DesktopSettings,
  ModelOption,
  ProviderApiMode,
  ProviderModelSettings,
  ProviderOption,
  ProviderSettings,
  ThinkingLevel,
  ThinkingLevelMap
} from "../../shared/protocol";
import { THINKING_LEVELS, thinkingLevelDraftFrom, thinkingLevelMapFromDraft } from "../../shared/thinking-levels";
import { ModelSelect } from "./components/ModelSelect";
import { addManualProviderModel, buildBuiltinProviderEntry, filterProviderModels, formatTokenLimit, parseTokenLimit, providerFormBlocker, pruneDisabledModelRefs, selectableCatalogModels, setProviderModelsEnabled } from "./lib/model-list";
import { useDesktopStore } from "./store";

/**
 * 模型服务页（设置页「模型服务」tab，2026-09-23 从 App.tsx 抽出并重排）。
 *
 * 原实现是 `App.tsx` 里一个没有类名的裸 `<form>`：服务商下拉 + 服务商字段 +
 * 8890 字符单行的模型列表 + 视觉识别混在**一条滚动**里，零分区语义；保存按钮
 * 在滚动内容尾部（要滚到底）；服务商是一条 `<select>`，十几个服务商时只能靠
 * 下拉里翻。
 *
 * 本轮按角色页/通用页同一套体系重排：
 * ① 两栏——左「服务商」列表栏（按自定义服务商 / 内置服务分组，行内带「已配置」
 *    徽标，底部「+ 新增服务」），右配置区；
 * ② 右栏三张分区卡片：服务商信息（名称 / 接口地址 / 默认 API 协议 / API 密钥 /
 *    拉取模型）、可用模型（工具栏 + 手动添加 + 列表 + 限额与思考等级行内编辑）、
 *    视觉识别（图片兜底）；
 * ③ 「取消 / 保存设置」固定在弹窗底部（滚动收进 `.model-editor-body`），
 *    拦截原因与错误就近显示在同一行左侧；
 * ④ 新增主题钩子 `data-pane="model-settings"` 与 `data-control="model-provider-add"`
 *    / `model-provider-delete` / `model-save` / `model-refresh`（既有的 `model-add`、
 *    `model-thinking-levels`、`model-thinking-panel` 原样保留）。
 *
 * 数据流与旧实现逐字节一致：所有命令（provider.save / provider.models.save /
 * provider.models.fetch / provider.models.refresh / provider.delete / auth.set /
 * vision.save）与载荷形状不变；模型行勾选仍走 `updateProviderModel` →
 * `applyProviderModels` 的 store 乐观写（取消对话框由父级 initialSettingsRef 回滚）。
 * 服务商级状态（customProvider / customModels / 三个拉取状态）改为本组件直接订阅
 * store —— 它们只有本页消费，原先是从 App 一路透传下来的 7 个 props。
 */

const CUSTOM_PROVIDER_ID = "chatanytime-openai-compatible";

interface ModelSettingsProps {
  settings: DesktopSettings;
  models: ModelOption[];
  providers: ProviderOption[];
  /** 「保存设置」提交后回调：父级刷新回滚基线并关闭弹窗。 */
  onSaved(nextSettings: DesktopSettings): void;
  /** 组件内部自行落盘的动作（视觉识别 / 删除服务）完成后回调：父级只刷新基线，不关弹窗。 */
  onDraftCommitted(nextSettings: DesktopSettings): void;
  /** 「取消」：父级回滚到打开时的设置快照并关闭弹窗。 */
  onCancel(): void;
}

export function ModelSettings({ settings, models, providers, onSaved, onDraftCommitted, onCancel }: ModelSettingsProps): ReactNode {
  // 仅本页消费的服务商级状态：直接订阅 store（无需从 SettingsDialog 透传）。
  const customProvider = useDesktopStore((state) => state.customProvider);
  const customModels = useDesktopStore((state) => state.customModels);
  const customModelFetchStatus = useDesktopStore((state) => state.customModelFetchStatus);
  const customModelFetchError = useDesktopStore((state) => state.customModelFetchError);
  const modelRefreshStatus = useDesktopStore((state) => state.modelRefreshStatus);
  const modelRefreshError = useDesktopStore((state) => state.modelRefreshError);
  const modelRefreshProvider = useDesktopStore((state) => state.modelRefreshProvider);

  const configuredProviders = settings.providers;
  const firstCustomProvider = configuredProviders[0];
  const [provider, setProvider] = useState(firstCustomProvider?.id ?? CUSTOM_PROVIDER_ID);
  const selectedProvider = configuredProviders.find((item) => item.id === provider);
  // 单例自定义服务的显示名/已配置徽标读实时 settings.providers 条目——store 的
  // customProvider 字段只在 bootstrap 赋值，会话内重命名或存 key 后会变陈旧。
  const liveCustomProvider = configuredProviders.find((item) => item.id === CUSTOM_PROVIDER_ID);
  const customProviderDisplayName = liveCustomProvider?.name ?? "新的模型服务";
  const customProviderKeySaved = Boolean(liveCustomProvider?.keyConfigured);
  const isCustomProvider = provider === CUSTOM_PROVIDER_ID || provider.startsWith("provider-") || (selectedProvider !== undefined && selectedProvider.custom !== false);
  const [customName, setCustomName] = useState(selectedProvider?.name ?? customProvider?.name ?? "我的中转站");
  const [customBaseUrl, setCustomBaseUrl] = useState(selectedProvider?.baseUrl ?? customProvider?.baseUrl ?? "");
  // 自定义服务商的默认 API 协议（兜底 openai-completions 保持历史行为）；
  // 内置服务商缺省由目录决定，不在这里配置服务商级 API。
  const [customApi, setCustomApi] = useState<ProviderApiMode | undefined>(selectedProvider?.api ?? customProvider?.api);
  const [customModelId, setCustomModelId] = useState(selectedProvider?.models[0]?.id ?? customProvider?.models[0]?.id ?? customModels[0]?.id ?? "");
  const [imageInputOverride, setImageInputOverride] = useState<boolean | undefined>();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [visionEnabled, setVisionEnabled] = useState(settings.vision?.enabled ?? false);
  const [visionModel, setVisionModel] = useState(settings.vision?.provider && settings.vision.model ? `${settings.vision.provider}/${settings.vision.model}` : "");
  const [visionPrompt, setVisionPrompt] = useState(settings.vision?.prompt ?? "");
  const [visionSaving, setVisionSaving] = useState(false);
  const [visionError, setVisionError] = useState<string>();
  const visionModelOptions = selectableCatalogModels(models).filter((model) => model.configured && model.imageInput);
  const hasSavedCustomKey = Boolean(selectedProvider?.keyConfigured) || (provider === CUSTOM_PROVIDER_ID && customProviderKeySaved);
  const providerModels: ProviderModelSettings[] = isCustomProvider
    ? (selectedProvider?.models ?? customModels)
    : (() => {
      const cataloged = models.filter((model) => model.provider === provider).map((model) => {
        const stored = selectedProvider?.models.find((item) => item.id === model.id);
        return {
          id: model.id,
          name: model.name,
          imageInput: stored?.imageInput ?? model.imageInput,
          // 生效 API：设置覆盖优先，否则目录定义（含过渡期间 catalog 未携带时 undefined）。
          api: stored?.api ?? model.api ?? undefined,
          // 限额显示生效值（用户修正优先，否则目录原值），供编辑框 placeholder 回显。
          contextWindow: stored?.contextWindow ?? (typeof model.contextWindow === "number" ? model.contextWindow : undefined),
          maxTokens: stored?.maxTokens ?? (typeof model.maxTokens === "number" ? model.maxTokens : undefined),
          // 思考等级声明的生效值：设置页编辑器的回显与「按当前能力填充」都靠它
          //（口径同 imageInput / 限额）。
          ...(stored?.thinkingLevelMap ?? model.thinkingLevelMap ? { thinkingLevelMap: stored?.thinkingLevelMap ?? model.thinkingLevelMap } : {}),
          enabled: stored ? stored.enabled !== false : true,
          // 手动添加标记跟存储条目走（目录刷新后 catalog 已含该模型，标记不能丢）。
          ...(stored?.manual === true ? { manual: true as const } : {})
        };
      });
      // 目录里还没有的手动条目（刚添加的乐观态、保存后 catalog 推送未返回）也要显示。
      const catalogIds = new Set(cataloged.map((model) => model.id));
      const manualExtras = (selectedProvider?.models ?? []).filter((model) => model.manual === true && !catalogIds.has(model.id));
      return [...cataloged, ...manualExtras];
    })();
  const enabledProviderModels = providerModels.filter((model) => model.enabled !== false);
  const [modelSearch, setModelSearch] = useState("");
  // 左栏服务商搜索：内置目录长，靠它快速定位（与角色列表搜索同一交互）。
  const [providerQuery, setProviderQuery] = useState("");
  // 限额行内编辑态：正在编辑的模型 id + 两个输入框草稿（字符串，空 = 清除覆盖）。
  const [editingModelId, setEditingModelId] = useState<string | undefined>();
  const [limitDraftContext, setLimitDraftContext] = useState("");
  const [limitDraftMaxTokens, setLimitDraftMaxTokens] = useState("");
  // 思考等级编辑态：只记「正在编辑哪个模型」，草稿状态归 ThinkingLevelEditor 自己管
  //（key=模型 id，换模型自然重置）。
  const [editingThinkingId, setEditingThinkingId] = useState<string | undefined>();
  // 行内 API 模式编辑态：正在编辑的模型 id（undefined = 收起）。
  const [editingModelApi, setEditingModelApi] = useState<string | undefined>();
  // 手动添加模型表单：展开态 + 模型 ID/显示名称草稿 + 行内错误（不动 formError，
  // 避免把整页保存错误和表单校验混在一个位置）。
  const [manualModelOpen, setManualModelOpen] = useState(false);
  const [manualModelIdDraft, setManualModelIdDraft] = useState("");
  const [manualModelNameDraft, setManualModelNameDraft] = useState("");
  const [manualModelError, setManualModelError] = useState<string>();
  const visibleProviderModels = filterProviderModels(providerModels, modelSearch);
  const allVisibleModelsEnabled = visibleProviderModels.length > 0 && visibleProviderModels.every((model) => model.enabled !== false);
  const someVisibleModelsEnabled = visibleProviderModels.some((model) => model.enabled !== false);
  const selectedCustomModel = providerModels.find((model) => model.id === customModelId);
  // 保存拦截原因集（抽到 lib 层单测）：旧版在置灰条件/提交护栏/错误文案三处内联重复，
  // 且错误地把「至少勾选一个模型」当成前置条件，导致无法保存空勾选。
  const formBlocker = providerFormBlocker({
    hasApiKey: Boolean(apiKey.trim()) || hasSavedCustomKey,
    isCustomProvider,
    customName,
    customBaseUrl,
    customModelId,
    totalModels: providerModels.length
  });

  /** 切换服务商：与新实现同源（下拉时代就在做的事，原样保留）。 */
  function selectProvider(next: string): void {
    setProvider(next);
    setModelSearch("");
    closeManualModelForm();
    const config = configuredProviders.find((item) => item.id === next);
    if (config) {
      setCustomName(config.name);
      setCustomBaseUrl(config.baseUrl);
      setCustomModelId(config.models[0]?.id ?? "");
      setCustomApi(config.api);
    } else if (next !== CUSTOM_PROVIDER_ID) {
      setCustomBaseUrl("");
      setCustomApi(undefined);
    }
  }

  function applyProviderModels(updated: ProviderModelSettings[]): void {
    useDesktopStore.setState((state) => {
      if (!isCustomProvider) {
        const existing = state.settings.providers.find((item) => item.id === provider);
        const catalog = providers.find((item) => item.id === provider);
        const entry: ProviderSettings = buildBuiltinProviderEntry(provider, existing, catalog?.name ?? provider, catalog?.configured, updated);
        return { settings: { ...state.settings, providers: existing ? state.settings.providers.map((item) => item.id === provider ? entry : item) : [...state.settings.providers, entry] } };
      }
      const hasConfiguredProvider = state.settings.providers.some((item) => item.id === provider);
      return {
        customModels: (!selectedProvider || provider === CUSTOM_PROVIDER_ID) ? updated : state.customModels,
        settings: hasConfiguredProvider
          ? { ...state.settings, providers: state.settings.providers.map((item) => item.id === provider ? { ...item, models: updated } : item) }
          : state.settings
      };
    });
  }

  /** 打开/收起某模型的思考等级编辑；限额编辑盒与它互斥（避免两行同时展开拉长列表）。 */
  function beginEditThinkingLevels(model: ProviderModelSettings): void {
    setEditingThinkingId((current) => current === model.id ? undefined : model.id);
    setEditingModelId(undefined);
  }

  function commitThinkingLevels(modelId: string, thinkingLevelMap: ThinkingLevelMap | undefined): void {
    updateProviderModel(modelId, { thinkingLevelMap });
    setEditingThinkingId(undefined);
  }

  function updateProviderModel(modelId: string, patch: Partial<ProviderModelSettings>): void {
    applyProviderModels(providerModels.map((model) => model.id === modelId ? { ...model, ...patch } : model));
  }

  /** 打开某模型的限额编辑：草稿回显已设置值；上下文/最大输出留空 = 清除覆盖。 */
  function beginEditModelLimits(model: ProviderModelSettings): void {
    setEditingModelId(current => current === model.id ? undefined : model.id);
    setLimitDraftContext(formatTokenLimit(model.contextWindow));
    setLimitDraftMaxTokens(formatTokenLimit(model.maxTokens));
  }

  function commitModelLimits(model: ProviderModelSettings): void {
    updateProviderModel(model.id, { contextWindow: parseTokenLimit(limitDraftContext), maxTokens: parseTokenLimit(limitDraftMaxTokens) });
    setEditingModelId(undefined);
  }

  // 手动添加模型只对支持的渠道开放：自定义服务商（模型表就是设置条目）与
  // PiDesktop 直连管理覆盖层的内置渠道（ProviderOption.manualModels，radius
  // 等远程目录渠道写入覆盖键会破坏 SDK 的 etag/lastModified 刷新门控）。
  const manualModelsSupported = isCustomProvider || providers.find((item) => item.id === provider)?.manualModels === true;

  function openManualModelForm(): void {
    setManualModelOpen(true);
    setManualModelError(undefined);
  }

  function closeManualModelForm(): void {
    setManualModelOpen(false);
    setManualModelIdDraft("");
    setManualModelNameDraft("");
    setManualModelError(undefined);
  }

  function commitManualModel(): void {
    const result = addManualProviderModel(providerModels, manualModelIdDraft, manualModelNameDraft);
    if (typeof result === "string") {
      setManualModelError(result);
      return;
    }
    applyProviderModels(result);
    closeManualModelForm();
  }

  /** 删除手动添加的模型行（整行移除，随「保存设置」持久化；取消对话框可回滚）。 */
  function removeManualModel(modelId: string): void {
    applyProviderModels(providerModels.filter((model) => model.id !== modelId));
    if (isCustomProvider && modelId === customModelId) {
      setCustomModelId(providerModels.find((item) => item.id !== modelId && item.enabled !== false)?.id ?? "");
    }
  }

  /** 模型行 API 徽标短文案：覆盖生效时显示协议名，未覆盖显示「默认」。 */
  function apiBadgeLabel(api: ProviderApiMode | undefined): string {
    return api === "openai-responses" ? "Resp" : api === "openai-completions" ? "Chat" : "默认";
  }
  function apiBadgeTitle(api: ProviderApiMode | undefined): string {
    return api === "openai-responses" ? "Responses（/v1/responses）" : api === "openai-completions" ? "OpenAI 兼容 chat/completions" : "跟随服务商/目录默认 API 模式";
  }

  /** 该模型是否已有手动设置的限额（编辑按钮点亮提示）。 */
  function hasModelLimitOverride(modelId: string): boolean {
    const stored = selectedProvider?.models.find((item) => item.id === modelId);
    return Boolean(stored && (stored.contextWindow !== undefined || stored.maxTokens !== undefined));
  }

  /** 全选/全取消：作用于当前搜索可见的模型（未过滤时即全部），OpenRouter 长列表先全取消再搜出想要的几个勾上。 */
  function setAllVisibleModelsEnabled(enabled: boolean): void {
    const updated = setProviderModelsEnabled(providerModels, visibleProviderModels, enabled);
    applyProviderModels(updated);
    if (isCustomProvider && !enabled && visibleProviderModels.some((model) => model.id === customModelId)) {
      setCustomModelId(updated.find((model) => model.enabled !== false)?.id ?? customModelId);
    }
  }

  /**
   * 目录里的推理能力标记。模型行本身不持有该字段：它属于目录元数据而不是设置项，
   * 只为「思考等级」编辑器判定「该档位是否本就不可用」而查询。
   */
  function modelReasoning(modelId: string): boolean | undefined {
    return models.find((item) => item.provider === provider && item.id === modelId)?.reasoning;
  }

  /** 该模型是否已有思考等级声明（编辑按钮点亮提示，口径同 hasModelLimitOverride）。 */
  function hasThinkingOverride(modelId: string): boolean {
    return Boolean(selectedProvider?.models.find((item) => item.id === modelId)?.thinkingLevelMap);
  }

  useEffect(() => {
    const firstModel = enabledProviderModels.at(0) ?? providerModels.at(0);
    if (firstModel && !providerModels.some((model) => model.id === customModelId)) setCustomModelId(firstModel.id);
    setImageInputOverride(providerModels.find((model) => model.id === customModelId)?.imageInput);
  }, [customModelId, providerModels]);

  async function fetchModels(): Promise<void> {
    const fetchApiKey = apiKey.trim() || undefined;
    if (!customBaseUrl.trim() || (!fetchApiKey && !hasSavedCustomKey)) return;
    useDesktopStore.setState({ customModelFetchStatus: "loading", customModelFetchError: undefined });
    await window.piDesktop.send({ type: "provider.models.fetch", providerId: provider, baseUrl: customBaseUrl.trim(), apiKey: fetchApiKey });
  }

  async function refreshBuiltinModels(): Promise<void> {
    if (!provider) return;
    useDesktopStore.setState({ modelRefreshStatus: "loading", modelRefreshError: undefined, modelRefreshProvider: provider });
    await window.piDesktop.send({ type: "provider.models.refresh", providerId: provider });
    // 兜底看门狗：主进程侧有 30 秒超时，这里再等 40 秒；若运行时始终无响应
    // （如旧版本未重启），避免按钮一直停留在"拉取中"。
    window.setTimeout(() => {
      useDesktopStore.setState((state) =>
        state.modelRefreshStatus === "loading" && state.modelRefreshProvider === provider
          ? { modelRefreshStatus: "error", modelRefreshError: "拉取模型列表超时，请检查网络后重试；若持续无响应请重启应用" }
          : state
      );
    }, 40_000);
  }

  async function saveVision(): Promise<void> {
    const slash = visionModel.indexOf("/");
    const visionProviderId = slash > 0 ? visionModel.slice(0, slash) : "";
    const modelId = slash > 0 ? visionModel.slice(slash + 1) : "";
    if (visionEnabled && (!visionProviderId || !modelId)) {
      setVisionError("请先在上方的服务商中配置一个支持图片输入的模型");
      return;
    }
    setVisionSaving(true);
    setVisionError(undefined);
    try {
      const vision = { enabled: visionEnabled, provider: visionProviderId, model: modelId, ...(visionPrompt.trim() ? { prompt: visionPrompt.trim() } : {}) };
      await window.piDesktop.send({ type: "vision.save", vision });
      // 已落盘 → 刷新父级回滚基线（否则「取消」会把它回滚成旧值）。
      onDraftCommitted({ ...settings, vision });
    } catch (error) {
      setVisionError(error instanceof Error ? error.message : "保存视觉识别设置失败");
    } finally {
      setVisionSaving(false);
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!provider || formBlocker) return;
    setSaving(true);
    setFormError(undefined);
    try {
      let committed: DesktopSettings | undefined;
      if (isCustomProvider) {
        const modelsForProvider = providerModels;
        const providerConfig = { id: provider, name: customName.trim(), baseUrl: customBaseUrl.trim(), ...(customApi ? { api: customApi } : {}), models: modelsForProvider.length ? modelsForProvider.map((model) => ({ ...model, enabled: model.enabled !== false })) : [{ id: customModelId.trim(), name: customModelId.trim(), imageInput: imageInputOverride ?? selectedCustomModel?.imageInput, manual: true, enabled: true }] };
        await window.piDesktop.send({ type: "provider.save", provider: providerConfig, apiKey: apiKey.trim() || undefined });
        const nextProviders = settings.providers.some((item) => item.id === provider) ? settings.providers.map((item) => item.id === provider ? providerConfig : item) : [...settings.providers, providerConfig];
        // 与内置分支同款落位：自定义服务取消勾选（含清空全部模型）后，本地乐观副本
        // 的默认模型/助手默认/视觉引用一并清理——否则陈旧引用会被下次保存写回磁盘
        // （code-review P1，2026-09-02）。
        committed = pruneDisabledModelRefs({ ...settings, providers: nextProviders.map((item) => item.id === provider ? { ...item, keyConfigured: Boolean(apiKey.trim()) || selectedProvider?.keyConfigured } : item) }, provider, providerConfig.models);
      } else {
        const builtinEntry = settings.providers.find((item) => item.id === provider && item.custom === false);
        if (builtinEntry) {
          // 接口地址覆盖并入条目（空 = 清除覆盖，还原目录默认）；主进程保存时
          // 同步 models-store 覆盖层。模型级 API 覆盖已随 models 一并落位。
          const updatedBuiltin = { ...builtinEntry, baseUrl: customBaseUrl.trim() };
          await window.piDesktop.send({ type: "provider.models.save", provider: updatedBuiltin });
          committed = pruneDisabledModelRefs({ ...settings, providers: settings.providers.map((item) => item.id === provider ? updatedBuiltin : item) }, provider, updatedBuiltin.models);
        } else {
          // 只填了接口地址、尚未配置模型（无条目）也要落盘覆盖：构造空模型条目发送
          //（空勾选合法，主进程与渲染端均已支持）。
          const freshBuiltin: ProviderSettings = { id: provider, name: providers.find((item) => item.id === provider)?.name ?? provider, baseUrl: customBaseUrl.trim(), models: [], custom: false };
          await window.piDesktop.send({ type: "provider.models.save", provider: freshBuiltin });
          committed = { ...settings, providers: [...settings.providers, freshBuiltin] };
        }
        // 留空 = 沿用已保存的 key：不发 auth.set，避免空 key 覆盖运行中的凭据，
        // 导致随后的模型校验误报 "No API key for …"。
        if (apiKey.trim()) await window.piDesktop.send({ type: "auth.set", provider, apiKey: apiKey.trim() });
      }
      setApiKey("");
      if (committed) onSaved(committed);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "应用模型服务设置失败");
    } finally {
      setSaving(false);
    }
  }

  function newProvider(): void {
    const id = `provider-${Date.now()}`;
    setProvider(id); setCustomName("新的模型服务"); setCustomBaseUrl(""); setCustomModelId(""); setCustomApi(undefined); setApiKey(""); setModelSearch(""); closeManualModelForm();
  }

  async function deleteProvider(): Promise<void> {
    if (!selectedProvider) return;
    await window.piDesktop.send({ type: "provider.delete", providerId: selectedProvider.id });
    const nextProviders = settings.providers.filter((item) => item.id !== selectedProvider.id);
    onDraftCommitted({
      ...settings,
      providers: nextProviders,
      model: settings.model?.provider === selectedProvider.id ? undefined : settings.model,
      agents: settings.agents.map((agent) => agent.defaultModel?.provider === selectedProvider.id ? { ...agent, defaultModel: undefined } : agent)
    });
    setProvider(nextProviders[0]?.id ?? CUSTOM_PROVIDER_ID);
    setModelSearch("");
  }

  // 左栏分组：自定义服务在前、内置服务在后（用户 2026-09-23 指定——自定义的是自己配的、
  // 常用且少，内置目录长，放后面不挡路）；每组的条目与旧下拉的 optgroup 逐项一致。
  const railGroups: Array<{ label: string; entries: Array<{ id: string; name: string; configured: boolean; custom: boolean; draft?: boolean }> }> = [
    {
      label: "自定义服务商",
      entries: [
        { id: CUSTOM_PROVIDER_ID, name: customProviderDisplayName, configured: customProviderKeySaved, custom: true },
        ...configuredProviders.filter((item) => item.id !== CUSTOM_PROVIDER_ID && item.custom !== false).map((item) => ({ id: item.id, name: item.name, configured: Boolean(item.keyConfigured), custom: true }))
      ]
    },
    {
      label: "内置服务",
      entries: [
        // 排除单例自定义服务的目录条目：它在下面的「自定义服务商」组里已有一条，
        // 不排会同一服务商在两组建两行（旧下拉时代就存在，列表化后才显眼）。
        ...providers.filter((item) => !item.custom && item.id !== CUSTOM_PROVIDER_ID && !configuredProviders.some((config) => config.id === item.id)).map((item) => ({ id: item.id, name: item.name, configured: Boolean(item.configured), custom: false })),
        ...configuredProviders.filter((item) => item.custom === false).map((item) => ({ id: item.id, name: item.name, configured: Boolean(item.keyConfigured), custom: false }))
      ]
    }
  ];
  // 新建但尚未保存的服务不在 settings.providers 里 —— 下拉时代当前值显示在下拉框里，
  // 换成一栏列表后必须显式补一条草稿项，否则刚点「+ 新增服务」左栏没有任何选中项
  // （2026-09-23 实测）。名字跟随「服务名称」输入框实时变。
  if (!railGroups.some((group) => group.entries.some((entry) => entry.id === provider))) {
    railGroups[0]!.entries.unshift({ id: provider, name: customName.trim() || "新的模型服务", configured: false, custom: true, draft: true });
  }
  // 搜索过滤：按名称或 id 匹配（内置目录十几项时靠它快速定位）；全组匹配为空则整组不渲染。
  const providerKeyword = providerQuery.trim().toLowerCase();
  const visibleRailGroups = railGroups
    .map((group) => ({ ...group, entries: group.entries.filter((entry) => !providerKeyword || `${entry.name} ${entry.id}`.toLowerCase().includes(providerKeyword)) }))
    .filter((group) => group.entries.length > 0);
  const editorTitle = selectedProvider?.name ?? (isCustomProvider ? customName : providers.find((item) => item.id === provider)?.name ?? provider);
  const refreshing = modelRefreshStatus === "loading" && modelRefreshProvider === provider;
  // 拉取模型：自定义服务走接口地址拉取（provider.models.fetch），内置服务走目录刷新
  //（provider.models.refresh）——旧实现的按钮在同一页两处分开摆，这里统一收进模型卡头。
  const fetchBusy = isCustomProvider ? customModelFetchStatus === "loading" : refreshing;
  const fetchDisabled = isCustomProvider ? (!customBaseUrl.trim() || (!apiKey.trim() && !customProviderKeySaved)) : false;

  return (
    <form className="model-settings" data-pane="model-settings" onSubmit={(event) => void save(event)}>
      <div className="model-settings-body">
        <aside className="model-rail" aria-label="服务商">
          <div className="model-rail-head">服务商</div>
          <label className="model-rail-search">
            <Search size={13} />
            <input value={providerQuery} placeholder="搜索服务商…" aria-label="搜索服务商" spellCheck={false} onChange={(event) => setProviderQuery(event.target.value)} />
          </label>
          <div className="model-rail-list">
            {visibleRailGroups.length === 0
              ? <p className="model-rail-empty">没有匹配「{providerQuery.trim()}」的服务商</p>
              : visibleRailGroups.map((group) => (
              <div className="model-rail-group" key={group.label}>
                <div className="model-rail-group-label">{group.label}</div>
                {group.entries.map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={entry.id === provider ? "model-rail-item active" : "model-rail-item"}
                    data-provider-id={entry.id}
                    data-provider-kind={entry.custom ? "custom" : "builtin"}
                    data-provider-draft={entry.draft ? "true" : undefined}
                    aria-current={entry.id === provider ? "true" : undefined}
                    onClick={() => selectProvider(entry.id)}
                  >
                    <span className="model-rail-avatar">{entry.name.trim().slice(0, 1) || "?"}</span>
                    <span className="model-rail-copy">
                      <strong>{entry.name}{entry.configured && <em className="model-rail-badge">已配置</em>}</strong>
                      <small>{entry.draft ? "未保存" : entry.custom ? "自定义" : "内置服务"}</small>
                    </span>
                  </button>
                ))}
              </div>
              ))}
          </div>
          <button type="button" className="model-rail-new" data-control="model-provider-add" onClick={newProvider}>+ 新增服务</button>
        </aside>

        <div className="model-editor">
          <header className="model-editor-head">
            <span className="model-editor-title">
              <strong>{editorTitle}</strong>
              <small>{isCustomProvider ? "自定义服务商" : "内置服务"} · {hasSavedCustomKey ? "已保存 API 密钥" : "未保存 API 密钥"} · 已启用 {enabledProviderModels.length}/{providerModels.length} 个模型</small>
            </span>
            <span className="model-editor-actions">
              {selectedProvider && selectedProvider.custom !== false && <button className="danger-button compact-button" type="button" data-control="model-provider-delete" onClick={() => void deleteProvider()}>删除服务</button>}
            </span>
          </header>

          <div className="model-editor-body">
            <section className="model-card" aria-label="服务商信息">
              <div className="model-card-head">
                <strong>服务商信息</strong>
                <small>{isCustomProvider ? "名称、接口地址与密钥都会随保存写回本机配置" : "内置服务商的接口地址可覆盖；其余走目录默认"}</small>
              </div>
              <div className="model-card-body">
                <div className="model-field-row">
                  {isCustomProvider && <label className="model-field"><span>服务名称</span><input value={customName} placeholder="例如：公司中转站" onChange={(event) => setCustomName(event.target.value)} /></label>}
                  {isCustomProvider && <label className="model-field"><span>默认 API 协议</span><select value={customApi ?? "openai-completions"} title="该服务商未按模型单独设置时的请求 API 模式；支持 /v1/responses 的中转站可选 Responses" onChange={(event) => setCustomApi(event.target.value as ProviderApiMode)}><option value="openai-completions">OpenAI 兼容 chat/completions</option><option value="openai-responses">Responses（/v1/responses）</option></select><small>按模型单独设置会覆盖它</small></label>}
                  <label className="model-field"><span>API 密钥</span><input type="password" value={apiKey} autoFocus autoComplete="off" placeholder={isCustomProvider && hasSavedCustomKey ? "已保存，留空则继续使用" : "请输入 API 密钥"} onChange={(event) => setApiKey(event.target.value)} /><small>存本机加密凭据，不进配置文件</small></label>
                </div>
                <div className="model-field-row">
                  <label className="model-field model-field-wide"><span>{isCustomProvider ? "接口地址" : "接口地址（可选）"}</span><input value={customBaseUrl} placeholder={isCustomProvider ? "https://api.example.com/v1" : "留空 = 跟随服务商目录默认地址（部分模型的 API 模式不同，接口地址也可按需覆盖）"} spellCheck={false} onChange={(event) => setCustomBaseUrl(event.target.value)} /></label>
                </div>
                {isCustomProvider && customModelFetchError && <p className="model-error">{customModelFetchError}</p>}
              </div>
            </section>

            <section className="model-card" aria-label="可用模型">
              <div className="model-card-head">
                <strong>可用模型</strong>
                <small>左侧勾选控制是否出现在模型选择器，右侧标记图片输入</small>
                <span className="model-card-actions">
                  <button className="secondary-button compact-button" type="button" data-control="model-refresh" title={isCustomProvider ? "从上方填写的接口地址拉取模型列表" : "从服务商目录拉取最新模型列表"} disabled={fetchBusy || fetchDisabled} onClick={() => void (isCustomProvider ? fetchModels() : refreshBuiltinModels())}><RefreshCw size={13} className={fetchBusy ? "spinning" : undefined} />{fetchBusy ? "拉取中…" : "拉取模型"}</button>
                  {manualModelsSupported && <button className="secondary-button compact-button" type="button" data-control="model-add" title="服务商列表接口没有的模型，在这里手动登记；拉取模型列表不会覆盖手动条目" aria-expanded={manualModelOpen} onClick={() => (manualModelOpen ? closeManualModelForm() : openManualModelForm())}><Plus size={13} />{manualModelOpen ? "收起" : "手动添加"}</button>}
                </span>
              </div>
              <div className="model-card-body model-list-body">
                {providerModels.length > 0 && (
                  <div className="model-list-toolbar">
                    <label className="checkbox-setting model-select-all" title={modelSearch.trim() ? "勾选或取消当前匹配到的模型" : "勾选或取消全部模型"}><input type="checkbox" checked={allVisibleModelsEnabled} disabled={visibleProviderModels.length === 0} ref={(el) => { if (el) el.indeterminate = !allVisibleModelsEnabled && someVisibleModelsEnabled; }} onChange={(event) => setAllVisibleModelsEnabled(event.target.checked)} />全选</label>
                    <small className="model-enabled-count">已启用 {enabledProviderModels.length}/{providerModels.length}</small>
                    {providerModels.length > 8 && <div className="model-search-box"><Search size={13} /><input value={modelSearch} placeholder="搜索模型名称或 ID" aria-label="搜索模型" onChange={(event) => setModelSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault(); }} /></div>}
                  </div>
                )}
                {manualModelOpen && (
                  <div className="model-add-form">
                    <label>模型 ID<input value={manualModelIdDraft} autoFocus autoComplete="off" spellCheck={false} placeholder="如 gpt-4o-mini（服务商文档里的模型标识）" onChange={(event) => setManualModelIdDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commitManualModel(); } }} /></label>
                    <label>显示名称<input value={manualModelNameDraft} autoComplete="off" placeholder="留空 = 使用模型 ID" onChange={(event) => setManualModelNameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commitManualModel(); } }} /></label>
                    <div className="model-add-actions"><button className="primary-button compact-button" type="button" onClick={commitManualModel}><Plus size={13} />添加</button><button className="secondary-button compact-button" type="button" onClick={closeManualModelForm}>取消</button></div>
                    {manualModelError && <p className="form-error model-add-error">{manualModelError}</p>}
                  </div>
                )}
                {!isCustomProvider && modelRefreshError && <p className="model-error">{modelRefreshError}</p>}
                {!isCustomProvider && modelRefreshStatus === "success" && modelRefreshProvider === provider && <p className="model-hint">模型列表已更新</p>}
                {providerModels.length === 0
                  ? <p className="model-empty">{isCustomProvider ? "请先拉取模型，或点右上「手动添加」登记模型" : manualModelsSupported ? "该服务商暂无可用模型，可先配置 API 密钥后拉取，或点右上「手动添加」登记模型" : "该服务商暂无可用模型，请先配置 API 密钥"}</p>
                  : visibleProviderModels.length === 0
                    ? <p className="model-empty">没有匹配「{modelSearch.trim()}」的模型</p>
                    : (
                      <div className="model-list">
                        {visibleProviderModels.map((model) => (
                          <div className="model-option" key={model.id}>
                            <label className="checkbox-setting model-enabled-option"><input type="checkbox" checked={model.enabled !== false} onChange={(event) => { const next = event.target.checked; updateProviderModel(model.id, { enabled: next }); if (isCustomProvider && model.id === customModelId && !next) setCustomModelId(providerModels.find((item) => item.id !== model.id && item.enabled !== false)?.id ?? model.id); }} /><span><strong>{model.name}{model.manual === true && <em className="model-manual-badge" title="手动添加的模型：拉取模型列表不会移除它">手动</em>}</strong><small>{model.id}</small></span></label>
                            <label className="checkbox-setting model-image-option" title={isCustomProvider ? "允许向此模型发送图片（勾选会清空该模型的思考等级声明——自定义模型的模板来自代理，两者可能不匹配）" : "手动标记该模型是否支持图片输入：目录元数据滞后或缺失时以这里的勾选为准"}><input type="checkbox" checked={model.imageInput === true} onChange={(event) => updateProviderModel(model.id, { imageInput: event.target.checked, ...(event.target.checked ? { thinkingLevelMap: undefined } : {}) })} />图片输入</label>
                            <button className={model.api ? "model-api-badge override" : "model-api-badge"} type="button" title={`${apiBadgeTitle(model.api)}${model.api ? "（已单独覆盖）" : "；点击单独设置"}`} aria-expanded={editingModelApi === model.id} onClick={() => setEditingModelApi(editingModelApi === model.id ? undefined : model.id)}>{apiBadgeLabel(model.api)}</button>
                            {editingModelApi === model.id && <select className="model-api-editor" autoFocus value={model.api ?? ""} onChange={(event) => { const value = event.target.value as "" | ProviderApiMode; updateProviderModel(model.id, { api: value || undefined }); setEditingModelApi(undefined); }} onBlur={() => setEditingModelApi(undefined)} onKeyDown={(event) => { if (event.key === "Escape") setEditingModelApi(undefined); }}><option value="">跟随默认</option><option value="openai-completions">chat/completions</option><option value="openai-responses">Responses</option></select>}
                            <button className={hasThinkingOverride(model.id) ? "icon-button model-edit-thinking active" : "icon-button model-edit-thinking"} data-control="model-thinking-levels" type="button" title={editingThinkingId === model.id ? "收起思考等级设置" : "声明该模型支持哪些思考等级（上游不支持「很高/最高」时在这里声明，例如把 high 发给上游写 xhigh）"} aria-expanded={editingThinkingId === model.id} onClick={() => beginEditThinkingLevels(model)}><Brain size={13} /></button>
                            <button className={hasModelLimitOverride(model.id) ? "icon-button model-edit-limits active" : "icon-button model-edit-limits"} type="button" title={editingModelId === model.id ? "收起限额编辑" : "修正上下文窗口与最大输出（服务商标错时手动覆盖）"} aria-expanded={editingModelId === model.id} onClick={() => beginEditModelLimits(model)}><Pencil size={13} /></button>
                            {model.manual === true && <button className="icon-button model-remove-button" type="button" title="移除这条手动添加的模型（点下方「保存设置」后生效）" onClick={() => removeManualModel(model.id)}><X size={13} /></button>}
                            {editingModelId === model.id && (
                              <div className="model-limits-editor">
                                <label>上下文窗口<input inputMode="numeric" autoComplete="off" value={limitDraftContext} placeholder={typeof model.contextWindow === "number" ? String(model.contextWindow) : "如 128k 或 128000"} onChange={(event) => setLimitDraftContext(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitModelLimits(model); } }} /><small>tokens</small></label>
                                <label>最大输出<input inputMode="numeric" autoComplete="off" value={limitDraftMaxTokens} placeholder={typeof model.maxTokens === "number" ? String(model.maxTokens) : "如 16k 或 16384"} onChange={(event) => setLimitDraftMaxTokens(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitModelLimits(model); } }} /><small>tokens</small></label>
                                <div className="model-limits-actions"><button className="secondary-button compact-button" type="button" onClick={() => { setLimitDraftContext(""); setLimitDraftMaxTokens(""); }}>清空</button><button className="primary-button compact-button" type="button" onClick={() => commitModelLimits(model)}>完成</button></div>
                                <p className="model-limits-hint">留空后点完成 = 清除手动设置，回退目录值；最后点下方「保存设置」持久化。</p>
                              </div>
                            )}
                            {editingThinkingId === model.id && <ThinkingLevelEditor key={model.id} model={model} reasoning={modelReasoning(model.id)} onCancel={() => setEditingThinkingId(undefined)} onCommit={(map) => commitThinkingLevels(model.id, map)} />}
                          </div>
                        ))}
                      </div>
                    )}
                {isCustomProvider && providerModels.length === 0 && customModelId && <label className="checkbox-setting model-image-override"><input type="checkbox" checked={imageInputOverride ?? false} onChange={(event) => setImageInputOverride(event.target.checked)} />支持图片输入（手动覆盖推断）</label>}
                {providerModels.length > 0 && enabledProviderModels.length === 0 && <p className="model-hint">已取消全部模型：保存后该服务商在模型选择器中不再提供模型（若运行中会话正在用它的模型会自动切走）；想彻底移除该服务，请用右上「删除服务」。</p>}
              </div>
            </section>

            <section className="model-card" aria-label="视觉识别">
              <div className="model-card-head">
                <strong>视觉识别（图片兜底）</strong>
                <small>对话模型不支持图片时，图片交给这里选的多模态模型识别，结果以文本交给对话模型</small>
                <span className="model-card-actions">
                  <label className="checkbox-setting model-vision-switch"><input type="checkbox" checked={visionEnabled} onChange={(event) => setVisionEnabled(event.target.checked)} />启用</label>
                </span>
              </div>
              <div className="model-card-body">
                <div className="model-field-row">
                  <label className="model-field"><span>视觉模型</span><ModelSelect models={visionModelOptions} providers={providers} value={visionModel} disabled={visionModelOptions.length === 0} emptyMessage="暂无已配置的多模态模型" placeholder="请选择视觉模型" onChange={setVisionModel} /><small>只列已配置且支持图片输入的模型</small></label>
                  <label className="model-field model-field-wide"><span>识别提示词（可选）</span><textarea rows={3} value={visionPrompt} placeholder="留空使用默认提示词：转写图中文字、描述物体、布局与配色等" onChange={(event) => setVisionPrompt(event.target.value)} /></label>
                </div>
                {visionError && <p className="model-error">{visionError}</p>}
                <div className="model-card-footer">
                  <button className="primary-button compact-button" type="button" disabled={visionSaving} onClick={() => void saveVision()}>{visionSaving ? "正在保存" : "保存视觉识别设置"}</button>
                  <small>独立保存，不影响上方模型列表的改动</small>
                </div>
              </div>
            </section>
          </div>

          <footer className="model-settings-footer">
            <span className="model-footer-note">{formError ? <span className="model-footer-error">{formError}</span> : formBlocker ? formBlocker : ""}</span>
            <span className="model-footer-actions">
              <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
              <button className="primary-button" data-control="model-save" disabled={saving || Boolean(formBlocker)} type="submit">{saving ? "正在应用" : "保存设置"}</button>
            </span>
          </footer>
        </div>
      </div>
    </form>
  );
}

/**
 * 思考等级编辑器（从 App.tsx 平移，仅模型服务页使用）。
 *
 * 模型目录里没写某模型支持哪些思考等级时，该档位在顶栏菜单里是灰的无法声明，
 * 正是本次要修的场景。
 */
function ThinkingLevelEditor({ model, reasoning, onCommit, onCancel }: { model: ProviderModelSettings; reasoning?: boolean; onCommit(thinkingLevelMap: ThinkingLevelMap | undefined): void; onCancel(): void }): ReactNode {
  const [draft, setDraft] = useState(() => thinkingLevelDraftFrom(model.thinkingLevelMap, reasoning));
  const editable = reasoning !== false;
  function patch(level: ThinkingLevel, change: Partial<{ enabled: boolean; value: string }>): void {
    setDraft((current) => ({
      enabled: change.enabled === undefined ? current.enabled : { ...current.enabled, [level]: change.enabled },
      values: change.value === undefined ? current.values : { ...current.values, [level]: change.value }
    }));
  }
  return (
    <div className="model-thinking-editor" data-control="model-thinking-panel">
      <div className="model-thinking-head">
        <span>思考等级支持</span>
        {!editable && <small className="model-thinking-note">目录标记该模型不支持推理，无法声明</small>}
      </div>
      <ul className="model-thinking-list">
        {THINKING_LEVELS.map((level) => {
          const isHighTier = level === "xhigh" || level === "max";
          return (
            <li key={level} className={editable ? "model-thinking-row" : "model-thinking-row unsupported"}>
              <label className="checkbox-setting model-thinking-toggle">
                <input type="checkbox" disabled={!editable} checked={draft.enabled[level]} onChange={(event) => patch(level, { enabled: event.target.checked })} />
                <span>{thinkingLevelLabels[level]}</span>
              </label>
              <input className="model-thinking-value" autoComplete="off" spellCheck={false} disabled={!editable} placeholder={level} value={draft.values[level]} onChange={(event) => patch(level, { value: event.target.value })} />
              {isHighTier && <small className="model-thinking-note">{draft.enabled[level] ? "已声明支持" : "勾选 = 声明支持（否则菜单里为灰）"}</small>}
            </li>
          );
        })}
      </ul>
      <p className="model-thinking-hint">左侧勾选 = 该档位可选；右侧取值 = 调用上游时实际发送的 reasoning_effort（留空用同名值，例如「高」默认发 high；上游只认 xhigh 时就在这里把「高」写成 xhigh）。</p>
      <div className="model-limits-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => setDraft(thinkingLevelDraftFrom(undefined, reasoning))}>恢复默认</button>
        <button className="secondary-button compact-button" type="button" onClick={onCancel}>取消</button>
        <button className="primary-button compact-button" type="button" onClick={() => onCommit(thinkingLevelMapFromDraft(draft))}>完成</button>
      </div>
    </div>
  );
}
