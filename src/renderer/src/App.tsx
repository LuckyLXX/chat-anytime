import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  Download,
  Eye,
  Folder,
  FolderOpen,
  LoaderCircle,
  MessageSquarePlus,
  MessageCircle,
  Puzzle,
  Search,
  Server,
  SquarePen,
  Zap,
  Users,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Plus,
  RefreshCw,
  RotateCcw,
  Pencil,
  Save,
  Settings,
  Trash2,
  FolderTree,
  GitBranch,
  ChevronLeft,
  Pin,
  History,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type {
  AccessMode,
  AppearanceSettings,
  InterfaceTuning,
  BrowserElementPick,
  AgentProfile,
  BuiltinToolName,
  ProviderSettings,
  ProviderModelSettings,
  CustomProviderModel,
  ModelOption,
  McpServerStatus,
  ProviderOption,
  CustomThemeDefinition,
  DivBubbleMode,
  ThinkingLevel,
  ThemeAssetMap,
  ThemeMode,
  ThemePresetId,
  ToolExecution,
  ResourceCatalog,
  ResourceScope,
  CommandDraft,
  CommandSummary,
  McpServerConfigDraft,
  RuntimeCommand,
  SessionSummary
} from "../../shared/protocol";
import { sessionRunStatusLabels, thinkingLevelLabels, toolLabel } from "../../shared/locale";
import type { ReplyChangedFile } from "./lib/changed-files";
import { ArtifactPreview, type PreviewEditorState, type PreviewTab, type PreviewTarget } from "./components/ArtifactPreview";
import type { EditorSaveStatus } from "./components/MarkdownEditor";
import { WorkspaceTree } from "./components/WorkspaceTree";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { RichContent } from "./components/RichContent";
import { PermissionDialog } from "./components/RuntimeDialogs";
import { detailTitle } from "./components/QuestionPanel";
import { compactPath, type Artifact } from "./lib/content";
import { composePickMessage } from "./lib/browser-pick";
import { DiffView } from "./components/DiffView";
import { clampPreviewSplit, PREVIEW_SPLIT_MAX, PREVIEW_SPLIT_MIN, previewSplitFromKey } from "./lib/preview-split";
import { groupSessionsByWorkspace, workspaceKey } from "./lib/session-groups";
import { filterProviderModels, setProviderModelsEnabled, buildBuiltinProviderEntry, selectableCatalogModels, parseTokenLimit, formatTokenLimit, providerFormBlocker, groupModelsByProvider } from "./lib/model-list";
import { CSS_URL_PATTERN, createThemeAssetUrls, isExternalThemeReference, normalizeThemeAssetReference, resolveThemeAssets } from "./lib/theme-assets";
import { THEME_PRESETS, bubbleOpacityCss, collectThemeLayers, panelOpacityCss, scopeCustomThemeCss, scopeCustomThemeCssForPreview, themePresetCss, themePreviewCss, themeWallpaperOpacity, wallpaperOpacityCss } from "./lib/theme-presets";
import { panePermissionRequest, paneQuestionRequest, dropPaneStates, pruneParkedPanels, useDesktopStore } from "./store";
import { ConversationPane, type PaneComposerApi, type PaneDraftStore } from "./ConversationPane";
import { SplitLayout } from "./SplitLayout";
import {
  MAX_SPLIT_PANES,
  balancedAddPane,
  countLeaves,
  firstLeafId,
  leafIds,
  parseStoredSplitLayout,
  pruneToIds,
  removePane,
  replaceLeaf,
  updateRatio,
  type SplitNode
} from "./lib/split-layout";
import { HooksSettings } from "./HooksSettings";
import { SubagentSettings } from "./SubagentSettings";
import { UsageSettings } from "./UsageSettings";

const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_BUBBLE_OPACITY = 0.8;
// Panel translucency keeps the theme's own --panel-bg by default (100%).
const DEFAULT_PANEL_OPACITY = 1;
const accessModeOptions: readonly { value: AccessMode; label: string }[] = [
  { value: "read-only", label: "只读" },
  { value: "ask", label: "每次询问" },
  { value: "workspace", label: "工作区访问" },
  { value: "full", label: "完全访问" }
];

function previewTargetKey(target: PreviewTarget): string {
  switch (target.type) {
    case "artifact": return target.artifact.id;
    case "browser": return target.id ?? "browser";
    case "terminal": return "terminal";
    case "file": return target.file.relativePath;
    case "plan": return "plan";
    default: return `${target.type}-${target.path ?? target.title}`;
  }
}

interface PreviewState {
  tabs: PreviewTab[];
  activeTabId: string;
}
// powershell 为 opt-in：新建 Agent 默认关闭（与 settings.defaultToolEnabled 对齐）。
const agentTools: BuiltinToolName[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

type SlashCommandBase = {
  trigger: string;
  label: string;
  description: string;
};

type SlashCommand = SlashCommandBase & (
  | { kind: "skill"; skillName: string }
  | { kind: "command"; command: RuntimeCommand }
);

function createCustomThemeId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return `custom-${globalThis.crypto.randomUUID()}`;
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cssThemeNameFromFile(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/u, "").trim();
}

type ThemeDirectoryFile = File & { webkitRelativePath?: string };

function themeRelativePath(file: File): string {
  const relative = (file as ThemeDirectoryFile).webkitRelativePath || file.name;
  return relative.replaceAll("\\", "/").replace(/^\.\/+?/u, "");
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("无法读取主题资源文件"));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取主题资源文件"));
    reader.readAsDataURL(file);
  });
}

function themeNameFromCss(css: string, fallback: string): string {
  const match = /(?:Theme Name|主题)\s*[:：]\s*([^\r\n*]+)/iu.exec(css);
  return match?.[1]?.trim() || fallback;
}

function customCssHasWallpaper(css: string): boolean {
  return /--chat-bg-image\s*:\s*(?!none\b)/iu.test(css);
}

async function collectThemeAssets(css: string, cssFile: File, files: File[]): Promise<ThemeAssetMap> {
  const assetFiles = files.filter((file) => /\.(?:png|jpe?g|webp|gif|woff2?|ttf|otf)$/iu.test(file.name));
  const assets = await Promise.all(assetFiles.map(async (file) => [themeRelativePath(file).toLowerCase(), await readFileAsDataUrl(file)] as const));
  const cssPath = themeRelativePath(cssFile);
  const cssDirectory = cssPath.includes("/") ? cssPath.slice(0, cssPath.lastIndexOf("/")) : "";
  const result: ThemeAssetMap = {};
  css.replace(CSS_URL_PATTERN, (match, _quote: string, rawReference: string) => {
    const reference = normalizeThemeAssetReference(rawReference);
    if (isExternalThemeReference(reference)) return match;
    const candidates = [
      cssDirectory ? `${cssDirectory}/${reference}` : reference,
      reference
    ];
    const asset = assets.find(([path]) => candidates.includes(path) || path.endsWith(`/${reference}`) || path.split("/").at(-1) === reference);
    if (asset) result[reference] = asset[1];
    return match;
  });
  return result;
}

function themeAssetsForAppearance(appearance: AppearanceSettings): ThemeAssetMap | undefined {
  if (appearance.customCssAssets) return appearance.customCssAssets;
  return appearance.customThemes.find((theme) => theme.css === appearance.customCss)?.assets;
}

function useThemeAssetUrls(assets: ThemeAssetMap | undefined): ThemeAssetMap {
  const [urls, setUrls] = useState<ThemeAssetMap>({});
  useEffect(() => {
    const assetUrlSet = createThemeAssetUrls(assets);
    setUrls(assetUrlSet.urls);
    return assetUrlSet.revoke;
  }, [assets]);
  return urls;
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function readStoredPreviewSplit(): number {
  try {
    const value = window.localStorage.getItem("pidesktop.preview-split");
    return value === null ? 50 : clampPreviewSplit(Number(value));
  } catch {
    return 50;
  }
}

/** 启动时恢复上次的分屏布局（会话列表就绪后逐格激活；失效格子被修剪）。
 *  单叶布局归一化为 null（单格不该走分屏渲染分支）。 */
function readStoredSplitState(): { tree: SplitNode | null; focusedPane?: string } {
  try {
    const parsed = parseStoredSplitLayout(window.localStorage.getItem("pidesktop.split-layout"));
    if (!parsed || parsed.tree.kind === "leaf") return { tree: null };
    return parsed;
  } catch {
    return { tree: null };
  }
}

function PreviewDivider({ split, dragging, onStart, onMove, onEnd, onCancel, onKeyDown, onReset }: {
  split: number;
  dragging: boolean;
  onStart(event: ReactPointerEvent<HTMLDivElement>): void;
  onMove(event: ReactPointerEvent<HTMLDivElement>): void;
  onEnd(event: ReactPointerEvent<HTMLDivElement>): void;
  onCancel(event: ReactPointerEvent<HTMLDivElement>): void;
  onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void;
  onReset(): void;
}): ReactNode {
  const [stacked, setStacked] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = (): void => setStacked(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return (
    <div
      className={`preview-divider${dragging ? " dragging" : ""}`}
      role="separator"
      aria-label="调整聊天和预览宽度"
      aria-orientation={stacked ? "horizontal" : "vertical"}
      aria-valuemin={PREVIEW_SPLIT_MIN}
      aria-valuemax={PREVIEW_SPLIT_MAX}
      aria-valuenow={Math.round(split)}
      aria-valuetext={`${Math.round(split)}% 聊天区域`}
      title="拖动调整分屏，双击恢复均分"
      tabIndex={0}
      onPointerDown={onStart}
      onPointerMove={onMove}
      onPointerUp={onEnd}
      onPointerCancel={onCancel}
      onLostPointerCapture={onCancel}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
    />
  );
}
function ThemePreview({ appearance }: { appearance: AppearanceSettings }): ReactNode {
  const themeAssetUrls = useThemeAssetUrls(themeAssetsForAppearance(appearance));
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
  const previewCss = `${themePreviewCss(appearance.themePreset)}\n${scopeCustomThemeCssForPreview(resolveThemeAssets(appearance.customCss, themeAssetUrls))}\n${wallpaperOpacityCss(appearance.wallpaperOpacity, ".theme-preview-scope[data-theme-custom]")}\n${bubbleOpacityCss(appearance.bubbleOpacity, ".theme-preview-scope[data-theme-custom]")}\n${panelOpacityCss(appearance.panelOpacity, ".theme-preview-scope[data-theme-custom]")}`;
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

function CustomThemeLibrary({ customCss, customThemes, customThemeName, editingCustomThemeId, onNameChange, onSave, onExport, onApply, onDelete }: CustomThemeLibraryProps): ReactNode {
  return (
    <div className="custom-theme-library">
      <div className="custom-theme-library-heading">
        <label className="custom-theme-name-field">当前 CSS 主题名称<input value={customThemeName} placeholder="例如：午夜玻璃" onChange={(event) => onNameChange(event.target.value)} /></label>
        <div className="custom-theme-library-actions"><button className="secondary-button" type="button" disabled={!customCss.trim()} onClick={onSave}><Save size={13} />保存当前主题</button><button className="secondary-button" type="button" disabled={!customCss.trim()} onClick={onExport}><Download size={13} />导出 CSS</button></div>
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

const resourceScopeLabels: Record<ResourceScope, string> = {
  global: "全局",
  project: "当前项目",
  package: "Pi Package",
  bundled: "内置",
  temporary: "临时",
  unknown: "未知"
};

const mcpStatusLabels: Record<McpServerStatus, string> = {
  connected: "已连接",
  cached: "有缓存",
  failed: "连接失败",
  "needs-auth": "需要认证",
  "not-connected": "未连接",
  disabled: "已停用"
};

function parseKeyValueLines(value: string): Record<string, string> | undefined {
  const entries = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`环境变量格式无效：${line}，应为 KEY=VALUE`);
    const key = line.slice(0, separator).trim();
    const entryValue = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error(`环境变量名无效：${key}`);
    return [key, entryValue] as const;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

interface ResourceSettingsProps {
  resources: ResourceCatalog;
}

function ResourceSettings({ resources }: ResourceSettingsProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpScope, setMcpScope] = useState<McpServerConfigDraft["scope"]>("project");
  const [mcpTransport, setMcpTransport] = useState<McpServerConfigDraft["transport"]>("stdio");
  const [mcpCommand, setMcpCommand] = useState("npx");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpAuth, setMcpAuth] = useState<NonNullable<McpServerConfigDraft["auth"]>>("none");
  const [mcpBearerTokenEnv, setMcpBearerTokenEnv] = useState("");
  const [mcpEnv, setMcpEnv] = useState("");
  const [commandFormOpen, setCommandFormOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<string>();
  const [commandName, setCommandName] = useState("");
  const [commandDescription, setCommandDescription] = useState("");
  const [commandTemplate, setCommandTemplate] = useState("");
  const [commandScope, setCommandScope] = useState<CommandDraft["scope"]>("project");
  const workspaceOpen = useDesktopStore((state) => Boolean(state.snapshot.workspace));
  const runtimeBusy = useDesktopStore((state) => state.snapshot.busy);
  const controlsBusy = busy || runtimeBusy;

  async function run(command: RuntimeCommand): Promise<boolean> {
    setBusy(true);
    setLocalError(undefined);
    try {
      await window.piDesktop.send(command);
      return true;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "资源操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 编辑已有命令：回填表单并展开（名字锁定，改名=删旧建新）。 */
  function editCommand(entry: CommandSummary): void {
    setEditingCommand(entry.name);
    setCommandName(entry.name);
    setCommandDescription(entry.description);
    setCommandTemplate(entry.template ?? "");
    setCommandScope(entry.scope === "project" ? "project" : "global");
    setCommandFormOpen(true);
  }

  async function saveCommand(event: FormEvent): Promise<void> {
    event.preventDefault();
    const success = await run({ type: "command.save", command: { name: commandName.trim(), description: commandDescription.trim() || undefined, template: commandTemplate, scope: commandScope } });
    if (!success) return;
    setCommandFormOpen(false);
    setEditingCommand(undefined);
    setCommandName("");
    setCommandDescription("");
    setCommandTemplate("");
  }

  async function addMcpServer(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const server: McpServerConfigDraft = {
        name: mcpName.trim(),
        scope: mcpScope,
        transport: mcpTransport,
        ...(mcpTransport === "stdio"
          ? {
              command: mcpCommand.trim(),
              args: mcpArgs.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
              env: parseKeyValueLines(mcpEnv)
            }
          : {
              url: mcpUrl.trim(),
              auth: mcpAuth,
              ...(mcpAuth === "bearer-env" ? { bearerTokenEnv: mcpBearerTokenEnv.trim() } : {})
            })
      };
      const success = await run({ type: "mcp.server.save", server });
      if (!success) return;
      setMcpName("");
      setMcpUrl("");
      setMcpArgs("");
      setMcpEnv("");
      setMcpBearerTokenEnv("");
      setMcpFormOpen(false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "MCP Server 配置无效");
    }
  }

  return (
    <div className="resource-settings">
      <div className="resource-settings-header"><div><h3><Puzzle size={16} />技能与工具</h3><p>自研 MCP / Skill / Todo / 子代理能力。Pi 的第三方扩展接入已移除，MCP 由内置客户端直连。</p></div><div className="resource-section-actions"><button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => void run({ type: "resources.reload" })}><RefreshCw size={13} className={controlsBusy ? "spinning" : undefined} />重载资源</button></div></div>
      {localError && <p className="form-error resource-error">{localError}</p>}
      <section className="resource-section">
        <div className="resource-section-heading"><span><Server size={14} />MCP Server</span><div className="resource-section-actions"><small>{resources.mcpServers.length} 个</small><button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={() => setMcpFormOpen((open) => !open)}><Plus size={13} />{mcpFormOpen ? "收起" : "添加"}</button></div></div>
        {mcpFormOpen && <form className="mcp-config-form" onSubmit={(event) => void addMcpServer(event)}>
          <div className="mcp-form-grid">
            <label>名称<input value={mcpName} placeholder="例如 context7" onChange={(event) => setMcpName(event.target.value)} /></label>
            <label>写入范围<select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpServerConfigDraft["scope"])}><option value="project">当前项目 .mcp.json</option><option value="global">用户全局配置</option></select></label>
            <label>连接方式<select value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value as McpServerConfigDraft["transport"])}><option value="stdio">本地命令（stdio）</option><option value="http">远程地址（HTTP）</option></select></label>
            {mcpTransport === "stdio" ? <>
              <label>启动命令<input value={mcpCommand} placeholder="npx" onChange={(event) => setMcpCommand(event.target.value)} /></label>
              <label className="mcp-form-wide">参数（每行一个）<textarea value={mcpArgs} rows={3} placeholder={"-y\ncontext7-mcp"} onChange={(event) => setMcpArgs(event.target.value)} /></label>
              <label className="mcp-form-wide">环境变量（可选，每行 KEY=VALUE）<textarea value={mcpEnv} rows={2} placeholder="API_KEY=xxx" onChange={(event) => setMcpEnv(event.target.value)} /></label>
            </> : <>
              <label className="mcp-form-wide">服务器地址<input value={mcpUrl} placeholder="https://mcp.example.com/mcp" onChange={(event) => setMcpUrl(event.target.value)} /></label>
              <label>认证<select value={mcpAuth} onChange={(event) => setMcpAuth(event.target.value as NonNullable<McpServerConfigDraft["auth"]>)}><option value="none">无</option><option value="oauth">OAuth</option><option value="bearer-env">Bearer 环境变量</option></select></label>
              {mcpAuth === "bearer-env" && <label>Token 环境变量<input value={mcpBearerTokenEnv} placeholder="MCP_TOKEN" onChange={(event) => setMcpBearerTokenEnv(event.target.value)} /></label>}
            </>}
          </div>
          <p className="resource-form-help">添加后会写入 MCP 配置并重建会话以加载新工具。stdio 服务通常由 npx 首次启动；敏感值建议用环境变量名，不要直接写入配置。</p>
          <footer className="mcp-form-actions"><button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setMcpFormOpen(false)}><X size={13} />取消</button><button className="primary-button" type="submit" disabled={controlsBusy}><Plus size={13} />添加 MCP</button></footer>
        </form>}
        {resources.mcpServers.length === 0 ? <p className="resource-empty">未发现 MCP Server。点击“添加”，或将已有配置放入 `.mcp.json`。</p> : <div className="resource-list">{resources.mcpServers.map((server) => <div className="resource-item mcp-resource-item" key={server.name}><div className={`resource-item-icon mcp-status-icon ${server.status}`}><Server size={14} /></div><div className="resource-item-copy"><strong>{server.name}</strong><small>{mcpStatusLabels[server.status]} · {server.toolCount} 个工具{server.resourceCount === undefined ? "" : ` · ${server.resourceCount} 个资源`}{server.failedAgoSeconds !== undefined ? ` · ${server.failedAgoSeconds} 秒前失败` : ""}</small>{server.error && <em>{server.error}</em>}</div><label className="resource-toggle"><input type="checkbox" checked={!server.disabled} disabled={controlsBusy} onChange={(event) => void run({ type: "mcp.server.toggle", name: server.name, enabled: event.target.checked })} /><span>启用</span></label><button className="icon-button resource-remove" type="button" title={`删除 ${server.name}`} aria-label={`删除 MCP ${server.name}`} disabled={controlsBusy} onClick={() => void run({ type: "mcp.server.delete", name: server.name, scope: "project" })}><Trash2 size={14} /></button></div>)}</div>}
      </section>
      <section className="resource-section">
        <div className="resource-section-heading"><span><Puzzle size={14} />Skill</span><small>{resources.skills.length} 个已发现</small></div>
        <p className="resource-form-help">把 <code>{`<slug>/SKILL.md`}</code> 放到全局目录 <code>pidesktop-skills/</code>、共享目录 <code>~/.agents/skills/</code> 或项目目录 <code>.pidesktop-skills/</code> 即可被发现，启用后会注入系统提示供模型调用。</p>
        {resources.skills.length === 0 ? <p className="resource-empty">当前没有发现 Skill。</p> : <div className="resource-list">{resources.skills.map((skill) => <div className="resource-item" key={skill.id}><div className="resource-item-icon"><Puzzle size={14} /></div><div className="resource-item-copy"><strong>/skill:{skill.name}</strong><small>{skill.description}</small><em>{resourceScopeLabels[skill.scope]} · {skill.source}{skill.disableModelInvocation ? " · 仅手动调用" : ""}</em></div><label className="resource-toggle"><input type="checkbox" checked={skill.enabled} disabled={controlsBusy || !skill.toggleable} onChange={(event) => void run({ type: "skill.toggle", id: skill.id, enabled: event.target.checked })} /><span>启用</span></label></div>)}</div>}
      </section>
      <section className="resource-section">
        <div className="resource-section-heading"><span><Zap size={14} />自定义命令</span><div className="resource-section-actions"><small>{resources.commands.length} 个</small><button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={() => { if (!commandFormOpen) { setEditingCommand(undefined); setCommandName(""); setCommandDescription(""); setCommandTemplate(""); setCommandScope(workspaceOpen ? "project" : "global"); } setCommandFormOpen((open) => !open); }}><Plus size={13} />{commandFormOpen ? "收起" : "添加"}</button></div></div>
        <p className="resource-form-help">md 模板文件名即命令名，正文支持 <code>$ARGUMENTS</code> 占位符；放到全局目录 <code>pidesktop-commands/</code> 或项目目录 <code>.pidesktop-commands/</code>（项目同名覆盖全局），也可直接在这里创建维护。输入框 <code>/命令名</code> 调用，改完下次发送即生效。</p>
        {commandFormOpen && <form className="mcp-config-form" onSubmit={(event) => void saveCommand(event)}>
          <div className="mcp-form-grid">
            <label>命令名{editingCommand ? <input value={commandName} disabled title="编辑时不改名；需要改名请删除后新建" /> : <input value={commandName} placeholder="例如 commit（支持中文）" onChange={(event) => setCommandName(event.target.value)} />}</label>
            <label>写入范围<select value={commandScope} onChange={(event) => setCommandScope(event.target.value as CommandDraft["scope"])}><option value="project">当前项目 .pidesktop-commands/</option><option value="global">用户全局 pidesktop-commands/</option></select></label>
            <label className="mcp-form-wide">说明（菜单副标题，可空）<input value={commandDescription} placeholder="例如 为当前改动生成提交信息" onChange={(event) => setCommandDescription(event.target.value)} /></label>
            <label className="mcp-form-wide">提示词模板（$ARGUMENTS 替换为发送时输入的参数）<textarea value={commandTemplate} rows={6} placeholder={"读取暂存区改动，按 type(scope): 中文描述 规范生成提交：$ARGUMENTS"} onChange={(event) => setCommandTemplate(event.target.value)} /></label>
          </div>
          <footer className="mcp-form-actions"><button className="secondary-button" type="button" disabled={controlsBusy} onClick={() => setCommandFormOpen(false)}><X size={13} />取消</button><button className="primary-button" type="submit" disabled={controlsBusy}>{editingCommand ? <Pencil size={13} /> : <Plus size={13} />}{editingCommand ? "保存修改" : "添加命令"}</button></footer>
        </form>}
        {resources.commands.length === 0 ? <p className="resource-empty">当前没有发现自定义命令。点击“添加”创建，或把 md 模板放入命令目录。</p> : <div className="resource-list">{resources.commands.map((entry) => <div className="resource-item" key={entry.name}><div className="resource-item-icon"><Zap size={14} /></div><div className="resource-item-copy"><strong>/{entry.name}</strong><small>{entry.description || "自定义命令"}</small><em>{resourceScopeLabels[entry.scope]}{entry.filePath ? ` · ${entry.filePath}` : ""}</em></div><button className="icon-button" type="button" title={`编辑 ${entry.name}`} aria-label={`编辑命令 ${entry.name}`} disabled={controlsBusy} onClick={() => editCommand(entry)}><Pencil size={14} /></button><button className="icon-button resource-remove" type="button" title={`删除 ${entry.name}`} aria-label={`删除命令 ${entry.name}`} disabled={controlsBusy} onClick={() => void run({ type: "command.delete", name: entry.name, scope: entry.scope === "project" ? "project" : "global" })}><Trash2 size={14} /></button></div>)}</div>}
      </section>
      {resources.diagnostics.length > 0 && <div className="resource-diagnostics"><strong>资源诊断</strong>{resources.diagnostics.map((diagnostic) => <p key={diagnostic}>{diagnostic}</p>)}</div>}

    </div>
  );
}

interface AgentSkillSelectorProps {
  agent: AgentProfile;
  skills: ResourceCatalog["skills"];
  onChange(skillId: string, enabled: boolean): void;
}

function agentSkillEnabled(agent: AgentProfile, skill: ResourceCatalog["skills"][number]): boolean {
  return agent.skillOverrides?.[skill.id] ?? skill.defaultEnabled;
}

function AgentSkillSelector({ agent, skills, onChange }: AgentSkillSelectorProps): ReactNode {
  const selectedSkills = skills.filter((skill) => agentSkillEnabled(agent, skill));
  return (
    <div className="agent-skill-field">
      <div className="agent-skill-heading"><span>Skill</span><small>{selectedSkills.length} 个已选择</small></div>
      {selectedSkills.length > 0
        ? <div className="agent-skill-chips">{selectedSkills.map((skill) => <span className="agent-skill-chip" key={skill.id}><Puzzle size={12} /><span>{skill.name}</span>{skill.toggleable && <button type="button" title={`移除 ${skill.name}`} aria-label={`移除 Skill ${skill.name}`} onClick={() => onChange(skill.id, false)}><X size={12} /></button>}</span>)}</div>
        : <p className="agent-skill-empty">未选择 Skill</p>}
      <details className="agent-skill-picker">
        <summary><Puzzle size={14} /><span>选择 Skill</span><ChevronDown size={14} /></summary>
        <div className="agent-skill-menu">
          {skills.length === 0
            ? <p>当前没有可用 Skill</p>
            : skills.map((skill) => {
                const checked = agentSkillEnabled(agent, skill);
                return <label className="agent-skill-option" key={skill.id} title={skill.toggleable ? undefined : "该 Skill 由运行时动态提供"}><input type="checkbox" checked={checked} disabled={!skill.toggleable} onChange={(event) => onChange(skill.id, event.target.checked)} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span>{checked && <Check size={14} />}</label>;
              })}
        </div>
      </details>
    </div>
  );
}

function SettingsDialog({ settings, models, providers, customProvider, customProviderKeyConfigured, customModels, customModelFetchStatus, customModelFetchError, modelRefreshStatus, modelRefreshError, modelRefreshProvider, resources, workspaceOpen, onClose }: { settings: import("../../shared/protocol").DesktopSettings; models: ModelOption[]; providers: ProviderOption[]; customProvider?: ProviderSettings; customProviderKeyConfigured: boolean; customModels: CustomProviderModel[]; customModelFetchStatus: "idle" | "loading" | "success" | "error"; customModelFetchError?: string; modelRefreshStatus: "idle" | "loading" | "success" | "error"; modelRefreshError?: string; modelRefreshProvider?: string; resources: ResourceCatalog; workspaceOpen: boolean; onClose(): void }): ReactNode {
  const customProviderId = "chatanytime-openai-compatible";
  const configuredProviders = settings.providers;
  const firstCustomProvider = configuredProviders[0];
  const [provider, setProvider] = useState(firstCustomProvider?.id ?? customProviderId);
  const selectedProvider = configuredProviders.find((item) => item.id === provider);
  const isCustomProvider = provider === customProviderId || provider.startsWith("provider-") || (selectedProvider !== undefined && selectedProvider.custom !== false);
  const [customName, setCustomName] = useState(selectedProvider?.name ?? customProvider?.name ?? "我的中转站");
  const [customBaseUrl, setCustomBaseUrl] = useState(selectedProvider?.baseUrl ?? customProvider?.baseUrl ?? "");
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
  const [tab, setTab] = useState<"general" | "models" | "agents" | "subagents" | "appearance" | "resources" | "hooks" | "usage">("general");
  const [opacityMode, setOpacityMode] = useState<ThemeMode>(() => {
    const { theme } = settings.appearance;
    if (theme === "light") return "light";
    if (theme === "dark") return "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const initialSettingsRef = useRef<import("../../shared/protocol").DesktopSettings>(structuredClone(settings));
  const [agentList, setAgentList] = useState<AgentProfile[]>(settings.agents);
  const [selectedAgentId, setSelectedAgentId] = useState(settings.currentAgentId);
  const cssFileInputRef = useRef<HTMLInputElement>(null);
  const themeDirectoryInputRef = useRef<HTMLInputElement>(null);
  const [themeImportError, setThemeImportError] = useState<string>();
  const initialCustomTheme = settings.appearance.customThemes.find((theme) => theme.css === settings.appearance.customCss);
  const [customThemeName, setCustomThemeName] = useState(initialCustomTheme?.name ?? "");
  const [editingCustomThemeId, setEditingCustomThemeId] = useState<string | undefined>(initialCustomTheme?.id);
  const selectedAgent = agentList.find((agent) => agent.id === selectedAgentId) ?? agentList[0];
  const configuredModels = selectableCatalogModels(models).filter((model) => model.configured);
  const groupedConfiguredModels = groupModelsByProvider(configuredModels, (providerId) => providers.find((item) => item.id === providerId)?.name);
  const hasSavedCustomKey = Boolean(selectedProvider?.keyConfigured) || (provider === customProviderId && customProviderKeyConfigured);
  const providerModels: ProviderModelSettings[] = isCustomProvider
    ? (selectedProvider?.models ?? customModels)
    : models.filter((model) => model.provider === provider).map((model) => {
      const stored = selectedProvider?.models.find((item) => item.id === model.id);
      return {
        id: model.id,
        name: model.name,
        imageInput: stored?.imageInput ?? model.imageInput,
        // 限额显示生效值（用户修正优先，否则目录原值），供编辑框 placeholder 回显。
        contextWindow: stored?.contextWindow ?? (typeof model.contextWindow === "number" ? model.contextWindow : undefined),
        maxTokens: stored?.maxTokens ?? (typeof model.maxTokens === "number" ? model.maxTokens : undefined),
        enabled: stored ? stored.enabled !== false : true
      };
    });
  const enabledProviderModels = providerModels.filter((model) => model.enabled !== false);
  const [modelSearch, setModelSearch] = useState("");
  // 限额行内编辑态：正在编辑的模型 id + 两个输入框草稿（字符串，空 = 清除覆盖）。
  const [editingModelId, setEditingModelId] = useState<string | undefined>();
  const [limitDraftContext, setLimitDraftContext] = useState("");
  const [limitDraftMaxTokens, setLimitDraftMaxTokens] = useState("");
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
  const wallpaperOpacityOverride = settings.appearance.wallpaperOpacity?.[opacityMode];
  const wallpaperOpacity = wallpaperOpacityOverride ?? themeWallpaperOpacity(settings.appearance.customCss, opacityMode) ?? 0;
  const wallpaperOpacityPercent = Math.round(wallpaperOpacity * 100);
  const bubbleOpacityOverride = settings.appearance.bubbleOpacity?.[opacityMode];
  const bubbleOpacity = bubbleOpacityOverride ?? DEFAULT_BUBBLE_OPACITY;
  const bubbleOpacityPercent = Math.round(bubbleOpacity * 100);
  const panelOpacityOverride = settings.appearance.panelOpacity?.[opacityMode];
  const panelOpacity = panelOpacityOverride ?? DEFAULT_PANEL_OPACITY;
  const panelOpacityPercent = Math.round(panelOpacity * 100);
  function closeSettings(): void { useDesktopStore.setState({ settings: structuredClone(initialSettingsRef.current) }); onClose(); }
  function markSettingsSaved(nextSettings: import("../../shared/protocol").DesktopSettings): void {
    const saved = structuredClone(nextSettings);
    initialSettingsRef.current = saved;
    useDesktopStore.setState({ settings: saved });
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
        customModels: (!selectedProvider || provider === customProviderId) ? updated : state.customModels,
        settings: hasConfiguredProvider
          ? { ...state.settings, providers: state.settings.providers.map((item) => item.id === provider ? { ...item, models: updated } : item) }
          : state.settings
      };
    });
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

  function updateAppearance(patch: Partial<AppearanceSettings>): void {
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

  async function importCustomCss(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setThemeImportError(undefined);
    const css = await file.text();
    setCustomThemeName(cssThemeNameFromFile(file.name));
    setEditingCustomThemeId(undefined);
    updateAppearance({ customCss: css, customCssAssets: {} });
  }

  async function importThemeDirectory(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []) as ThemeDirectoryFile[];
    event.target.value = "";
    setThemeImportError(undefined);
    if (files.length === 0) return;
    const cssFiles = files.filter((file) => file.name.toLowerCase().endsWith(".css"));
    if (cssFiles.length === 0) {
      setThemeImportError("主题目录中没有找到 CSS 文件");
      return;
    }
    try {
      const rootName = themeRelativePath(cssFiles[0]!).split("/")[0] || cssThemeNameFromFile(cssFiles[0]!.name);
      const cssFile = cssFiles.find((file) => file.name.toLowerCase() === "theme.css")
        ?? cssFiles.find((file) => file.name.toLowerCase() === `${rootName.toLowerCase()}.css`)
        ?? cssFiles[0]!;
      const css = await cssFile.text();
      const assets = await collectThemeAssets(css, cssFile, files);
      setCustomThemeName(themeNameFromCss(css, rootName));
      setEditingCustomThemeId(undefined);
      updateAppearance({ customCss: css, customCssAssets: assets });
    } catch (error) {
      setThemeImportError(error instanceof Error ? error.message : "主题目录导入失败");
    }
  }

  function saveCustomTheme(): void {
    const css = settings.appearance.customCss;
    if (!css.trim()) return;
    const currentThemes = settings.appearance.customThemes;
    const existingIndex = editingCustomThemeId ? currentThemes.findIndex((theme) => theme.id === editingCustomThemeId) : -1;
    const existing = existingIndex >= 0 ? currentThemes[existingIndex] : undefined;
    const assets = settings.appearance.customCssAssets;
    const nextTheme: CustomThemeDefinition = {
      id: existing?.id ?? createCustomThemeId(),
      name: customThemeName.trim() || existing?.name || `自定义主题 ${currentThemes.length + 1}`,
      css,
      ...(assets && Object.keys(assets).length > 0 ? { assets: structuredClone(assets) } : {})
    };
    const nextThemes = existingIndex >= 0
      ? currentThemes.map((theme, index) => index === existingIndex ? nextTheme : theme)
      : [...currentThemes, nextTheme];
    setEditingCustomThemeId(nextTheme.id);
    setCustomThemeName(nextTheme.name);
    updateAppearance({ customThemes: nextThemes });
  }

  function applyCustomTheme(theme: CustomThemeDefinition): void {
    setEditingCustomThemeId(theme.id);
    setCustomThemeName(theme.name);
    updateAppearance({ customCss: theme.css, customCssAssets: theme.assets ?? {} });
  }

  function deleteCustomTheme(theme: CustomThemeDefinition): void {
    const nextThemes = settings.appearance.customThemes.filter((item) => item.id !== theme.id);
    const isActive = editingCustomThemeId === theme.id || (!editingCustomThemeId && settings.appearance.customCss === theme.css);
    setEditingCustomThemeId(undefined);
    if (isActive) {
      setCustomThemeName("");
      updateAppearance({ customCss: "", customCssAssets: {}, customThemes: nextThemes });
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
    const provider = slash > 0 ? visionModel.slice(0, slash) : "";
    const modelId = slash > 0 ? visionModel.slice(slash + 1) : "";
    if (visionEnabled && (!provider || !modelId)) {
      setVisionError("请先在上方的服务商中配置一个支持图片输入的模型");
      return;
    }
    setVisionSaving(true);
    setVisionError(undefined);
    try {
      const vision = { enabled: visionEnabled, provider, model: modelId, ...(visionPrompt.trim() ? { prompt: visionPrompt.trim() } : {}) };
      await window.piDesktop.send({ type: "vision.save", vision });
      markSettingsSaved({ ...settings, vision });
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
      if (isCustomProvider) {
        const modelsForProvider = providerModels;
        const providerConfig = { id: provider, name: customName.trim(), baseUrl: customBaseUrl.trim(), models: modelsForProvider.length ? modelsForProvider.map((model) => ({ ...model, enabled: model.enabled !== false })) : [{ id: customModelId.trim(), name: customModelId.trim(), imageInput: imageInputOverride ?? selectedCustomModel?.imageInput, enabled: true }] };
        await window.piDesktop.send({ type: "provider.save", provider: providerConfig, apiKey: apiKey.trim() || undefined });
        const nextProviders = settings.providers.some((item) => item.id === provider) ? settings.providers.map((item) => item.id === provider ? providerConfig : item) : [...settings.providers, providerConfig];
        markSettingsSaved({ ...settings, providers: nextProviders.map((item) => item.id === provider ? { ...item, keyConfigured: Boolean(apiKey.trim()) || selectedProvider?.keyConfigured } : item) });
      } else {
        const builtinEntry = settings.providers.find((item) => item.id === provider && item.custom === false);
        if (builtinEntry) {
          await window.piDesktop.send({ type: "provider.models.save", provider: builtinEntry });
          const enabledIds = new Set(builtinEntry.models.filter((model) => model.enabled !== false).map((model) => model.id));
          markSettingsSaved({
            ...settings,
            model: settings.model?.provider === provider && !enabledIds.has(settings.model.id) ? undefined : settings.model,
            agents: settings.agents.map((agent) => agent.defaultModel?.provider === provider && !enabledIds.has(agent.defaultModel.id) ? { ...agent, defaultModel: undefined } : agent),
            ...(settings.vision?.provider === provider && !enabledIds.has(settings.vision.model) ? { vision: { ...settings.vision, enabled: false } } : {})
          });
        }
        // 留空 = 沿用已保存的 key：不发 auth.set，避免空 key 覆盖运行中的凭据，
        // 导致随后的模型校验误报 "No API key for …"。
        if (apiKey.trim()) await window.piDesktop.send({ type: "auth.set", provider, apiKey: apiKey.trim() });
      }
      setApiKey("");
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "应用模型服务设置失败");
    } finally {
      setSaving(false);
    }
  }

  function newProvider(): void {
    const id = `provider-${Date.now()}`;
    setProvider(id); setCustomName("新的模型服务"); setCustomBaseUrl(""); setCustomModelId(""); setApiKey(""); setModelSearch("");
  }

  async function deleteProvider(): Promise<void> {
    if (!selectedProvider) return;
    await window.piDesktop.send({ type: "provider.delete", providerId: selectedProvider.id });
    const nextProviders = settings.providers.filter((item) => item.id !== selectedProvider.id);
    markSettingsSaved({
      ...settings,
      providers: nextProviders,
      model: settings.model?.provider === selectedProvider.id ? undefined : settings.model,
      agents: settings.agents.map((agent) => agent.defaultModel?.provider === selectedProvider.id ? { ...agent, defaultModel: undefined } : agent)
    });
    setProvider(nextProviders[0]?.id ?? customProviderId);
    setModelSearch("");
  }

  function newAgent(): void {
    const id = `agent-${Date.now()}`;
    const agent: AgentProfile = { id, name: "新 Agent", description: "", systemPrompt: "", divMode: "auto", defaultThinkingLevel: "medium", tools: Object.fromEntries(agentTools.map((tool) => [tool, tool !== "powershell"])) as Record<BuiltinToolName, boolean> };
    setAgentList((current) => [...current, agent]);
    setSelectedAgentId(id);
  }

  function updateAgent(patch: Partial<AgentProfile>): void {
    if (!selectedAgent) return;
    setAgentList((current) => current.map((agent) => agent.id === selectedAgent.id ? { ...agent, ...patch } : agent));
  }

  function updateAgentSkillOverride(skillId: string, enabled: boolean): void {
    if (!selectedAgent) return;
    updateAgent({ skillOverrides: { ...selectedAgent.skillOverrides, [skillId]: enabled } });
  }

  async function saveAgent(): Promise<void> {
    if (!selectedAgent || !selectedAgent.name.trim()) return;
    const normalized = { ...selectedAgent, name: selectedAgent.name.trim() };
    await window.piDesktop.send({ type: "agent.save", agent: normalized });
    const nextSettings = { ...settings, agents: agentList.map((agent) => agent.id === normalized.id ? normalized : agent) };
    setAgentList(nextSettings.agents);
    markSettingsSaved(nextSettings);
  }

  function duplicateAgent(): void {
    if (!selectedAgent) return;
    const copy: AgentProfile = { ...selectedAgent, id: `agent-${Date.now()}`, name: `${selectedAgent.name} 副本`, tools: { ...selectedAgent.tools }, ...(selectedAgent.skillOverrides ? { skillOverrides: { ...selectedAgent.skillOverrides } } : {}) };
    setAgentList((current) => [...current, copy]);
    setSelectedAgentId(copy.id);
  }

  async function archiveAgent(): Promise<void> {
    if (!selectedAgent || selectedAgent.id === "default") return;
    await window.piDesktop.send({ type: "agent.archive", agentId: selectedAgent.id, archived: true });
    const nextAgents = agentList.map((agent) => agent.id === selectedAgent.id ? { ...agent, archived: true } : agent);
    setAgentList(nextAgents);
    setSelectedAgentId("default");
    markSettingsSaved({ ...settings, agents: nextAgents, currentAgentId: settings.currentAgentId === selectedAgent.id ? "default" : settings.currentAgentId });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={closeSettings}>
      <section className="settings-dialog settings-center" data-pane="settings-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><Settings size={19} /><div><h2>ChatAnyTime 设置</h2><p>模型服务和 Agent 角色配置保存在本机。</p></div></div><button className="icon-button" type="button" title="关闭设置" aria-label="关闭设置" onClick={closeSettings}><X size={18} /></button></header>
        <div className="settings-body"><nav className="settings-tabs"><button type="button" className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>通用</button><button type="button" className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>模型服务</button><button type="button" className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>Agent 角色</button><button type="button" className={tab === "subagents" ? "active" : ""} onClick={() => setTab("subagents")}>子智能体</button><button type="button" className={tab === "resources" ? "active" : ""} onClick={() => setTab("resources")}>技能与工具</button><button type="button" className={tab === "hooks" ? "active" : ""} onClick={() => setTab("hooks")}>钩子</button><button type="button" className={tab === "appearance" ? "active" : ""} onClick={() => setTab("appearance")}>外观</button><button type="button" className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}>用量统计</button></nav><div className="settings-content">{tab === "general" ? <form onSubmit={(event) => { event.preventDefault(); const nextSettings = structuredClone(settings); void window.piDesktop.send({ type: "settings.save", settings: { model: nextSettings.model, thinkingLevel: nextSettings.thinkingLevel, accessMode: nextSettings.accessMode, appearance: nextSettings.appearance, browser: nextSettings.browser } }); markSettingsSaved(nextSettings); onClose(); }}>
          <label>全局默认模型<select value={settings.model ? `${settings.model.provider}/${settings.model.id}` : ""} onChange={(event) => { const value = event.target.value; const slash = value.indexOf("/"); useDesktopStore.setState({ settings: { ...settings, model: slash > 0 ? { provider: value.slice(0, slash), id: value.slice(slash + 1) } : undefined } }); }}>{<option value="">请选择默认模型</option>}{configuredModels.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}</select></label>
          <label>默认思考等级<select value={settings.thinkingLevel} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, thinkingLevel: event.target.value as ThinkingLevel } })}>{thinkingLevels.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}</select></label>
          <label>访问模式<select value={settings.accessMode} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, accessMode: event.target.value as AccessMode } })}>{accessModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {settings.accessMode === "full" && <p className="access-mode-warning">完全访问会允许 Pi 直接执行命令并访问工作区外路径，请只在可信项目中使用。</p>}
          {settings.accessMode === "workspace" && <p className="access-mode-hint">工作区内的文件写入会自动允许；bash 命令和工作区外路径仍会询问。</p>}
            <label className="checkbox-setting"><input type="checkbox" checked={settings.browser?.enabled !== false} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, browser: { enabled: event.target.checked } } })} />启用 AI 浏览器自动化（browser_* 工具）</label>
          <label className="checkbox-setting"><input type="checkbox" checked={settings.appearance.showThinking} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, showThinking: event.target.checked } } })} />展示思考过程</label>
          <footer><button type="button" className="secondary-button" onClick={closeSettings}>取消</button><button className="primary-button" type="submit">保存通用设置</button></footer>
        </form> : tab === "models" ? <form onSubmit={save}>
        <div className="settings-provider-heading"><label>服务商<select value={provider} onChange={(event) => { const next = event.target.value; setProvider(next); setModelSearch(""); const config = configuredProviders.find((item) => item.id === next); if (config) { setCustomName(config.name); setCustomBaseUrl(config.baseUrl); setCustomModelId(config.models[0]?.id ?? ""); } }}><optgroup label="内置服务">{providers.filter((item) => !item.custom && !configuredProviders.some((config) => config.id === item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}{item.configured ? " - 已配置" : ""}</option>)}{configuredProviders.filter((item) => item.custom === false).map((item) => <option key={item.id} value={item.id}>{item.name}{item.keyConfigured ? " - 已配置" : ""}</option>)}</optgroup><optgroup label="OpenAI 兼容服务"><option value={customProviderId}>{customProvider?.name ?? "新的模型服务"}{customProviderKeyConfigured ? " - 已配置" : ""}</option>{configuredProviders.filter((item) => item.id !== customProviderId && item.custom !== false).map((item) => <option key={item.id} value={item.id}>{item.name}{item.keyConfigured ? " - 已配置" : ""}</option>)}</optgroup></select></label><button className="secondary-button" type="button" onClick={newProvider}>+ 新增服务</button>{selectedProvider && selectedProvider.custom !== false && <button className="danger-button" type="button" onClick={() => void deleteProvider()}>删除服务</button>}</div>
        {isCustomProvider && <>
          <label>服务名称<input value={customName} placeholder="例如：公司中转站" onChange={(event) => setCustomName(event.target.value)} /></label>
          <div className="settings-action-row"><label>OpenAI 兼容接口地址<input value={customBaseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setCustomBaseUrl(event.target.value)} /></label><button className="secondary-button" type="button" disabled={customModelFetchStatus === "loading" || !customBaseUrl.trim() || (!apiKey.trim() && !customProviderKeyConfigured)} onClick={() => void fetchModels()}><RefreshCw size={14} className={customModelFetchStatus === "loading" ? "spinning" : undefined} />{customModelFetchStatus === "loading" ? "拉取中" : "拉取模型"}</button></div>
        </>}
        <div className="model-selection"><div className="model-selection-heading"><span>可用模型</span><small>左侧控制显示，右侧标记图片输入</small>{!isCustomProvider && <button className="secondary-button model-refresh-button" type="button" title="从服务商目录拉取最新模型列表" disabled={modelRefreshStatus === "loading" && modelRefreshProvider === provider} onClick={() => void refreshBuiltinModels()}><RefreshCw size={14} className={modelRefreshStatus === "loading" && modelRefreshProvider === provider ? "spinning" : undefined} />{modelRefreshStatus === "loading" && modelRefreshProvider === provider ? "拉取中" : "拉取模型"}</button>}</div>{providerModels.length > 0 && <div className="model-list-toolbar"><label className="checkbox-setting model-select-all" title={modelSearch.trim() ? "勾选或取消当前匹配到的模型" : "勾选或取消全部模型"}><input type="checkbox" checked={allVisibleModelsEnabled} disabled={visibleProviderModels.length === 0} ref={(el) => { if (el) el.indeterminate = !allVisibleModelsEnabled && someVisibleModelsEnabled; }} onChange={(event) => setAllVisibleModelsEnabled(event.target.checked)} />全选</label><small className="model-enabled-count">已启用 {enabledProviderModels.length}/{providerModels.length}</small>{providerModels.length > 8 && <div className="model-search-box"><Search size={13} /><input value={modelSearch} placeholder="搜索模型名称或 ID" aria-label="搜索模型" onChange={(event) => setModelSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault(); }} /></div>}</div>}{!isCustomProvider && modelRefreshError && <p className="form-error model-refresh-error">{modelRefreshError}</p>}{!isCustomProvider && modelRefreshStatus === "success" && modelRefreshProvider === provider && <p className="form-hint model-refresh-hint">模型列表已更新</p>}{providerModels.length === 0 ? <p className="panel-empty">{isCustomProvider ? "请先拉取模型，或手动填写模型 ID" : "该服务商暂无可用模型，请先配置 API 密钥"}</p> : visibleProviderModels.length === 0 ? <p className="panel-empty">没有匹配「{modelSearch.trim()}」的模型</p> : visibleProviderModels.map((model) => <div className="model-option" key={model.id}><label className="checkbox-setting model-enabled-option"><input type="checkbox" checked={model.enabled !== false} onChange={(event) => { const next = event.target.checked; updateProviderModel(model.id, { enabled: next }); if (isCustomProvider && model.id === customModelId && !next) setCustomModelId(providerModels.find((item) => item.id !== model.id && item.enabled !== false)?.id ?? model.id); }} /><span><strong>{model.name}</strong><small>{model.id}</small></span></label><label className="checkbox-setting model-image-option" title={isCustomProvider ? "允许向此模型发送图片" : "手动标记该模型是否支持图片输入：目录元数据滞后或缺失时以这里的勾选为准"}><input type="checkbox" checked={model.imageInput === true} onChange={(event) => updateProviderModel(model.id, { imageInput: event.target.checked })} />图片输入</label><button className={hasModelLimitOverride(model.id) ? "icon-button model-edit-limits active" : "icon-button model-edit-limits"} type="button" title={editingModelId === model.id ? "收起限额编辑" : "修正上下文窗口与最大输出（服务商标错时手动覆盖）"} aria-expanded={editingModelId === model.id} onClick={() => beginEditModelLimits(model)}><Pencil size={13} /></button>{editingModelId === model.id && <div className="model-limits-editor"><label>上下文窗口<input inputMode="numeric" autoComplete="off" value={limitDraftContext} placeholder={typeof model.contextWindow === "number" ? String(model.contextWindow) : "如 128k 或 128000"} onChange={(event) => setLimitDraftContext(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitModelLimits(model); } }} /><small>tokens</small></label><label>最大输出<input inputMode="numeric" autoComplete="off" value={limitDraftMaxTokens} placeholder={typeof model.maxTokens === "number" ? String(model.maxTokens) : "如 16k 或 16384"} onChange={(event) => setLimitDraftMaxTokens(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitModelLimits(model); } }} /><small>tokens</small></label><div className="model-limits-actions"><button className="secondary-button" type="button" onClick={() => { setLimitDraftContext(""); setLimitDraftMaxTokens(""); }}>清空</button><button className="primary-button" type="button" onClick={() => commitModelLimits(model)}>完成</button></div><p className="model-limits-hint">留空后点完成 = 清除手动设置，回退目录值；最后点下方「保存设置」持久化。</p></div>}</div>)}</div>
        {isCustomProvider && providerModels.length === 0 && customModelId && <label className="checkbox-setting"><input type="checkbox" checked={imageInputOverride ?? false} onChange={(event) => setImageInputOverride(event.target.checked)} />支持图片输入（手动覆盖推断）</label>}
        {providerModels.length > 0 && enabledProviderModels.length === 0 && <p className="form-hint">已取消全部模型：保存后该服务商在模型选择器中不再提供模型（若运行中会话正在用它的模型会自动切走）；想彻底移除该服务，请用上方「删除服务」。</p>}
        {isCustomProvider && customModelFetchError && <p className="form-error">{customModelFetchError}</p>}
        <label>API 密钥<input type="password" value={apiKey} autoFocus placeholder={isCustomProvider && hasSavedCustomKey ? "已保存，留空则继续使用" : "请输入 API 密钥"} onChange={(event) => setApiKey(event.target.value)} /></label>
        <section className="vision-settings" aria-label="视觉识别设置">
          <div className="vision-settings-heading">
            <div><h3>视觉识别（图片兜底）</h3><p>当前对话模型不支持图片输入时，发送的图片会自动交给这里选择的多模态模型识别，识别结果以文本形式交给对话模型。模型来自上方已配置的模型服务。</p></div>
            <label className="checkbox-setting"><input type="checkbox" checked={visionEnabled} onChange={(event) => setVisionEnabled(event.target.checked)} />启用</label>
          </div>
          <label>视觉模型<select value={visionModel} disabled={visionModelOptions.length === 0} onChange={(event) => setVisionModel(event.target.value)}>
            <option value="">{visionModelOptions.length === 0 ? "暂无已配置的多模态模型" : "请选择视觉模型"}</option>
            {visionModelOptions.some((model) => `${model.provider}/${model.id}` === visionModel)
              ? visionModelOptions.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}（{providers.find((provider) => provider.id === model.provider)?.name ?? model.provider}）</option>)
              : [<option key={visionModel} value={visionModel}>{visionModel}</option>, ...visionModelOptions.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}（{providers.find((provider) => provider.id === model.provider)?.name ?? model.provider}）</option>)]}
          </select></label>
          <label>识别提示词（可选）<textarea rows={3} value={visionPrompt} placeholder="留空使用默认提示词：转写图中文字、描述物体、布局与配色等" onChange={(event) => setVisionPrompt(event.target.value)} /></label>
          {visionError && <p className="form-error">{visionError}</p>}
          <div className="vision-settings-footer"><button className="primary-button" type="button" disabled={visionSaving} onClick={() => void saveVision()}>{visionSaving ? "正在保存" : "保存视觉识别设置"}</button></div>
        </section>
        {formBlocker && <p className="form-hint">{formBlocker}</p>}
        {formError && <p className="form-error">{formError}</p>}
        <footer><button type="button" className="secondary-button" onClick={closeSettings}>取消</button><button className="primary-button" disabled={saving || Boolean(formBlocker)} type="submit">{saving ? "正在应用" : "保存设置"}</button></footer>
        </form> : tab === "agents" ? <div className="agent-settings">
          <div className="settings-agent-list">{agentList.filter((agent) => !agent.archived).map((agent) => <button type="button" key={agent.id} className={agent.id === selectedAgent?.id ? "active" : ""} onClick={() => setSelectedAgentId(agent.id)}><strong>{agent.name}</strong><small>{agent.description || "未填写说明"}</small></button>)}<button type="button" className="secondary-button agent-new-button" onClick={newAgent}>+ 新建 Agent</button></div>
          {selectedAgent && <div className="agent-editor"><label>名称<input value={selectedAgent.name} onChange={(event) => updateAgent({ name: event.target.value })} /></label><label>说明<input value={selectedAgent.description} onChange={(event) => updateAgent({ description: event.target.value })} /></label><label>系统提示词<textarea value={selectedAgent.systemPrompt} rows={6} onChange={(event) => updateAgent({ systemPrompt: event.target.value })} /></label><label>Div 气泡模式<select value={selectedAgent.divMode} onChange={(event) => updateAgent({ divMode: event.target.value as DivBubbleMode })}><option value="off">关闭</option><option value="auto">智能判断（按场景使用）</option><option value="always">始终开启（全部回复使用）</option></select></label><label>默认模型<select value={selectedAgent.defaultModel ? `${selectedAgent.defaultModel.provider}/${selectedAgent.defaultModel.id}` : ""} onChange={(event) => { const value = event.target.value; updateAgent({ defaultModel: value ? { provider: value.slice(0, value.indexOf("/")), id: value.slice(value.indexOf("/") + 1) } : undefined }); }}><option value="">跟随全局默认模型</option>{groupedConfiguredModels.map((group) => <optgroup key={group.provider} label={group.providerName}>{group.models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}</optgroup>)}</select></label><label>默认思考等级<select value={selectedAgent.defaultThinkingLevel} onChange={(event) => updateAgent({ defaultThinkingLevel: event.target.value as ThinkingLevel })}>{thinkingLevels.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}</select></label><AgentSkillSelector agent={selectedAgent} skills={resources.skills} onChange={updateAgentSkillOverride} /><fieldset><legend>工具权限</legend>{agentTools.map((tool) => <label className="tool-toggle" key={tool}><input type="checkbox" checked={selectedAgent.tools[tool]} onChange={(event) => updateAgent({ tools: { ...selectedAgent.tools, [tool]: event.target.checked } })} />{toolLabel(tool)}</label>)}</fieldset><footer><button type="button" className="danger-button" disabled={selectedAgent.id === "default"} onClick={() => void archiveAgent()}>归档</button><button type="button" className="secondary-button" onClick={duplicateAgent}>复制</button><button type="button" className="primary-button" onClick={() => void saveAgent()}>保存 Agent</button></footer></div>}
        </div> : tab === "subagents" ? <SubagentSettings resources={resources} workspaceOpen={workspaceOpen} models={models} providers={providers} /> : tab === "resources" ? <ResourceSettings resources={resources} /> : tab === "hooks" ? <HooksSettings resources={resources} workspaceOpen={workspaceOpen} /> : tab === "usage" ? <UsageSettings /> : <form className="appearance-settings" onSubmit={(event) => { event.preventDefault(); const nextSettings = structuredClone(settings); void window.piDesktop.send({ type: "appearance.save", appearance: nextSettings.appearance }); markSettingsSaved(nextSettings); onClose(); }}>
          <div className="appearance-grid">
            <div>
              <section className="interface-tuning-settings" aria-label="界面微调">
                <div className="theme-color-heading"><span className="settings-field-label">界面微调</span></div>
                <p className="theme-color-hint">不改主题，微调界面密度与圆角，切换后实时生效；默认跟随主题。</p>
                <label>界面密度<select value={settings.appearance.tune?.density ?? ""} onChange={(event) => updateTune({ density: event.target.value as InterfaceTuning["density"] | "" })}><option value="">跟随主题</option><option value="compact">紧凑</option><option value="comfortable">舒适</option><option value="relaxed">宽松</option></select></label>
                <label>圆角<select value={settings.appearance.tune?.radius ?? ""} onChange={(event) => updateTune({ radius: event.target.value as InterfaceTuning["radius"] | "" })}><option value="">跟随主题</option><option value="square">方角</option><option value="small">小圆</option><option value="medium">中圆</option><option value="round">圆润</option></select></label>
              </section>
              <label>主题模式<select value={settings.appearance.theme} onChange={(event) => { const next = event.target.value as "system" | "light" | "dark"; useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, theme: next } } }); setOpacityMode(next === "light" ? "light" : next === "dark" ? "dark" : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")); }}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
              <label className="checkbox-setting"><input type="checkbox" checked={settings.appearance.showThinking} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, showThinking: event.target.checked } } })} />展示思考过程</label>
              <div className="theme-preset-field"><span className="settings-field-label">主题预设</span><div className="theme-preset-grid">{THEME_PRESETS.map((preset) => <button type="button" key={preset.id} className={`theme-preset-card${settings.appearance.themePreset === preset.id ? " active" : ""}`} onClick={() => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, themePreset: preset.id as ThemePresetId } } })}><span className="theme-swatches">{preset.swatches.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span><strong>{preset.name}</strong><small>{preset.description}</small></button>)}</div></div>
              <section className="theme-color-settings" aria-label="壁纸透明度">
                <div className="theme-color-heading"><span className="settings-field-label">背景图片透明度</span><div className="theme-color-mode-switch" role="tablist" aria-label="透明度模式"><button type="button" className={opacityMode === "light" ? "active" : ""} role="tab" aria-selected={opacityMode === "light"} onClick={() => setOpacityMode("light")}>浅色</button><button type="button" className={opacityMode === "dark" ? "active" : ""} role="tab" aria-selected={opacityMode === "dark"} onClick={() => setOpacityMode("dark")}>深色</button></div></div>
                <p className="theme-color-hint">背景透明度覆盖主题声明的壁纸不透明度；气泡/面板透明度控制壁纸模式下消息气泡与左右上下栏底色透明程度（气泡默认 80%、面板默认 100% 即保持现状，建议不低于 60% 保证文字可读）。颜色完全由主题 CSS 决定，主题未设置壁纸时不生效。</p>
                 <div className="theme-opacity-row"><label htmlFor="theme-wallpaper-opacity">背景透明度</label><input id="theme-wallpaper-opacity" type="range" min="0" max="100" step="1" value={wallpaperOpacityPercent} aria-valuetext={`${wallpaperOpacityPercent}%`} onChange={(event) => updateWallpaperOpacity(Number(event.target.value) / 100)} /><output>{wallpaperOpacityPercent}%</output><button className="icon-button theme-color-reset" type="button" disabled={wallpaperOpacityOverride === undefined} title="恢复主题默认透明度" aria-label="恢复主题默认透明度" onClick={resetWallpaperOpacity}><RotateCcw size={14} /></button></div>
                 <div className="theme-opacity-row"><label htmlFor="theme-bubble-opacity">气泡透明度</label><input id="theme-bubble-opacity" type="range" min="40" max="100" step="1" value={bubbleOpacityPercent} aria-valuetext={`${bubbleOpacityPercent}%`} onChange={(event) => updateBubbleOpacity(Number(event.target.value) / 100)} /><output>{bubbleOpacityPercent}%</output><button className="icon-button theme-color-reset" type="button" disabled={bubbleOpacityOverride === undefined} title="恢复默认气泡透明度（80%）" aria-label="恢复默认气泡透明度" onClick={resetBubbleOpacity}><RotateCcw size={14} /></button></div>
                 <div className="theme-opacity-row"><label htmlFor="theme-panel-opacity">面板透明度</label><input id="theme-panel-opacity" type="range" min="40" max="100" step="1" value={panelOpacityPercent} aria-valuetext={`${panelOpacityPercent}%`} onChange={(event) => updatePanelOpacity(Number(event.target.value) / 100)} /><output>{panelOpacityPercent}%</output><button className="icon-button theme-color-reset" type="button" disabled={panelOpacityOverride === undefined} title="恢复默认面板透明度（100%）" aria-label="恢复默认面板透明度" onClick={resetPanelOpacity}><RotateCcw size={14} /></button></div>
               </section>
            </div>
            <ThemePreview appearance={settings.appearance} />
          </div>
              <div className="custom-css-heading"><span>自定义 CSS</span><div><input ref={cssFileInputRef} hidden type="file" accept=".css,text/css" onChange={(event) => void importCustomCss(event)} /><input ref={(element) => { themeDirectoryInputRef.current = element; element?.setAttribute("webkitdirectory", ""); }} hidden type="file" multiple accept=".css,image/png,image/jpeg,image/webp,image/gif,.woff,.woff2,.ttf,.otf" onChange={(event) => void importThemeDirectory(event)} /><button className="secondary-button" type="button" onClick={() => cssFileInputRef.current?.click()}>导入 CSS</button><button className="secondary-button" type="button" onClick={() => themeDirectoryInputRef.current?.click()}>导入主题目录</button><button className="secondary-button" type="button" onClick={() => { setEditingCustomThemeId(undefined); setCustomThemeName(""); setThemeImportError(undefined); updateAppearance({ customCss: "", customCssAssets: {} }); }}>清空</button></div></div>
              <label className="custom-css-field"><textarea value={settings.appearance.customCss} spellCheck={false} rows={11} placeholder={":root[data-theme-effective=\"dark\"] {\n  --accent: #8b5cf6;\n}"} aria-label="自定义 CSS" onChange={(event) => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, customCss: event.target.value } } })} /></label>
              {themeImportError && <p className="form-error theme-import-error">{themeImportError}</p>}
              <CustomThemeLibrary customCss={settings.appearance.customCss} customThemes={settings.appearance.customThemes} customThemeName={customThemeName} editingCustomThemeId={editingCustomThemeId} onNameChange={setCustomThemeName} onSave={saveCustomTheme} onExport={exportCustomCss} onApply={applyCustomTheme} onDelete={deleteCustomTheme} />
          <footer><button type="button" className="secondary-button" onClick={closeSettings}>取消</button><button className="primary-button" type="submit">保存外观设置</button></footer>
        </form>}</div></div>
      </section>
    </div>
  );
}

export function App(): ReactNode {
  const { ready, snapshot, models, providers, resources, customProvider, customProviderKeyConfigured, customModels, customModelFetchStatus, customModelFetchError, modelRefreshStatus, modelRefreshError, modelRefreshProvider, permissions, questions, error, checkpointResult, initialize, clearError } = useDesktopStore();
  // 分屏布局：tree 为递归二叉分割树，focusedPane 是焦点格（= 激活会话）。
  // 权限/提问按格子集合过滤（焦点格优先），store 的数组跨会话累积，直接取
  // [0] 会把后台会话待决的弹窗冒到别的格子视图里；单窗口退化为 [激活会话]，
  // 与旧的“按当前激活会话过滤”行为一致。
  const [splitState, setSplitState] = useState(readStoredSplitState);
  const splitTree = splitState.tree;
  const focusedPaneId = splitState.focusedPane;
  const [maximizedPaneId, setMaximizedPaneId] = useState<string>();
  const paneIds = useMemo(() => (splitTree ? leafIds(splitTree) : []), [splitTree]);
  const paneFocusOrder = useMemo(() => {
    const active = focusedPaneId ?? snapshot.sessionId;
    return [active, ...paneIds.filter((id) => id !== active)].filter((id): id is string => Boolean(id));
  }, [paneIds, focusedPaneId, snapshot.sessionId]);
  const permission = panePermissionRequest(permissions, paneFocusOrder);
  const question = paneQuestionRequest(questions, paneFocusOrder);
  const settings = useDesktopStore((state) => state.settings);
  const themeAssetUrls = useThemeAssetUrls(themeAssetsForAppearance(settings.appearance));
  const [messageActionError, setMessageActionError] = useState<string>();
  const setActionError = useCallback((message?: string): void => {
    setMessageActionError(message);
  }, []);
  /** 打开单文件回滚确认框：产物行自带该文件的 toolCallIds，无产物不弹。 */
  const openRollbackConfirm = useCallback((file: ReplyChangedFile, sessionId: string | undefined): void => {
    if (!sessionId || file.toolCallIds.length === 0) return;
    setRollbackTarget({ file, sessionId });
  }, []);
  const [sidebarTab, setSidebarTab] = useState<"agents" | "topics">("topics");
  const [sidebarQuery, setSidebarQuery] = useState("");
  // 启动时所有工作区分组默认折叠（空表 = 无展开项）；用户展开后保持到退出。
  const [expandedWorkspaceGroups, setExpandedWorkspaceGroups] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewOpened, setPreviewOpened] = useState(false);
  const [preview, setPreview] = useState<PreviewState>();
  const [previewAddMenuOpen, setPreviewAddMenuOpen] = useState(false);
  const previewRef = useRef<PreviewState | undefined>(preview);
  previewRef.current = preview;
  const [previewEditorStates, setPreviewEditorStates] = useState<Record<string, PreviewEditorState>>({});
  const [sidebarView, setSidebarView] = useState<"topics" | "files">("topics");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarFlyoutOpen, setSidebarFlyoutOpen] = useState(false);
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const [browsingWorkspace, setBrowsingWorkspace] = useState("");
  const [treeRefreshSignal, setTreeRefreshSignal] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [renameSession, setRenameSession] = useState<{ path: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteSession, setDeleteSession] = useState<{ path: string; title: string } | null>(null);
  const [removeWorkspace, setRemoveWorkspace] = useState<{ workspace: string; name: string; count: number } | null>(null);
  // —— checkpoint 回滚：单文件确认对话框目标 + 完成后的 toast ——
  const [rollbackTarget, setRollbackTarget] = useState<{ file: ReplyChangedFile; sessionId: string } | null>(null);
  const [checkpointToast, setCheckpointToast] = useState<string>();
  const lastCheckpointAtRef = useRef(0);
  useEffect(() => {
    if (!checkpointResult || checkpointResult.at === lastCheckpointAtRef.current) return;
    lastCheckpointAtRef.current = checkpointResult.at;
    setCheckpointToast(checkpointResult.message ?? "回滚完成");
    // 回滚改了盘上文件：文件树重新拉取（预览重开时自然读到新内容）。
    setTreeRefreshSignal((value) => value + 1);
  }, [checkpointResult]);
  const [previewSplit, setPreviewSplit] = useState(readStoredPreviewSplit);
  const [previewDragging, setPreviewDragging] = useState(false);
  const previewDragPointerRef = useRef<number | undefined>(undefined);
  const workAreaRef = useRef<HTMLDivElement>(null);
  // —— 分屏支撑：会话草稿（格子 remount 恢复）与 composer 主动写入桥 ——
  const draftsRef = useRef(new Map<string, string>());
  const draftStore = useMemo<PaneDraftStore>(() => ({
    load: (sessionId) => draftsRef.current.get(sessionId),
    save: (sessionId, text) => {
      if (text) draftsRef.current.set(sessionId, text);
      else draftsRef.current.delete(sessionId);
    }
  }), []);
  const composerBridge = useRef(new Map<string, PaneComposerApi>());
  const registerComposerApi = useCallback((api: PaneComposerApi | undefined, sessionId: string | undefined): void => {
    if (sessionId === undefined) return;
    if (api) composerBridge.current.set(sessionId, api);
    else composerBridge.current.delete(sessionId);
  }, []);
  // 已 watch 的格子集合（effect 维护）；session.new 在分屏中替换某格时记录待替换格。
  const watchedPaneIdsRef = useRef(new Set<string>());
  // 当前处于 hidden 模式（最大化中被隐藏、主进程停推）的格子集合。
  const hiddenPaneIdsRef = useRef(new Set<string>());
  const pendingPaneReplaceRef = useRef<string | undefined>(undefined);
  // 浏览器元素选择「发送到聊天框」：元素块写入焦点格输入框并聚焦——用户可
  // 继续编辑，随下一条消息一起发出。
  const sendPickedElement = useCallback((pick: BrowserElementPick, note: string): void => {
    const block = composePickMessage(pick, note);
    const targetId = focusedPaneId ?? snapshot.sessionId;
    if (!targetId) return;
    composerBridge.current.get(targetId)?.insertText(block);
  }, [focusedPaneId, snapshot.sessionId]);
  // 浏览器标签页状态回流：用页面标题/加载态更新预览标签的元数据。
  const handleBrowserStateChange = useCallback((tabId: string, state: import("../../shared/protocol").BrowserPreviewState): void => {
    setPreview((current) => current ? {
      ...current,
      tabs: current.tabs.map((tab) => tab.id === tabId && tab.target.type === "browser" && (tab.target.title !== state.title || tab.target.loading !== state.loading)
        ? { ...tab, target: { ...tab.target, title: state.title || tab.target.title, loading: state.loading } }
        : tab)
    } : current);
  }, []);
  const visibleAgents = useMemo(() => settings.agents.filter((agent) => !agent.archived && `${agent.name} ${agent.description}`.toLowerCase().includes(sidebarQuery.trim().toLowerCase())), [settings.agents, sidebarQuery]);
  const sessionGroups = useMemo(() => groupSessionsByWorkspace(snapshot.sessions, sidebarQuery, snapshot.recentWorkspaces), [snapshot.sessions, snapshot.recentWorkspaces, sidebarQuery]);
  const themeLayers = useMemo(() => collectThemeLayers(settings.appearance.customCss), [settings.appearance.customCss]);
  // 主题根属性（data-ui-*）反映焦点格（分屏下即激活会话）的状态。
  const isGenerating = Boolean(snapshot.busy && snapshot.turnTiming && snapshot.turnTiming.completedAt === undefined);
  const isChatEmpty = !snapshot.workspace || (snapshot.messages.length === 0 && !isGenerating);
  const activePreviewTab = preview?.tabs.find((tab) => tab.id === preview.activeTabId);

  // Race-safe subscription: if the component unmounts before initialize()
  // resolves (e.g. React.StrictMode's mount-unmount-mount in dev), the cleanup
  // runs with unsubscribe still pending. The cancelled flag makes the late
  // resolution tear down the listener immediately instead of leaking it.
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void initialize().then((fn) => {
      if (cancelled) fn?.();
      else unsubscribe = fn;
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [initialize]);

  useEffect(() => {
    document.title = "ChatAnyTime";
  }, []);


  useEffect(() => {
    try { window.localStorage.setItem("pidesktop.preview-split", String(previewSplit)); } catch { /* storage may be unavailable in browser demo */ }
  }, [previewSplit]);

  useEffect(() => {
    if (preview) return;
    previewDragPointerRef.current = undefined;
    setPreviewDragging(false);
  }, [preview]);

  useEffect(() => {
    if (!preview) return;
    // 会话切换不收回右侧边栏：只清理会话级标签（artifact/diff），面板保持
    // 展开；跨会话标签（browser/terminal/file）全部保留。浏览器视图由
    // BrowserPreview 组件在失活时隐藏、激活时恢复，无需销毁——销毁只发生在
    // 用户显式关标签或关闭预览面板时（closePreviewTab/closePreview）。
    const keepTabs = preview.tabs.filter((tab) => tab.target.type !== "artifact" && tab.target.type !== "diff");
    if (keepTabs.length > 0) {
      const activeStillThere = keepTabs.some((tab) => tab.id === preview.activeTabId);
      setPreview({ tabs: keepTabs, activeTabId: activeStillThere ? preview.activeTabId : keepTabs[0]!.id });
    } else {
      setPreview(undefined);
    }
  }, [snapshot.sessionId]);

  const previousWorkspaceRef = useRef(snapshot.workspace);
  useEffect(() => {
    if (previousWorkspaceRef.current === snapshot.workspace) return;
    previousWorkspaceRef.current = snapshot.workspace;
    // Terminals spawn with the old workspace as cwd; retire them all when it
    // changes instead of leaving shells pointing at a stale directory.
    const terminalTabs = (preview?.tabs ?? []).filter((tab) => tab.target.type === "terminal");
    for (const tab of terminalTabs) void window.piDesktop.terminal({ type: "kill", terminalId: tab.id });
    if (terminalTabs.length === 0) return;
    setPreview((current) => {
      if (!current) return current;
      const tabs = current.tabs.filter((tab) => tab.target.type !== "terminal");
      if (tabs.length === 0) return undefined;
      const activeTabId = tabs.some((tab) => tab.id === current.activeTabId) ? current.activeTabId : tabs[0]!.id;
      return { tabs, activeTabId };
    });
  }, [snapshot.workspace, preview]);

  useEffect(() => {
    const toggleTerminal = (event: KeyboardEvent): void => {
      if (event.code !== "Backquote" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      const activeTabId = preview?.activeTabId;
      const activeTab = preview?.tabs.find((tab) => tab.id === activeTabId);
      if (previewOpened && activeTab?.target.type === "terminal") {
        closePreviewTab(activeTab.id);
        return;
      }
      const existing = preview?.tabs.find((tab) => tab.target.type === "terminal");
      if (existing) {
        setPreviewOpened(true);
        selectPreviewTab(existing.id);
      } else {
        openTerminalPreview();
      }
    };
    document.addEventListener("keydown", toggleTerminal);
    return () => document.removeEventListener("keydown", toggleTerminal);
  }, [preview, previewOpened]);


  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => {
      root.dataset.theme = settings.appearance.theme;
      root.dataset.themeEffective = settings.appearance.theme === "dark" || (settings.appearance.theme === "system" && media.matches) ? "dark" : "light";
    };
    update();
    media.addEventListener("change", update);
    return () => {
      media.removeEventListener("change", update);
      delete root.dataset.themeEffective;
    };
  }, [settings.appearance.theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.themePreset = settings.appearance.themePreset;
    root.dataset.themeCustom = "true";
    if (customCssHasWallpaper(settings.appearance.customCss)) root.dataset.themeWallpaper = "true";
    else delete root.dataset.themeWallpaper;
    const styleId = "pi-desktop-custom-theme";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    const customCss = resolveThemeAssets(settings.appearance.customCss, themeAssetUrls);
    style.textContent = `${themePresetCss(settings.appearance.themePreset)}\n${scopeCustomThemeCss(customCss)}\n${wallpaperOpacityCss(settings.appearance.wallpaperOpacity, ":root[data-theme-custom]")}\n${bubbleOpacityCss(settings.appearance.bubbleOpacity, ":root[data-theme-custom]")}\n${panelOpacityCss(settings.appearance.panelOpacity, ":root[data-theme-custom]")}`;
    return () => {
      style?.remove();
      delete root.dataset.themePreset;
      delete root.dataset.themeCustom;
      delete root.dataset.themeWallpaper;
    };
  }, [settings.appearance.themePreset, settings.appearance.wallpaperOpacity, settings.appearance.bubbleOpacity, settings.appearance.panelOpacity, settings.appearance.customCss, settings.appearance.customCssAssets, settings.appearance.customThemes, themeAssetUrls]);

  // Project UI state onto the document root so custom themes can react to
  // settings/preview/chat state without observing the DOM. Attribute presence
  // means true; these names are part of the stable theme-hook contract.
  // 分屏语义：generating/chat-empty/attachments 反映焦点格（= 激活会话）；
  // permission/question 是“任一格有待决”的聚合。
  useEffect(() => {
    const root = document.documentElement;
    const states: readonly [string, boolean][] = [
      ["data-ui-settings-open", settingsOpen],
      ["data-ui-workspace-open", Boolean(snapshot.workspace)],
      ["data-ui-chat-empty", isChatEmpty],
      ["data-ui-generating", isGenerating],
      ["data-ui-preview-open", previewOpened],
      ["data-ui-permission-pending", Boolean(permission)],
      ["data-ui-question-pending", Boolean(question)],
      ["data-ui-split-open", paneIds.length > 1]
    ];
    const valueStates: readonly [string, string | undefined][] = [
      ["data-ui-sidebar-view", sidebarView],
      ["data-ui-density", settings.appearance.tune?.density],
      ["data-ui-radius", settings.appearance.tune?.radius]
    ];
    for (const [name, active] of states) {
      if (active) root.setAttribute(name, "");
      else root.removeAttribute(name);
    }
    for (const [name, value] of valueStates) {
      if (value) root.setAttribute(name, value);
      else root.removeAttribute(name);
    }
    return () => {
      for (const [name] of states) root.removeAttribute(name);
      for (const [name] of valueStates) root.removeAttribute(name);
    };
  }, [settingsOpen, snapshot.workspace, isChatEmpty, isGenerating, previewOpened, permission, question, paneIds.length, sidebarView, settings.appearance.tune]);

  async function openWorkspace(): Promise<void> {
    const path = await window.piDesktop.chooseWorkspace();
    if (path) await window.piDesktop.send({ type: "workspace.open", path });
  }

  /**
   * 新建话题：分屏中替换 paneSessionId 指定的格子（缺省焦点格）。新会话 id
   * 要等主进程激活后才知道，先记 pending，snapshot.sessionId 变化时落位。
   */
  async function createNewSession(workspace?: string, paneSessionId?: string): Promise<void> {
    try {
      if (splitTree) {
        const target = paneSessionId ?? focusedPaneId ?? snapshot.sessionId;
        if (target) pendingPaneReplaceRef.current = target;
      }
      await window.piDesktop.send({ type: "session.new", workspace });
      // 分组默认折叠，新建后展开目标工作区，让新话题立即可见。
      const key = workspaceKey(workspace ?? snapshot.workspace ?? "");
      if (key) setExpandedWorkspaceGroups((current) => ({ ...current, [key]: true }));
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "新建话题失败");
    }
  }

  async function openSession(path: string, sessionWorkspace: string, sessionId?: string): Promise<void> {
    try {
      // 分屏中：已在格子里的会话只聚焦；不在的替换焦点格（草稿/焦点随之迁移）。
      if (splitTree && sessionId) {
        if (leafIds(splitTree).includes(sessionId)) {
          focusPane(sessionId);
          return;
        }
        const target = focusedPaneId ?? snapshot.sessionId;
        if (target && sessionId) setSplitState((current) => current.tree ? { tree: replaceLeaf(current.tree, target, { kind: "leaf", sessionId }), focusedPane: sessionId } : current);
      }
      await window.piDesktop.send({ type: "session.open", path, workspace: sessionWorkspace });
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "打开话题失败");
    }
  }

  // —— 分屏：焦点 / 增删格 / 最大化 ——

  /** 聚焦某格 = 激活该会话（live 快路径），全局镜像（topbar/任务面板）随焦点切换。 */
  function focusPane(sessionId: string): void {
    if (sessionId === focusedPaneId && sessionId === snapshot.sessionId) return;
    setSplitState((current) => ({ tree: current.tree, focusedPane: sessionId }));
    setMaximizedPaneId((current) => (current !== undefined && current !== sessionId ? undefined : current));
    if (sessionId === snapshot.sessionId) return;
    const item = snapshot.sessions.find((summary) => summary.id === sessionId);
    if (item) {
      void window.piDesktop.send({ type: "session.open", path: item.path, workspace: item.workspace }).catch((error) => {
        setMessageActionError(error instanceof Error ? error.message : "切换分屏失败");
      });
    }
  }

  /** 侧栏右键「分屏」：自动把新会话插入到最接近方形的格子（方向由算法决定），新格成为焦点并被激活。 */
  function addSplitPane(item: SessionSummary): void {
    if (!snapshot.sessionId) return;
    if (splitTree && leafIds(splitTree).includes(item.id)) {
      focusPane(item.id);
      return;
    }
    if (splitTree && countLeaves(splitTree) >= MAX_SPLIT_PANES) return;
    // 自动均衡：不再固定「从焦点格链式分裂」，而是选最接近方形的格子落位、方向自动。
    setSplitState((current) => ({ tree: balancedAddPane(current.tree, snapshot.sessionId, item.id), focusedPane: item.id }));
    void window.piDesktop.send({ type: "session.open", path: item.path, workspace: item.workspace }).catch((error) => {
      setMessageActionError(error instanceof Error ? error.message : "分屏打开会话失败");
    });
  }

  /** 关闭一格：剪叶塌缩；只剩一格退出分屏（该会话保持运行，回到单窗口视图）。
   *  关闭的是焦点格时激活接替格（首叶），否则激活会话仍指向刚被移出屏幕的
   *  那个会话，全局镜像（topbar/任务面板/权限过滤）会跟着一个看不见的会话走。 */
  function removeSplitPane(sessionId: string): void {
    if (!splitTree) return;
    let successor: string | undefined;
    setSplitState((current) => {
      if (!current.tree) return current;
      const collapsed = removePane(current.tree, sessionId);
      // 单叶 = 退出分屏：树置 null，渲染条件回到单窗口分支。
      const next = collapsed?.kind === "leaf" ? null : collapsed;
      const focusedGone = current.focusedPane === sessionId;
      if (focusedGone && next) successor = firstLeafId(next);
      const focusedPane = focusedGone ? (next ? firstLeafId(next) : snapshot.sessionId) : current.focusedPane;
      return { tree: next, focusedPane };
    });
    setMaximizedPaneId((current) => (current === sessionId ? undefined : current));
    if (successor !== undefined) focusPane(successor);
  }

  function toggleMaximizePane(sessionId: string): void {
    setMaximizedPaneId((current) => (current === sessionId ? undefined : sessionId));
  }

  // —— 分屏格子回调的稳定身份 ——
  // 上面四个分屏函数每次渲染都重建；直接内联进格子 props 会让 memo 化的
  // ConversationPane 在布局树任何变化（拖分隔条每帧）时全体重渲染。这里持有
  // 最新函数版本的 ref + 按 sessionId 缓存的回调（闭包只捕获 leafSessionId，
  // 行为经 ref 永远取到当次渲染的函数），格子 props 身份跨渲染恒定。
  const paneActionsRef = useRef({ focusPane, removeSplitPane, toggleMaximizePane, createNewSession });
  paneActionsRef.current = { focusPane, removeSplitPane, toggleMaximizePane, createNewSession };
  const paneCallbacksRef = useRef(new Map<string, { onFocus(): void; onClose(): void; onToggleMaximize(): void; onNewSession(): Promise<void> }>());
  const getPaneCallbacks = useCallback((leafSessionId: string) => {
    let callbacks = paneCallbacksRef.current.get(leafSessionId);
    if (!callbacks) {
      callbacks = {
        onFocus: () => paneActionsRef.current.focusPane(leafSessionId),
        onClose: () => paneActionsRef.current.removeSplitPane(leafSessionId),
        onToggleMaximize: () => paneActionsRef.current.toggleMaximizePane(leafSessionId),
        onNewSession: () => paneActionsRef.current.createNewSession(undefined, leafSessionId)
      };
      paneCallbacksRef.current.set(leafSessionId, callbacks);
    }
    return callbacks;
  }, []);
  /** 单窗口 /new：与格子回调同模式走 ref，保持稳定身份。 */
  const defaultNewSession = useCallback((): Promise<void> => paneActionsRef.current.createNewSession(), []);

  // —— 分屏 effects ——

  /** 格子集合/可见性变化时同步 session.watch：非激活格子注册推送（主进程豁免
   *  驱逐、不设终端圆点、streaming 走 session.state 通道）；移出的格子注销并清
   *  缓存。最大化时其余格子转 hidden 模式（保留 watch 与驱逐豁免，只停推送），
   *  恢复可见时主进程补推水合帧。登记簿只收“真正发送过 watch 的 id”：格子首次
   *  成为焦点（激活）时被跳过、后来失焦的，会在本 effect 随 snapshot.sessionId
   *  变化重跑时补发——主进程幂等接受并立即回推一帧全量水合。 */
  useEffect(() => {
    if (!ready) return;
    const registered = watchedPaneIdsRef.current;
    const hiddenRegistered = hiddenPaneIdsRef.current;
    const panes = new Set(paneIds);
    const activeId = snapshot.sessionId;
    const visible = maximizedPaneId !== undefined && panes.has(maximizedPaneId)
      ? new Set([maximizedPaneId])
      : panes;
    // 可见性切换：visible → hidden 停推，hidden → visible 恢复（主进程补水合帧）。
    // 激活会话走 state 通道，不参与 hidden（即便瞬时不可见）。
    for (const id of panes) {
      const wantHidden = !visible.has(id) && id !== activeId;
      if (wantHidden === hiddenRegistered.has(id)) continue;
      if (wantHidden) {
        hiddenRegistered.add(id);
        void window.piDesktop.send({ type: "session.watch", sessionId: id, watch: true, hidden: true }).catch(() => {
          hiddenRegistered.delete(id);
        });
      } else {
        hiddenRegistered.delete(id);
        if (id !== activeId) {
          void window.piDesktop.send({ type: "session.watch", sessionId: id, watch: true }).catch(() => undefined);
        }
      }
    }
    for (const id of visible) {
      if (id === activeId || registered.has(id)) continue;
      registered.add(id);
      void window.piDesktop.send({ type: "session.watch", sessionId: id, watch: true }).catch(() => {
        registered.delete(id);
      });
    }
    const removed: string[] = [];
    for (const id of registered) {
      if (panes.has(id)) continue;
      removed.push(id);
      void window.piDesktop.send({ type: "session.watch", sessionId: id, watch: false }).catch(() => undefined);
    }
    for (const id of removed) {
      registered.delete(id);
      hiddenRegistered.delete(id);
    }
    if (removed.length > 0) {
      dropPaneStates(removed);
      // 回调缓存随格子一并释放（Map 不随会话消失自动清理）。
      for (const id of removed) paneCallbacksRef.current.delete(id);
    }
    // 单窗口（无格子）下 state 通道每次切会话都会写 parkedPanels 留档，而这些
    // 条目永远不会被读取——按当前格子集合修剪，防止内存无界增长。
    pruneParkedPanels(panes);
  }, [paneIds, snapshot.sessionId, ready, maximizedPaneId]);

  /** 分屏布局持久化（localStorage，重启恢复；失效格子由修剪 effect 清理）。
   *  尾随防抖：拖动分隔条时布局树每个 pointermove 帧都在变，同步写盘既卡主线程
   *  又磨损存储；停留 400ms 后落一次最终值。 */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (splitTree && focusedPaneId) window.localStorage.setItem("pidesktop.split-layout", JSON.stringify({ tree: splitTree, focusedPane: focusedPaneId }));
        else window.localStorage.removeItem("pidesktop.split-layout");
      } catch { /* storage 可能不可用 */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [splitTree, focusedPaneId]);

  /** 会话消失（删除/工作区移除）时修剪格子；焦点格被剪则回退到首个叶子。 */
  useEffect(() => {
    if (!splitTree || snapshot.sessions.length === 0) return;
    const valid = new Set(snapshot.sessions.map((item) => item.id));
    if (snapshot.sessionId) valid.add(snapshot.sessionId);
    setSplitState((current) => {
      if (!current.tree) return current;
      const { tree, removed } = pruneToIds(current.tree, valid);
      if (removed.length === 0) return current;
      const focusedGone = current.focusedPane !== undefined && removed.includes(current.focusedPane);
      const focusedPane = focusedGone ? (tree ? firstLeafId(tree) : snapshot.sessionId) : current.focusedPane;
      return { tree, focusedPane };
    });
  }, [snapshot.sessions, snapshot.sessionId, splitTree]);

  /**
   * 激活会话落位（按“激活 id 迁移”触发，树变化不触发）：维持「焦点格 =
   * 激活会话」不变量。三条路径——
   * ① 激活会话在格子集合里：聚焦跟随（focusPane / 侧栏打开 / 启动恢复的常规落位）；
   * ② 激活的会话在格子外且 pending 指定了目标格（/new 来自非焦点格）：替换该格；
   * ③ 其余格子外激活（session.new 默认、workspace.open、删除会话后的补空白等
   *   外部路径）：替换焦点格——否则激活会话不在任何格子里，分屏视图与全局
   *   镜像（topbar/任务面板/权限过滤）会指向一个看不见的会话。
   */
  const previousActiveIdRef = useRef<string | undefined>(snapshot.sessionId);
  useEffect(() => {
    const activeId = snapshot.sessionId;
    if (previousActiveIdRef.current === activeId) return;
    previousActiveIdRef.current = activeId;
    if (!splitTree || !activeId) return;
    if (paneIds.includes(activeId)) {
      setSplitState((current) => current.focusedPane === activeId ? current : { tree: current.tree, focusedPane: activeId });
      return;
    }
    const pending = pendingPaneReplaceRef.current;
    pendingPaneReplaceRef.current = undefined;
    const target = pending !== undefined && paneIds.includes(pending)
      ? pending
      : focusedPaneId ?? (splitTree ? firstLeafId(splitTree) : undefined);
    if (!target) return;
    setSplitState((current) => current.tree
      ? { tree: replaceLeaf(current.tree, target, { kind: "leaf", sessionId: activeId }), focusedPane: activeId }
      : current);
  }, [snapshot.sessionId, splitTree, paneIds, focusedPaneId]);

  /** 切换助手清空分屏（会话列表按助手划分，旧格子全部失效）。 */
  const agentIdRef = useRef(snapshot.agentId);
  useEffect(() => {
    if (agentIdRef.current === snapshot.agentId) return;
    agentIdRef.current = snapshot.agentId;
    setSplitState({ tree: null });
    setMaximizedPaneId(undefined);
    draftsRef.current.clear();
  }, [snapshot.agentId]);

  /** 启动恢复分屏：会话列表就绪后先打开焦点格（用户注视的画面最先出现，不排
   *  在 N-1 个背景会话构建之后），再逐个以 activate:false 打开背景格（创建
   *  record 但不激活，全局镜像保持焦点格）。背景格的 session.watch 已由 watch
   *  effect 先行发出（主进程 pendingWatchSessions 排队，创建即补水合帧）。 */
  const splitRestoreDoneRef = useRef(false);
  useEffect(() => {
    if (splitRestoreDoneRef.current || !ready || !splitTree || snapshot.sessions.length === 0) return;
    splitRestoreDoneRef.current = true;
    const focused = focusedPaneId && paneIds.includes(focusedPaneId) ? focusedPaneId : paneIds[0];
    const background = paneIds.filter((id) => id !== focused);
    void (async () => {
      const focusedItem = snapshot.sessions.find((summary) => summary.id === focused);
      if (focusedItem) {
        try {
          await window.piDesktop.send({ type: "session.open", path: focusedItem.path, workspace: focusedItem.workspace });
        } catch {
          /* 焦点格失败不阻断背景格恢复 */
        }
      }
      for (const id of background) {
        const item = snapshot.sessions.find((summary) => summary.id === id);
        if (!item) continue;
        try {
          await window.piDesktop.send({ type: "session.open", path: item.path, workspace: item.workspace, activate: false });
        } catch {
          /* 单格失败不阻断其余格子 */
        }
      }
    })();
  }, [ready, splitTree, paneIds, focusedPaneId, snapshot.sessions]);

  /** 最大化目标格子被剪/退出分屏时清除最大化态。 */
  useEffect(() => {
    if (maximizedPaneId && (!splitTree || !leafIds(splitTree).includes(maximizedPaneId))) setMaximizedPaneId(undefined);
  }, [splitTree, maximizedPaneId]);

  function updatePreviewSplitFromPointer(clientX: number, clientY: number): void {
    const bounds = workAreaRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const stacked = window.matchMedia("(max-width: 760px)").matches;
    const value = stacked
      ? ((clientY - bounds.top) / bounds.height) * 100
      : ((clientX - bounds.left) / bounds.width) * 100;
    setPreviewSplit(Math.round(clampPreviewSplit(value) * 10) / 10);
  }

  function startPreviewResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    previewDragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    setPreviewDragging(true);
    updatePreviewSplitFromPointer(event.clientX, event.clientY);
  }

  function movePreviewResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (previewDragPointerRef.current !== event.pointerId) return;
    updatePreviewSplitFromPointer(event.clientX, event.clientY);
  }

  function endPreviewResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (previewDragPointerRef.current !== event.pointerId) return;
    updatePreviewSplitFromPointer(event.clientX, event.clientY);
    previewDragPointerRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setPreviewDragging(false);
  }

  function cancelPreviewResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (previewDragPointerRef.current !== event.pointerId) return;
    previewDragPointerRef.current = undefined;
    setPreviewDragging(false);
  }

  function resizePreviewWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>): void {
    const next = previewSplitFromKey(event.key, previewSplit);
    if (next === undefined) return;
    event.preventDefault();
    setPreviewSplit(next);
  }

  function openPreviewTarget(target: PreviewTarget, id: string = previewTargetKey(target)): void {
    setPreviewOpened(true);
    setPreview((current) => {
      if (current?.tabs.some((tab) => tab.id === id)) return { ...current, activeTabId: id };
      const tab: PreviewTab = { id, target };
      return current ? { tabs: [...current.tabs, tab], activeTabId: id } : { tabs: [tab], activeTabId: id };
    });
  }

  function updatePreviewTarget(id: string, target: PreviewTarget): void {
    setPreview((current) => (current ? { ...current, tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, target } : tab)) } : current));
  }

  function selectPreviewTab(id: string): void {
    setPreview((current) => (current ? { ...current, activeTabId: id } : current));
  }

  function closePreviewTab(id: string): void {
    // Real removal of a browser tab must destroy its native view; mere tab
    // switching only hides it (see BrowserPreview unmount behavior). Terminal
    // tabs are the same: closing kills the PTY, switching keeps it alive.
    const closing = preview?.tabs.find((tab) => tab.id === id);
    if (closing?.target.type === "browser") {
      void window.piDesktop.browserPreview({ type: "close", tabId: id });
    }
    if (closing?.target.type === "terminal") {
      void window.piDesktop.terminal({ type: "kill", terminalId: id });
    }
    setPreview((current) => {
      if (!current) return undefined;
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      if (tabs.length === 0) return undefined;
      const activeTabId = current.activeTabId === id ? tabs[Math.min(index, tabs.length - 1)]!.id : current.activeTabId;
      return { tabs, activeTabId };
    });
  }

  const openArtifactPreview = useCallback((artifact: Artifact): void => {
    openPreviewTarget({ type: "artifact", artifact });
  }, []);

  function openBrowserPreview(): void {
    openPreviewTarget({ type: "browser", id: `browser-${crypto.randomUUID()}` });
  }

  /** 打开计划全文预览（内存 markdown，不落盘），供审查面板「查看完整」跳转。 */
  function openPlanPreview(detail: string): void {
    openPreviewTarget({ type: "plan", title: detailTitle(detail), content: detail });
  }

  function openTerminalPreview(): void {
    openPreviewTarget({ type: "terminal" }, `terminal-${crypto.randomUUID()}`);
  }

  async function openManualFilePreview(): Promise<void> {
    try {
      const file = await window.piDesktop.choosePreviewFile();
      if (!file) return;
      openPreviewTarget({ type: "file", file, workspace: file.workspace });
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "无法打开预览文件");
    }
  }

  const openFilePreview = useCallback(async (relativePath: string, workspace?: string): Promise<void> => {
    const id = workspace ? `${workspace}::${relativePath}` : relativePath;
    setPreviewOpened(true);
    if (previewRef.current?.tabs.some((tab) => tab.id === id)) {
      setPreview((current) => (current ? { ...current, activeTabId: id } : current));
      return;
    }
    const title = relativePath.split("/").at(-1) ?? relativePath;
    openPreviewTarget({ type: "loading", title, path: relativePath }, id);
    try {
      const file = await window.piDesktop.readWorkspaceFile(relativePath, workspace);
      // 记下文件所属工作区：编辑后必须写回该工作区，而不是当前会话工作区。
      updatePreviewTarget(id, { type: "file", file, workspace: file.workspace ?? workspace });
    } catch (error) {
      updatePreviewTarget(id, { type: "error", title, path: relativePath, message: error instanceof Error ? error.message : "读取文件失败" });
    }
  }, []);

  const openDiffPreview = useCallback((execution: ToolExecution): void => {
    if (!execution.patch) return;
    const path = execution.changedFile?.relativePath;
    openPreviewTarget({ type: "diff", title: path?.split("/").at(-1) ?? `${toolLabel(execution.name)}变更`, path, patch: execution.patch });
  }, []);

  const latestReviewExecution = [...snapshot.executions].reverse().find((execution) => Boolean(execution.patch));
  const openLatestReview = useCallback((): void => {
    if (latestReviewExecution) openDiffPreview(latestReviewExecution);
  }, [latestReviewExecution, openDiffPreview]);

  /** 分屏格子的渲染器：头部信息来自会话列表摘要，交互回调全部绑定本格 sessionId。 */
  const renderSplitLeaf = useCallback((leafSessionId: string): ReactNode => {
    const summary = snapshot.sessions.find((item) => item.id === leafSessionId);
    const { onFocus, onClose, onToggleMaximize, onNewSession } = getPaneCallbacks(leafSessionId);
    return (
      <div className="split-pane" key={leafSessionId} data-pane-active={leafSessionId === focusedPaneId || undefined}>
        <ConversationPane
          sessionId={leafSessionId}
          compact
          focused={leafSessionId === focusedPaneId}
          maximized={leafSessionId === maximizedPaneId}
          title={summary?.title}
          runStatus={summary?.runStatus}
          showDock={leafSessionId === focusedPaneId}
          onFocus={onFocus}
          onClose={onClose}
          onToggleMaximize={onToggleMaximize}
          onNewSession={onNewSession}
          registerComposerApi={registerComposerApi}
          draftStore={draftStore}
          onOpenArtifact={openArtifactPreview}
          onOpenFile={openFilePreview}
          onOpenDiff={openDiffPreview}
          onOpenPlanDetail={openPlanPreview}
          onActionError={setActionError}
          onRollback={(file) => openRollbackConfirm(file, leafSessionId)}
        />
      </div>
    );
  }, [snapshot.sessions, focusedPaneId, maximizedPaneId, openArtifactPreview, openFilePreview, openDiffPreview, registerComposerApi, draftStore, setActionError, getPaneCallbacks, openRollbackConfirm]);

  /** 分隔条拖动：按 split 节点路径更新比例（夹取在 SplitDivider 内完成）。 */
  const handleSplitRatioChange = useCallback((path: readonly number[], ratio: number): void => {
    setSplitState((current) => current.tree ? { ...current, tree: updateRatio(current.tree, path, ratio) } : current);
  }, []);

  // —— Markdown 编辑器状态与 AI 变更智能合并 ——
  const previewEditorStatesRef = useRef(previewEditorStates);
  previewEditorStatesRef.current = previewEditorStates;
  const editorSyncedExecutionsRef = useRef<Record<string, string>>({});
  const defaultEditorState = (): PreviewEditorState => ({ editing: true, dirty: false, externalConflict: false });
  function getEditorState(tabId: string): PreviewEditorState {
    return previewEditorStates[tabId] ?? defaultEditorState();
  }
  function patchEditorState(tabId: string, patch: Partial<PreviewEditorState>): void {
    setPreviewEditorStates((prev) => ({ ...prev, [tabId]: { ...(prev[tabId] ?? defaultEditorState()), ...patch } }));
  }
  // —— Markdown 编辑器保存管线（乐观快照 + 右上角状态指示器） ——
  // 每次输入即时同步 tab 快照：切 tab/切预览立即显示最新内容，不会短暂回退成旧内容。
  function handleActiveEditorContentChange(tabId: string, content: string): void {
    const tab = previewRef.current?.tabs.find((t) => t.id === tabId);
    if (tab?.target.type !== "file" || tab.target.file.content === content) return;
    updatePreviewTarget(tabId, { type: "file", file: { ...tab.target.file, content }, workspace: tab.target.workspace });
  }
  // 落盘成功后同步快照（内容已乐观同步过，这里补上精确字节数）。
  function handleActiveEditorSaved(tabId: string, content: string): void {
    const tab = previewRef.current?.tabs.find((t) => t.id === tabId);
    if (tab?.target.type !== "file") return;
    updatePreviewTarget(tabId, { type: "file", file: { ...tab.target.file, content, size: new Blob([content]).size }, workspace: tab.target.workspace });
  }
  // 保存状态 → 右上角指示器；“已保存”2.5s 后自动收起，期间重新输入则不收起。
  function handleActiveEditorStatusChange(tabId: string, status: EditorSaveStatus): void {
    patchEditorState(tabId, { saveStatus: status });
    if (status !== "saved") return;
    window.setTimeout(() => {
      setPreviewEditorStates((prev) => {
        const current = prev[tabId];
        if (!current || current.saveStatus !== "saved") return prev;
        return { ...prev, [tabId]: { ...current, saveStatus: "idle" } };
      });
    }, 2500);
  }
  async function reloadEditorFromDisk(tabId: string, relativePath: string): Promise<void> {
    try {
      const tab = previewRef.current?.tabs.find((t) => t.id === tabId);
      const fileWorkspace = tab?.target.type === "file" ? tab.target.workspace : undefined;
      const file = await window.piDesktop.readWorkspaceFile(relativePath, fileWorkspace ?? snapshot.workspace);
      updatePreviewTarget(tabId, { type: "file", file, workspace: fileWorkspace ?? file.workspace });
      setPreviewEditorStates((prev) => {
        const prior = prev[tabId] ?? defaultEditorState();
        return { ...prev, [tabId]: { ...prior, remoteReload: { content: file.content ?? "", nonce: (prior.remoteReload?.nonce ?? 0) + 1 }, externalConflict: false, dirty: false } };
      });
    } catch {
      /* 读取失败则保留当前编辑器内容 */
    }
  }
  function handleEditorResolveConflict(tabId: string, choice: "keep-local" | "load-remote"): void {
    const tab = previewRef.current?.tabs.find((t) => t.id === tabId);
    const relativePath = tab?.target.type === "file" ? tab.target.file.relativePath : undefined;
    const exec = relativePath
      ? [...snapshot.executions].reverse().find((e) => e.status === "completed" && e.changedFile && e.changedFile.relativePath.toLowerCase() === relativePath.toLowerCase())
      : undefined;
    if (tab && exec) editorSyncedExecutionsRef.current[tab.id] = exec.id;
    if (choice === "load-remote" && relativePath) {
      void reloadEditorFromDisk(tabId, relativePath);
    } else {
      setPreviewEditorStates((prev) => ({ ...prev, [tabId]: { ...(prev[tabId] ?? defaultEditorState()), externalConflict: false } }));
    }
  }
  // 当 edit/write 工具改动了正在编辑的 markdown 文件：本地无未保存改动→自动刷新；
  // 有未保存改动→置冲突提示，等用户在编辑器内选择保留本地或加载 AI 版本。
  useEffect(() => {
    if (!preview) return;
    for (const tab of preview.tabs) {
      if (tab.target.type !== "file" || tab.target.file.kind !== "markdown") continue;
      const relativePath = tab.target.file.relativePath.toLowerCase();
      const exec = [...snapshot.executions].reverse().find((e) => e.status === "completed" && e.changedFile && e.changedFile.relativePath.toLowerCase() === relativePath);
      if (!exec || editorSyncedExecutionsRef.current[tab.id] === exec.id) continue;
      const state = previewEditorStatesRef.current[tab.id] ?? defaultEditorState();
      if (state.dirty) {
        if (!state.externalConflict) patchEditorState(tab.id, { externalConflict: true });
      } else {
        editorSyncedExecutionsRef.current[tab.id] = exec.id;
        void reloadEditorFromDisk(tab.id, tab.target.file.relativePath);
      }
    }
  }, [snapshot.executions, preview]);

  // AI 浏览器自动化与预览面板同步：created 把新标签加进面板并激活；
  // automation-started 展开面板并切到 AI 正在操作的标签（面板未打开时
  // 自动打开，用户能看到 AI 的操作过程）；closed 移除面板标签（native
  // view 已在主进程销毁）。用户手动开/关标签触发同一事件，openPreviewTarget
  // 的去重逻辑保证幂等。
  useEffect(() => window.piDesktop.onBrowserTabsChanged((event) => {
    if (event.action === "created" || event.action === "automation-started") {
      openPreviewTarget({ type: "browser", id: event.tabId }, event.tabId);
      return;
    }
    setPreview((current) => {
      if (!current) return undefined;
      const tabs = current.tabs.filter((tab) => tab.id !== event.tabId);
      if (tabs.length === 0) return undefined;
      const activeTabId = current.activeTabId === event.tabId ? tabs[0]!.id : current.activeTabId;
      return { tabs, activeTabId };
    });
  }), []);

  const sidebarInner = (
    <>
      {sidebarView === "files" ? (
        <>
          <div className="workspace-tree-header">
            <button type="button" className="workspace-tree-back" onClick={() => setSidebarView("topics")}><ChevronLeft size={14} />返回</button>
            <span title={browsingWorkspace}>{browsingWorkspace ? (browsingWorkspace.split(/[\\/]/u).at(-1) ?? browsingWorkspace) : "工作区文件"}</span>
            <button type="button" className="workspace-tree-refresh" title="刷新文件列表" aria-label="刷新文件列表" onClick={() => setTreeRefreshSignal((signal) => signal + 1)}><RefreshCw size={13} /></button>
          </div>
          {browsingWorkspace
            ? <WorkspaceTree key={browsingWorkspace} workspace={browsingWorkspace} onOpenFile={(relativePath) => openFilePreview(relativePath, browsingWorkspace)} refreshSignal={treeRefreshSignal} />
            : <div className="session-list-empty">请从话题列表选择工作区</div>}
        </>
      ) : (
        <>
          <div className="sidebar-tabs" role="tablist" aria-label="侧栏视图">
            <button type="button" role="tab" aria-selected={sidebarTab === "agents"} className={sidebarTab === "agents" ? "active" : ""} onClick={() => { setSidebarTab("agents"); setSidebarQuery(""); }}><Users size={14} />助手<span>{settings.agents.filter((agent) => !agent.archived).length}</span></button>
            <button type="button" role="tab" aria-selected={sidebarTab === "topics"} className={sidebarTab === "topics" ? "active" : ""} onClick={() => { setSidebarTab("topics"); setSidebarQuery(""); }}><MessageCircle size={14} />话题<span>{snapshot.sessions.length}</span></button>
          </div>
          <label className="sidebar-search"><Search size={14} /><input ref={sidebarSearchRef} value={sidebarQuery} placeholder={sidebarTab === "agents" ? "搜索助手" : "搜索话题"} aria-label={sidebarTab === "agents" ? "搜索助手" : "搜索话题"} onChange={(event) => setSidebarQuery(event.target.value)} /></label>
          <div className="sidebar-section-label">{sidebarTab === "agents" ? "角色" : "最近话题"}</div>
          {sidebarTab === "agents" ? <nav className="agent-list" aria-label="助手列表">
            {visibleAgents.map((agent) => <button className={agent.id === snapshot.agentId ? "active" : ""} type="button" key={agent.id} data-row-kind="agent" data-row-active={agent.id === snapshot.agentId || undefined} onClick={() => { useDesktopStore.setState({ settings: { ...settings, currentAgentId: agent.id } }); void window.piDesktop.send({ type: "agent.select", agentId: agent.id }); }}><span className="agent-list-icon"><Bot size={15} /></span><span><strong>{agent.name}</strong><small>{agent.description || "未填写说明"}</small></span></button>)}
          </nav> : <nav className="session-list" aria-label="话题列表">
            {sessionGroups.length === 0 ? <div className="session-list-empty">暂无匹配话题</div> : sessionGroups.map((group) => {
              const collapsed = expandedWorkspaceGroups[group.key] !== true;
              const workspaceName = group.workspace.split(/[\\/]/u).at(-1) || group.workspace;
              return (
                <section className="session-workspace-group" key={group.key}>
                  <div className="session-workspace-heading" data-row-kind="workspace" data-row-expanded={!collapsed || undefined} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, items: [{ label: "打开文件目录", onClick: () => { setBrowsingWorkspace(group.workspace); setTreeRefreshSignal(0); setSidebarView("files"); } }, { label: "移除工作区", danger: true, onClick: () => setRemoveWorkspace({ workspace: group.workspace, name: workspaceName, count: group.sessions.length }) }] }); }}>
                    <button
                      className="session-workspace-toggle"
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() => setExpandedWorkspaceGroups((current) => ({ ...current, [group.key]: collapsed }))}
                    >
                      <Folder size={15} />
                      <span><strong>{workspaceName}</strong><small>{compactPath(group.workspace)}</small></span>
                      <em>{group.sessions.length}</em>
                      <ChevronDown size={14} className={collapsed ? "collapsed" : ""} />
                    </button>
                    <button
                      className="session-workspace-files-button"
                      type="button"
                      title={`查看 ${workspaceName} 文件`}
                      aria-label={`查看 ${workspaceName} 文件`}
                      onClick={() => { setBrowsingWorkspace(group.workspace); setTreeRefreshSignal(0); setSidebarView("files"); }}
                    >
                      <FolderTree size={14} />
                    </button>
                    <button
                      className="session-workspace-new-button"
                      type="button"
                      title={`在 ${workspaceName} 中新建话题`}
                      aria-label={`在 ${workspaceName} 中新建话题`}
                      onClick={() => void createNewSession(group.workspace)}
                    >
                      <SquarePen size={14} />
                    </button>
                  </div>
                  {!collapsed && <div className="session-workspace-items">
                    {group.sessions.length === 0
                      ? <div className="session-workspace-empty">暂无话题，点击右上角新建</div>
                      : group.sessions.map((item) => <button className={item.id === snapshot.sessionId || (splitTree ? paneIds.includes(item.id) : false) ? "active" : ""} type="button" key={item.path} title={item.title} data-row-kind="session" data-row-active={item.id === snapshot.sessionId || (splitTree ? paneIds.includes(item.id) : false) || undefined} onClick={() => void openSession(item.path, item.workspace, item.id)} onContextMenu={(event) => { event.preventDefault(); const splitDisabled = !snapshot.sessionId || (splitTree ? countLeaves(splitTree) >= MAX_SPLIT_PANES : false); const inPane = splitTree ? leafIds(splitTree).includes(item.id) : false; setContextMenu({ x: event.clientX, y: event.clientY, items: [{ label: "重命名", onClick: () => { setRenameSession({ path: item.path, title: item.title }); setRenameValue(item.title); } }, { label: item.pinned ? "取消置顶" : "置顶", onClick: () => { void window.piDesktop.send({ type: "session.pin", path: item.path, pinned: !item.pinned }); } }, { label: inPane ? "已分屏，切换到该格" : "分屏", disabled: !inPane && splitDisabled, onClick: () => addSplitPane(item) }, { label: "删除会话", danger: true, onClick: () => setDeleteSession({ path: item.path, title: item.title }) }] }); }}><MessageCircle size={14} /><span><strong>{item.title}</strong><small>{new Date(item.modifiedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</small></span>{(item.runStatus || item.pinned) && <div className="session-item-meta">{item.runStatus && <i className={`session-status-dot ${item.runStatus}`} title={sessionRunStatusLabels[item.runStatus]} aria-label={sessionRunStatusLabels[item.runStatus]!} />}{item.pinned && <Pin size={11} className="session-pin-indicator" />}</div>}</button>)}
                  </div>}
                </section>
              );
            })}
          </nav>}
        </>
      )}
      <button className="new-session-button" data-control="new-session" type="button" disabled={!snapshot.workspace} onClick={() => void createNewSession()}><MessageSquarePlus size={16} />新建话题</button>
      <div className="sidebar-footer">
        <button type="button" data-control="settings" onClick={() => setSettingsOpen(true)}><Settings size={16} />设置</button>
        <span className={`runtime-indicator${snapshot.busy ? " busy" : ""}`}><i />{snapshot.status}</span>
      </div>
    </>
  );

  if (!ready) return <div className="app-loading"><div className="brand-mark">CA</div><LoaderCircle className="spinning" size={22} /></div>;

  return (
    <div className={`desktop-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      {themeLayers.map(({ kind, name }) => (
        <div key={`${kind}-${name}`} className="theme-layer" data-theme-layer={name} data-layer-kind={kind} style={{ background: `var(--pi-${kind}-${name}, none)` }} />
      ))}
      {sidebarCollapsed ? (
        <div className="sidebar-rail" data-pane="sidebar" data-ui-sidebar-collapsed>
          <button type="button" className="rail-brand" data-control="sidebar-expand" title="展开侧边栏" aria-label="展开侧边栏" onClick={() => { if (sidebarFlyoutOpen) { setSidebarFlyoutOpen(false); } else { setSidebarCollapsed(false); } }}><span className="rail-brand-mark">CA</span><PanelLeftOpen className="rail-brand-expand" size={18} /></button>
          <div className="sidebar-rail-items">
            <button type="button" className="rail-new-session" data-control="new-session" title="在当前工作区新建话题" aria-label="在当前工作区新建话题" disabled={!snapshot.workspace} onClick={() => void createNewSession()}><Plus size={18} /></button>
            <button type="button" className="rail-icon" data-control="rail-topics" title="话题列表" aria-label="话题列表" onClick={() => { setSidebarView("topics"); setSidebarTab("topics"); setSidebarFlyoutOpen(true); }}><MessageCircle size={18} /></button>
            <button type="button" className="rail-icon" data-control="rail-search" title="搜索" aria-label="搜索" onClick={() => { setSidebarView("topics"); setSidebarFlyoutOpen(true); window.setTimeout(() => sidebarSearchRef.current?.focus(), 30); }}><Search size={18} /></button>
            <button type="button" className="rail-icon" data-control="rail-agents" title="助手" aria-label="助手" onClick={() => { setSidebarView("topics"); setSidebarTab("agents"); setSidebarFlyoutOpen(true); }}><Users size={18} /></button>
          </div>
          {sidebarFlyoutOpen && (
            <aside className="sidebar sidebar-flyout" data-pane="sidebar">
              <div className="brand-row"><div className="brand-mark">CA</div><div><strong>ChatAnyTime</strong><span>桌面端</span></div></div>
              {sidebarInner}
            </aside>
          )}
        </div>
      ) : (
        <aside className="sidebar" data-pane="sidebar">
          <div className="brand-row">
            <div className="brand-mark">CA</div>
            <div><strong>ChatAnyTime</strong><span>桌面端</span></div>
            <button type="button" className="brand-collapse-button" data-control="sidebar-collapse" title="折叠侧边栏" aria-label="折叠侧边栏" onClick={() => setSidebarCollapsed(true)}><PanelLeftClose size={16} /></button>
          </div>
          {sidebarInner}
        </aside>
      )}


      <main className="workspace-main" data-pane="workspace">
        <header className="topbar" data-pane="topbar">
          <div className="project-title"><Folder size={17} /><span><strong>{snapshot.workspace?.split(/[\\/]/u).at(-1) ?? "ChatAnyTime"}</strong><small>{snapshot.agentName} · {snapshot.sessionId ? "当前话题" : "未开始话题"}</small></span>{snapshot.gitBranch && <span className="git-branch-badge" title={`当前 Git 分支：${snapshot.gitBranch}`}><GitBranch size={13} />{snapshot.gitBranch}</span>}</div>
          <div className="runtime-controls">
            <button className="workspace-top-button" data-control="workspace-open" type="button" onClick={() => void openWorkspace()}><FolderOpen size={15} /><span>工作区</span><strong>{compactPath(snapshot.workspace)}</strong><ChevronDown size={13} /></button>
            <button className="icon-button preview-panel-toggle" data-control="preview-toggle" type="button" aria-label={previewOpened ? "关闭预览" : "打开预览"} title={previewOpened ? "关闭预览" : "打开预览"} onClick={() => {
              // 顶部按钮始终完全关闭/打开预览面板：即使已有标签页也不会
              // 折叠成残留一列栏+展开按钮的中间态。
              if (previewOpened) {
                setPreviewOpened(false);
              } else {
                setPreviewOpened(true);
              }
            }}>{previewOpened ? <PanelRightClose size={18} /> : <Eye size={18} />}</button>
          </div>
        </header>

          <div
            ref={workAreaRef}
            data-pane="work-area"
            className={`work-area${previewOpened && preview && preview.tabs.length > 0 ? " with-preview" : previewOpened ? " with-preview-empty" : ""}${previewDragging ? " is-preview-dragging" : ""}`}
            style={previewOpened ? { "--preview-split": `${previewSplit}%` } as CSSProperties : undefined}
          >
          {/* 会话槽位：单窗口 = 一个 ConversationPane；分屏 = 布局树递归渲染，
              最大化时只渲染目标格（树保留，还原即恢复）。预览面板/终端是全局
              标签页，与会话槽位并存于 work-area 网格。 */}
          {splitTree && paneIds.length > 0 ? (
            <div className={`split-view${maximizedPaneId ? " maximized" : ""}`}>
              {maximizedPaneId && paneIds.includes(maximizedPaneId)
                ? renderSplitLeaf(maximizedPaneId)
                : <SplitLayout node={splitTree} renderLeaf={renderSplitLeaf} onRatioChange={handleSplitRatioChange} />}
            </div>
          ) : (
            <ConversationPane
              sessionId={snapshot.sessionId}
              showDock
              focused
              onNewSession={defaultNewSession}
              registerComposerApi={registerComposerApi}
              draftStore={draftStore}
              onOpenArtifact={openArtifactPreview}
              onOpenFile={openFilePreview}
              onOpenDiff={openDiffPreview}
              onOpenPlanDetail={openPlanPreview}
              onActionError={setActionError}
              onRollback={(file) => openRollbackConfirm(file, snapshot.sessionId)}
            />
          )}

          {previewOpened && preview && <PreviewDivider split={previewSplit} dragging={previewDragging} onStart={startPreviewResize} onMove={movePreviewResize} onEnd={endPreviewResize} onCancel={cancelPreviewResize} onKeyDown={resizePreviewWithKeyboard} onReset={() => setPreviewSplit(50)} />}

          {previewOpened && (preview && preview.tabs.length > 0 ? (
            <ArtifactPreview tabs={preview.tabs} activeTabId={preview.activeTabId} browserSuspended={previewDragging || settingsOpen || Boolean(permission) || Boolean(messageActionError) || previewAddMenuOpen} onSelectTab={selectPreviewTab} onCloseTab={closePreviewTab} onOpenArtifact={openArtifactPreview} onAddBrowser={openBrowserPreview} onAddTerminal={openTerminalPreview} onAddFile={() => void openManualFilePreview()} onAddReview={openLatestReview} onAddMenuOpenChange={setPreviewAddMenuOpen} reviewAvailable={Boolean(latestReviewExecution)} workspace={snapshot.workspace} activeEditorState={activePreviewTab?.target.type === "file" && activePreviewTab.target.file.kind === "markdown" ? getEditorState(activePreviewTab.id) : undefined} onActiveEditorChange={(patch) => { if (activePreviewTab) patchEditorState(activePreviewTab.id, patch); }} onActiveEditorContentChange={handleActiveEditorContentChange} onActiveEditorSaved={handleActiveEditorSaved} onActiveEditorStatusChange={handleActiveEditorStatusChange} onActiveEditorSaveError={(message) => setMessageActionError(`保存 ${activePreviewTab?.target.type === "file" ? activePreviewTab.target.file.name : "Markdown"} 失败：${message}`)} onActiveEditorResolveConflict={(choice) => { if (activePreviewTab) handleEditorResolveConflict(activePreviewTab.id, choice); }} onToggleEditing={() => { if (activePreviewTab) patchEditorState(activePreviewTab.id, { editing: !getEditorState(activePreviewTab.id).editing }); }} onBrowserStateChange={handleBrowserStateChange} onBrowserPickSend={sendPickedElement} />
          ) : (
            <ArtifactPreview key="empty-state" tabs={[]} activeTabId="" onSelectTab={selectPreviewTab} onCloseTab={closePreviewTab} onOpenArtifact={openArtifactPreview} onAddBrowser={openBrowserPreview} onAddTerminal={openTerminalPreview} onAddFile={() => void openManualFilePreview()} onBrowserPickSend={sendPickedElement} />
          ))}
        </div>
      </main>

      {settingsOpen && <SettingsDialog settings={settings} models={models} providers={providers} customProvider={customProvider} customProviderKeyConfigured={customProviderKeyConfigured} customModels={customModels} customModelFetchStatus={customModelFetchStatus} customModelFetchError={customModelFetchError} modelRefreshStatus={modelRefreshStatus} modelRefreshError={modelRefreshError} modelRefreshProvider={modelRefreshProvider} resources={resources} workspaceOpen={Boolean(snapshot.workspace)} onClose={() => setSettingsOpen(false)} />}
      {permission && <PermissionDialog request={permission} sessionTitle={snapshot.sessions.find((item) => item.id === permission.principal.sessionId)?.title} />}
      {contextMenu && <ContextMenu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)} />}
      {renameSession && (
        <div className="modal-backdrop permission-backdrop" onClick={() => setRenameSession(null)}>
          <div className="permission-dialog extension-ui-dialog" role="dialog" aria-modal="true" aria-label="重命名会话" onClick={(event) => event.stopPropagation()}>
            <header><div className="risk-icon command"><Pencil size={20} /></div><div><h2>重命名会话</h2></div></header>
            <form onSubmit={(event) => { event.preventDefault(); const title = renameValue.trim(); if (title) { void window.piDesktop.send({ type: "session.rename", path: renameSession.path, title }); setRenameSession(null); } }}>
              <div className="field"><label>会话名称</label><input value={renameValue} placeholder="输入会话名称" autoFocus onChange={(event) => setRenameValue(event.target.value)} /></div>
              <footer><button className="secondary-button" type="button" onClick={() => setRenameSession(null)}>取消</button><button className="primary-button" type="submit" disabled={!renameValue.trim()}>确定</button></footer>
            </form>
          </div>
        </div>
      )}
      {deleteSession && (
        <div className="modal-backdrop permission-backdrop" onClick={() => setDeleteSession(null)}>
          <div className="permission-dialog" role="alertdialog" aria-modal="true" aria-label="删除会话" onClick={(event) => event.stopPropagation()}>
            <header><div className="risk-icon outside-workspace"><Trash2 size={20} /></div><div><h2>删除会话「{deleteSession.title}」？</h2><p>将永久删除该会话及其关联的任务清单，此操作不可恢复。</p></div></header>
            <footer><button className="secondary-button" type="button" onClick={() => setDeleteSession(null)}>取消</button><button className="danger-button" type="button" onClick={() => { void window.piDesktop.send({ type: "session.delete", path: deleteSession.path }); setDeleteSession(null); }}>删除</button></footer>
          </div>
        </div>
      )}
      {rollbackTarget && (
        <div className="modal-backdrop permission-backdrop" onClick={() => setRollbackTarget(null)}>
          <div className="permission-dialog" role="alertdialog" aria-modal="true" aria-label="回滚文件" onClick={(event) => event.stopPropagation()}>
            <header><div className="risk-icon write"><History size={20} /></div><div><h2>回滚文件「{rollbackTarget.file.relativePath.split("/").at(-1)}」？</h2><p>{rollbackTarget.file.relativePath}</p><p>该文件将恢复到本次改动前的状态；若它是本次新建的文件则会被删除，当前内容会被覆盖。</p></div></header>
            <footer>
              <button className="secondary-button" type="button" onClick={() => setRollbackTarget(null)}>取消</button>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  void window.piDesktop.send({
                    type: "checkpoint.rollback",
                    sessionId: rollbackTarget.sessionId,
                    targets: [{ relativePath: rollbackTarget.file.relativePath, toolCallIds: rollbackTarget.file.toolCallIds }]
                  });
                  setRollbackTarget(null);
                }}
              >回滚</button>
            </footer>
          </div>
        </div>
      )}
      {checkpointToast && (
        <div className="error-toast checkpoint-toast"><History size={18} /><span>{checkpointToast}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={() => setCheckpointToast(undefined)}><X size={16} /></button></div>
      )}
      {removeWorkspace && (
        <div className="modal-backdrop permission-backdrop" onClick={() => setRemoveWorkspace(null)}>
          <div className="permission-dialog" role="alertdialog" aria-modal="true" aria-label="移除工作区" onClick={(event) => event.stopPropagation()}>
            <header><div className="risk-icon outside-workspace"><Trash2 size={20} /></div><div><h2>移除工作区「{removeWorkspace.name}」？</h2><p>{removeWorkspace.count > 0 ? `将永久删除该工作区下 ${removeWorkspace.count} 个会话，此操作不可恢复。` : "该工作区暂无会话，将从侧边栏移除。"}</p></div></header>
            <footer><button className="secondary-button" type="button" onClick={() => setRemoveWorkspace(null)}>取消</button><button className="danger-button" type="button" onClick={() => { void window.piDesktop.send({ type: "workspace.remove", workspace: removeWorkspace.workspace }); setRemoveWorkspace(null); }}>移除</button></footer>
          </div>
        </div>
      )}
      {error && <div className="error-toast"><AlertCircle size={18} /><span>{error}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={clearError}><X size={16} /></button></div>}
      {messageActionError && <div className="error-toast"><AlertCircle size={18} /><span>{messageActionError}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={() => setMessageActionError(undefined)}><X size={16} /></button></div>}
    </div>
  );
}
