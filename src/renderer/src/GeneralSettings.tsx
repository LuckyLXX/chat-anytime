import { Bot, ChevronDown, Computer, FolderOpen, Globe, Palette, RotateCcw, Terminal } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type { AccessMode, DesktopSettings, JevSettings, ModelOption, ProviderOption, ThinkingLevel } from "../../shared/protocol";
import { THINKING_LEVELS } from "../../shared/thinking-levels";
import { thinkingLevelLabels } from "../../shared/locale";
import { ModelSelect } from "./components/ModelSelect";
import { selectableCatalogModels } from "./lib/model-list";
import { useDesktopStore } from "./store";

/**
 * 通用页（设置页「通用」tab，2026-09-23 从 App.tsx 抽出并重排）。
 *
 * 原实现是 App.tsx 里一行平铺的表单：7 类内容（模型 / 思考等级 / 访问模式 /
 * 默认工作区 / 4 个能力总闸 / Jev 实验区 / 展示思考）混在一条滚动里，零分区
 * 语义；能力总闸是裸复选框、说明全藏在 title；Jev 区块占近一屏喧宾夺主。
 *
 * 本轮按角色页（AgentSettings.tsx）已验证的分区卡片体系重排：
 * ① 六张分区卡片：对话与权限 / 视觉识别（图片兜底）/ 默认工作区 / 能力总闸 /
 *    Jev 快速决策 / 界面（视觉识别 2026-09-23 从「模型服务」页迁来——它是全局项，
 *    原先挂在每个服务商的滚动内容里）；
 * ② 能力总闸改整行开关（图标 + 名称 + 一行可见说明 + 右侧开关），
 *    与角色页 agent-switch-row 同构；
 * ③ Jev 折叠成一张卡片，默认收起——头部一行显示标题 + 状态徽标 + 启用开关，
 *    点开才展开字段（实验性能力不该占据首屏）；
 * ④ 「取消 / 保存通用设置」固定在弹窗底部（settings-dialog footer 独立
 *    于滚动内容），不再需要滚到底才能保存。
 *
 * 数据流与旧实现逐字节一致：settings.save 的载荷仍由父级 SettingsDialog 的
 * form 提交（本组件渲染 footer 的 submit 按钮），Jev 的草稿保存仍走独立的
 * jev.save（密钥与配置分开落位，不混进「保存通用设置」的整包提交）。
 * settings-save-contract.test.ts 钉住载荷键集，抽组件时键集不变。
 */

const ACCESS_MODE_OPTIONS: readonly { value: AccessMode; label: string }[] = [
  { value: "read-only", label: "只读" },
  { value: "ask", label: "每次询问" },
  { value: "workspace", label: "工作区访问" },
  { value: "full", label: "完全访问" }
];

/**
 * 能力总闸行配置：说明必须可见（旧版藏在 hover title 里）。
 * `key` 同时是 DesktopSettings 上那个总闸字段名（browser / ssh / computer / design），
 * 也是 data-control 的后缀（`capability-<key>`），主题与测试都按它定位。
 */
type CapabilityKey = "browser" | "ssh" | "computer" | "design";

const CAPABILITY_SWITCHES: Array<{
  key: CapabilityKey;
  title: string;
  hint: string;
  icon: typeof Bot;
}> = [
  { key: "browser", title: "浏览器自动化", hint: "browser_* 工具：AI 可导航、截图与操作内置浏览器页面", icon: Globe },
  { key: "ssh", title: "SSH 远程操作", hint: "ssh_* 工具；只管 AI，不拦你自己在 SSH 面板建立的连接", icon: Terminal },
  { key: "computer", title: "电脑控制", hint: "computer_* 桌面窗口工具；还须在会话顶栏开启才注入", icon: Computer },
  { key: "design", title: "设计模式", hint: "design_* 工具仅在开了设计模式的会话里注入", icon: Palette }
];

interface GeneralSettingsProps {
  settings: DesktopSettings;
  models: ModelOption[];
  providers: ProviderOption[];
  /** TypeSafe 密钥是否已保存（来自主进程 bootstrap，明文不进渲染端）。 */
  jevKeyConfigured: boolean;
  /** 「保存通用设置」提交后回调：父级刷新取消回滚基线并关闭弹窗。 */
  onSaved(nextSettings: DesktopSettings): void;
  /**
   * 组件内部自己落盘的动作（目前只有 Jev 保存）完成后回调：父级只刷新回滚基线，
   * 不关弹窗。
   *
   * 为什么必须有：Jev 走独立的 `jev.save`，保存时只 patchSettings 而不动父级的
   * initialSettingsRef，那么此后点「取消」会把 store 里的 jev 回滚成打开时的旧值
   * （磁盘上却是新值），而下一次「保存通用设置」的 settings.save 载荷带着这个旧值
   * 写回主进程 —— 静默抹掉刚保存的 Jev 配置。这正是 2026-09-21 `settings.jev`
   * 从 settings.json 里消失的同一类故障，所以基线必须在落盘处同步刷新。
   */
  onDraftCommitted(nextSettings: DesktopSettings): void;
  /** 「取消」：父级回滚到打开时的设置快照并关闭弹窗。 */
  onCancel(): void;
}

export function GeneralSettings({ settings, models, providers, jevKeyConfigured, onSaved, onDraftCommitted, onCancel }: GeneralSettingsProps): ReactNode {
  const configuredModels = models.filter((model) => model.configured);
  const [jevExpanded, setJevExpanded] = useState(false);
  // Jev 快速决策（实验性、缺省关闭）：字段各自本地化，保存走独立的 jev.save 命令
  // （密钥与配置分开落位，不混进「保存通用设置」的整包提交）。
  const [jevEnabled, setJevEnabled] = useState(settings.jev?.enabled === true);
  const [jevBaseUrl, setJevBaseUrl] = useState(settings.jev?.baseUrl ?? "https://api.typesafe.ai/v1");
  const [jevModel, setJevModel] = useState(settings.jev?.model ?? "jev-latest");
  const [jevTextModel, setJevTextModel] = useState(settings.jev?.textProvider && settings.jev?.textModel ? `${settings.jev.textProvider}/${settings.jev.textModel}` : "");
  const [jevMaxSteps, setJevMaxSteps] = useState(String(settings.jev?.maxSteps ?? 30));
  const [jevAutoPilot, setJevAutoPilot] = useState(settings.jev?.autoPilot !== false);
  const [jevApiKey, setJevApiKey] = useState("");
  const [jevSaving, setJevSaving] = useState(false);
  const [jevError, setJevError] = useState<string>();
  // 「测试连接」的状态放全局 store（结果由 utility 以 jev-test-result 推送），与
  // customModelFetchStatus 同一形状：推送 → store 投影 → 控件读。
  const jevTestStatus = useDesktopStore((state) => state.jevTestStatus);
  const jevTestMessage = useDesktopStore((state) => state.jevTestMessage);
  const [jevSaved, setJevSaved] = useState(false);
  // 视觉识别（图片兜底）：全局项（原先挂在「模型服务」页每个服务商的滚动内容里，
  // 2026-09-23 用户指出它是公共选项 → 迁到本页）。与 Jev 一样走独立命令 + 独立保存，
  // 不进「保存通用设置」的 settings.save 载荷（那份 Pick 里没有 vision 键）。
  const [visionEnabled, setVisionEnabled] = useState(settings.vision?.enabled ?? false);
  const [visionModel, setVisionModel] = useState(settings.vision?.provider && settings.vision.model ? `${settings.vision.provider}/${settings.vision.model}` : "");
  const [visionPrompt, setVisionPrompt] = useState(settings.vision?.prompt ?? "");
  const [visionSaving, setVisionSaving] = useState(false);
  const [visionError, setVisionError] = useState<string>();
  const visionModelOptions = selectableCatalogModels(models).filter((model) => model.configured && model.imageInput);

  function patchSettings(patch: Partial<DesktopSettings>): void {
    useDesktopStore.setState({ settings: { ...settings, ...patch } });
  }

  /** 单个能力总闸开关（缺省启用，与运行时 `enabled !== false` 同一口径）。 */
  function capabilityEnabled(key: CapabilityKey): boolean {
    return settings[key]?.enabled !== false;
  }

  function toggleCapability(key: CapabilityKey, enabled: boolean): void {
    // 四个总闸形状一致（{ enabled }），Pick<DesktopSettings, CapabilityKey> 即它们；
    // 断言只是收窄 computed key，运行时无转换。
    patchSettings({ [key]: { enabled } } as Pick<DesktopSettings, CapabilityKey>);
  }

  async function saveJev(): Promise<void> {
    const slash = jevTextModel.indexOf("/");
    const textProvider = slash > 0 ? jevTextModel.slice(0, slash) : "";
    const textModelId = slash > 0 ? jevTextModel.slice(slash + 1) : "";
    if (jevEnabled && (!textProvider || !textModelId)) {
      setJevError("启用 Jev 前请先选择文本助手模型（用于给字段填值；Jev 本身只做选择）");
      return;
    }
    if (jevEnabled && !jevBaseUrl.trim()) {
      setJevError("请填写 TypeSafe 接口地址");
      return;
    }
    setJevSaving(true);
    setJevError(undefined);
    try {
      const steps = Math.min(100, Math.max(1, Math.round(Number(jevMaxSteps) || 30)));
      const jev: JevSettings = {
        enabled: jevEnabled,
        baseUrl: jevBaseUrl.trim() || "https://api.typesafe.ai/v1",
        model: jevModel.trim() || "jev-latest",
        textProvider,
        textModel: textModelId,
        maxSteps: steps,
        autoPilot: jevAutoPilot
      };
      await window.piDesktop.send({ type: "jev.save", jev, ...(jevApiKey.trim() ? { apiKey: jevApiKey.trim() } : {}) });
      if (jevApiKey.trim()) useDesktopStore.setState({ jevKeyConfigured: true });
      setJevApiKey("");
      patchSettings({ jev });
      // 已落盘 → 同步刷新父级回滚基线（见 onDraftCommitted 的注释）。
      onDraftCommitted({ ...settings, jev });
      setJevSaved(true);
      window.setTimeout(() => setJevSaved(false), 2500);
    } catch (error) {
      setJevError(error instanceof Error ? error.message : "保存 Jev 设置失败");
    } finally {
      setJevSaving(false);
    }
  }

  async function saveVision(): Promise<void> {
    const slash = visionModel.indexOf("/");
    const provider = slash > 0 ? visionModel.slice(0, slash) : "";
    const modelId = slash > 0 ? visionModel.slice(slash + 1) : "";
    if (visionEnabled && (!provider || !modelId)) {
      setVisionError("请先选择一个支持图片输入的模型");
      return;
    }
    setVisionSaving(true);
    setVisionError(undefined);
    try {
      const vision = { enabled: visionEnabled, provider, model: modelId, ...(visionPrompt.trim() ? { prompt: visionPrompt.trim() } : {}) };
      await window.piDesktop.send({ type: "vision.save", vision });
      // 已落盘 → 同步刷新父级回滚基线（与 Jev 保存同一口径）。
      onDraftCommitted({ ...settings, vision });
    } catch (error) {
      setVisionError(error instanceof Error ? error.message : "保存视觉识别设置失败");
    } finally {
      setVisionSaving(false);
    }
  }

  async function testJev(): Promise<void> {
    // 「测试连接」：发一次真实的 TypeSafe 决策请求（只读）。刻意不要求先勾「启用」——
    // 否则用户会卡在「不启用不能测、不测不敢启用」。草稿为空时由 utility 侧回落已保存值。
    useDesktopStore.setState({ jevTestStatus: "loading", jevTestMessage: undefined });
    try {
      await window.piDesktop.send({
        type: "jev.test",
        ...(jevBaseUrl.trim() ? { baseUrl: jevBaseUrl.trim() } : {}),
        ...(jevModel.trim() ? { model: jevModel.trim() } : {}),
        ...(jevApiKey.trim() ? { apiKey: jevApiKey.trim() } : {})
      });
    } catch (error) {
      // 命令通道本身报错（不是探测失败）：也落到同一个提示位上。
      useDesktopStore.setState({ jevTestStatus: "error", jevTestMessage: error instanceof Error ? error.message : "测试连接失败" });
    }
  }

  async function clearJevKey(): Promise<void> {
    try {
      await window.piDesktop.send({ type: "jev.clearKey" });
      useDesktopStore.setState({ jevKeyConfigured: false });
      setJevSaved(true);
      window.setTimeout(() => setJevSaved(false), 2500);
    } catch (error) {
      setJevError(error instanceof Error ? error.message : "清除密钥失败");
    }
  }

  // 默认工作区草稿直接进 store（随「保存通用设置」提交；取消则回滚父级的
  // initialSettingsRef——与旧实现一致）。
  async function chooseDefaultWorkspace(): Promise<void> {
    const path = await window.piDesktop.chooseWorkspace();
    if (path) patchSettings({ defaultWorkspace: path });
  }
  function resetDefaultWorkspace(): void {
    patchSettings({ defaultWorkspace: undefined });
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    const nextSettings = structuredClone(settings);
    void window.piDesktop.send({ type: "settings.save", settings: { model: nextSettings.model, thinkingLevel: nextSettings.thinkingLevel, accessMode: nextSettings.accessMode, appearance: nextSettings.appearance, browser: nextSettings.browser, computer: nextSettings.computer, design: nextSettings.design, ssh: nextSettings.ssh, jev: nextSettings.jev, defaultWorkspace: nextSettings.defaultWorkspace } });
    // 通知父级「已保存」：父级负责 markSettingsSaved（刷新取消回滚基线）并关闭弹窗。
    onSaved(nextSettings);
  }

  const jevStatus = !jevEnabled
    ? { label: "未启用", tone: "off" as const }
    : jevTestStatus === "loading"
      ? { label: "测试中…", tone: "busy" as const }
      : jevTestStatus === "error"
        ? { label: "连接异常", tone: "warn" as const }
        : jevTestStatus === "success"
          ? { label: "连接正常", tone: "ok" as const }
          : { label: "已启用", tone: "ok" as const };

  return (
    <form className="general-settings" data-pane="general-settings" onSubmit={onSubmit}>
      <div className="general-settings-body">
        <section className="general-card" aria-label="对话与权限">
          <div className="general-card-head"><strong>对话与权限</strong><small>新会话的默认值；访问模式是全局权限轴</small></div>
          <div className="general-card-body">
            <div className="general-field-row">
              <label className="general-field general-field-wide"><span>全局默认模型</span><ModelSelect models={configuredModels} providers={providers} value={settings.model ? `${settings.model.provider}/${settings.model.id}` : ""} placeholder="请选择默认模型" onChange={(value) => { const slash = value.indexOf("/"); patchSettings({ model: slash > 0 ? { provider: value.slice(0, slash), id: value.slice(slash + 1) } : undefined }); }} /></label>
              <label className="general-field"><span>默认思考等级</span><select value={settings.thinkingLevel} onChange={(event) => patchSettings({ thinkingLevel: event.target.value as ThinkingLevel })}>{THINKING_LEVELS.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}</select></label>
              <label className="general-field"><span>访问模式</span><select value={settings.accessMode} onChange={(event) => patchSettings({ accessMode: event.target.value as AccessMode })}>{ACCESS_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            </div>
            {settings.accessMode === "full" && <p className="general-warning">完全访问会允许 Pi 直接执行命令并访问工作区外路径，请只在可信项目中使用。</p>}
            {settings.accessMode === "workspace" && <p className="general-hint">工作区内的文件写入会自动允许；bash 命令和工作区外路径仍会询问。</p>}
          </div>
        </section>

        <section className="general-card" aria-label="视觉识别（图片兜底）">
          <div className="general-card-head">
            <strong>视觉识别（图片兜底）</strong>
            <small>全局项：对话模型不支持图片输入时，发送的图片交给这里选的多模态模型识别，结果以文本交给对话模型</small>
            <span className="general-card-actions">
              <label className="checkbox-setting general-vision-switch"><input type="checkbox" checked={visionEnabled} onChange={(event) => setVisionEnabled(event.target.checked)} />启用</label>
            </span>
          </div>
          <div className="general-card-body">
            <div className="general-field-row">
              <label className="general-field"><span>视觉模型</span><ModelSelect models={visionModelOptions} providers={providers} value={visionModel} disabled={visionModelOptions.length === 0} emptyMessage="暂无已配置的多模态模型" placeholder="请选择视觉模型" onChange={setVisionModel} /><small>只列已配置且支持图片输入的模型</small></label>
              <label className="general-field general-field-wide"><span>识别提示词（可选）</span><textarea rows={3} value={visionPrompt} placeholder="留空使用默认提示词：转写图中文字、描述物体、布局与配色等" onChange={(event) => setVisionPrompt(event.target.value)} /></label>
            </div>
            {visionError && <p className="form-error general-form-error">{visionError}</p>}
            <div className="general-card-footer">
              <button className="primary-button compact-button" type="button" disabled={visionSaving} onClick={() => void saveVision()}>{visionSaving ? "正在保存" : "保存视觉识别设置"}</button>
              <small>独立保存，不受「保存通用设置」影响</small>
            </div>
          </div>
        </section>

        <section className="general-card" aria-label="默认工作区">
          <div className="general-card-head"><strong>默认工作区</strong><small>没有选择过工作区的助手，所有话题都落在这里</small></div>
          <div className="general-card-body">
            <p className="general-hint">未自定义时使用内置目录 workspace-default，开箱即可对话；已选过工作区的助手仍各自记忆、互不影响。</p>
            <div className="general-workspace-row">
              <code className="general-workspace-path" title={settings.defaultWorkspace ?? undefined}>{settings.defaultWorkspace ?? "未自定义（使用内置目录）"}</code>
              <span className="general-workspace-actions">
                <button className="secondary-button compact-button" type="button" onClick={() => void chooseDefaultWorkspace()}><FolderOpen size={13} />选择文件夹</button>
                <button className="secondary-button compact-button" type="button" disabled={!settings.defaultWorkspace} onClick={resetDefaultWorkspace}><RotateCcw size={13} />恢复默认</button>
              </span>
            </div>
          </div>
        </section>

        <section className="general-card" aria-label="能力总闸">
          <div className="general-card-head"><strong>能力总闸</strong><small>关掉即从活动集摘除该族工具；会话级开关独立于此</small></div>
          <div className="general-card-body">
            {CAPABILITY_SWITCHES.map(({ key, title, hint, icon: Icon }) => (
              <label className="general-switch-row" key={key} title={`总闸：关掉后${title}工具不再注入任何会话`}>
                <span className="general-switch-icon"><Icon size={13} /></span>
                <span className="general-switch-copy"><strong>{title}</strong><small>{hint}</small></span>
                <input type="checkbox" className="general-switch" data-control="capability-switch" data-capability={key} checked={capabilityEnabled(key)} onChange={(event) => toggleCapability(key, event.target.checked)} />
              </label>
            ))}
          </div>
        </section>

        <section className={jevExpanded ? "general-card general-card-jev expanded" : "general-card general-card-jev"} aria-label="Jev 快速决策">
          <div className="general-card-head jev-head">
            <button type="button" className="general-jev-toggle" data-control="jev-expand" aria-expanded={jevExpanded} onClick={() => setJevExpanded((open) => !open)}>
              <ChevronDown size={14} className={jevExpanded ? "chevron" : "chevron collapsed"} />
              <strong>Jev 快速决策</strong>
              <em className="general-jev-badge experimental">实验性</em>
              <em className={jevExpanded ? "general-jev-badge" : `general-jev-badge ${jevStatus.tone}`}>{jevStatus.label}</em>
            </button>
            <label className="checkbox-setting general-jev-switch" title="总闸：关闭时不注入任何工具、不读密钥、不产生请求">
              <input type="checkbox" checked={jevEnabled} onChange={(event) => setJevEnabled(event.target.checked)} />启用 browser_jev_run
            </label>
          </div>
          {jevExpanded && (
            <div className="general-card-body">
              <p className="general-hint">由 Jev（TypeSafe）逐轮决策、主模型只给一次目标，在内置浏览器里连续操作页面。它需要一个能访问的 TypeSafe 端点；<strong>内网环境通常没有，请保持关闭</strong>。关闭时不注入任何工具、不读密钥、不产生请求。</p>
              <div className="general-field-row">
                <label className="general-field"><span>TypeSafe 接口地址</span><input value={jevBaseUrl} placeholder="https://api.typesafe.ai/v1" spellCheck={false} onChange={(event) => setJevBaseUrl(event.target.value)} /><small>含 /v1；也可填自建网关（如 Vercel AI Gateway 的 /typesafe/v1）</small></label>
                <label className="general-field"><span>Jev 模型</span><input value={jevModel} placeholder="jev-latest" spellCheck={false} onChange={(event) => setJevModel(event.target.value)} /><small>可固定版本，例如 jev-1.13.0</small></label>
                <label className="general-field"><span>单次步数上限</span><input inputMode="numeric" value={jevMaxSteps} placeholder="30" onChange={(event) => setJevMaxSteps(event.target.value)} /><small>1–100，默认 30；达到上限会把页面现状交回模型</small></label>
              </div>
              <div className="general-field-row">
                <label className="general-field general-field-wide"><span>文本助手模型</span><ModelSelect models={configuredModels} providers={providers} value={jevTextModel} emptyMessage="暂无已配置模型" placeholder="请选择用于给字段填值的模型" onChange={setJevTextModel} /><small>Jev 只做选择，字段值由这个模型生成（走已配置的模型服务）</small></label>
                <label className="general-field"><span>TypeSafe API Key</span><input type="password" value={jevApiKey} autoComplete="off" placeholder={jevKeyConfigured ? "已保存，留空则继续使用" : "请输入 API 密钥（存本机加密凭据，不进配置文件）"} onChange={(event) => setJevApiKey(event.target.value)} /></label>
              </div>
              <label className="checkbox-setting general-jev-autopilot" title="关闭后每走一步就把控制权交回主模型（不会自动连跑）">
                <input type="checkbox" checked={jevAutoPilot} onChange={(event) => setJevAutoPilot(event.target.checked)} />自动驾驶（连续执行到完成/阻塞；关闭则一次只走一步）
              </label>
              {jevError && <p className="form-error general-form-error">{jevError}</p>}
              {jevTestStatus !== "idle" && <p className={jevTestStatus === "error" ? "form-error jev-test-result" : "form-hint jev-test-result"} data-role="jev-test-result">{jevTestStatus === "loading" ? "正在连接 TypeSafe…" : jevTestMessage}</p>}
              <div className="general-jev-footer">
                <button className="primary-button compact-button" type="button" disabled={jevSaving} onClick={() => void saveJev()}>{jevSaving ? "正在保存" : "保存 Jev 设置"}</button>
                <button className="secondary-button compact-button" type="button" data-control="jev-test" disabled={jevTestStatus === "loading"} onClick={() => void testJev()}>{jevTestStatus === "loading" ? "测试中" : "测试连接"}</button>
                <button className="secondary-button compact-button" type="button" disabled={!jevKeyConfigured} onClick={() => void clearJevKey()}>清除密钥</button>
                {jevSaved && <span className="form-hint">已保存</span>}
              </div>
            </div>
          )}
        </section>

        <section className="general-card" aria-label="界面">
          <div className="general-card-head"><strong>界面</strong><small>外观主题在「外观」页；这里只管对话过程展示</small></div>
          <div className="general-card-body">
            <label className="general-switch-row">
              <span className="general-switch-icon"><Bot size={13} /></span>
              <span className="general-switch-copy"><strong>展示思考过程</strong><small>在时间线里展开模型的思考段落</small></span>
              <input type="checkbox" className="general-switch" checked={settings.appearance.showThinking} onChange={(event) => patchSettings({ appearance: { ...settings.appearance, showThinking: event.target.checked } })} />
            </label>
          </div>
        </section>
      </div>

      <footer className="general-settings-footer">
        <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
        <button className="primary-button" type="submit">保存通用设置</button>
      </footer>
    </form>
  );
}
