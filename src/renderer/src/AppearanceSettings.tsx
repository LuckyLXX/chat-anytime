import { Download, RotateCcw, Save, Trash2 } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type {
  AppearanceSettings as AppearanceSettingsValue,
  CustomThemeDefinition,
  DesktopSettings,
  InterfaceTuning,
  ThemeMode,
  ThemePresetId
} from "../../shared/protocol";
import { RichContent } from "./components/RichContent";
import { activeThemeScope, resolveThemeAssetUrls } from "../../shared/theme-assets";
import type { ThemeImportOutcome } from "../../shared/theme-assets";
import { THEME_PRESETS, bubbleOpacityCss, panelOpacityCss, scopeCustomThemeCssForPreview, themePreviewCss, themeWallpaperOpacity, wallpaperOpacityCss } from "./lib/theme-presets";
import { customCssHasWallpaper } from "./lib/theme-runtime";
import { useDesktopStore } from "./store";

/**
 * 外观页（设置页「外观」tab，2026-09-23 从 App.tsx 抽出并重排）。
 *
 * 原实现塞在 App.tsx 里：`<form className="appearance-settings">` 内一段
 * `appearance-grid`（左内容 / 右预览）+ 页尾的自定义 CSS 与主题库，全部字段共用
 * `.settings-dialog label` 的 `margin: 15px 18px` 与一串自带 18px 外边距的旧类
 * （.theme-color-settings / .custom-css-heading / .custom-theme-library…），保存钮
 * 在滚动内容尾部；预览列宽是 `minmax(230px, 34%)`，在 920px 弹窗里实际只有
 * 约 230px 宽（深浅两栏各 115px）。
 *
 * 本轮按分区卡片体系重排：
 * ① 左列四张卡片：主题与预设 / 界面微调 / 透明度 / 自定义 CSS（含主题库）；
 * ② 右列预览改为 sticky 常驻并加宽——弹窗在本页也走 settings-wide（1080px），
 *    预览列 `minmax(340px, 46%)`，预览体高度 390→460（用户要求「预览稍微大一点」）；
 * ③ 「取消 / 保存外观设置」固定在弹窗底部，滚动收进 `.appearance-page-body`；
 * ④ 新增主题钩子 `data-pane="appearance-settings"` 与 data-control
 *    "appearance-import-css" / "appearance-import-theme" / "appearance-clear-css"
 *    / "appearance-save-theme" / "appearance-save"。
 *
 * 数据流与旧实现一致：即时生效的字段仍直接写 store（取消对话框由父级
 * initialSettingsRef 回滚），提交仍是 `appearance.save` 整包发 settings.appearance。
 * 壁纸判定（customCssHasWallpaper）抽到 lib/theme-runtime.ts，App 外壳与本页同源引用。
 *
 * 2026-09-26 主题资产落磁盘：导入不再由渲染端读目录/读文件——`themeImport(kind)`
 * 让主进程弹对话框、读盘、把 CSS 引用的资产写进 `<agentDir>/pidesktop-themes/current/`，
 * 本页只拿 CSS 文本与统计（资产落盘数/未命中的引用）；`themePromote(id)` 在「保存当前
 * 主题」时把草稿槽归到该主题 id 下。资产全程不过渲染端、不过 IPC。
 *
 * 刻意移除：本页原先重复的「展示思考过程」开关（通用页「界面」卡已声明归属）。
 */

interface AppearanceSettingsProps {
  settings: DesktopSettings;
  /** 「保存外观设置」提交后回调：父级刷新回滚基线并关闭弹窗。 */
  onSaved(nextSettings: DesktopSettings): void;
  /** 「取消」：父级回滚到打开时的设置快照并关闭弹窗。 */
  onCancel(): void;
}

export function AppearanceSettings({ settings, onSaved, onCancel }: AppearanceSettingsProps): ReactNode {
  const [opacityMode, setOpacityMode] = useState<ThemeMode>(() => {
    const { theme } = settings.appearance;
    if (theme === "light") return "light";
    if (theme === "dark") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [themeImportError, setThemeImportError] = useState<string>();
  const [themeImportNote, setThemeImportNote] = useState<string>();
  const [themeImporting, setThemeImporting] = useState(false);
  const initialCustomTheme = settings.appearance.customThemes.find((theme) => theme.css === settings.appearance.customCss);
  const [customThemeName, setCustomThemeName] = useState(initialCustomTheme?.name ?? "");
  const [editingCustomThemeId, setEditingCustomThemeId] = useState<string | undefined>(initialCustomTheme?.id);

  const appearance = settings.appearance;
  const wallpaperOpacityOverride = appearance.wallpaperOpacity?.[opacityMode];
  const wallpaperOpacity = wallpaperOpacityOverride ?? themeWallpaperOpacity(appearance.customCss, opacityMode) ?? 0;
  const wallpaperOpacityPercent = Math.round(wallpaperOpacity * 100);
  const bubbleOpacityOverride = appearance.bubbleOpacity?.[opacityMode];
  const bubbleOpacity = bubbleOpacityOverride ?? DEFAULT_BUBBLE_OPACITY;
  const bubbleOpacityPercent = Math.round(bubbleOpacity * 100);
  const panelOpacityOverride = appearance.panelOpacity?.[opacityMode];
  const panelOpacity = panelOpacityOverride ?? DEFAULT_PANEL_OPACITY;
  const panelOpacityPercent = Math.round(panelOpacity * 100);

  /** 即时生效的草稿写入（细节同旧实现：整包替换 appearance，取消由父级快照回滚）。 */
  function updateAppearance(patch: Partial<AppearanceSettingsValue>): void {
    useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, ...patch } } });
  }

  /** 更新运行时界面微调（密度/圆角）。同一次调用只更新显式传入的字段：
   *  传非空值=设为该档、传空串=清除该字段回跟随主题；未传（undefined）的字段保留现状，
   *  避免「设密度顺手清掉圆角、反之亦然」。全字段清空才置 tune=undefined。 */
  function updateTune(patch: { density?: InterfaceTuning["density"] | ""; radius?: InterfaceTuning["radius"] | "" }): void {
    const current = { ...(settings.appearance.tune ?? {}) } as InterfaceTuning;
    if (patch.density !== undefined) {
      if (patch.density) current.density = patch.density;
      else delete current.density;
    }
    if (patch.radius !== undefined) {
      if (patch.radius) current.radius = patch.radius;
      else delete current.radius;
    }
    updateAppearance({ tune: Object.keys(current).length > 0 ? current : undefined });
  }

  function updateWallpaperOpacity(value: number): void {
    const wallpaperOpacity = { ...settings.appearance.wallpaperOpacity, [opacityMode]: Math.min(1, Math.max(0, value)) };
    updateAppearance({ wallpaperOpacity });
  }

  function resetWallpaperOpacity(): void {
    const current = settings.appearance.wallpaperOpacity;
    if (!current?.[opacityMode]) return;
    const wallpaperOpacity = structuredClone(current);
    delete wallpaperOpacity[opacityMode];
    updateAppearance(Object.keys(wallpaperOpacity).length > 0 ? { wallpaperOpacity } : { wallpaperOpacity: undefined });
  }

  function updateBubbleOpacity(value: number): void {
    const bubbleOpacity = { ...settings.appearance.bubbleOpacity, [opacityMode]: Math.min(1, Math.max(0, value)) };
    updateAppearance({ bubbleOpacity });
  }

  function resetBubbleOpacity(): void {
    const current = settings.appearance.bubbleOpacity;
    if (!current?.[opacityMode]) return;
    const bubbleOpacity = structuredClone(current);
    delete bubbleOpacity[opacityMode];
    updateAppearance(Object.keys(bubbleOpacity).length > 0 ? { bubbleOpacity } : { bubbleOpacity: undefined });
  }

  function updatePanelOpacity(value: number): void {
    const panelOpacity = { ...settings.appearance.panelOpacity, [opacityMode]: Math.min(1, Math.max(0, value)) };
    updateAppearance({ panelOpacity });
  }

  function resetPanelOpacity(): void {
    const current = settings.appearance.panelOpacity;
    if (!current?.[opacityMode]) return;
    const panelOpacity = structuredClone(current);
    delete panelOpacity[opacityMode];
    updateAppearance(Object.keys(panelOpacity).length > 0 ? { panelOpacity } : { panelOpacity: undefined });
  }

  /**
   * 导入主题（目录 / 单个 CSS）：**全部文件工作在主进程**——它弹选择对话框、读盘、
   * 按 CSS 里的安全相对引用把资产写进草稿槽 `<agentDir>/pidesktop-themes/current/`，
   * 渲染端只拿到 CSS 文本与统计（导入不再由渲染端读盘：资产全程不过渲染端、不过 IPC）。
   */
  async function importTheme(kind: "dir" | "css"): Promise<void> {
    setThemeImportError(undefined);
    setThemeImportNote(undefined);
    setThemeImporting(true);
    try {
      const result = await window.piDesktop.themeImport(kind);
      if (!result.ok) {
        if (!result.canceled) setThemeImportError(result.message ?? "主题导入失败");
        return;
      }
      setCustomThemeName(result.name ?? "");
      setEditingCustomThemeId(undefined);
      updateAppearance({ customCss: result.css ?? "" });
      setThemeImportNote(importSummary(result));
    } catch (error) {
      setThemeImportError(error instanceof Error ? error.message : "主题导入失败");
    } finally {
      setThemeImporting(false);
    }
  }

  function saveCustomTheme(): void {
    const css = settings.appearance.customCss;
    if (!css.trim()) return;
    const currentThemes = settings.appearance.customThemes;
    const existingIndex = editingCustomThemeId ? currentThemes.findIndex((theme) => theme.id === editingCustomThemeId) : -1;
    const existing = existingIndex >= 0 ? currentThemes[existingIndex] : undefined;
    const nextTheme: CustomThemeDefinition = {
      id: existing?.id ?? createCustomThemeId(),
      name: customThemeName.trim() || existing?.name || `自定义主题 ${currentThemes.length + 1}`,
      css
    };
    const nextThemes = existingIndex >= 0
      ? currentThemes.map((theme, index) => index === existingIndex ? nextTheme : theme)
      : [...currentThemes, nextTheme];
    setEditingCustomThemeId(nextTheme.id);
    setCustomThemeName(nextTheme.name);
    updateAppearance({ customThemes: nextThemes });
    setThemeImportNote(undefined);
    // 活动资产从草稿槽 current/ 归到 <id>/ **立刻做**：作用域已随 CSS 等值命中变成
    // 主题 id，等到「保存外观设置」才归位的话，这中间壁纸会 404。
    void window.piDesktop.themePromote(nextTheme.id).catch(() => undefined);
  }

  function applyCustomTheme(theme: CustomThemeDefinition): void {
    setEditingCustomThemeId(theme.id);
    setCustomThemeName(theme.name);
    setThemeImportNote(undefined);
    updateAppearance({ customCss: theme.css });
  }

  function deleteCustomTheme(theme: CustomThemeDefinition): void {
    const nextThemes = settings.appearance.customThemes.filter((item) => item.id !== theme.id);
    const isActive = editingCustomThemeId === theme.id || (!editingCustomThemeId && settings.appearance.customCss === theme.css);
    setEditingCustomThemeId(undefined);
    if (isActive) {
      setCustomThemeName("");
      updateAppearance({ customCss: "", customThemes: nextThemes });
      return;
    }
    updateAppearance({ customThemes: nextThemes });
  }

  function exportCustomCss(): void {
    const css = settings.appearance.customCss;
    if (!css.trim()) return;
    const fileName = `${(customThemeName.trim() || "chatanytime-theme").replace(/[<>:"/\\|?*\x00-\x1F]/gu, "-").slice(0, 80)}.css`;
    const url = URL.createObjectURL(new Blob([css], { type: "text/css;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    const nextSettings = structuredClone(settings);
    void window.piDesktop.send({ type: "appearance.save", appearance: nextSettings.appearance });
    onSaved(nextSettings);
  }

  return (
    <form className="appearance-page" data-pane="appearance-settings" onSubmit={onSubmit}>
      <div className="appearance-page-body">
        <div className="appearance-columns">
          <div className="appearance-column">
            <section className="appearance-card" aria-label="主题与预设">
              <div className="appearance-card-head"><strong>主题与预设</strong><small>深浅模式即时生效；预设只换配色，不动你的自定义 CSS</small></div>
              <div className="appearance-card-body">
                <label className="appearance-field"><span>主题模式</span><select value={appearance.theme} onChange={(event) => { const next = event.target.value as "system" | "light" | "dark"; useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, theme: next } } }); setOpacityMode(next === "light" ? "light" : next === "dark" ? "dark" : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")); }}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
                <div className="appearance-preset-field">
                  <span className="appearance-field-label">主题预设</span>
                  <div className="theme-preset-grid">
                    {THEME_PRESETS.map((preset) => (
                      <button type="button" key={preset.id} className={`theme-preset-card${settings.appearance.themePreset === preset.id ? " active" : ""}`} onClick={() => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, themePreset: preset.id as ThemePresetId } } })}>
                        <span className="theme-swatches">{preset.swatches.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span>
                        <strong>{preset.name}</strong>
                        <small>{preset.description}</small>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="appearance-card" aria-label="界面微调">
              <div className="appearance-card-head"><strong>界面微调</strong><small>不改主题，微调界面密度与圆角，切换后实时生效；默认跟随主题</small></div>
              <div className="appearance-card-body">
                <div className="appearance-field-row">
                  <label className="appearance-field"><span>界面密度</span><select value={settings.appearance.tune?.density ?? ""} onChange={(event) => updateTune({ density: event.target.value as InterfaceTuning["density"] | "" })}><option value="">跟随主题</option><option value="compact">紧凑</option><option value="comfortable">舒适</option><option value="relaxed">宽松</option></select></label>
                  <label className="appearance-field"><span>圆角</span><select value={settings.appearance.tune?.radius ?? ""} onChange={(event) => updateTune({ radius: event.target.value as InterfaceTuning["radius"] | "" })}><option value="">跟随主题</option><option value="square">方角</option><option value="small">小圆</option><option value="medium">中圆</option><option value="round">圆润</option></select></label>
                </div>
                <label className="checkbox-setting appearance-motion-switch"><input type="checkbox" checked={settings.appearance.motion !== false} onChange={(event) => setAppearanceMotion(event.target.checked)} />界面动效（关闭后过渡与弹出动画全部停用；系统「减弱动态效果」开启时也会自动停用）</label>
              </div>
            </section>

            <section className="appearance-card" aria-label="透明度">
              <div className="appearance-card-head">
                <strong>透明度</strong>
                <small>背景透明度覆盖主题声明的壁纸不透明度；气泡默认 80%、面板默认 100%，建议不低于 60% 保证文字可读</small>
                <span className="appearance-card-actions">
                  <div className="theme-color-mode-switch" role="tablist" aria-label="透明度模式">
                    <button type="button" className={opacityMode === "light" ? "active" : ""} role="tab" aria-selected={opacityMode === "light"} onClick={() => setOpacityMode("light")}>浅色</button>
                    <button type="button" className={opacityMode === "dark" ? "active" : ""} role="tab" aria-selected={opacityMode === "dark"} onClick={() => setOpacityMode("dark")}>深色</button>
                  </div>
                </span>
              </div>
              <div className="appearance-card-body appearance-opacity-body">
                <div className="theme-opacity-row"><label htmlFor="theme-wallpaper-opacity">背景透明度</label><input id="theme-wallpaper-opacity" type="range" min="0" max="100" step="1" value={wallpaperOpacityPercent} aria-valuetext={`${wallpaperOpacityPercent}%`} onChange={(event) => updateWallpaperOpacity(Number(event.target.value) / 100)} /><output>{wallpaperOpacityPercent}%</output><button className="icon-button theme-color-reset" type="button" disabled={wallpaperOpacityOverride === undefined} title="恢复主题默认透明度" aria-label="恢复主题默认透明度" onClick={resetWallpaperOpacity}><RotateCcw size={14} /></button></div>
                <div className="theme-opacity-row"><label htmlFor="theme-bubble-opacity">气泡透明度</label><input id="theme-bubble-opacity" type="range" min="40" max="100" step="1" value={bubbleOpacityPercent} aria-valuetext={`${bubbleOpacityPercent}%`} onChange={(event) => updateBubbleOpacity(Number(event.target.value) / 100)} /><output>{bubbleOpacityPercent}%</output><button className="icon-button theme-color-reset" type="button" disabled={bubbleOpacityOverride === undefined} title="恢复默认气泡透明度（80%）" aria-label="恢复默认气泡透明度" onClick={resetBubbleOpacity}><RotateCcw size={14} /></button></div>
                <div className="theme-opacity-row"><label htmlFor="theme-panel-opacity">面板透明度</label><input id="theme-panel-opacity" type="range" min="40" max="100" step="1" value={panelOpacityPercent} aria-valuetext={`${panelOpacityPercent}%`} onChange={(event) => updatePanelOpacity(Number(event.target.value) / 100)} /><output>{panelOpacityPercent}%</output><button className="icon-button theme-color-reset" type="button" disabled={panelOpacityOverride === undefined} title="恢复默认面板透明度（100%）" aria-label="恢复默认面板透明度" onClick={resetPanelOpacity}><RotateCcw size={14} /></button></div>
                <p className="appearance-hint">颜色完全由主题 CSS 决定，主题未设置壁纸时背景透明度不生效。</p>
              </div>
            </section>

            <section className="appearance-card" aria-label="自定义 CSS">
              <div className="appearance-card-head">
                <strong>自定义 CSS</strong>
                <small>原样应用（只做旧变量别名映射与模式选择器重定作用域）</small>
                <span className="appearance-card-actions">
                  <button className="secondary-button compact-button" type="button" data-control="appearance-import-css" disabled={themeImporting} onClick={() => void importTheme("css")}>导入 CSS</button>
                  <button className="secondary-button compact-button" type="button" data-control="appearance-import-theme" disabled={themeImporting} onClick={() => void importTheme("dir")}>导入主题目录</button>
                  <button className="secondary-button compact-button" type="button" data-control="appearance-clear-css" onClick={() => { setEditingCustomThemeId(undefined); setCustomThemeName(""); setThemeImportError(undefined); setThemeImportNote(undefined); updateAppearance({ customCss: "" }); }}>清空</button>
                </span>
              </div>
              <div className="appearance-card-body">
                <label className="custom-css-field"><textarea value={settings.appearance.customCss} spellCheck={false} rows={10} placeholder={":root[data-theme-effective=\"dark\"] {\n  --accent: #8b5cf6;\n}"} aria-label="自定义 CSS" onChange={(event) => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, customCss: event.target.value } } })} /></label>
                {themeImportError && <p className="form-error appearance-import-error">{themeImportError}</p>}
                {themeImportNote && <p className="appearance-hint appearance-import-note">{themeImportNote}</p>}
                <CustomThemeLibrary customCss={settings.appearance.customCss} customThemes={settings.appearance.customThemes} customThemeName={customThemeName} editingCustomThemeId={editingCustomThemeId} onNameChange={setCustomThemeName} onSave={saveCustomTheme} onExport={exportCustomCss} onApply={applyCustomTheme} onDelete={deleteCustomTheme} />
              </div>
            </section>
          </div>

          <aside className="appearance-preview"><ThemePreview appearance={settings.appearance} /></aside>
        </div>
      </div>

      <footer className="appearance-page-footer">
        <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
        <button className="primary-button" type="submit" data-control="appearance-save">保存外观设置</button>
      </footer>
    </form>
  );
}

/** 界面动效开关（语义与旧实现一致：只在 appearance 上写 motion）。 */
function setAppearanceMotion(enabled: boolean): void {
  const live = useDesktopStore.getState().settings;
  useDesktopStore.setState({ settings: { ...live, appearance: { ...live.appearance, motion: enabled } } });
}

const DEFAULT_BUBBLE_OPACITY = 0.8;
// Panel translucency keeps the theme's own --panel-bg by default (100%).
const DEFAULT_PANEL_OPACITY = 1;

/** 主题预览（从 App.tsx 平移，仅本页使用）：深浅两栏共用同一份富内容。 */
function ThemePreview({ appearance }: { appearance: AppearanceSettingsValue }): ReactNode {
  const previewContent = `**实时主题预览**

Markdown、表格、代码、公式和图表会共用当前主题变量。

| 输出 | 状态 |
| --- | --- |
| 代码高亮 | 跟随主题 |
| HTML 片段 | 已清洗 |

\`\`\`ts
const theme = "live";
\`\`\`

$$E = mc^2$$

\`\`\`mermaid
flowchart LR
  Theme[主题] --> Preview[实时预览]
  Preview --> Output[消息输出]
\`\`\`

<assistant_html><div><strong>HTML 片段</strong><p>安全清洗后仍保留布局和交互样式。</p></div></assistant_html>`;
  const previewCss = `${themePreviewCss(appearance.themePreset)}\n${scopeCustomThemeCssForPreview(resolveThemeAssetUrls(appearance.customCss, activeThemeScope(appearance)))}\n${wallpaperOpacityCss(appearance.wallpaperOpacity, ".theme-preview-scope[data-theme-custom]")}\n${bubbleOpacityCss(appearance.bubbleOpacity, ".theme-preview-scope[data-theme-custom]")}\n${panelOpacityCss(appearance.panelOpacity, ".theme-preview-scope[data-theme-custom]")}`;
  const hasWallpaper = customCssHasWallpaper(appearance.customCss);
  const panes = [
    { id: "dark", label: "深色", effective: "dark" },
    { id: "light", label: "浅色", effective: "light" }
  ] as const;
  return (
    <div className="theme-preview" aria-label="主题预览">
      <style>{previewCss}</style>
      <div className="theme-preview-header"><span className="theme-preview-dot" /><strong>Pi Desktop</strong><small>深浅模式实时预览</small></div>
      <div className="theme-preview-modes">
        {panes.map((pane) => (
          <section className="theme-preview-pane theme-preview-scope" data-theme={pane.effective} data-theme-effective={pane.effective} data-theme-preset={appearance.themePreset} data-theme-custom="true" data-theme-wallpaper={hasWallpaper ? "true" : undefined} key={pane.id}>
            <header className="theme-preview-pane-header"><strong>{pane.label}模式</strong><small>富内容输出</small></header>
            <div className="theme-preview-body"><div className="theme-preview-user-bubble">用户消息：主题色也会实时更新</div><RichContent streaming={false} artifactPrefix={`theme-preview-${pane.id}`} onOpenArtifact={() => undefined}>{previewContent}</RichContent></div>
          </section>
        ))}
      </div>
    </div>
  );
}

interface CustomThemeLibraryProps {
  customCss: string;
  customThemes: CustomThemeDefinition[];
  customThemeName: string;
  editingCustomThemeId?: string;
  onNameChange(name: string): void;
  onSave(): void;
  onExport(): void;
  onApply(theme: CustomThemeDefinition): void;
  onDelete(theme: CustomThemeDefinition): void;
}

/** 自定义主题库（从 App.tsx 平移，仅本页使用）。 */
function CustomThemeLibrary({ customCss, customThemes, customThemeName, editingCustomThemeId, onNameChange, onSave, onExport, onApply, onDelete }: CustomThemeLibraryProps): ReactNode {
  return (
    <div className="custom-theme-library">
      <div className="custom-theme-library-heading">
        <label className="custom-theme-name-field">当前 CSS 主题名称<input value={customThemeName} placeholder="例如：午夜玻璃" onChange={(event) => onNameChange(event.target.value)} /></label>
        <div className="custom-theme-library-actions"><button className="secondary-button compact-button" type="button" data-control="appearance-save-theme" disabled={!customCss.trim()} onClick={onSave}><Save size={13} />保存当前主题</button><button className="secondary-button compact-button" type="button" title="只导出 CSS 文本；图片/字体资产不包含（主题资产已落盘到 agentDir，可自行复制该目录）" disabled={!customCss.trim()} onClick={onExport}><Download size={13} />导出 CSS</button></div>
      </div>
      {customThemes.length > 0 ? (
        <div className="custom-theme-list">
          {customThemes.map((theme) => (
            <div className={`custom-theme-item${editingCustomThemeId === theme.id ? " active" : ""}`} key={theme.id}>
              <button className="custom-theme-select" type="button" onClick={() => onApply(theme)}>
                <span className="custom-theme-swatch" aria-hidden="true" />
                <span><strong>{theme.name}</strong><small>{theme.css.trim().split("\n")[0]?.slice(0, 56) || "空 CSS"}</small></span>
              </button>
              <button className="icon-button custom-theme-delete" type="button" title={`删除主题 ${theme.name}`} aria-label={`删除主题 ${theme.name}`} onClick={() => onDelete(theme)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      ) : <p className="custom-theme-empty">保存后的 CSS 主题会出现在这里，可随时点击切换并实时预览。</p>}
    </div>
  );
}

function createCustomThemeId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return `custom-${globalThis.crypto.randomUUID()}`;
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 导入结果的一句话摘要（资产落盘统计 + 未命中的引用 + 下一步提示）。 */
function importSummary(result: ThemeImportOutcome): string {
  const parts: string[] = [];
  parts.push(result.assetCount ? `已落盘 ${result.assetCount} 个资产（${formatBytes(result.bytes ?? 0)}）` : "主题未引用资产文件");
  if (result.missing?.length) parts.push(`有 ${result.missing.length} 个引用没找到：${result.missing.slice(0, 3).join("、")}`);
  if (result.skipped?.length) parts.push(`已跳过不支持的格式：${result.skipped.slice(0, 3).join("、")}`);
  parts.push("点「保存当前主题」收进主题库");
  return parts.join("；");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
