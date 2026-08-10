import {
  AlertCircle,
  Bot,
  Check,
  Copy,
  ChevronDown,
  CircleStop,
  CodeXml,
  Download,
  FileDiff,
  Folder,
  FolderOpen,
  KeyRound,
  Layers,
  LoaderCircle,
  MessageSquarePlus,
  MessageCircle,
  PackageOpen,
  PlugZap,
  Puzzle,
  Search,
  Server,
  Share2,
  SquarePen,
  Users,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Pencil,
  Save,
  ShieldAlert,
  Settings,
  ShieldCheck,
  Trash2,
  Wrench,
  X
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  AccessMode,
  AppearanceSettings,
  ChatMessage,
  AgentProfile,
  BuiltinToolName,
  ProviderSettings,
  CustomProviderModel,
  ModelOption,
  McpServerStatus,
  ProviderOption,
  CustomThemeDefinition,
  ThinkingLevel,
  ThemeColorKey,
  ThemeAssetMap,
  ThemeOverrideMode,
  ThemePresetId,
  ToolExecution,
  MessageBlock,
  TurnTiming,
  ResourceCatalog,
  ResourceScope,
  McpServerConfigDraft,
  RuntimeCommand
} from "../../shared/protocol";
import { thinkingLevelLabels, toolLabel } from "../../shared/locale";
import { ArtifactPreview } from "./components/ArtifactPreview";
import { DiffView } from "./components/DiffView";
import { ExtensionResourceList } from "./components/ExtensionResourceList";
import { RichContent } from "./components/RichContent";
import { ExtensionUiDialog, PermissionDialog } from "./components/RuntimeDialogs";
import { compactPath, formatDuration, type Artifact } from "./lib/content";
import { groupAssistantMessages, splitAssistantToolLayout } from "./lib/chat-layout";
import { groupSessionsByWorkspace } from "./lib/session-groups";
import { CSS_URL_PATTERN, createThemeAssetUrls, isExternalThemeReference, normalizeThemeAssetReference, resolveThemeAssets } from "./lib/theme-assets";
import { THEME_PRESETS, scopeCustomThemeCss, scopeCustomThemeCssForPreview, themeOverrideCss, themePresetColor, themePresetCss, themePreviewCss, themeWallpaperOpacity } from "./lib/theme-presets";
import { shareElementAsImage } from "./lib/share-image";
import { useDesktopStore } from "./store";

const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const accessModeOptions: readonly { value: AccessMode; label: string }[] = [
  { value: "read-only", label: "只读" },
  { value: "ask", label: "每次询问" },
  { value: "workspace", label: "工作区访问" },
  { value: "full", label: "完全访问" }
];
const accessModeDescriptions: Record<AccessMode, string> = {
  "read-only": "只允许读取，不执行修改和命令",
  ask: "危险操作执行前逐次询问",
  workspace: "工作区内文件写入自动允许",
  full: "自动允许全部工具操作"
};
const agentTools: BuiltinToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const themeColorFields: readonly { key: ThemeColorKey; label: string }[] = [
  { key: "accent", label: "主题色" },
  { key: "accentHover", label: "辅助色" },
  { key: "userBubble", label: "用户气泡" },
  { key: "aiBubble", label: "AI 气泡" }
];
const HEX_COLOR_PATTERN = /^#[\da-f]{6}$/iu;

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
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("无法读取主题图片"));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取主题图片"));
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
  const imageFiles = files.filter((file) => /\.(?:png|jpe?g|webp|gif)$/iu.test(file.name));
  const assets = await Promise.all(imageFiles.map(async (file) => [themeRelativePath(file).toLowerCase(), await readFileAsDataUrl(file)] as const));
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

function themeColorValue(appearance: AppearanceSettings, mode: ThemeOverrideMode, key: ThemeColorKey): string {
  return appearance.themeOverrides[mode][key] ?? themePresetColor(appearance.themePreset, mode, key);
}

function messageText(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function thinkingText(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.type === "thinking")
    .map((block) => block.text)
    .join("");
}

function blockText(blocks: MessageBlock[]): string {
  return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function useElapsedNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setNow(Date.now());
      return;
    }
    const update = (): void => setNow(Date.now());
    update();
    const timer = window.setInterval(update, 100);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value === "true";
  } catch {
    return fallback;
  }
}

function readStoredPanelTab(): "activity" | "changes" {
  try {
    return window.localStorage.getItem("pidesktop.right-panel-tab") === "changes" ? "changes" : "activity";
  } catch {
    return "activity";
  }
}

function TimingMeta({ timing, now }: { timing: TurnTiming; now: number }): ReactNode {
  const completedAt = timing.completedAt ?? now;
  return (
    <div className="message-timing" aria-label="回答耗时与总耗时">
      <span>回答耗时 {timing.answerStartedAt === undefined ? "等待输出" : formatDuration(timing.answerStartedAt, completedAt)}</span>
      <span>总耗时 {formatDuration(timing.startedAt, completedAt)}</span>
    </div>
  );
}

function PendingResponse({ agentName, timing, now }: { agentName: string; timing?: TurnTiming; now: number }): ReactNode {
  return (
    <article className="message message-assistant pending-response">
      <div className="message-avatar pi-avatar"><LoaderCircle size={17} className="spinning" /></div>
      <div className="message-body message-bubble pending-response-body">
        <div className="response-progress"><LoaderCircle size={14} className="spinning" /><span>{agentName}正在努力输出中……</span></div>
        {timing && <TimingMeta timing={timing} now={now} />}
      </div>
    </article>
  );
}

function ImageMessageBlock({ block }: { block: Extract<MessageBlock, { type: "image" }> }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const src = `data:${block.mimeType};base64,${block.data}`;
  useEffect(() => {
    if (!expanded) return;
    function close(event: KeyboardEvent): void {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);
  return (
    <>
      <button className="image-message" type="button" aria-label="放大图片" onClick={() => setExpanded(true)}><img src={src} alt="用户上传的图片" /></button>
      {expanded && <div className="modal-backdrop image-lightbox" role="presentation" onMouseDown={() => setExpanded(false)}><div className="image-lightbox-content" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={(event) => event.stopPropagation()}><button className="icon-button modal-close" type="button" title="关闭图片" aria-label="关闭图片" onClick={() => setExpanded(false)}><X size={17} /></button><img src={src} alt="用户上传的图片" /></div></div>}
    </>
  );
}

function toolCallStatusIcon(execution: ToolExecution | undefined, streaming?: boolean): ReactNode {
  if (execution?.status === "running" || (!execution && streaming)) return <LoaderCircle size={14} className="spinning" />;
  if (execution?.status === "error") return <AlertCircle size={14} />;
  return <Check size={14} />;
}

function toolCallStatusLabel(execution: ToolExecution | undefined, streaming?: boolean): string {
  if (execution?.status === "error") return "失败";
  if (execution?.status === "completed") return "已运行";
  return streaming ? "运行中" : "已运行";
}

function ToolGroup({ calls, executions, streaming }: { calls: Array<Extract<MessageBlock, { type: "tool-call" }>>; executions: ToolExecution[]; streaming?: boolean }): ReactNode {
  const byId = new Map(executions.map((execution) => [execution.id, execution]));
  const items = calls.map((call) => ({ call, execution: byId.get(call.id) }));
  const active = streaming || items.some((item) => item.execution?.status === "running");
  const names = [...new Set(items.map((item) => toolLabel(item.call.name)))];
  const failedCount = items.filter((item) => item.execution?.status === "error").length;
  const currentTool = [...items].reverse().find((item) => item.execution?.status === "running")?.call;
  let statusLabel = "已完成";
  if (active) statusLabel = currentTool ? `正在${toolLabel(currentTool.name)}` : "正在处理";
  else if (failedCount > 0) statusLabel = `${failedCount} 个失败`;
  return (
    <details className={`tool-call-group${active ? " active" : ""}`}>
      <summary className="tool-call-group-summary">
        <span className="tool-call-group-title"><Wrench size={14} /><strong>连续工具调用 · {calls.length} 次</strong><span className={`tool-call-group-status${failedCount > 0 ? " error" : active ? " running" : ""}`}>{statusLabel}</span></span>
        <span className="tool-call-group-preview">{names.slice(0, 3).map((name) => <span className="tool-call-group-chip" key={name}>{name}</span>)}{names.length > 3 && <span className="tool-call-group-extra">+{names.length - 3}</span>}</span>
        <span className="tool-call-group-toggle" aria-hidden="true" />
      </summary>
      <div className="tool-call-group-body">
        {items.map(({ call, execution }) => {
          let bubbleClass = "tool-call-bubble";
          if (execution?.status === "completed") bubbleClass += " completed";
          if (execution?.status === "error") bubbleClass += " error";
          return (
            <div className="tool-call-group-item" key={call.id}>
              <div className={bubbleClass}>
                {toolCallStatusIcon(execution, streaming)}
                <span className="tool-call-line-state">{toolCallStatusLabel(execution, streaming)}</span><strong>{toolLabel(call.name)}</strong>
                {execution?.completedAt && <span className="tool-call-duration">{formatDuration(execution.startedAt, execution.completedAt)}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

// Memoized so an unchanged message bubble (stable ChatMessage reference from
// the store's uuid-based reuse) is skipped during high-frequency streaming
// updates that only mutate other bubbles.
const MessageView = memo(function MessageView({ message, executions, onOpenArtifact, onHtmlAction, onCopy, onEdit, onRegenerate, onShare, showThinking = true, busy = false, timing, now = Date.now() }: { message: ChatMessage; executions: ToolExecution[]; onOpenArtifact(artifact: Artifact): void; onHtmlAction(text: string): void; onCopy(message: ChatMessage): void; onEdit(message: ChatMessage): void; onRegenerate(message: ChatMessage): void; onShare(message: ChatMessage, target: HTMLElement): Promise<void>; showThinking?: boolean; busy?: boolean; timing?: TurnTiming; now?: number }): ReactNode {
  const text = messageText(message);
  const thinking = thinkingText(message);
  const toolLayout = splitAssistantToolLayout(message);
  const shareTargetRef = useRef<HTMLDivElement | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(false);
  const hasShareableContent = Boolean(text || (toolLayout && (blockText(toolLayout.leading) || blockText(toolLayout.trailing))));

  async function share(): Promise<void> {
    const target = shareTargetRef.current;
    if (!target || sharing) return;
    setSharing(true);
    setShared(false);
    try {
      await onShare(message, target);
      setShared(true);
      window.setTimeout(() => setShared(false), 1500);
    } finally {
      setSharing(false);
    }
  }

  if (message.role === "user") {
    const images = message.blocks.filter((block): block is Extract<MessageBlock, { type: "image" }> => block.type === "image");
    return (
      <article className="message message-user">
        <div className="message-avatar user-avatar">我</div>
        <div className="message-body message-bubble">{message.skill && <div className="message-skill-badge"><Puzzle size={13} /><strong>{message.skill.name}</strong></div>}{images.length > 0 && <div className="image-message-list">{images.map((block, index) => <ImageMessageBlock key={`${message.id}-image-${index}`} block={block} />)}</div>}{text && <p className="user-text">{text}</p>}<div className="message-actions"><button type="button" title="复制" aria-label="复制用户消息" onClick={() => onCopy(message)}><Copy size={13} /></button><button type="button" title="重新编辑" aria-label="重新编辑用户消息" onClick={() => onEdit(message)}><Pencil size={13} /></button></div></div>
      </article>
    );
  }

  return (
    <article className="message message-assistant">
      <div className="message-avatar pi-avatar"><Bot size={17} /></div>
      <div className="message-body message-bubble">
        <div className="assistant-share-content" ref={shareTargetRef}>
          {thinking && showThinking && (
            <details className="thinking-block" open={message.streaming}>
              <summary><LoaderCircle size={14} className={message.streaming ? "spinning" : ""} /> 思考过程</summary>
              <p>{thinking}</p>
            </details>
          )}
          {toolLayout ? (
            <>
              {blockText(toolLayout.leading) && <RichContent streaming={false} artifactPrefix={`${message.id}-leading`} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{blockText(toolLayout.leading)}</RichContent>}
              <ToolGroup calls={toolLayout.process} executions={executions} streaming={message.streaming} />
              {blockText(toolLayout.trailing) && <RichContent streaming={message.streaming} artifactPrefix={`${message.id}-trailing`} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{blockText(toolLayout.trailing)}</RichContent>}
            </>
          ) : text && <RichContent streaming={message.streaming} artifactPrefix={message.id} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{text}</RichContent>}
          {message.error && <p className="inline-error"><AlertCircle size={15} />{message.error}</p>}
          {timing && <TimingMeta timing={timing} now={now} />}
        </div>
        {!message.streaming && !busy && <div className="message-actions"><button type="button" title="重新生成" aria-label="重新生成回复" onClick={() => onRegenerate(message)}><RefreshCw size={13} /></button><button type="button" title="复制" aria-label="复制 AI 回复" onClick={() => onCopy(message)}><Copy size={13} /></button>{hasShareableContent && <button type="button" title={sharing ? "正在生成图片" : shared ? "已复制图片" : "分享图片"} aria-label={sharing ? "正在生成回复图片" : shared ? "回复图片已复制" : "分享 AI 回复图片"} disabled={sharing} onClick={() => void share()}>{sharing ? <LoaderCircle size={13} className="spinning" /> : shared ? <Check size={13} /> : <Share2 size={13} />}</button>}</div>}
      </div>
    </article>
  );
});

function ExecutionItem({ execution, selected, onSelect }: { execution: ToolExecution; selected: boolean; onSelect(): void }): ReactNode {
  const statusIcon = execution.status === "running"
    ? <LoaderCircle size={14} className="spinning" />
    : execution.status === "error"
      ? <AlertCircle size={14} />
      : <Check size={14} />;
  return (
    <button type="button" className={`execution-item${selected ? " selected" : ""}`} onClick={onSelect}>
      <span className={`execution-status ${execution.status}`}>{statusIcon}</span>
      <span className="execution-copy">
        <strong>{toolLabel(execution.name)}</strong>
        <small>{formatDuration(execution.startedAt, execution.completedAt)}</small>
      </span>
      <ChevronDown size={14} className="execution-chevron" />
    </button>
  );
}

function ActivityPanel({ executions }: { executions: ToolExecution[] }): ReactNode {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = executions.find((item) => item.id === selectedId) ?? executions.at(-1);
  return (
    <div className="activity-panel">
      <div className="activity-list">
        {executions.length === 0 ? (
          <div className="panel-empty"><Wrench size={20} /><span>暂无工具活动</span></div>
        ) : executions.map((execution) => (
          <ExecutionItem
            key={execution.id}
            execution={execution}
            selected={selected?.id === execution.id}
            onSelect={() => setSelectedId(execution.id)}
          />
        ))}
      </div>
      {selected && (
        <div className="execution-detail">
          <div className="detail-section">
            <h3>输入</h3>
            <pre>{JSON.stringify(selected.args, null, 2)}</pre>
          </div>
          {selected.patch && <div className="detail-section"><h3>变更</h3><DiffView patch={selected.patch} /></div>}
          {selected.output && <div className="detail-section"><h3>输出</h3><pre>{selected.output}</pre></div>}
        </div>
      )}
    </div>
  );
}

function ChangesPanel({ executions }: { executions: ToolExecution[] }): ReactNode {
  const changes = executions.filter((execution) => execution.patch);
  if (changes.length === 0) return <div className="panel-empty"><FileDiff size={20} /><span>暂无文件变更</span></div>;
  return (
    <div className="changes-panel">
      {changes.map((execution) => (
        <details key={execution.id} open>
          <summary><FileDiff size={15} />{toolLabel(execution.name)}<span>{formatDuration(execution.startedAt, execution.completedAt)}</span></summary>
          <DiffView patch={execution.patch!} />
        </details>
      ))}
    </div>
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
  const previewCss = `${themePreviewCss(appearance.themePreset)}\n${scopeCustomThemeCssForPreview(resolveThemeAssets(appearance.customCss, themeAssetUrls))}\n${themeOverrideCss(appearance.themeOverrides, ".theme-preview-scope[data-theme-custom]")}`;
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
  const [packageSource, setPackageSource] = useState("");
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

  async function installPackage(event: FormEvent): Promise<void> {
    event.preventDefault();
    const source = packageSource.trim();
    if (!source) return;
    if (await run({ type: "resources.package.install", source })) setPackageSource("");
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
      <div className="resource-settings-header"><div><h3><Puzzle size={16} />技能与工具</h3><p>管理 Skill、MCP Server 和第三方扩展。</p></div><button className="secondary-button" type="button" disabled={busy} onClick={() => void run({ type: "resources.reload" })}><RefreshCw size={13} className={busy ? "spinning" : undefined} />重载资源</button></div>
      {!resources.mcpAdapterLoaded && <div className="resource-notice"><PlugZap size={15} /><span>MCP 适配器尚未加载。请先重载资源，或安装 `pi-mcp-adapter` Package。</span></div>}
      {localError && <p className="form-error resource-error">{localError}</p>}
      <section className="resource-section">
        <div className="resource-section-heading"><span><Puzzle size={14} />Skill</span><small>{resources.skills.length} 个已发现</small></div>
        {resources.skills.length === 0 ? <p className="resource-empty">当前没有发现 Skill。安装一个 Pi Package 后重载资源，Package 中的 `SKILL.md` 会出现在这里。</p> : <div className="resource-list">{resources.skills.map((skill) => <div className="resource-item" key={`${skill.source}:${skill.name}`}><div className="resource-item-icon"><Puzzle size={14} /></div><div className="resource-item-copy"><strong>/skill:{skill.name}</strong><small>{skill.description}</small><em>{resourceScopeLabels[skill.scope]} · {skill.source}{skill.disableModelInvocation ? " · 仅手动调用" : ""}</em></div></div>)}</div>}
      </section>
      <section className="resource-section">
        <div className="resource-section-heading"><span><Server size={14} />MCP Server</span><div className="resource-section-actions"><small>{resources.mcpServers.length} 个已发现</small><button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => setMcpFormOpen((open) => !open)}><Plus size={13} />{mcpFormOpen ? "收起" : "添加"}</button></div></div>
        {mcpFormOpen && <form className="mcp-config-form" onSubmit={(event) => void addMcpServer(event)}>
          <div className="mcp-form-grid">
            <label>名称<input value={mcpName} placeholder="例如 context7" onChange={(event) => setMcpName(event.target.value)} /></label>
            <label>写入范围<select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpServerConfigDraft["scope"])}><option value="project">当前项目 .mcp.json</option><option value="global">用户全局 Pi 配置</option></select></label>
            <label>连接方式<select value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value as McpServerConfigDraft["transport"])}><option value="stdio">本地命令（stdio）</option><option value="http">远程地址（HTTP）</option></select></label>
            {mcpTransport === "stdio" ? <>
              <label>启动命令<input value={mcpCommand} placeholder="npx" onChange={(event) => setMcpCommand(event.target.value)} /></label>
              <label className="mcp-form-wide">参数（每行一个）<textarea value={mcpArgs} rows={3} placeholder={"-y\ncontext7-mcp"} onChange={(event) => setMcpArgs(event.target.value)} /></label>
              <label className="mcp-form-wide">环境变量（可选，每行 `KEY=VALUE`）<textarea value={mcpEnv} rows={2} placeholder="API_KEY=$env:CONTEXT7_API_KEY" onChange={(event) => setMcpEnv(event.target.value)} /></label>
            </> : <>
              <label className="mcp-form-wide">服务器地址<input value={mcpUrl} placeholder="https://mcp.example.com/mcp" onChange={(event) => setMcpUrl(event.target.value)} /></label>
              <label>认证<select value={mcpAuth} onChange={(event) => setMcpAuth(event.target.value as NonNullable<McpServerConfigDraft["auth"]>)}><option value="none">无</option><option value="oauth">OAuth</option><option value="bearer-env">Bearer 环境变量</option></select></label>
              {mcpAuth === "bearer-env" && <label>Token 环境变量<input value={mcpBearerTokenEnv} placeholder="MCP_TOKEN" onChange={(event) => setMcpBearerTokenEnv(event.target.value)} /></label>}
            </>}
          </div>
          <p className="resource-form-help">添加后会写入 Pi 标准 MCP 配置并自动重载。stdio 服务通常由 `npx` 在首次使用时启动；敏感值建议使用 `$env:变量名`，不要直接写入配置。</p>
          <footer className="mcp-form-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setMcpFormOpen(false)}><X size={13} />取消</button><button className="primary-button" type="submit" disabled={busy}><Plus size={13} />添加 MCP</button></footer>
        </form>}
        {resources.mcpServers.length === 0 ? <p className="resource-empty">未发现 MCP Server。点击“添加”，或将已有配置放入 `.mcp.json`。</p> : <div className="resource-list">{resources.mcpServers.map((server) => <div className="resource-item mcp-resource-item" key={server.name}><div className={`resource-item-icon mcp-status-icon ${server.status}`}><Server size={14} /></div><div className="resource-item-copy"><strong>{server.name}</strong><small>{mcpStatusLabels[server.status]} · {server.toolCount} 个工具{server.resourceCount === undefined ? "" : ` · ${server.resourceCount} 个资源`}</small>{server.failedAgoSeconds !== undefined && <em>{server.failedAgoSeconds} 秒前失败</em>}</div><label className="resource-toggle"><input type="checkbox" checked={!server.disabled} disabled={busy} onChange={(event) => void run({ type: "mcp.server.toggle", name: server.name, enabled: event.target.checked })} /><span>启用</span></label></div>)}</div>}
      </section>
      <section className="resource-section">
        <div className="resource-section-heading"><span><PackageOpen size={14} />安装 Skill / 扩展包</span><small>支持 npm 和 Git</small></div>
        <p className="resource-form-help resource-package-help">安装后，Skill 会自动出现；扩展工具需要在下方单独启用。</p>
        <form className="resource-package-form" onSubmit={(event) => void installPackage(event)}><input value={packageSource} placeholder="npm:package-name 或 git:..." onChange={(event) => setPackageSource(event.target.value)} /><button className="primary-button" type="submit" disabled={busy || !packageSource.trim()}><PackageOpen size={13} />安装</button></form>
        <div className="resource-list resource-package-list">{resources.packages.map((item) => <div className="resource-item" key={`${item.scope}:${item.source}`}><div className="resource-item-icon"><PackageOpen size={14} /></div><div className="resource-item-copy"><strong>{item.source}</strong><small>{resourceScopeLabels[item.scope]} · {item.installed ? "已安装" : "未安装"}</small></div>{item.removable && <button className="icon-button resource-remove" type="button" title={`删除 ${item.source}`} aria-label={`删除 ${item.source}`} disabled={busy} onClick={() => void run({ type: "resources.package.remove", source: item.source, scope: item.scope === "project" ? "project" : "global" })}><Trash2 size={14} /></button>}</div>)}</div>
      </section>
      <ExtensionResourceList extensions={resources.extensions} scopeLabels={resourceScopeLabels} onApprove={(id) => void run({ type: "resources.extension.approve", id })} />
      {resources.diagnostics.length > 0 && <div className="resource-diagnostics"><strong>资源诊断</strong>{resources.diagnostics.map((diagnostic) => <p key={diagnostic}>{diagnostic}</p>)}</div>}
    </div>
  );
}

function SettingsDialog({ settings, models, providers, customProvider, customProviderKeyConfigured, customModels, customModelFetchStatus, customModelFetchError, resources, onClose }: { settings: import("../../shared/protocol").DesktopSettings; models: ModelOption[]; providers: ProviderOption[]; customProvider?: ProviderSettings; customProviderKeyConfigured: boolean; customModels: CustomProviderModel[]; customModelFetchStatus: "idle" | "loading" | "success" | "error"; customModelFetchError?: string; resources: ResourceCatalog; onClose(): void }): ReactNode {
  const customProviderId = "chatanytime-openai-compatible";
  const configuredProviders = settings.providers;
  const firstCustomProvider = configuredProviders[0];
  const [provider, setProvider] = useState(firstCustomProvider?.id ?? customProviderId);
  const selectedProvider = configuredProviders.find((item) => item.id === provider);
  const isCustomProvider = provider === customProviderId || provider.startsWith("provider-") || Boolean(selectedProvider);
  const [customName, setCustomName] = useState(selectedProvider?.name ?? customProvider?.name ?? "我的中转站");
  const [customBaseUrl, setCustomBaseUrl] = useState(selectedProvider?.baseUrl ?? customProvider?.baseUrl ?? "");
  const [customModelId, setCustomModelId] = useState(selectedProvider?.models[0]?.id ?? customProvider?.models[0]?.id ?? customModels[0]?.id ?? "");
  const [imageInputOverride, setImageInputOverride] = useState<boolean | undefined>();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string>();
  const [tab, setTab] = useState<"general" | "models" | "agents" | "appearance" | "resources">("general");
  const [themeColorMode, setThemeColorMode] = useState<ThemeOverrideMode>(() => {
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
  const configuredModels = models.filter((model) => model.configured);
  const hasSavedCustomKey = Boolean(selectedProvider?.keyConfigured) || (provider === customProviderId && customProviderKeyConfigured);
  const providerModels = isCustomProvider ? (selectedProvider?.models ?? customModels) : [];
  const enabledProviderModels = providerModels.filter((model) => model.enabled !== false);
  const selectedCustomModel = providerModels.find((model) => model.id === customModelId);
  const wallpaperOpacityOverride = settings.appearance.themeOverrides[themeColorMode].wallpaperOpacity;
  const wallpaperOpacity = wallpaperOpacityOverride ?? themeWallpaperOpacity(settings.appearance.customCss, themeColorMode) ?? 0;
  const wallpaperOpacityPercent = Math.round(wallpaperOpacity * 100);
  function closeSettings(): void { useDesktopStore.setState({ settings: structuredClone(initialSettingsRef.current) }); onClose(); }
  function markSettingsSaved(nextSettings: import("../../shared/protocol").DesktopSettings): void {
    const saved = structuredClone(nextSettings);
    initialSettingsRef.current = saved;
    useDesktopStore.setState({ settings: saved });
  }

  function updateProviderModel(modelId: string, patch: Partial<import("../../shared/protocol").ProviderModelSettings>): void {
    const updated = providerModels.map((model) => model.id === modelId ? { ...model, ...patch } : model);
    const hasConfiguredProvider = settings.providers.some((item) => item.id === provider);
    useDesktopStore.setState((state) => ({
      customModels: (!selectedProvider || provider === customProviderId) ? updated : state.customModels,
      settings: hasConfiguredProvider
        ? { ...state.settings, providers: state.settings.providers.map((item) => item.id === provider ? { ...item, models: updated } : item) }
        : state.settings
    }));
  }

  function updateAppearance(patch: Partial<AppearanceSettings>): void {
    useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, ...patch } } });
  }

  function updateThemeColor(key: ThemeColorKey, value: string): void {
    const themeOverrides = structuredClone(settings.appearance.themeOverrides);
    themeOverrides[themeColorMode][key] = value.toLowerCase();
    updateAppearance({ themeOverrides });
  }

  function resetThemeColor(key: ThemeColorKey): void {
    const themeOverrides = structuredClone(settings.appearance.themeOverrides);
    delete themeOverrides[themeColorMode][key];
    updateAppearance({ themeOverrides });
  }

  function updateWallpaperOpacity(value: number): void {
    const themeOverrides = structuredClone(settings.appearance.themeOverrides);
    themeOverrides[themeColorMode].wallpaperOpacity = Math.min(1, Math.max(0, value));
    updateAppearance({ themeOverrides });
  }

  function resetWallpaperOpacity(): void {
    const themeOverrides = structuredClone(settings.appearance.themeOverrides);
    delete themeOverrides[themeColorMode].wallpaperOpacity;
    updateAppearance({ themeOverrides });
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

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!provider || (!apiKey.trim() && !hasSavedCustomKey)) return;
    if (!apiKey.trim() && !hasSavedCustomKey) return;
    if (isCustomProvider && (!customName.trim() || !customBaseUrl.trim() || !customModelId.trim() || (providerModels.length > 0 && enabledProviderModels.length === 0))) return;
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
        await window.piDesktop.send({ type: "auth.set", provider, apiKey: apiKey.trim() });
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
    setProvider(id); setCustomName("新的模型服务"); setCustomBaseUrl(""); setCustomModelId(""); setApiKey("");
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
  }

  function newAgent(): void {
    const id = `agent-${Date.now()}`;
    const agent: AgentProfile = { id, name: "新 Agent", description: "", systemPrompt: "", divMode: false, defaultThinkingLevel: "medium", tools: Object.fromEntries(agentTools.map((tool) => [tool, true])) as Record<BuiltinToolName, boolean> };
    setAgentList((current) => [...current, agent]);
    setSelectedAgentId(id);
  }

  function updateAgent(patch: Partial<AgentProfile>): void {
    if (!selectedAgent) return;
    setAgentList((current) => current.map((agent) => agent.id === selectedAgent.id ? { ...agent, ...patch } : agent));
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
    const copy: AgentProfile = { ...selectedAgent, id: `agent-${Date.now()}`, name: `${selectedAgent.name} 副本`, tools: { ...selectedAgent.tools } };
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
      <section className="settings-dialog settings-center" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><Settings size={19} /><div><h2>ChatAnyTime 设置</h2><p>模型服务和 Agent 角色配置保存在本机。</p></div></div><button className="icon-button" type="button" title="关闭设置" aria-label="关闭设置" onClick={closeSettings}><X size={18} /></button></header>
        <div className="settings-body"><nav className="settings-tabs"><button type="button" className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>通用</button><button type="button" className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>模型服务</button><button type="button" className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>Agent 角色</button><button type="button" className={tab === "resources" ? "active" : ""} onClick={() => setTab("resources")}>技能与工具</button><button type="button" className={tab === "appearance" ? "active" : ""} onClick={() => setTab("appearance")}>外观</button></nav><div className="settings-content">{tab === "general" ? <form onSubmit={(event) => { event.preventDefault(); const nextSettings = structuredClone(settings); void window.piDesktop.send({ type: "settings.save", settings: { model: nextSettings.model, thinkingLevel: nextSettings.thinkingLevel, accessMode: nextSettings.accessMode, appearance: nextSettings.appearance } }); markSettingsSaved(nextSettings); onClose(); }}>
          <label>全局默认模型<select value={settings.model ? `${settings.model.provider}/${settings.model.id}` : ""} onChange={(event) => { const value = event.target.value; const slash = value.indexOf("/"); useDesktopStore.setState({ settings: { ...settings, model: slash > 0 ? { provider: value.slice(0, slash), id: value.slice(slash + 1) } : undefined } }); }}>{<option value="">请选择默认模型</option>}{models.filter((model) => model.configured).map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}</select></label>
          <label>默认思考等级<select value={settings.thinkingLevel} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, thinkingLevel: event.target.value as ThinkingLevel } })}>{thinkingLevels.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}</select></label>
          <label>访问模式<select value={settings.accessMode} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, accessMode: event.target.value as AccessMode } })}>{accessModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {settings.accessMode === "full" && <p className="access-mode-warning">完全访问会允许 Pi 直接执行命令并访问工作区外路径，请只在可信项目中使用。</p>}
          {settings.accessMode === "workspace" && <p className="access-mode-hint">工作区内的文件写入会自动允许；bash 命令和工作区外路径仍会询问。</p>}
          <label className="checkbox-setting"><input type="checkbox" checked={settings.appearance.showThinking} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, showThinking: event.target.checked } } })} />展示思考过程</label>
          <footer><button type="button" className="secondary-button" onClick={closeSettings}>取消</button><button className="primary-button" type="submit">保存通用设置</button></footer>
        </form> : tab === "models" ? <form onSubmit={save}>
        <div className="settings-provider-heading"><label>服务商<select value={provider} onChange={(event) => { const next = event.target.value; setProvider(next); const config = configuredProviders.find((item) => item.id === next); if (config) { setCustomName(config.name); setCustomBaseUrl(config.baseUrl); setCustomModelId(config.models[0]?.id ?? ""); } }}><optgroup label="内置服务">{providers.filter((item) => !item.custom && !configuredProviders.some((config) => config.id === item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}{item.configured ? " - 已配置" : ""}</option>)}</optgroup><optgroup label="OpenAI 兼容服务"><option value={customProviderId}>{customProvider?.name ?? "新的模型服务"}{customProviderKeyConfigured ? " - 已配置" : ""}</option>{configuredProviders.filter((item) => item.id !== customProviderId).map((item) => <option key={item.id} value={item.id}>{item.name}{item.keyConfigured ? " - 已配置" : ""}</option>)}</optgroup></select></label><button className="secondary-button" type="button" onClick={newProvider}>+ 新增服务</button>{selectedProvider && <button className="danger-button" type="button" onClick={() => void deleteProvider()}>删除服务</button>}</div>
        {isCustomProvider && <>
          <label>服务名称<input value={customName} placeholder="例如：公司中转站" onChange={(event) => setCustomName(event.target.value)} /></label>
          <div className="settings-action-row"><label>OpenAI 兼容接口地址<input value={customBaseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setCustomBaseUrl(event.target.value)} /></label><button className="secondary-button" type="button" disabled={customModelFetchStatus === "loading" || !customBaseUrl.trim() || (!apiKey.trim() && !customProviderKeyConfigured)} onClick={() => void fetchModels()}><RefreshCw size={14} className={customModelFetchStatus === "loading" ? "spinning" : undefined} />{customModelFetchStatus === "loading" ? "拉取中" : "拉取模型"}</button></div>
          <div className="model-selection"><div className="model-selection-heading"><span>可用模型</span><small>左侧控制显示，右侧标记图片输入</small></div>{providerModels.length === 0 ? <p className="panel-empty">请先拉取模型，或手动填写模型 ID</p> : providerModels.map((model) => <div className="model-option" key={model.id}><label className="checkbox-setting model-enabled-option"><input type="checkbox" checked={model.enabled !== false} onChange={(event) => { const next = event.target.checked; updateProviderModel(model.id, { enabled: next }); if (model.id === customModelId && !next) setCustomModelId(providerModels.find((item) => item.id !== model.id && item.enabled !== false)?.id ?? model.id); }} /><span><strong>{model.name}</strong><small>{model.id}</small></span></label><label className="checkbox-setting model-image-option" title="允许向此模型发送图片"><input type="checkbox" checked={model.imageInput === true} onChange={(event) => updateProviderModel(model.id, { imageInput: event.target.checked })} />图片输入</label></div>)}</div>
          {providerModels.length === 0 && customModelId && <label className="checkbox-setting"><input type="checkbox" checked={imageInputOverride ?? false} onChange={(event) => setImageInputOverride(event.target.checked)} />支持图片输入（手动覆盖推断）</label>}
          {providerModels.length > 0 && enabledProviderModels.length === 0 && <p className="form-error">请至少勾选一个模型</p>}
          {customModelFetchError && <p className="form-error">{customModelFetchError}</p>}
        </>}
        <label>API 密钥<input type="password" value={apiKey} autoFocus placeholder={isCustomProvider && hasSavedCustomKey ? "已保存，留空则继续使用" : "请输入 API 密钥"} onChange={(event) => setApiKey(event.target.value)} /></label>
        {formError && <p className="form-error">{formError}</p>}
        <footer><button type="button" className="secondary-button" onClick={closeSettings}>取消</button><button className="primary-button" disabled={saving || (!apiKey.trim() && !hasSavedCustomKey) || (isCustomProvider && (!customName.trim() || !customBaseUrl.trim() || !customModelId.trim() || (providerModels.length > 0 && enabledProviderModels.length === 0)))} type="submit">{saving ? "正在应用" : "保存设置"}</button></footer>
        </form> : tab === "agents" ? <div className="agent-settings">
          <div className="agent-list">{agentList.filter((agent) => !agent.archived).map((agent) => <button type="button" key={agent.id} className={agent.id === selectedAgent?.id ? "active" : ""} onClick={() => setSelectedAgentId(agent.id)}><strong>{agent.name}</strong><small>{agent.description || "未填写说明"}</small></button>)}<button type="button" className="secondary-button agent-new-button" onClick={newAgent}>+ 新建 Agent</button></div>
          {selectedAgent && <div className="agent-editor"><label>名称<input value={selectedAgent.name} onChange={(event) => updateAgent({ name: event.target.value })} /></label><label>说明<input value={selectedAgent.description} onChange={(event) => updateAgent({ description: event.target.value })} /></label><label>系统提示词<textarea value={selectedAgent.systemPrompt} rows={6} onChange={(event) => updateAgent({ systemPrompt: event.target.value })} /></label><label className="checkbox-setting"><input type="checkbox" checked={selectedAgent.divMode} onChange={(event) => updateAgent({ divMode: event.target.checked })} />启用 Div 气泡模式</label><label>默认模型<select value={selectedAgent.defaultModel ? `${selectedAgent.defaultModel.provider}/${selectedAgent.defaultModel.id}` : ""} onChange={(event) => { const value = event.target.value; updateAgent({ defaultModel: value ? { provider: value.slice(0, value.indexOf("/")), id: value.slice(value.indexOf("/") + 1) } : undefined }); }}><option value="">跟随全局默认模型</option>{configuredModels.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}</select></label><label>默认思考等级<select value={selectedAgent.defaultThinkingLevel} onChange={(event) => updateAgent({ defaultThinkingLevel: event.target.value as ThinkingLevel })}>{thinkingLevels.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}</select></label><fieldset><legend>工具权限</legend>{agentTools.map((tool) => <label className="tool-toggle" key={tool}><input type="checkbox" checked={selectedAgent.tools[tool]} onChange={(event) => updateAgent({ tools: { ...selectedAgent.tools, [tool]: event.target.checked } })} />{tool}</label>)}</fieldset><footer><button type="button" className="danger-button" disabled={selectedAgent.id === "default"} onClick={() => void archiveAgent()}>归档</button><button type="button" className="secondary-button" onClick={duplicateAgent}>复制</button><button type="button" className="primary-button" onClick={() => void saveAgent()}>保存 Agent</button></footer></div>}
        </div> : tab === "resources" ? <ResourceSettings resources={resources} /> : <form className="appearance-settings" onSubmit={(event) => { event.preventDefault(); const nextSettings = structuredClone(settings); void window.piDesktop.send({ type: "appearance.save", appearance: nextSettings.appearance }); markSettingsSaved(nextSettings); onClose(); }}>
          <div className="appearance-grid">
            <div>
              <label>主题模式<select value={settings.appearance.theme} onChange={(event) => { const next = event.target.value as "system" | "light" | "dark"; useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, theme: next } } }); setThemeColorMode(next === "light" ? "light" : next === "dark" ? "dark" : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")); }}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
              <label className="checkbox-setting"><input type="checkbox" checked={settings.appearance.showThinking} onChange={(event) => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, showThinking: event.target.checked } } })} />展示思考过程</label>
              <div className="theme-preset-field"><span className="settings-field-label">主题预设</span><div className="theme-preset-grid">{THEME_PRESETS.map((preset) => <button type="button" key={preset.id} className={`theme-preset-card${settings.appearance.themePreset === preset.id ? " active" : ""}`} onClick={() => useDesktopStore.setState({ settings: { ...settings, appearance: { ...settings.appearance, themePreset: preset.id as ThemePresetId, themeOverrides: { light: {}, dark: {} } } } })}><span className="theme-swatches">{preset.swatches.map((color) => <i key={color} style={{ backgroundColor: color }} />)}</span><strong>{preset.name}</strong><small>{preset.description}</small></button>)}</div></div>
              <section className="theme-color-settings" aria-label="自定义配色">
                <div className="theme-color-heading"><span className="settings-field-label">自定义配色</span><div className="theme-color-mode-switch" role="tablist" aria-label="配色模式"><button type="button" className={themeColorMode === "light" ? "active" : ""} role="tab" aria-selected={themeColorMode === "light"} onClick={() => setThemeColorMode("light")}>浅色</button><button type="button" className={themeColorMode === "dark" ? "active" : ""} role="tab" aria-selected={themeColorMode === "dark"} onClick={() => setThemeColorMode("dark")}>深色</button></div></div>
                <p className="theme-color-hint">为当前模式覆盖预设颜色；切换预设会重置这些覆盖。</p>
                 <div className="theme-color-grid">{themeColorFields.map((field) => { const value = themeColorValue(settings.appearance, themeColorMode, field.key); return <div className="theme-color-row" key={field.key}><label htmlFor={`theme-color-${field.key}`}>{field.label}</label><input id={`theme-color-${field.key}`} type="color" value={value} onChange={(event) => updateThemeColor(field.key, event.target.value)} /><input className="theme-color-hex" type="text" inputMode="text" maxLength={7} spellCheck={false} aria-label={`${field.label}十六进制值`} value={value} onChange={(event) => { const next = event.target.value.trim(); if (HEX_COLOR_PATTERN.test(next)) updateThemeColor(field.key, next); }} /><button className="icon-button theme-color-reset" type="button" title={`重置${field.label}`} aria-label={`重置${field.label}`} onClick={() => resetThemeColor(field.key)}><RotateCcw size={14} /></button></div>; })}</div>
                 <div className="theme-opacity-row"><label htmlFor="theme-wallpaper-opacity">背景图片透明度</label><input id="theme-wallpaper-opacity" type="range" min="0" max="100" step="1" value={wallpaperOpacityPercent} aria-valuetext={`${wallpaperOpacityPercent}%`} onChange={(event) => updateWallpaperOpacity(Number(event.target.value) / 100)} /><output>{wallpaperOpacityPercent}%</output><button className="icon-button theme-color-reset" type="button" disabled={wallpaperOpacityOverride === undefined} title="恢复主题默认透明度" aria-label="恢复主题默认透明度" onClick={resetWallpaperOpacity}><RotateCcw size={14} /></button></div>
               </section>
            </div>
            <ThemePreview appearance={settings.appearance} />
          </div>
              <div className="custom-css-heading"><span>自定义 CSS</span><div><input ref={cssFileInputRef} hidden type="file" accept=".css,text/css" onChange={(event) => void importCustomCss(event)} /><input ref={(element) => { themeDirectoryInputRef.current = element; element?.setAttribute("webkitdirectory", ""); }} hidden type="file" multiple accept=".css,image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void importThemeDirectory(event)} /><button className="secondary-button" type="button" onClick={() => cssFileInputRef.current?.click()}>导入 CSS</button><button className="secondary-button" type="button" onClick={() => themeDirectoryInputRef.current?.click()}>导入主题目录</button><button className="secondary-button" type="button" onClick={() => { setEditingCustomThemeId(undefined); setCustomThemeName(""); setThemeImportError(undefined); updateAppearance({ customCss: "", customCssAssets: {} }); }}>清空</button></div></div>
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
  const { ready, snapshot, models, providers, resources, customProvider, customProviderKeyConfigured, customModels, customModelFetchStatus, customModelFetchError, permissions, extensionUiDialogs, extensionNotice, error, initialize, clearError, clearExtensionNotice } = useDesktopStore();
  const permission = permissions[0];
  const extensionUiDialog = extensionUiDialogs[0];
  const settings = useDesktopStore((state) => state.settings);
  const themeAssetUrls = useThemeAssetUrls(themeAssetsForAppearance(settings.appearance));
  const [input, setInput] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<string>();
  const [editingMessageTimestamp, setEditingMessageTimestamp] = useState<number>();
  const [localTurnStartedAt, setLocalTurnStartedAt] = useState<number>();
  const [messageActionError, setMessageActionError] = useState<string>();
  // Tool details are already available inline in the conversation. Keep the
  // live activity panel opt-in so the first screen stays focused on the chat.
  const [rightPanel, setRightPanel] = useState(() => readStoredBoolean("pidesktop.right-panel-open", false));
  const [sidebarTab, setSidebarTab] = useState<"agents" | "topics">("topics");
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [panelTab, setPanelTab] = useState<"activity" | "changes">(readStoredPanelTab);
  const [collapsedWorkspaceGroups, setCollapsedWorkspaceGroups] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accessModeMenuOpen, setAccessModeMenuOpen] = useState(false);
  const [composerMenu, setComposerMenu] = useState<"model" | "thinking">();
  const [artifact, setArtifact] = useState<Artifact>();
  const [attachments, setAttachments] = useState<import("../../shared/protocol").PromptAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const accessModeMenuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [slashIndex, setSlashIndex] = useState(0);
  const selectedModel = snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "";
  const availableModels = useMemo(() => models.filter((model) => model.configured), [models]);
  const selectedModelOption = availableModels.find((model) => `${model.provider}/${model.id}` === selectedModel);
  const visibleAgents = useMemo(() => settings.agents.filter((agent) => !agent.archived && `${agent.name} ${agent.description}`.toLowerCase().includes(sidebarQuery.trim().toLowerCase())), [settings.agents, sidebarQuery]);
  const sessionGroups = useMemo(() => groupSessionsByWorkspace(snapshot.sessions, sidebarQuery), [snapshot.sessions, sidebarQuery]);
  const displayMessages = useMemo(() => groupAssistantMessages(snapshot.messages), [snapshot.messages]);
  const latestAssistantIndex = useMemo(() => [...displayMessages].reverse().findIndex((message) => message.role === "assistant"), [displayMessages]);
  const latestAssistantMessageIndex = latestAssistantIndex < 0 ? -1 : displayMessages.length - 1 - latestAssistantIndex;
  const localTiming = localTurnStartedAt === undefined ? undefined : { startedAt: localTurnStartedAt } satisfies TurnTiming;
  const localTurnPending = localTiming !== undefined && (snapshot.turnTiming === undefined || snapshot.turnTiming.startedAt < localTiming.startedAt);
  const activeTurnTiming = localTurnPending ? localTiming : snapshot.turnTiming;
  const isGenerating = localTurnPending || Boolean(snapshot.busy && snapshot.turnTiming && snapshot.turnTiming.completedAt === undefined);
  const now = useElapsedNow(isGenerating);
  const hasAssistantMessage = displayMessages.some((message) => message.role === "assistant");
  const showTurnTimingOnLatest = Boolean(snapshot.turnTiming && (!snapshot.busy || displayMessages[latestAssistantMessageIndex]?.streaming));
  const canSubmit = Boolean(snapshot.workspace && snapshot.model && (input.trim() || attachments.length > 0 || selectedSkill));
  let composerPlaceholder = "请先打开一个项目";
  if (snapshot.workspace) composerPlaceholder = selectedSkill ? "输入任务要求" : "让 Pi 检查、修改或运行这个项目";

  // 斜杠指令清单：固定会话命令 + 已发现的 Skill
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const fixed: SlashCommand[] = [
      { trigger: "/compact", label: "/compact", description: "压缩当前会话上下文", kind: "command", command: { type: "session.compact" } },
      { trigger: "/new", label: "/new", description: "开启新话题", kind: "command", command: { type: "session.new" } }
    ];
    const skills: SlashCommand[] = resources.skills.map((skill) => ({
      trigger: `/skill:${skill.name}`,
      label: `/skill:${skill.name}`,
      description: skill.description || "调用 Skill",
      kind: "skill",
      skillName: skill.name
    }));
    return [...fixed, ...skills];
  }, [resources.skills]);

  // 仅当输入以 / 开头且光标仍处于首个 token（无空格）时才过滤指令
  const slashToken = useMemo(() => {
    if (selectedSkill) return null;
    const trimmed = input.trimStart();
    if (!trimmed.startsWith("/")) return null;
    const tail = trimmed.slice(1);
    if (tail.includes(" ")) return null; // 首个 token 已结束，补全关闭
    return trimmed.toLowerCase();
  }, [input, selectedSkill]);

  const slashMatches = useMemo(() => {
    if (!slashToken) return [];
    return slashCommands.filter((cmd) => cmd.trigger.toLowerCase().startsWith(slashToken) && cmd.trigger.toLowerCase() !== slashToken);
  }, [slashToken, slashCommands]);

  const slashOpen = slashMatches.length > 0;
  const activeSlashIndex = Math.min(slashIndex, slashMatches.length - 1);

  useEffect(() => {
    if (slashIndex > slashMatches.length - 1) setSlashIndex(Math.max(0, slashMatches.length - 1));
  }, [slashMatches.length, slashIndex]);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    void initialize().then((unsubscribe) => {
      dispose = unsubscribe;
    });
    return () => dispose?.();
  }, [initialize]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const updateScrollIntent = (): void => {
      const gap = timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop;
      stickToBottomRef.current = gap <= 64;
    };
    updateScrollIntent();
    timeline.addEventListener("scroll", updateScrollIntent, { passive: true });
    return () => timeline.removeEventListener("scroll", updateScrollIntent);
  }, []);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !stickToBottomRef.current) return;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: snapshot.busy ? "smooth" : "auto" });
  }, [snapshot.messages, snapshot.busy]);

  useEffect(() => {
    if (!snapshot.busy) setLocalTurnStartedAt(undefined);
  }, [snapshot.busy]);

  useEffect(() => {
    try { window.localStorage.setItem("pidesktop.right-panel-open", String(rightPanel)); } catch { /* storage may be unavailable in browser demo */ }
  }, [rightPanel]);

  useEffect(() => {
    try { window.localStorage.setItem("pidesktop.right-panel-tab", panelTab); } catch { /* storage may be unavailable in browser demo */ }
  }, [panelTab]);

  useEffect(() => {
    setEditingMessageTimestamp(undefined);
    setSelectedSkill(undefined);
  }, [snapshot.sessionId]);

  useEffect(() => {
    if (!accessModeMenuOpen && !composerMenu) return;
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!accessModeMenuRef.current?.contains(event.target as Node)) setAccessModeMenuOpen(false);
      if (!composerRef.current?.contains(event.target as Node)) setComposerMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setAccessModeMenuOpen(false);
        setComposerMenu(undefined);
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [accessModeMenuOpen, composerMenu]);

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
    style.textContent = `${themePresetCss(settings.appearance.themePreset)}\n${scopeCustomThemeCss(customCss)}\n${themeOverrideCss(settings.appearance.themeOverrides, ":root[data-theme-custom]")}`;
    return () => {
      style?.remove();
      delete root.dataset.themePreset;
      delete root.dataset.themeCustom;
      delete root.dataset.themeWallpaper;
    };
  }, [settings.appearance.themePreset, settings.appearance.themeOverrides, settings.appearance.customCss, settings.appearance.customCssAssets, settings.appearance.customThemes, themeAssetUrls]);

  async function openWorkspace(): Promise<void> {
    const path = await window.piDesktop.chooseWorkspace();
    if (path) await window.piDesktop.send({ type: "workspace.open", path });
  }

  async function createNewSession(workspace?: string): Promise<void> {
    try {
      await window.piDesktop.send({ type: "session.new", workspace });
      setInput("");
      setAttachments([]);
      setSelectedSkill(undefined);
      setEditingMessageTimestamp(undefined);
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "新建话题失败");
    }
  }

  async function openSession(path: string, sessionWorkspace: string): Promise<void> {
    try {
      await window.piDesktop.send({ type: "session.open", path, workspace: sessionWorkspace });
    } catch (error) {
      setMessageActionError(error instanceof Error ? error.message : "打开话题失败");
    }
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = input.trim();
    const isNewSessionCommand = !selectedSkill && text === "/new";
    if ((!text && attachments.length === 0 && !selectedSkill) || (snapshot.busy && !isNewSessionCommand)) return;
    // 客户端执行的固定指令：不透传给 Pi（会话层会当噪声），直接发协议命令
    if (!selectedSkill && text === "/new") {
      try {
        await createNewSession();
      } catch (error) {
        setMessageActionError(error instanceof Error ? error.message : "新建话题失败");
      }
      return;
    }
    if (!selectedSkill && (text === "/compact" || text.startsWith("/compact "))) {
      const instructions = text.startsWith("/compact ") ? text.slice("/compact ".length).trim() || undefined : undefined;
      try {
        await window.piDesktop.send({ type: "session.compact", instructions });
        setInput("");
        setAttachments([]);
        setEditingMessageTimestamp(undefined);
      } catch (error) {
        setMessageActionError(error instanceof Error ? error.message : "压缩上下文失败");
      }
      return;
    }
    const skillMatch = selectedSkill ? undefined : text.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/u);
    const skillName = selectedSkill ?? skillMatch?.[1];
    const skillInstructions = selectedSkill ? text || undefined : skillMatch?.[2]?.trim() || undefined;
    if (attachments.some((item) => item.kind === "image") && !models.find((item) => `${item.provider}/${item.id}` === selectedModel)?.imageInput) { setAttachmentError("当前模型不支持图片输入，请先切换多模态模型"); return; }
    setLocalTurnStartedAt(Date.now());
    try {
      if (editingMessageTimestamp !== undefined) {
        await window.piDesktop.send({ type: "session.regenerate", text, timestamp: editingMessageTimestamp, skillName, attachments });
      } else if (skillName) {
        await window.piDesktop.send({ type: "session.skill", name: skillName, instructions: skillInstructions, attachments });
      } else {
        await window.piDesktop.send({ type: "session.prompt", text, attachments });
      }
      setInput("");
      setSelectedSkill(undefined);
      setAttachments([]);
      setEditingMessageTimestamp(undefined);
    } catch (error) {
      setLocalTurnStartedAt(undefined);
      setAttachmentError(error instanceof Error ? error.message : "附件发送失败");
    }
  }

  async function copyMessage(message: ChatMessage): Promise<void> {
    const text = messageText(message);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setMessageActionError("复制失败，请检查剪贴板权限");
    }
  }

  async function shareMessage(_message: ChatMessage, target: HTMLElement): Promise<void> {
    setMessageActionError(undefined);
    try {
      await shareElementAsImage(target);
    } catch (error) {
      setMessageActionError(error instanceof Error ? `分享失败：${error.message}` : "分享失败，请重试");
      throw error;
    }
  }

  function editMessage(message: ChatMessage): void {
    setInput(messageText(message));
    setSelectedSkill(message.skill?.name);
    setAttachments([]);
    setEditingMessageTimestamp(message.timestamp);
    setMessageActionError(undefined);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function handleHtmlAction(text: string): void {
    setInput((current) => current.trim() ? `${current.trim()}\n${text}` : text);
    setSelectedSkill(undefined);
    setEditingMessageTimestamp(undefined);
    setMessageActionError(undefined);
  }

  async function regenerateMessage(message: ChatMessage): Promise<void> {
    if (snapshot.busy) return;
    const index = snapshot.messages.findIndex((item) => item.id === message.id);
    const previousUser = index > 0 ? [...snapshot.messages.slice(0, index)].reverse().find((item) => item.role === "user") : undefined;
    const text = previousUser ? messageText(previousUser) : "";
    if (!text && !previousUser?.skill) return;
    setLocalTurnStartedAt(Date.now());
    try {
      await window.piDesktop.send({ type: "session.regenerate", text, timestamp: previousUser?.timestamp, skillName: previousUser?.skill?.name });
    } catch (error) {
      setLocalTurnStartedAt(undefined);
      setMessageActionError(error instanceof Error ? error.message : "重新生成失败");
    }
  }

  async function addAttachments(): Promise<void> {
    let selected: import("../../shared/protocol").PromptAttachment[];
    try {
      selected = await window.piDesktop.chooseAttachments(snapshot.workspace);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : "读取附件失败");
      return;
    }
    const remaining = Math.max(0, 5 - attachments.length);
    const seen = new Set(attachments.map((item) => item.kind === "file" ? item.relativePath : `${item.name}:${item.size}`));
    const next = selected.filter((item) => {
      const key = item.kind === "file" ? item.relativePath : `${item.name}:${item.size}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, remaining);
    if (next.length < selected.length) setAttachmentError("已跳过重复附件或超出 5 个附件上限");
    setAttachments((current) => [...current, ...next]);
  }

  async function addLocalFiles(files: FileList | File[]): Promise<void> {
    const remaining = Math.max(0, 5 - attachments.length);
    const accepted: import("../../shared/protocol").PromptAttachment[] = [];
    for (const file of Array.from(files).slice(0, remaining)) {
      if (file.size > 20 * 1024 * 1024) { setAttachmentError(`${file.name} 超过 20 MB 限制`); continue; }
      const isImage = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type);
      if (isImage) {
        const data = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? ""); reader.readAsDataURL(file); });
        accepted.push({ kind: "image", name: file.name, mimeType: file.type, size: file.size, data });
      } else if ((file as File & { path?: string }).path) {
        const path = (file as File & { path: string }).path;
        if (snapshot.workspace) {
          const root = snapshot.workspace.replace(/[\\/]+$/u, "").replaceAll("\\", "/");
          const candidate = path.replaceAll("\\", "/");
          if (!(candidate.toLowerCase().startsWith(`${root.toLowerCase()}/`) && candidate !== root)) { setAttachmentError(`${file.name} 不在当前工作区内`); continue; }
          const relativePath = candidate.slice(root.length + 1);
          if (!relativePath) { setAttachmentError(`${file.name} 不在当前工作区内`); continue; }
          accepted.push({ kind: "file", name: file.name, path: relativePath, relativePath, size: file.size });
          continue;
        }
        setAttachmentError(`${file.name} 不是可读取的工作区文件`);
      } else setAttachmentError(`${file.name} 不是可读取的工作区文件`);
    }
    const keys = new Set(attachments.map((item) => item.kind === "file" ? item.relativePath : `${item.name}:${item.size}`));
    const unique = accepted.filter((item) => { const key = item.kind === "file" ? item.relativePath : `${item.name}:${item.size}`; if (keys.has(key)) return false; keys.add(key); return true; });
    if (unique.length < accepted.length) setAttachmentError("已跳过重复附件");
    setAttachments((current) => [...current, ...unique]);
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files);
    if (files.length) { event.preventDefault(); void addLocalFiles(files); }
  }

  function handleDrop(event: React.DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    void addLocalFiles(event.dataTransfer.files);
  }

  function applySlashCommand(command: SlashCommand): void {
    setEditingMessageTimestamp(undefined);
    if (command.kind === "skill") {
      setSelectedSkill(command.skillName);
      setInput("");
      setSlashIndex(0);
      setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }
    if (snapshot.busy && command.command.type !== "session.new") return;
    setSelectedSkill(undefined);
    setInput("");
    setAttachments([]);
    setSlashIndex(0);
    void window.piDesktop.send(command.command).catch((error) => {
      setMessageActionError(error instanceof Error ? error.message : "指令执行失败");
    });
  }

  function handleComposerKey(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (slashOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((current) => (current + 1) % slashMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((current) => (current - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        const selected = slashMatches[activeSlashIndex];
        if (selected) applySlashCommand(selected);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashIndex(0);
        setInput("");
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  async function selectModel(value: string): Promise<void> {
    setComposerMenu(undefined);
    const slash = value.indexOf("/");
    if (slash < 1) return;
    await window.piDesktop.send({ type: "model.select", provider: value.slice(0, slash), id: value.slice(slash + 1) });
  }

  async function selectAccessMode(value: AccessMode): Promise<void> {
    setAccessModeMenuOpen(false);
    setComposerMenu(undefined);
    if (value === settings.accessMode) return;
    const previousSettings = settings;
    const nextSettings = { ...settings, accessMode: value };
    useDesktopStore.setState({ settings: nextSettings });
    try {
      await window.piDesktop.send({ type: "settings.save", settings: { model: nextSettings.model, thinkingLevel: nextSettings.thinkingLevel, accessMode: value, appearance: nextSettings.appearance } });
    } catch (error) {
      useDesktopStore.setState({ settings: previousSettings });
      setMessageActionError(error instanceof Error ? error.message : "访问模式切换失败");
    }
  }

  async function selectThinkingLevel(level: ThinkingLevel): Promise<void> {
    setComposerMenu(undefined);
    await window.piDesktop.send({ type: "thinking.select", level });
  }

  if (!ready) return <div className="app-loading"><div className="brand-mark">CA</div><LoaderCircle className="spinning" size={22} /></div>;

  return (
    <div className="desktop-shell">
      <aside className="sidebar">
        <div className="brand-row"><div className="brand-mark">CA</div><div><strong>ChatAnyTime</strong><span>桌面端</span></div></div>
        <div className="sidebar-tabs" role="tablist" aria-label="侧栏视图">
          <button type="button" role="tab" aria-selected={sidebarTab === "agents"} className={sidebarTab === "agents" ? "active" : ""} onClick={() => { setSidebarTab("agents"); setSidebarQuery(""); }}><Users size={14} />助手<span>{settings.agents.filter((agent) => !agent.archived).length}</span></button>
          <button type="button" role="tab" aria-selected={sidebarTab === "topics"} className={sidebarTab === "topics" ? "active" : ""} onClick={() => { setSidebarTab("topics"); setSidebarQuery(""); }}><MessageCircle size={14} />话题<span>{snapshot.sessions.length}</span></button>
        </div>
        <label className="sidebar-search"><Search size={14} /><input value={sidebarQuery} placeholder={sidebarTab === "agents" ? "搜索助手" : "搜索话题"} aria-label={sidebarTab === "agents" ? "搜索助手" : "搜索话题"} onChange={(event) => setSidebarQuery(event.target.value)} /></label>
        <div className="sidebar-section-label">{sidebarTab === "agents" ? "角色" : "最近话题"}</div>
        {sidebarTab === "agents" ? <nav className="agent-list" aria-label="助手列表">
          {visibleAgents.map((agent) => <button className={agent.id === snapshot.agentId ? "active" : ""} type="button" key={agent.id} disabled={snapshot.busy} onClick={() => { useDesktopStore.setState({ settings: { ...settings, currentAgentId: agent.id } }); void window.piDesktop.send({ type: "agent.select", agentId: agent.id }); }}><span className="agent-list-icon"><Bot size={15} /></span><span><strong>{agent.name}</strong><small>{agent.description || "未填写说明"}</small></span></button>)}
        </nav> : <nav className="session-list" aria-label="话题列表">
          {sessionGroups.length === 0 ? <div className="session-list-empty">暂无匹配话题</div> : sessionGroups.map((group) => {
            const collapsed = collapsedWorkspaceGroups[group.key] === true;
            const workspaceName = group.workspace.split(/[\\/]/u).at(-1) || group.workspace;
            return (
              <section className="session-workspace-group" key={group.key}>
                <div className="session-workspace-heading">
                  <button
                    className="session-workspace-toggle"
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() => setCollapsedWorkspaceGroups((current) => ({ ...current, [group.key]: !collapsed }))}
                  >
                    <Folder size={15} />
                    <span><strong>{workspaceName}</strong><small>{compactPath(group.workspace)}</small></span>
                    <em>{group.sessions.length}</em>
                    <ChevronDown size={14} className={collapsed ? "collapsed" : ""} />
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
                  {group.sessions.map((item) => <button className={item.id === snapshot.sessionId ? "active" : ""} type="button" key={item.path} onClick={() => void openSession(item.path, item.workspace)}><MessageCircle size={14} /><span><strong>{item.title}</strong><small>{new Date(item.modifiedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</small></span></button>)}
                </div>}
              </section>
            );
          })}
        </nav>}
        <button className="new-session-button" type="button" disabled={!snapshot.workspace} onClick={() => void createNewSession()}><MessageSquarePlus size={16} />新建话题</button>
        <div className="sidebar-footer">
          <button type="button" onClick={() => setSettingsOpen(true)}><Settings size={16} />设置</button>
          <span className={`runtime-indicator${snapshot.busy ? " busy" : ""}`}><i />{snapshot.status}</span>
        </div>
      </aside>

      <main className="workspace-main">
        <header className="topbar">
          <div className="project-title"><Folder size={17} /><span><strong>{snapshot.workspace?.split(/[\\/]/u).at(-1) ?? "ChatAnyTime"}</strong><small>{snapshot.agentName} · {snapshot.sessionId ? "当前话题" : "未开始话题"}</small></span></div>
          <div className="runtime-controls">
            <button className="workspace-top-button" type="button" onClick={() => void openWorkspace()}><FolderOpen size={15} /><span>工作区</span><strong>{compactPath(snapshot.workspace)}</strong><ChevronDown size={13} /></button>
            <button className="icon-button panel-toggle" type="button" aria-label={rightPanel ? "关闭活动面板" : "打开活动面板"} title={rightPanel ? "关闭活动面板" : "打开活动面板"} onClick={() => setRightPanel((open) => !open)}>{rightPanel ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
          </div>
        </header>

        <div className={`work-area${rightPanel ? " with-panel" : ""}`}>
          <section className="conversation-pane">
            <div className="timeline" ref={timelineRef}>
              {!snapshot.workspace ? (
                <div className="empty-workspace"><div className="empty-icon"><FolderOpen size={27} /></div><h1>打开一个项目</h1><button className="primary-button" type="button" onClick={() => void openWorkspace()}><FolderOpen size={16} />选择文件夹</button></div>
              ) : displayMessages.length === 0 && !isGenerating ? (
                <div className="empty-conversation"><div className="empty-icon"><CodeXml size={27} /></div><h1>今天想开发什么？</h1></div>
              ) : <>
                {displayMessages.map((message, index) => <MessageView key={message.uuid ?? message.id} message={message} executions={snapshot.executions} onOpenArtifact={setArtifact} onHtmlAction={handleHtmlAction} onCopy={(item) => void copyMessage(item)} onEdit={editMessage} onRegenerate={(item) => void regenerateMessage(item)} onShare={shareMessage} showThinking={settings.appearance.showThinking} busy={snapshot.busy} timing={showTurnTimingOnLatest && index === latestAssistantMessageIndex && message.role === "assistant" ? snapshot.turnTiming : undefined} now={now} />)}
                {isGenerating && (hasAssistantMessage ? <div className="response-progress response-progress-inline"><LoaderCircle size={14} className="spinning" /><span>{snapshot.agentName}正在努力输出中……</span>{activeTurnTiming && <TimingMeta timing={activeTurnTiming} now={now} />}</div> : <PendingResponse agentName={snapshot.agentName} timing={activeTurnTiming} now={now} />)}
              </>}
            </div>
            <form ref={composerRef} className="composer" onSubmit={submit} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
              {attachments.length > 0 && <div className="attachment-list">{attachments.map((attachment, index) => <span className="attachment-chip" key={`${attachment.name}-${index}`}>{attachment.kind === "image" ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /> : <FileDiff size={12} />}<span>{attachment.name}</span><button type="button" title="移除附件" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={12} /></button></span>)}</div>}
              {attachmentError && <div className="attachment-error" role="alert">{attachmentError}<button type="button" title="关闭提示" aria-label="关闭附件提示" onClick={() => setAttachmentError(undefined)}><X size={12} /></button></div>}
              <input ref={fileInputRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.css,.html" onChange={(event) => { void addLocalFiles(event.target.files ?? []); event.currentTarget.value = ""; }} />
              {slashOpen && (
                <div className="slash-menu" role="listbox" aria-label="斜杠指令">
                  {slashMatches.map((cmd, index) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === activeSlashIndex}
                      key={`${cmd.kind}:${cmd.trigger}`}
                      className={`slash-menu-item${index === activeSlashIndex ? " active" : ""}`}
                      disabled={cmd.kind === "command" && snapshot.busy && cmd.command.type !== "session.new"}
                      onMouseEnter={() => setSlashIndex(index)}
                      onClick={() => applySlashCommand(cmd)}
                    >
                      <span className="slash-menu-icon">{cmd.trigger.startsWith("/skill:") ? <Puzzle size={14} /> : cmd.trigger === "/compact" ? <Layers size={14} /> : <MessageSquarePlus size={14} />}</span>
                      <span className="slash-menu-copy"><strong>{cmd.label}</strong><small>{cmd.description}</small></span>
                    </button>
                  ))}
                </div>
              )}
              <div className="composer-input-row">
                {selectedSkill && <span className="composer-skill-chip"><Puzzle size={13} /><strong>{selectedSkill}</strong><button type="button" title="取消 Skill" aria-label={`取消 Skill ${selectedSkill}`} onClick={() => setSelectedSkill(undefined)}><X size={12} /></button></span>}
                <textarea
                  ref={textareaRef}
                  value={input}
                  rows={1}
                  disabled={!snapshot.workspace}
                  placeholder={composerPlaceholder}
                  onKeyDown={handleComposerKey}
                  onPaste={handlePaste}
                  onChange={(event) => setInput(event.target.value)}
                />
              </div>
              <div className="composer-footer">
                <div className="composer-footer-left">
                  <button className="icon-button attach-button" type="button" title="添加附件" aria-label="添加附件" disabled={snapshot.busy || attachments.length >= 5} onClick={() => void addAttachments()}><Plus size={18} /></button>
                  <div className="access-mode-menu-shell" ref={accessModeMenuRef}>
                    <button className={`access-mode-button${settings.accessMode === "full" ? " full" : ""}`} type="button" aria-haspopup="menu" aria-expanded={accessModeMenuOpen} onClick={() => { setComposerMenu(undefined); setAccessModeMenuOpen((open) => !open); }}>{settings.accessMode === "full" ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}<span>{accessModeOptions.find((option) => option.value === settings.accessMode)?.label ?? "访问模式"}</span><ChevronDown size={13} /></button>
                    {accessModeMenuOpen && <div className="access-mode-menu" role="menu" aria-label="访问模式">
                      {accessModeOptions.map((option) => <button className={`access-mode-menu-item${option.value === settings.accessMode ? " active" : ""}${option.value === "full" ? " full" : ""}`} type="button" role="menuitemradio" aria-checked={option.value === settings.accessMode} key={option.value} onClick={() => void selectAccessMode(option.value)}>{option.value === "full" ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}<span><strong>{option.label}</strong><small>{accessModeDescriptions[option.value]}</small></span>{option.value === settings.accessMode && <Check size={14} />}</button>)}
                    </div>}
                  </div>
                </div>
                <div className="composer-footer-right">
                  <div className="composer-control-menu">
                    <button className="composer-menu-trigger" type="button" title="模型快捷切换" aria-label="模型快捷切换" aria-haspopup="menu" aria-expanded={composerMenu === "model"} disabled={snapshot.busy} onClick={() => { setAccessModeMenuOpen(false); setComposerMenu((current) => current === "model" ? undefined : "model"); }}><Bot size={14} /><span>{selectedModelOption?.name ?? snapshot.model?.id ?? "选择模型"}</span><ChevronDown size={13} /></button>
                    {composerMenu === "model" && <div className="composer-select-menu model-select-menu" role="menu" aria-label="模型快捷切换">
                      {Array.from(new Set(availableModels.map((model) => model.provider))).map((providerId) => <div className="composer-menu-group" key={providerId}><small>{providers.find((provider) => provider.id === providerId)?.name ?? providerId}</small>{availableModels.filter((model) => model.provider === providerId).map((model) => { const value = `${model.provider}/${model.id}`; return <button className={value === selectedModel ? "active" : ""} type="button" role="menuitemradio" aria-checked={value === selectedModel} key={value} onClick={() => void selectModel(value)}><span>{model.name}</span>{value === selectedModel && <Check size={13} />}</button>; })}</div>)}
                    </div>}
                  </div>
                  <div className="composer-control-menu thinking-control">
                    <button className="composer-menu-trigger" type="button" title="思考级别" aria-label="思考级别" aria-haspopup="menu" aria-expanded={composerMenu === "thinking"} disabled={snapshot.busy} onClick={() => { setAccessModeMenuOpen(false); setComposerMenu((current) => current === "thinking" ? undefined : "thinking"); }}><span>思考</span><strong>{thinkingLevelLabels[snapshot.thinkingLevel]}</strong><ChevronDown size={13} /></button>
                    {composerMenu === "thinking" && <div className="composer-select-menu thinking-select-menu" role="menu" aria-label="思考级别">{thinkingLevels.map((level) => <button className={level === snapshot.thinkingLevel ? "active" : ""} type="button" role="menuitemradio" aria-checked={level === snapshot.thinkingLevel} key={level} onClick={() => void selectThinkingLevel(level)}><span>{thinkingLevelLabels[level]}</span>{level === snapshot.thinkingLevel && <Check size={13} />}</button>)}</div>}
                  </div>
                  {snapshot.busy ? (
                    <button className="stop-button" type="button" title="停止" aria-label="停止" onClick={() => void window.piDesktop.send({ type: "session.abort" })}><CircleStop size={18} /></button>
                  ) : (
                    <button className="send-button" type="submit" title="发送" aria-label="发送" disabled={!canSubmit}><Play size={17} fill="currentColor" /></button>
                  )}
                </div>
              </div>
            </form>
          </section>

          {rightPanel && (
            <aside className="right-panel">
              <div className="panel-tabs">
                <button className={panelTab === "activity" ? "active" : ""} type="button" onClick={() => setPanelTab("activity")}><Wrench size={15} />活动</button>
                <button className={panelTab === "changes" ? "active" : ""} type="button" onClick={() => setPanelTab("changes")}><FileDiff size={15} />变更<span>{snapshot.executions.filter((item) => item.patch).length}</span></button>
              </div>
              {panelTab === "activity" ? <ActivityPanel executions={snapshot.executions} /> : <ChangesPanel executions={snapshot.executions} />}
            </aside>
          )}
        </div>
      </main>

      {settingsOpen && <SettingsDialog settings={settings} models={models} providers={providers} customProvider={customProvider} customProviderKeyConfigured={customProviderKeyConfigured} customModels={customModels} customModelFetchStatus={customModelFetchStatus} customModelFetchError={customModelFetchError} resources={resources} onClose={() => setSettingsOpen(false)} />}
      {permission && <PermissionDialog request={permission} />}
      {!permission && extensionUiDialog && <ExtensionUiDialog key={extensionUiDialog.id} request={extensionUiDialog} />}
      {artifact && <ArtifactPreview artifact={artifact} onClose={() => setArtifact(undefined)} />}
      {error && <div className="error-toast"><AlertCircle size={18} /><span>{error}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={clearError}><X size={16} /></button></div>}
      {extensionNotice && <div className={`error-toast extension-notice ${extensionNotice.level}`}><PlugZap size={18} /><span>{extensionNotice.message}</span><button className="icon-button" type="button" title="关闭扩展提示" aria-label="关闭扩展提示" onClick={clearExtensionNotice}><X size={16} /></button></div>}
      {messageActionError && <div className="error-toast"><AlertCircle size={18} /><span>{messageActionError}</span><button className="icon-button" type="button" title="关闭提示" aria-label="关闭提示" onClick={() => setMessageActionError(undefined)}><X size={16} /></button></div>}
    </div>
  );
}
