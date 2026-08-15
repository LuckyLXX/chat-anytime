import {
  AlertCircle,
  Brain,
  Bot,
  Check,
  Copy,
  ChevronDown,
  CircleStop,
  CodeXml,
  Download,
  Eye,
  File,
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
  Workflow,
  FolderTree,
  ChevronLeft,
  Pin,
  X
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
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
import { ArtifactPreview, type PreviewEditorState, type PreviewTab, type PreviewTarget } from "./components/ArtifactPreview";
import type { EditorSaveStatus } from "./components/MarkdownEditor";
import { WorkspaceTree } from "./components/WorkspaceTree";
import { ContextMenu, type ContextMenuItem } from "./components/ContextMenu";
import { RichContent } from "./components/RichContent";
import { PermissionDialog } from "./components/RuntimeDialogs";
import { compactPath, formatDuration, type Artifact } from "./lib/content";
import { actionTimelineSegments, actionTimelineStats, formatProcessDuration, type ActionTimelineSegment } from "./lib/action-timeline";
import { changedFilesForMessage, type ReplyChangedFile } from "./lib/changed-files";
import { groupAssistantMessages } from "./lib/chat-layout";
import { clampPreviewSplit, PREVIEW_SPLIT_MAX, PREVIEW_SPLIT_MIN, previewSplitFromKey } from "./lib/preview-split";
import { groupSessionsByWorkspace } from "./lib/session-groups";
import { CSS_URL_PATTERN, createThemeAssetUrls, isExternalThemeReference, normalizeThemeAssetReference, resolveThemeAssets } from "./lib/theme-assets";
import { THEME_PRESETS, scopeCustomThemeCss, scopeCustomThemeCssForPreview, themeOverrideCss, themePresetColor, themePresetCss, themePreviewCss, themeWallpaperOpacity } from "./lib/theme-presets";
import { shareElementAsImage } from "./lib/share-image";
import { useDesktopStore } from "./store";
import { TaskPanel } from "./TaskPanel";

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

function previewTargetKey(target: PreviewTarget): string {
  switch (target.type) {
    case "artifact": return target.artifact.id;
    case "browser": return target.id ?? "browser";
    case "file": return target.file.relativePath;
    default: return `${target.type}-${target.path ?? target.title}`;
  }
}

interface PreviewState {
  tabs: PreviewTab[];
  activeTabId: string;
}
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

function readStoredPreviewSplit(): number {
  try {
    const value = window.localStorage.getItem("pidesktop.preview-split");
    return value === null ? 50 : clampPreviewSplit(Number(value));
  } catch {
    return 50;
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

function PendingResponse({ label, timing, now }: { label: string; timing?: TurnTiming; now: number }): ReactNode {
  return (
    <article className="message message-assistant pending-response">
      <div className="message-avatar pi-avatar"><LoaderCircle size={17} className="spinning" /></div>
      <div className="message-body message-bubble pending-response-body">
        <div className="response-progress"><LoaderCircle size={14} className="spinning" /><span>{label}</span></div>
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

function formatToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "（无参数）";
  try {
    const text = JSON.stringify(args, null, 2);
    return text === undefined ? String(args) : text;
  } catch {
    return String(args);
  }
}

const MAX_TOOL_OUTPUT_CHARS = 20_000;

function truncateToolOutput(output: string): string {
  return output.length > MAX_TOOL_OUTPUT_CHARS ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…（输出过长，已截断显示）` : output;
}

function actionTimelineIcon(segment: ActionTimelineSegment, execution: ToolExecution | undefined, streaming: boolean): ReactNode {
  if (segment.type === "thinking") return <Brain size={14} />;
  if (segment.type === "text") return <MessageCircle size={14} />;
  return toolCallStatusIcon(execution, streaming);
}

function actionTimelineNodeState(segment: ActionTimelineSegment, execution: ToolExecution | undefined, streaming: boolean): string {
  if (segment.type === "thinking") return "thinking";
  if (segment.type === "text") return "text";
  return execution?.status ?? (streaming ? "running" : "completed");
}

/** Expandable tool-call node: shows the call arguments and the tool output. */
function ToolCallDetails({ call, execution, streaming }: { call: Extract<MessageBlock, { type: "tool-call" }>; execution: ToolExecution | undefined; streaming: boolean }): ReactNode {
  const running = execution?.status === "running" || (!execution && streaming);
  const [open, setOpen] = useState(() => running);
  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);
  return (
    <details className="action-timeline-call" open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary className="action-timeline-call-summary">
        <strong>{toolLabel(call.name)}</strong>
        <span>{toolCallStatusLabel(execution, streaming)}{execution?.completedAt ? ` · ${formatDuration(execution.startedAt, execution.completedAt)}` : ""}</span>
        <ChevronDown size={12} className="action-timeline-call-chevron" />
      </summary>
      <div className="action-timeline-call-detail">
        <div className="action-timeline-call-section">
          <span className="action-timeline-call-section-title">调用指令</span>
          <pre className="action-timeline-call-code">{formatToolArgs(execution?.args ?? call.arguments)}</pre>
        </div>
        <div className="action-timeline-call-section">
          <span className="action-timeline-call-section-title">输出</span>
          {execution?.output ? <pre className="action-timeline-call-code">{truncateToolOutput(execution.output)}</pre> : <span className="action-timeline-call-empty">{running ? "运行中…" : "（无输出）"}</span>}
        </div>
      </div>
    </details>
  );
}

interface ActionTimelineProps {
  message: ChatMessage;
  executions: ToolExecution[];
  turnActive: boolean;
  showThinking: boolean;
  thinkingLabel?: string;
  onOpenArtifact(artifact: Artifact): void;
  onHtmlAction(text: string): void;
  timing?: TurnTiming;
  now: number;
}

function ActionTimeline({ message, executions, turnActive, showThinking, thinkingLabel, onOpenArtifact, onHtmlAction, timing, now }: ActionTimelineProps): ReactNode {
  const segments = actionTimelineSegments(message, showThinking);
  const lastActionIndex = segments.reduce((index, segment, currentIndex) => segment.type === "thinking" || segment.type === "tool-call" ? currentIndex : index, -1);
  if (lastActionIndex < 0) return segments[0]?.type === "text" ? <RichContent streaming={message.streaming} artifactPrefix={message.id} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{segments[0].text}</RichContent> : null;
  const process = segments.slice(0, lastActionIndex + 1);
  const trailing = segments.slice(lastActionIndex + 1).filter((segment): segment is Extract<ActionTimelineSegment, { type: "text" }> => segment.type === "text");
  const processActive = turnActive || Boolean(message.streaming);
  const stats = actionTimelineStats(process, executions, processActive);
  const executionById = new Map(executions.map((execution) => [execution.id, execution]));
  const historicalStartedAt = stats.startedAt === undefined ? message.timestamp : Math.min(message.timestamp, stats.startedAt);
  const startedAt = timing?.startedAt ?? historicalStartedAt;
  const completedAt = stats.active ? now : timing?.completedAt ?? stats.completedAt;
  const elapsed = startedAt === undefined ? undefined : formatProcessDuration(startedAt, completedAt ?? now);
  const summary = stats.active ? "正在处理" : elapsed ? `已处理 ${elapsed}` : "已处理";
  return (
    <>
      <details className={`action-timeline${stats.active ? " active" : ""}`} open={stats.active}>
        <summary className="action-timeline-summary">
          <span className="action-timeline-summary-title"><Workflow size={15} /><strong>{summary}</strong></span>
          <span className="action-timeline-summary-meta">{stats.thinkingCount > 0 && `${stats.thinkingCount} 段思考`}{stats.thinkingCount > 0 && stats.toolCount > 0 ? " · " : ""}{stats.toolCount > 0 && `${stats.toolCount} 次工具调用`}{stats.failedCount > 0 && ` · ${stats.failedCount} 个失败`}</span>
          <ChevronDown size={14} className="action-timeline-chevron" />
        </summary>
        <div className="action-timeline-body">
          {process.map((segment, index) => {
            const execution = segment.type === "tool-call" ? executionById.get(segment.call.id) : undefined;
            const stateClass = actionTimelineNodeState(segment, execution, processActive);
            return (
              <div className={`action-timeline-node ${segment.type} ${stateClass}`} key={segment.type === "tool-call" ? segment.call.id : `${segment.type}-${index}`}>
                <span className="action-timeline-node-icon">{actionTimelineIcon(segment, execution, processActive)}</span>
                <div className="action-timeline-node-content">
                  {segment.type === "thinking" ? <><strong>{thinkingLabel || "思考过程"}</strong><p>{segment.text}</p></> : segment.type === "tool-call" ? <ToolCallDetails call={segment.call} execution={execution} streaming={Boolean(message.streaming)} /> : <RichContent streaming={false} artifactPrefix={`${message.id}-process-${index}`} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{segment.text}</RichContent>}
                </div>
              </div>
            );
          })}
        </div>
      </details>
      {trailing.map((segment, index) => <RichContent key={`trailing-${index}`} streaming={message.streaming} artifactPrefix={`${message.id}-trailing-${index}`} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{segment.text}</RichContent>)}
    </>
  );
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

function CompactTimingMeta({ timing, now }: { timing: TurnTiming; now: number }): ReactNode {
  return (
    <div className="message-timing" aria-label="压缩耗时">
      <span>压缩耗时 {formatDuration(timing.startedAt, timing.completedAt ?? now)}</span>
    </div>
  );
}

function ChangedFilesPanel({ files, onOpenFile, onOpenDiff }: { files: ReplyChangedFile[]; onOpenFile(relativePath: string): void; onOpenDiff(execution: ToolExecution): void }): ReactNode {
  return (
    <details className="reply-files-panel">
      <summary>
        <span><FileDiff size={14} /><strong>本次变更文件</strong><em>{files.length}</em></span>
        <span className="reply-files-toggle" aria-hidden="true" />
      </summary>
      <div className="reply-files-list">
        {files.map(({ relativePath, execution }) => {
          const name = relativePath.split("/").at(-1) ?? relativePath;
          const hasDiff = Boolean(execution.patch);
          return (
            <div className="reply-file-row" key={relativePath}>
              <span className="reply-file-info"><File size={14} /><span className="reply-file-text"><strong>{name}</strong><small>{relativePath}</small></span></span>
              <span className="reply-file-actions">
                <button type="button" className="reply-file-action" title={`预览 ${relativePath}`} aria-label={`预览 ${name}`} onClick={() => onOpenFile(relativePath)}><Eye size={14} /></button>
                <button type="button" className="reply-file-action" title={hasDiff ? `查看 ${relativePath} 变更` : "暂无变更记录"} aria-label={`查看 ${name} 变更`} disabled={!hasDiff} onClick={() => onOpenDiff(execution)}><FileDiff size={14} /></button>
              </span>
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
const MessageView = memo(function MessageView({ message, executions, onOpenArtifact, onOpenFile, onOpenDiff, onHtmlAction, onCopy, onEdit, onRegenerate, onShare, showThinking = true, hiddenThinkingLabel, busy = false, turnActive = false, timing, now = Date.now() }: { message: ChatMessage; executions: ToolExecution[]; onOpenArtifact(artifact: Artifact): void; onOpenFile(relativePath: string): void; onOpenDiff(execution: ToolExecution): void; onHtmlAction(text: string): void; onCopy(message: ChatMessage): void; onEdit(message: ChatMessage): void; onRegenerate(message: ChatMessage): void; onShare(message: ChatMessage, target: HTMLElement): Promise<void>; showThinking?: boolean; hiddenThinkingLabel?: string; busy?: boolean; turnActive?: boolean; timing?: TurnTiming; now?: number }): ReactNode {
  const text = messageText(message);
  const shareTargetRef = useRef<HTMLDivElement | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState(false);
  const isControlMessage = message.control !== undefined;
  const hasShareableContent = Boolean(text);
  const changedFiles = changedFilesForMessage(message, executions);

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

  if (message.role === "extension") {
    const images = message.blocks.filter((block): block is Extract<MessageBlock, { type: "image" }> => block.type === "image");
    return (
      <article className="message message-extension">
        <div className="message-avatar extension-avatar"><PlugZap size={16} /></div>
        <div className="message-body extension-message-callout">
          <strong>{message.extension?.customType || "扩展消息"}</strong>
          {images.length > 0 && <div className="image-message-list">{images.map((block, index) => <ImageMessageBlock key={`${message.id}-extension-image-${index}`} block={block} />)}</div>}
          {text && <RichContent streaming={false} artifactPrefix={`${message.id}-extension`} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{text}</RichContent>}
        </div>
      </article>
    );
  }

  if (message.role === "user") {
    const images = message.blocks.filter((block): block is Extract<MessageBlock, { type: "image" }> => block.type === "image");
    return (
      <article className="message message-user">
        <div className="message-avatar user-avatar">我</div>
        <div className="message-body message-bubble">{message.skill && <div className="message-skill-badge"><Puzzle size={13} /><strong>{message.skill.name}</strong></div>}{images.length > 0 && <div className="image-message-list">{images.map((block, index) => <ImageMessageBlock key={`${message.id}-image-${index}`} block={block} />)}</div>}{text && <p className="user-text">{text}</p>}{!isControlMessage && <div className="message-actions"><button type="button" title="复制" aria-label="复制用户消息" onClick={() => onCopy(message)}><Copy size={13} /></button><button type="button" title="重新编辑" aria-label="重新编辑用户消息" onClick={() => onEdit(message)}><Pencil size={13} /></button></div>}</div>
      </article>
    );
  }

  return (
    <article className="message message-assistant">
      <div className="message-avatar pi-avatar"><Bot size={17} /></div>
      <div className="message-body message-bubble">
        <div className="assistant-share-content" ref={shareTargetRef}>
          <ActionTimeline message={message} executions={executions} turnActive={turnActive} showThinking={showThinking} thinkingLabel={hiddenThinkingLabel} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction} timing={timing} now={now} />
          {message.error && <p className="inline-error"><AlertCircle size={15} />{message.error}</p>}
          {timing && (isControlMessage ? <CompactTimingMeta timing={timing} now={now} /> : <TimingMeta timing={timing} now={now} />)}
        </div>
        {changedFiles.length > 0 && <ChangedFilesPanel files={changedFiles} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />}
        {!isControlMessage && !message.streaming && !busy && <div className="message-actions"><button type="button" title="重新生成" aria-label="重新生成回复" onClick={() => onRegenerate(message)}><RefreshCw size={13} /></button><button type="button" title="复制" aria-label="复制 AI 回复" onClick={() => onCopy(message)}><Copy size={13} /></button>{hasShareableContent && <button type="button" title={sharing ? "正在生成图片" : shared ? "已复制图片" : "分享图片"} aria-label={sharing ? "正在生成回复图片" : shared ? "回复图片已复制" : "分享 AI 回复图片"} disabled={sharing} onClick={() => void share()}>{sharing ? <LoaderCircle size={13} className="spinning" /> : shared ? <Check size={13} /> : <Share2 size={13} />}</button>}</div>}
      </div>
    </article>
  );
});

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
          {selectedAgent && <div className="agent-editor"><label>名称<input value={selectedAgent.name} onChange={(event) => updateAgent({ name: event.target.value })} /></label><label>说明<input value={selectedAgent.description} onChange={(event) => updateAgent({ description: event.target.value })} /></label><label>系统提示词<textarea value={selectedAgent.systemPrompt} rows={6} onChange={(event) => updateAgent({ systemPrompt: event.target.value })} /></label><label className="checkbox-setting"><input type="checkbox" checked={selectedAgent.divMode} onChange={(event) => updateAgent({ divMode: event.target.checked })} />启用 Div 气泡模式</label><label>默认模型<select value={selectedAgent.defaultModel ? `${selectedAgent.defaultModel.provider}/${selectedAgent.defaultModel.id}` : ""} onChange={(event) => { const value = event.target.value; updateAgent({ defaultModel: value ? { provider: value.slice(0, value.indexOf("/")), id: value.slice(value.indexOf("/") + 1) } : undefined }); }}><option value="">跟随全局默认模型</option>{configuredModels.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}</option>)}</select></label><label>默认思考等级<select value={selectedAgent.defaultThinkingLevel} onChange={(event) => updateAgent({ defaultThinkingLevel: event.target.value as ThinkingLevel })}>{thinkingLevels.map((level) => <option key={level} value={level}>{thinkingLevelLabels[level]}</option>)}</select></label><AgentSkillSelector agent={selectedAgent} skills={resources.skills} onChange={updateAgentSkillOverride} /><fieldset><legend>工具权限</legend>{agentTools.map((tool) => <label className="tool-toggle" key={tool}><input type="checkbox" checked={selectedAgent.tools[tool]} onChange={(event) => updateAgent({ tools: { ...selectedAgent.tools, [tool]: event.target.checked } })} />{tool}</label>)}</fieldset><footer><button type="button" className="danger-button" disabled={selectedAgent.id === "default"} onClick={() => void archiveAgent()}>归档</button><button type="button" className="secondary-button" onClick={duplicateAgent}>复制</button><button type="button" className="primary-button" onClick={() => void saveAgent()}>保存 Agent</button></footer></div>}
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
  const { ready, snapshot, models, providers, resources, customProvider, customProviderKeyConfigured, customModels, customModelFetchStatus, customModelFetchError, permissions, error, initialize, clearError } = useDesktopStore();
  const permission = permissions[0];
  const settings = useDesktopStore((state) => state.settings);
  const themeAssetUrls = useThemeAssetUrls(themeAssetsForAppearance(settings.appearance));
  const [input, setInput] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<string>();
  const [editingMessageTimestamp, setEditingMessageTimestamp] = useState<number>();
  const [localTurnStartedAt, setLocalTurnStartedAt] = useState<number>();
  const [messageActionError, setMessageActionError] = useState<string>();
  const [sidebarTab, setSidebarTab] = useState<"agents" | "topics">("topics");
  const [sidebarQuery, setSidebarQuery] = useState("");
  const [collapsedWorkspaceGroups, setCollapsedWorkspaceGroups] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accessModeMenuOpen, setAccessModeMenuOpen] = useState(false);
  const [composerMenu, setComposerMenu] = useState<"model" | "thinking">();
  const [previewOpened, setPreviewOpened] = useState(false);
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [preview, setPreview] = useState<PreviewState>();
  const previewRef = useRef<PreviewState | undefined>(preview);
  previewRef.current = preview;
  const [previewEditorStates, setPreviewEditorStates] = useState<Record<string, PreviewEditorState>>({});
  const [sidebarView, setSidebarView] = useState<"topics" | "files">("topics");
  const [browsingWorkspace, setBrowsingWorkspace] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [renameSession, setRenameSession] = useState<{ path: string; title: string } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [removeWorkspace, setRemoveWorkspace] = useState<{ workspace: string; name: string; count: number } | null>(null);
  const [previewSplit, setPreviewSplit] = useState(readStoredPreviewSplit);
  const [previewDragging, setPreviewDragging] = useState(false);
  const [attachments, setAttachments] = useState<import("../../shared/protocol").PromptAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const accessModeMenuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const processedComposerRequestsRef = useRef(new Set<string>());
  const previewDragPointerRef = useRef<number | undefined>(undefined);
  const workAreaRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const previousSessionIdRef = useRef<string | undefined>(undefined);
  const [slashIndex, setSlashIndex] = useState(0);
  const selectedModel = snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "";
  const availableModels = useMemo(() => models.filter((model) => model.configured), [models]);
  const selectedModelOption = availableModels.find((model) => `${model.provider}/${model.id}` === selectedModel);
  const visibleAgents = useMemo(() => settings.agents.filter((agent) => !agent.archived && `${agent.name} ${agent.description}`.toLowerCase().includes(sidebarQuery.trim().toLowerCase())), [settings.agents, sidebarQuery]);
  const sessionGroups = useMemo(() => groupSessionsByWorkspace(snapshot.sessions, sidebarQuery, snapshot.recentWorkspaces), [snapshot.sessions, snapshot.recentWorkspaces, sidebarQuery]);
  const displayMessages = useMemo(() => groupAssistantMessages(snapshot.messages), [snapshot.messages]);
  const latestAssistantIndex = useMemo(() => [...displayMessages].reverse().findIndex((message) => message.role === "assistant"), [displayMessages]);
  const latestAssistantMessageIndex = latestAssistantIndex < 0 ? -1 : displayMessages.length - 1 - latestAssistantIndex;
  const localTiming = localTurnStartedAt === undefined ? undefined : { startedAt: localTurnStartedAt } satisfies TurnTiming;
  const localTurnPending = localTiming !== undefined && (snapshot.turnTiming === undefined || snapshot.turnTiming.startedAt < localTiming.startedAt);
  const activeTurnTiming = localTurnPending ? localTiming : snapshot.turnTiming;
  const isGenerating = localTurnPending || Boolean(snapshot.busy && snapshot.turnTiming && snapshot.turnTiming.completedAt === undefined);
  const activePreviewTab = preview?.tabs.find((tab) => tab.id === preview.activeTabId);
  const now = useElapsedNow(isGenerating);
  const hasAssistantMessage = displayMessages.some((message) => message.role === "assistant" && !message.control);
  const showTurnTimingOnLatest = Boolean(snapshot.turnTiming && (!snapshot.busy || displayMessages[latestAssistantMessageIndex]?.streaming));
  const canSubmit = Boolean(snapshot.workspace && (input.trim() || attachments.length > 0 || selectedSkill) && snapshot.model);
  const workingLabel = `${snapshot.agentName}正在努力输出中……`;
  let composerPlaceholder = "请先打开一个项目";
  if (snapshot.workspace) composerPlaceholder = selectedSkill ? "输入任务要求" : "让 Pi 检查、修改或运行这个项目";

  // 斜杠指令清单：固定会话命令 + 已发现的 Skill
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const fixed: SlashCommand[] = [
      { trigger: "/compact", label: "/compact", description: "压缩当前会话上下文", kind: "command", command: { type: "session.compact" } },
      { trigger: "/new", label: "/new", description: "开启新话题", kind: "command", command: { type: "session.new" } }
    ];
    const skills: SlashCommand[] = resources.skills.filter((skill) => skill.enabled).map((skill) => ({
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
    if (!ready) return;
    const composer = composerRef.current;
    const pane = composer?.parentElement;
    if (!composer || !pane) return;
    const update = (): void => pane.style.setProperty("--composer-space", `${composer.getBoundingClientRect().height + 40}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      pane.style.removeProperty("--composer-space");
    };
  }, [ready]);

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
    if (!timeline) return;
    const sessionChanged = previousSessionIdRef.current !== snapshot.sessionId;
    previousSessionIdRef.current = snapshot.sessionId;
    if (sessionChanged) {
      // Session switch: jump straight to the newest content instead of smooth-
      // scrolling through the swapped-in history. Images/code may still be
      // measuring, so re-jump on the next frames while still stuck to bottom.
      stickToBottomRef.current = true;
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: "auto" });
      requestAnimationFrame(() => {
        const element = timelineRef.current;
        if (element && stickToBottomRef.current) element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
      });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const element = timelineRef.current;
        if (element && stickToBottomRef.current) element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
      }));
      return;
    }
    if (!stickToBottomRef.current) return;
    // Instant scroll while busy: streaming fires frequent updates, and smooth
    // scrolling on every frame stacks competing animations and janks. Reserve
    // smooth scrolling for the occasional new message when idle.
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: snapshot.busy ? "auto" : "smooth" });
  }, [snapshot.messages, snapshot.busy, snapshot.sessionId]);

  useEffect(() => {
    if (!snapshot.busy) setLocalTurnStartedAt(undefined);
  }, [snapshot.busy]);

  useEffect(() => {
    try { window.localStorage.setItem("pidesktop.preview-split", String(previewSplit)); } catch { /* storage may be unavailable in browser demo */ }
  }, [previewSplit]);

  useEffect(() => {
    if (preview) return;
    previewDragPointerRef.current = undefined;
    setPreviewDragging(false);
  }, [preview]);

  useEffect(() => {
    setEditingMessageTimestamp(undefined);
    setSelectedSkill(undefined);
    if (preview) {
      // Closing the preview wholesale must also destroy any live browser
      // views; otherwise their hidden WebContentsViews would leak.
      for (const tab of preview.tabs) {
        if (tab.target.type === "browser") void window.piDesktop.browserPreview({ type: "close", tabId: tab.id });
      }
    }
    setPreview(undefined);
    setPreviewOpened(false);
    setPreviewCollapsed(false);
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

  const copyMessage = useCallback(async (message: ChatMessage): Promise<void> => {
    const text = messageText(message);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setMessageActionError("复制失败，请检查剪贴板权限");
    }
  }, []);

  const shareMessage = useCallback(async (_message: ChatMessage, target: HTMLElement): Promise<void> => {
    setMessageActionError(undefined);
    try {
      await shareElementAsImage(target);
    } catch (error) {
      setMessageActionError(error instanceof Error ? `分享失败：${error.message}` : "分享失败，请重试");
      throw error;
    }
  }, []);

  const editMessage = useCallback((message: ChatMessage): void => {
    setInput(messageText(message));
    setSelectedSkill(message.skill?.name);
    setAttachments([]);
    setEditingMessageTimestamp(message.timestamp);
    setMessageActionError(undefined);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const handleHtmlAction = useCallback((text: string): void => {
    setInput((current) => current.trim() ? `${current.trim()}\n${text}` : text);
    setSelectedSkill(undefined);
    setEditingMessageTimestamp(undefined);
    setMessageActionError(undefined);
  }, []);

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
    setPreviewCollapsed(false);
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
    // switching only hides it (see BrowserPreview unmount behavior).
    const closing = preview?.tabs.find((tab) => tab.id === id);
    if (closing?.target.type === "browser") {
      void window.piDesktop.browserPreview({ type: "close", tabId: id });
    }
    setPreview((current) => {
      if (!current) return undefined;
      const index = current.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      if (tabs.length === 0) {
        setPreviewCollapsed(false);
        return undefined;
      }
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

  // Latest snapshot ref so regenerateMessage keeps a stable identity instead of
  // rebuilding on every streaming frame — rebuilding it would hand a new
  // onRegenerate to every MessageView and bust their memo during streaming.
  const latestSnapshotRef = useRef(snapshot);
  latestSnapshotRef.current = snapshot;
  const regenerateMessage = useCallback(async (message: ChatMessage): Promise<void> => {
    const { busy, messages } = latestSnapshotRef.current;
    if (busy) return;
    const index = messages.findIndex((item) => item.id === message.id);
    const previousUser = index > 0 ? [...messages.slice(0, index)].reverse().find((item) => item.role === "user") : undefined;
    const text = previousUser ? messageText(previousUser) : "";
    if (!text && !previousUser?.skill) return;
    setLocalTurnStartedAt(Date.now());
    try {
      await window.piDesktop.send({ type: "session.regenerate", text, timestamp: previousUser?.timestamp, skillName: previousUser?.skill?.name });
    } catch (error) {
      setLocalTurnStartedAt(undefined);
      setMessageActionError(error instanceof Error ? error.message : "重新生成失败");
    }
  }, []);

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
        {sidebarView === "files" ? (
          <>
            <div className="workspace-tree-header">
              <button type="button" className="workspace-tree-back" onClick={() => setSidebarView("topics")}><ChevronLeft size={14} />返回</button>
              <span title={browsingWorkspace}>{browsingWorkspace ? (browsingWorkspace.split(/[\\/]/u).at(-1) ?? browsingWorkspace) : "工作区文件"}</span>
            </div>
            {browsingWorkspace
              ? <WorkspaceTree key={browsingWorkspace} workspace={browsingWorkspace} onOpenFile={(relativePath) => openFilePreview(relativePath, browsingWorkspace)} />
              : <div className="session-list-empty">请从话题列表选择工作区</div>}
          </>
        ) : (
          <>
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
                <div className="session-workspace-heading" onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, items: [{ label: "移除工作区", danger: true, onClick: () => setRemoveWorkspace({ workspace: group.workspace, name: workspaceName, count: group.sessions.length }) }] }); }}>
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
                    className="session-workspace-files-button"
                    type="button"
                    title={`查看 ${workspaceName} 文件`}
                    aria-label={`查看 ${workspaceName} 文件`}
                    onClick={() => { setBrowsingWorkspace(group.workspace); setSidebarView("files"); }}
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
                    : group.sessions.map((item) => <button className={item.id === snapshot.sessionId ? "active" : ""} type="button" key={item.path} title={item.title} onClick={() => void openSession(item.path, item.workspace)} onContextMenu={(event) => { event.preventDefault(); setContextMenu({ x: event.clientX, y: event.clientY, items: [{ label: "重命名", onClick: () => { setRenameSession({ path: item.path, title: item.title }); setRenameValue(item.title); } }, { label: item.pinned ? "取消置顶" : "置顶", onClick: () => { void window.piDesktop.send({ type: "session.pin", path: item.path, pinned: !item.pinned }); } }] }); }}><MessageCircle size={14} /><span><strong>{item.title}</strong><small>{new Date(item.modifiedAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</small></span>{item.pinned && <Pin size={11} className="session-pin-indicator" />}</button>)}
                </div>}
              </section>
            );
          })}
        </nav>}
          </>
        )}
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
            <button className="icon-button preview-panel-toggle" type="button" aria-label={previewOpened ? "关闭预览" : "打开预览"} title={previewOpened ? "关闭预览" : "打开预览"} onClick={() => {
              if (previewCollapsed) setPreviewCollapsed(false);
              else if (preview) setPreviewCollapsed(true);
              else if (previewOpened) setPreviewOpened(false);
              else setPreviewOpened(true);
            }}>{previewOpened ? <PanelRightClose size={18} /> : <Eye size={18} />}</button>
          </div>
        </header>

          <div
            ref={workAreaRef}
            className={`work-area${preview && !previewCollapsed ? " with-preview" : previewCollapsed ? " with-preview-collapsed" : previewOpened ? " with-preview-empty" : ""}${previewDragging ? " is-preview-dragging" : ""}`}
            style={(preview && !previewCollapsed) || previewOpened ? { "--preview-split": `${previewSplit}%` } as CSSProperties : undefined}
          >
          <section className="conversation-pane">
            <TaskPanel />
            <div className="timeline" ref={timelineRef}>
              {!snapshot.workspace ? (
                <div className="empty-workspace"><div className="empty-icon"><FolderOpen size={27} /></div><h1>打开一个项目</h1><button className="primary-button" type="button" onClick={() => void openWorkspace()}><FolderOpen size={16} />选择文件夹</button></div>
              ) : displayMessages.length === 0 && !isGenerating ? (
                <div className="empty-conversation"><div className="empty-icon"><CodeXml size={27} /></div><h1>今天想开发什么？</h1></div>
              ) : <>
                {displayMessages.map((message, index) => {
                  const timing = showTurnTimingOnLatest && index === latestAssistantMessageIndex && message.role === "assistant" ? snapshot.turnTiming : undefined;
                  const turnActive = snapshot.busy && index === latestAssistantMessageIndex && message.role === "assistant";
                  return <MessageView key={message.uuid ?? message.id} message={message} executions={snapshot.executions} onOpenArtifact={openArtifactPreview} onOpenFile={openFilePreview} onOpenDiff={openDiffPreview} onHtmlAction={handleHtmlAction} onCopy={copyMessage} onEdit={editMessage} onRegenerate={regenerateMessage} onShare={shareMessage} showThinking={settings.appearance.showThinking} busy={snapshot.busy} turnActive={turnActive} timing={timing} now={timing ? now : undefined} />;
                })}
                {isGenerating && (hasAssistantMessage ? <div className="response-progress response-progress-inline"><LoaderCircle size={14} className="spinning" /><span>{workingLabel}</span>{activeTurnTiming && <TimingMeta timing={activeTurnTiming} now={now} />}</div> : <PendingResponse label={workingLabel} timing={activeTurnTiming} now={now} />)}
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

          {preview && !previewCollapsed && <PreviewDivider split={previewSplit} dragging={previewDragging} onStart={startPreviewResize} onMove={movePreviewResize} onEnd={endPreviewResize} onCancel={cancelPreviewResize} onKeyDown={resizePreviewWithKeyboard} onReset={() => setPreviewSplit(50)} />}

          {previewCollapsed && (
            <aside className="preview-panel-collapsed" aria-label="预览已折叠">
              <button className="icon-button preview-panel-collapsed-toggle" type="button" aria-label="展开预览" title="展开预览" onClick={() => setPreviewCollapsed(false)}><PanelRightOpen size={16} /></button>
            </aside>
          )}
          {(!preview && previewOpened) || (preview && !previewCollapsed && preview.tabs.length === 0) ? (
            <ArtifactPreview key="empty-state" tabs={[]} activeTabId="" onSelectTab={selectPreviewTab} onCloseTab={closePreviewTab} onOpenArtifact={openArtifactPreview} onAddBrowser={openBrowserPreview} onAddFile={() => void openManualFilePreview()} />
          ) : (
            preview && !previewCollapsed && <ArtifactPreview tabs={preview.tabs} activeTabId={preview.activeTabId} browserSuspended={previewDragging || settingsOpen || Boolean(permission) || Boolean(messageActionError)} onSelectTab={selectPreviewTab} onCloseTab={closePreviewTab} onOpenArtifact={openArtifactPreview} onAddBrowser={openBrowserPreview} onAddFile={() => void openManualFilePreview()} onAddReview={openLatestReview} reviewAvailable={Boolean(latestReviewExecution)} workspace={snapshot.workspace} activeEditorState={activePreviewTab?.target.type === "file" && activePreviewTab.target.file.kind === "markdown" ? getEditorState(activePreviewTab.id) : undefined} onActiveEditorChange={(patch) => { if (activePreviewTab) patchEditorState(activePreviewTab.id, patch); }} onActiveEditorContentChange={handleActiveEditorContentChange} onActiveEditorSaved={handleActiveEditorSaved} onActiveEditorStatusChange={handleActiveEditorStatusChange} onActiveEditorSaveError={(message) => setMessageActionError(`保存 ${activePreviewTab?.target.type === "file" ? activePreviewTab.target.file.name : "Markdown"} 失败：${message}`)} onActiveEditorResolveConflict={(choice) => { if (activePreviewTab) handleEditorResolveConflict(activePreviewTab.id, choice); }} onToggleEditing={() => { if (activePreviewTab) patchEditorState(activePreviewTab.id, { editing: !getEditorState(activePreviewTab.id).editing }); }} />
          )}
        </div>
      </main>

      {settingsOpen && <SettingsDialog settings={settings} models={models} providers={providers} customProvider={customProvider} customProviderKeyConfigured={customProviderKeyConfigured} customModels={customModels} customModelFetchStatus={customModelFetchStatus} customModelFetchError={customModelFetchError} resources={resources} onClose={() => setSettingsOpen(false)} />}
      {permission && <PermissionDialog request={permission} />}
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
