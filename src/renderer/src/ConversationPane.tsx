import {
  AlertCircle,
  Bot,
  Brain,
  Check,
  Clock,
  Copy,
  ChevronDown,
  CircleStop,
  CodeXml,
  File,
  FileDiff,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  LoaderCircle,
  MessageCircle,
  MessageSquarePlus,
  PackageOpen,
  Pencil,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Share2,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Workflow,
  X,
  Zap,
  ClipboardList
} from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type {
  AccessMode,
  ChatMessage,
  PromptAttachment,
  QueuedMessage,
  RuntimeCommand,
  RuntimeSnapshot,
  SessionPaneSnapshot,
  SessionRunStatus,
  ThinkingLevel,
  ToolExecution,
  TurnTiming,
  WorkspaceFileSearchEntry
} from "../../shared/protocol";
import { sessionRunStatusLabels, thinkingLevelLabels, toolLabel } from "../../shared/locale";
import { CodeBlock, RichContent } from "./components/RichContent";
import { QuestionPanel } from "./components/QuestionPanel";
import { compactPath, extractMentionTokens, formatDuration, type Artifact } from "./lib/content";
import { contextUsageCacheLabel, contextUsagePercentLabel, contextUsageTone, contextUsageTooltip } from "./lib/context-usage";
import { actionTimelineSegments, actionTimelineStats, formatProcessDuration, type ActionTimelineSegment } from "./lib/action-timeline";
import { changedFilesForMessage, type ReplyChangedFile } from "./lib/changed-files";
import { groupAssistantMessages } from "./lib/chat-layout";
import { buildEditDiffs, editArgsSummary, languageFromPath, parseEditCallArgs, parseReadCallArgs, parseWriteCallArgs, writeArgsSummary, type EditCallPreview, type EditDiffBlock, type WriteCallPreview } from "./lib/tool-call-preview";
import { DiffView } from "./components/DiffView";
import { shareElementAsImage } from "./lib/share-image";
import { selectableCatalogModels } from "./lib/model-list";
import { currentQuestionRequest, useDesktopStore } from "./store";
import { PanelDock } from "./PanelDock";

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

/** 会话级指令（/compact、/plan）——发送时附加格子 sessionId 定位目标会话。 */
type SessionTargetCommand = Extract<RuntimeCommand, { type: "session.compact" } | { type: "session.planMode" }>;

type SlashCommand = {
  trigger: string;
  label: string;
  description: string;
} & (
  | { kind: "skill"; skillName: string }
  | { kind: "command"; command: SessionTargetCommand }
  | { kind: "new" }
);

/**
 * 会话区数据源：单窗口/焦点格直接复用主快照（RuntimeSnapshot 是
 * SessionPaneSnapshot 的超集），分屏中 parked 的格子读取 store.paneStates。
 */
export type PaneConversationData = RuntimeSnapshot | SessionPaneSnapshot;

const emptyPaneData: SessionPaneSnapshot = {
  thinkingLevel: "medium",
  busy: false,
  status: "",
  queuedMessages: [],
  messages: [],
  executions: []
};

function usePaneData(sessionId: string | undefined): PaneConversationData {
  const selector = useCallback((state: { snapshot: RuntimeSnapshot; paneStates: Record<string, SessionPaneSnapshot>; parkedPanels: Record<string, SessionPaneSnapshot> }): PaneConversationData => {
    if (sessionId === undefined || state.snapshot.sessionId === sessionId) return state.snapshot;
    if (state.paneStates[sessionId]) return state.paneStates[sessionId];
    // 焦点刚切走：该会话最近一份完整快照在 parkedPanels 里，主进程的
    // session.state 水合帧到达前先用它渲染（零闪烁）。多槽：三分屏里非
    // “上一任”的格子也能兜住，不会被误渲染成“正在载入会话”。
    if (state.parkedPanels[sessionId]) return state.parkedPanels[sessionId];
    return emptyPaneData;
  }, [sessionId]);
  return useDesktopStore(selector);
}

/** App 层主动写入输入框的通道（浏览器元素选择 / HTML 动作回填），路由到焦点格。 */
export interface PaneComposerApi {
  focus(): void;
  /** 在草稿末尾追加文本块；已选 Skill/编辑态一并复位。 */
  insertText(text: string): void;
}

/** 会话级草稿存取（App 层 Map 持有，格子 remount 后恢复）。 */
export interface PaneDraftStore {
  load(sessionId: string): string | undefined;
  save(sessionId: string, text: string): void;
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
    <article className="message message-assistant pending-response" data-role="assistant">
      <div className="message-avatar pi-avatar"><Bot size={17} /></div>
      <div className="message-body message-bubble pending-response-body">
        <div className="response-progress"><LoaderCircle size={14} className="spinning" /><span>{label}</span></div>
      </div>
      {timing && <TimingMeta timing={timing} now={now} />}
    </article>
  );
}

function ImageMessageBlock({ block }: { block: Extract<import("../../shared/protocol").MessageBlock, { type: "image" }> }): ReactNode {
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
/** 工具内容走 CodeBlock 语法高亮的字符上限；超过则退化为可截断的纯文本块。 */
const MAX_TOOL_PREVIEW_CHARS = 60_000;

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
function ToolCallDetails({ call, execution, streaming }: { call: Extract<import("../../shared/protocol").MessageBlock, { type: "tool-call" }>; execution: ToolExecution | undefined; streaming: boolean }): ReactNode {
  const running = execution?.status === "running" || (!execution && streaming);
  // 默认全部折叠：工具调用气泡初始收拢，程序不干预开合——运行中 / 已结束都不自动展开，
  // 长会话不会被一排展开的工具调用节点淹没；运行状态由 summary 的「运行中 · 转圈」提示承载。
  // 用户想看细节时手动点开，开合状态完全由用户控制（onToggle 记录）。
  const [open, setOpen] = useState(false);
  const args = execution?.args ?? call.arguments;
  const editPreview = useMemo(() => (call.name === "edit" ? parseEditCallArgs(args) : undefined), [call.name, args]);
  const writePreview = useMemo(() => (call.name === "write" ? parseWriteCallArgs(args) : undefined), [call.name, args]);
  const readPreview = useMemo(() => (call.name === "read" ? parseReadCallArgs(args) : undefined), [call.name, args]);
  const editDiffs = useMemo(() => (editPreview ? buildEditDiffs(editPreview.edits) : undefined), [editPreview]);
  const patch = execution?.status === "completed" ? execution.patch : undefined;
  const writeContent = writePreview && writePreview.content.length <= MAX_TOOL_PREVIEW_CHARS ? writePreview.content : undefined;
  const readContent = execution && execution.status === "completed" && readPreview && execution.output && execution.output.length <= MAX_TOOL_PREVIEW_CHARS ? execution.output : undefined;
  return (
    <details className="action-timeline-call" open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary className="action-timeline-call-summary">
        <strong>{toolLabel(call.name)}</strong>
        <span>{toolCallStatusLabel(execution, streaming)}{execution?.completedAt ? ` · ${formatDuration(execution.startedAt, execution.completedAt)}` : ""}</span>
        <ChevronDown size={12} className="action-timeline-call-chevron" />
      </summary>
      <div className="action-timeline-call-detail">
        {editPreview && <EditChangeSection preview={editPreview} diffs={editDiffs} patch={patch} />}
        {writePreview && (
          <div className="action-timeline-call-section">
            <span className="action-timeline-call-section-title">写入内容</span>
            <div className="action-timeline-call-meta">
              {writePreview.path && <span className="action-timeline-call-path" title={writePreview.path}>{compactPath(writePreview.path)}</span>}
              <span>{writePreview.content.length} 字符</span>
            </div>
            {writeContent ? <CodeBlock language={languageFromPath(writePreview.path) ?? ""} code={writeContent} /> : <pre className="action-timeline-call-code">{writePreview.content.length > MAX_TOOL_OUTPUT_CHARS ? `${writePreview.content.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…（内容过长，已截断显示）` : writePreview.content}</pre>}
          </div>
        )}
        <div className="action-timeline-call-section">
          <span className="action-timeline-call-section-title">调用指令</span>
          <pre className="action-timeline-call-code">{editPreview ? editArgsSummary(editPreview) : writePreview ? writeArgsSummary(writePreview) : formatToolArgs(args)}</pre>
        </div>
        <div className="action-timeline-call-section">
          <span className="action-timeline-call-section-title">输出</span>
          {execution?.output ? (readContent ? <CodeBlock language={languageFromPath(readPreview?.path) ?? ""} code={readContent} /> : <pre className="action-timeline-call-code">{truncateToolOutput(execution.output)}</pre>) : <span className="action-timeline-call-empty">{running ? "运行中…" : "（无输出）"}</span>}
        </div>
      </div>
    </details>
  );
}

/** `edit` 调用的人类可读变更视图：优先展示工具返回的统一 patch，否则按 edits 计算行级 diff。 */
function EditChangeSection({ preview, diffs, patch }: { preview: EditCallPreview; diffs: EditDiffBlock[] | undefined; patch: string | undefined }): ReactNode {
  return (
    <div className="action-timeline-call-section">
      <span className="action-timeline-call-section-title">变更</span>
      <div className="action-timeline-call-meta">
        {preview.path && <span className="action-timeline-call-path" title={preview.path}>{compactPath(preview.path)}</span>}
        <span>{preview.edits.length} 处编辑</span>
      </div>
      <div className="action-timeline-call-diff-scroll">
        {patch ? <DiffView patch={patch} /> : diffs?.map((block, index) => (
          <div className="action-timeline-edit-block" key={index}>
            {diffs.length > 1 && <span className="action-timeline-edit-block-label">变更 {index + 1}</span>}
            {block.lines ? (
              <pre className="diff-view">{block.lines.map((line, lineIndex) => <span className={line.type === "context" ? "diff-context" : `diff-${line.type}`} key={lineIndex}>{line.text || " "}{"\n"}</span>)}</pre>
            ) : (
              <pre className="action-timeline-call-code">…（变更区域过长，请展开查看调用指令）</pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 思考内容块：折叠时限制在固定高度内滚动输出，超出限高才出现展开按钮；
 * 点击展开后展示全文，再点收起恢复限高。流式输出期间文本变化会重新测量。
 */
function ThinkingBlock({ text, label }: { text: string; label: string }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return; // 展开时保持按钮状态，避免测量全高后误判为不溢出
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  return (
    <>
      <strong>{label}</strong>
      <p ref={bodyRef} className={`thinking-body${expanded ? " expanded" : ""}`}>{text}</p>
      {overflowing && (
        <button type="button" className="thinking-expand" data-control="thinking-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
    </>
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
              <div className={`action-timeline-node ${segment.type} ${stateClass}`} data-node-kind={segment.type} data-node-state={stateClass || undefined} key={segment.type === "tool-call" ? segment.call.id : `${segment.type}-${index}`}>
                <span className="action-timeline-node-icon">{actionTimelineIcon(segment, execution, processActive)}</span>
                <div className="action-timeline-node-content">
                  {segment.type === "thinking" ? <ThinkingBlock text={segment.text} label={thinkingLabel || "思考过程"} /> : segment.type === "tool-call" ? <ToolCallDetails call={segment.call} execution={execution} streaming={Boolean(message.streaming)} /> : <RichContent streaming={false} artifactPrefix={`${message.id}-process-${index}`} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{segment.text}</RichContent>}
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
        <span><PackageOpen size={14} /><strong>交付产物</strong><em>{files.length}</em></span>
        <span className="reply-files-toggle" aria-hidden="true" />
      </summary>
      <div className="reply-files-list">
        {files.map(({ relativePath, kind, execution }) => {
          const name = relativePath.split("/").at(-1) ?? relativePath;
          const hasDiff = Boolean(execution.patch);
          const isImage = kind === "image";
          return (
            <div className="reply-file-row" key={relativePath}>
              <button
                type="button"
                className={isImage ? "reply-file-open reply-file-open-image" : "reply-file-open"}
                title={isImage ? `预览图片 ${relativePath}` : `预览 ${relativePath}`}
                aria-label={`预览 ${name}`}
                onClick={() => onOpenFile(relativePath)}
              >
                {isImage ? <ImageIcon size={14} /> : <File size={14} />}
                <span className="reply-file-text"><strong>{name}</strong><small>{relativePath}</small></span>
              </button>
              <span className="reply-file-actions">
                {!isImage && <button type="button" className="reply-file-action" title={hasDiff ? `查看 ${relativePath} 变更` : "暂无变更记录"} aria-label={`查看 ${name} 变更`} disabled={!hasDiff} onClick={() => onOpenDiff(execution)}><FileDiff size={14} /></button>}
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
    const images = message.blocks.filter((block): block is Extract<import("../../shared/protocol").MessageBlock, { type: "image" }> => block.type === "image");
    return (
      <article className="message message-extension" data-role="extension">
        <div className="message-avatar extension-avatar"><Puzzle size={16} /></div>
        <div className="message-body extension-message-callout">
          <strong>{message.extension?.customType || "扩展消息"}</strong>
          {images.length > 0 && <div className="image-message-list">{images.map((block, index) => <ImageMessageBlock key={`${message.id}-extension-image-${index}`} block={block} />)}</div>}
          {text && <RichContent streaming={false} artifactPrefix={`${message.id}-extension`} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction}>{text}</RichContent>}
        </div>
      </article>
    );
  }

  if (message.role === "user") {
    const images = message.blocks.filter((block): block is Extract<import("../../shared/protocol").MessageBlock, { type: "image" }> => block.type === "image");
    // @文件引用在气泡里渲染为 chip 行（同 skill badge），正文去掉路径尾巴；
    // 复制/编辑仍用原始全文，重新发送后同样回环成 chip。
    const { mentions, body } = extractMentionTokens(text);
    return (
      <article className="message message-user" data-role="user">
        <div className="message-avatar user-avatar">我</div>
        <div className="message-body message-bubble">{message.skill && <div className="message-skill-badge"><Puzzle size={13} /><strong>{message.skill.name}</strong></div>}{mentions.length > 0 && <div className="message-mention-badges">{mentions.map((token) => <span className="message-skill-badge" key={token} title={token}><File size={13} /><strong>{token}</strong></span>)}</div>}{images.length > 0 && <div className="image-message-list">{images.map((block, index) => <ImageMessageBlock key={`${message.id}-image-${index}`} block={block} />)}</div>}{body && <p className="user-text">{body}</p>}{!isControlMessage && <div className="message-actions"><button type="button" data-control="copy" title="复制" aria-label="复制用户消息" onClick={() => onCopy(message)}><Copy size={13} /></button><button type="button" data-control="edit" title="重新编辑" aria-label="重新编辑用户消息" onClick={() => onEdit(message)}><Pencil size={13} /></button></div>}</div>
      </article>
    );
  }

  return (
    <article className="message message-assistant" data-role="assistant">
      <div className="message-avatar pi-avatar"><Bot size={17} /></div>
      <div className="message-body message-bubble">
        <div className="assistant-share-content" ref={shareTargetRef}>
          <ActionTimeline message={message} executions={executions} turnActive={turnActive} showThinking={showThinking} thinkingLabel={hiddenThinkingLabel} onOpenArtifact={onOpenArtifact} onHtmlAction={onHtmlAction} timing={timing} now={now} />
          {message.error && <p className="inline-error"><AlertCircle size={15} />{message.error}</p>}
        </div>
        {changedFiles.length > 0 && <ChangedFilesPanel files={changedFiles} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />}
        {!isControlMessage && !message.streaming && !busy && <div className="message-actions"><button type="button" data-control="regenerate" title="重新生成" aria-label="重新生成回复" onClick={() => onRegenerate(message)}><RefreshCw size={13} /></button><button type="button" data-control="copy" title="复制" aria-label="复制 AI 回复" onClick={() => onCopy(message)}><Copy size={13} /></button>{hasShareableContent && <button type="button" data-control="share" title={sharing ? "正在生成图片" : shared ? "已复制图片" : "分享图片"} aria-label={sharing ? "正在生成回复图片" : shared ? "回复图片已复制" : "分享 AI 回复图片"} disabled={sharing} onClick={() => void share()}>{sharing ? <LoaderCircle size={13} className="spinning" /> : shared ? <Check size={13} /> : <Share2 size={13} />}</button>}</div>}
      </div>
      {timing && (isControlMessage ? <CompactTimingMeta timing={timing} now={now} /> : <TimingMeta timing={timing} now={now} />)}
    </article>
  );
});

export interface ConversationPaneProps {
  /** 本格绑定的会话 id；单窗口空态（未开工作区）为 undefined。 */
  sessionId: string | undefined;
  /** 分屏紧凑模式：渲染格子头部。 */
  compact?: boolean;
  /** 是否焦点格（决定 PanelDock 渲染与主题态）。 */
  focused?: boolean;
  maximized?: boolean;
  /** 分屏头部展示的会话标题（App 从 sessions 列表解析）。 */
  title?: string;
  /** 侧栏圆点语义（分屏头部展示运行状态）。 */
  runStatus?: SessionRunStatus;
  /** 任务/记忆面板只在焦点格（单窗口）渲染。 */
  showDock?: boolean;
  onFocus?(): void;
  onClose?(): void;
  onToggleMaximize?(): void;
  /** 会话级 /new：单窗口 = App 新建话题；分屏 = 替换本格。 */
  onNewSession(): Promise<void> | void;
  /** App 层主动写入通道注册（browser-pick / html action 路由到焦点格）。 */
  registerComposerApi?(api: PaneComposerApi | undefined, sessionId: string | undefined): void;
  draftStore?: PaneDraftStore;
  onOpenArtifact(artifact: Artifact): void;
  onOpenFile(relativePath: string, workspace?: string): void;
  onOpenDiff(execution: ToolExecution): void;
  onOpenPlanDetail(detail: string): void;
  /** 会话操作失败提示（App 层 toast）。传 undefined 清除。 */
  onActionError(message?: string): void;
}

/**
 * 单个会话区（时间线 + 提问面板 + 完整输入框）。单窗口与分屏格子共用：
 * 通过 sessionId 订阅自己的数据切片（焦点格 = 主快照，parked 格 =
 * store.paneStates），所有发送类命令都携带本格 sessionId，多个格子并发
 * 运行互不干扰。
 */
export function ConversationPane({
  sessionId,
  compact = false,
  focused = false,
  maximized = false,
  title,
  runStatus,
  showDock = false,
  onFocus,
  onClose,
  onToggleMaximize,
  onNewSession,
  registerComposerApi,
  draftStore,
  onOpenArtifact,
  onOpenFile,
  onOpenDiff,
  onOpenPlanDetail,
  onActionError
}: ConversationPaneProps): ReactNode {
  const data = usePaneData(sessionId);
  const settings = useDesktopStore((state) => state.settings);
  const models = useDesktopStore((state) => state.models);
  const providers = useDesktopStore((state) => state.providers);
  const resources = useDesktopStore((state) => state.resources);
  const ready = useDesktopStore((state) => state.ready);
  const questions = useDesktopStore((state) => state.questions);
  const question = currentQuestionRequest(questions, data.sessionId);
  const showThinking = settings.appearance.showThinking;

  const [input, setInput] = useState(() => (sessionId !== undefined ? draftStore?.load(sessionId) ?? "" : ""));
  const [selectedSkill, setSelectedSkill] = useState<string>();
  const [editingMessageTimestamp, setEditingMessageTimestamp] = useState<number>();
  // 本地待回复计时必须绑定发起回合时的会话：跨会话/跨格子同时执行时 busy 恒为
  // true，按 busy 清理的 effect 不会触发；绑定 sessionId 后格子间自动失效。
  const [localTurn, setLocalTurn] = useState<{ startedAt: number; sessionId: string | undefined }>();
  const [attachments, setAttachments] = useState<PromptAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [accessModeMenuOpen, setAccessModeMenuOpen] = useState(false);
  const [composerMenu, setComposerMenu] = useState<"model" | "thinking">();
  const [slashIndex, setSlashIndex] = useState(0);
  // @ 提及：tokenStart 为输入串中 @ 的下标；Esc 后按 token 记忆“已关闭”，
  // 继续输入（token 变化）才重新弹出。
  const [mention, setMention] = useState<{ query: string; tokenStart: number }>();
  const [mentionResults, setMentionResults] = useState<WorkspaceFileSearchEntry[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissedToken, setMentionDismissedToken] = useState<string>();
  // @ 选中的文件引用：与 skill chip 同样的气泡交互，发送时拼回 @路径。
  const [mentionedFiles, setMentionedFiles] = useState<WorkspaceFileSearchEntry[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const accessModeMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  // 默认粘底：单窗口切会话、分屏格子打开都直接位于底部（最新消息），保持与
  // 单窗口一致；用户上滚历史时 stickToBottom 置假、停止跟随，滚到底即恢复。
  const stickToBottomRef = useRef(true);
  // 初始 undefined：任何新挂载（分屏格子初次、分屏回归单窗口、应用启动）首次都
  // 按「会话切换」处理，直接 auto 瞬跳到底部（无平滑滚动动画）。若初始等于 sessionId，
  // 新挂载会走 idle 的 smooth 滚动，正是「从顶滚到底部」动画的来源。
  const previousSessionIdRef = useRef<string | undefined>(undefined);
  const previousDraftSessionIdRef = useRef<string | undefined>(sessionId);
  const inputRef = useRef(input);
  inputRef.current = input;
  const selectedModel = data.model ? `${data.model.provider}/${data.model.id}` : "";
  const availableModels = useMemo(() => selectableCatalogModels(models).filter((model) => model.configured), [models]);
  const selectedModelOption = availableModels.find((model) => `${model.provider}/${model.id}` === selectedModel);
  const visionFallbackAvailable = Boolean(settings.vision?.enabled && settings.vision.provider && settings.vision.model
    && models.some((item) => item.provider === settings.vision?.provider && item.id === settings.vision?.model && item.configured && item.imageInput && item.enabled !== false));
  const modelAcceptsImages = Boolean(models.find((item) => `${item.provider}/${item.id}` === selectedModel)?.imageInput);
  const displayMessages = useMemo(() => groupAssistantMessages(data.messages), [data.messages]);
  const latestAssistantIndex = useMemo(() => [...displayMessages].reverse().findIndex((message) => message.role === "assistant"), [displayMessages]);
  const latestAssistantMessageIndex = latestAssistantIndex < 0 ? -1 : displayMessages.length - 1 - latestAssistantIndex;
  const localTiming = localTurn !== undefined && localTurn.sessionId === data.sessionId ? { startedAt: localTurn.startedAt } satisfies TurnTiming : undefined;
  const localTurnPending = localTiming !== undefined && (data.turnTiming === undefined || data.turnTiming.startedAt < localTiming.startedAt);
  const activeTurnTiming = localTurnPending ? localTiming : data.turnTiming;
  const isGenerating = localTurnPending || Boolean(data.busy && data.turnTiming && data.turnTiming.completedAt === undefined);
  const now = useElapsedNow(isGenerating);
  // The avatar'd pending bubble shows from the moment a turn starts (including
  // the local-pending window before the snapshot round-trips) until this
  // turn's assistant reply actually renders; afterwards the plain inline
  // progress row continues under the existing assistant bubble.
  const lastDisplayMessage = displayMessages[displayMessages.length - 1];
  const assistantBubbleVisible = !localTurnPending && lastDisplayMessage?.role === "assistant" && !lastDisplayMessage.control;
  // 耗时元信息只在气泡外出现：回合进行中由底部行内进度（response-progress-inline
  // / PendingResponse 的 caption）展示实时耗时；回合结束后在最新一条回复的气泡
  // 下方展示定格值，不再嵌进气泡内容（用户反馈：气泡内不应出现回答耗时/总耗时）。
  const showTurnTimingOnLatest = Boolean(data.turnTiming && !isGenerating);
  const canSubmit = Boolean(data.workspace && (input.trim() || attachments.length > 0 || selectedSkill || mentionedFiles.length > 0) && data.model);
  const workingLabel = `${title ?? "Pi"}正在努力输出中……`;
  let composerPlaceholder = "请先打开一个项目";
  if (data.workspace) composerPlaceholder = selectedSkill ? "输入任务要求" : "让 Pi 检查、修改或运行这个项目，@ 可引用文件";
  if (data.workspace && data.busy) composerPlaceholder = "连续输入以排队后续修改";

  // —— 斜杠指令 ——
  // Skill 的 trigger 仍是 /skill:<名字>（选中后回填用），但候选框里只展示裸名，
  // 匹配时同时接受 /sk 前缀与裸名前缀两种输入方式。
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const fixed: SlashCommand[] = [
      { trigger: "/compact", label: "/compact", description: "压缩当前会话上下文", kind: "command", command: { type: "session.compact" } },
      { trigger: "/new", label: "/new", description: "开启新话题", kind: "new" },
      { trigger: "/plan", label: "/plan", description: data.planMode ? "退出计划模式" : "进入计划模式：先出计划，批准后实施", kind: "command", command: { type: "session.planMode", enabled: !data.planMode } }
    ];
    const skills: SlashCommand[] = resources.skills.filter((skill) => skill.enabled).map((skill) => ({
      trigger: `/skill:${skill.name}`,
      label: skill.name,
      description: skill.description || "调用 Skill",
      kind: "skill",
      skillName: skill.name
    }));
    return [...fixed, ...skills];
  }, [resources.skills, data.planMode]);

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
    return slashCommands.filter((cmd) => {
      const trigger = cmd.trigger.toLowerCase();
      if (trigger.startsWith(slashToken) && trigger !== slashToken) return true;
      // 裸名匹配：/design 也能命中 /skill:design-xxx（去掉开头的 / 再比对）
      if (cmd.kind === "skill") return cmd.skillName.toLowerCase().startsWith(slashToken.slice(1));
      return false;
    });
  }, [slashToken, slashCommands]);

  // 候选框按「会话指令 / 技能」分组渲染；flatIndex 保持键盘导航指向扁平 slashMatches。
  const slashGroups = useMemo(() => {
    const groups = [
      { key: "command", title: "会话指令", items: new Array<{ cmd: SlashCommand; flatIndex: number }>() },
      { key: "skill", title: "技能", items: new Array<{ cmd: SlashCommand; flatIndex: number }>() }
    ];
    slashMatches.forEach((cmd, flatIndex) => {
      groups.find((group) => group.key === cmd.kind)?.items.push({ cmd, flatIndex });
    });
    return groups.filter((group) => group.items.length > 0);
  }, [slashMatches]);

  const slashOpen = slashMatches.length > 0;
  const activeSlashIndex = Math.min(slashIndex, slashMatches.length - 1);

  useEffect(() => {
    if (slashIndex > slashMatches.length - 1) setSlashIndex(Math.max(0, slashMatches.length - 1));
  }, [slashMatches.length, slashIndex]);

  // —— @ 提及工作区文件 ——
  const mentionToken = mention ? `${mention.tokenStart}:${mention.query}` : "";
  const mentionOpen = Boolean(mention && data.workspace && mentionToken !== mentionDismissedToken && mentionResults.length > 0);
  const activeMentionIndex = Math.min(mentionIndex, mentionResults.length - 1);

  useEffect(() => {
    if (mentionIndex > mentionResults.length - 1) setMentionIndex(Math.max(0, mentionResults.length - 1));
  }, [mentionResults.length, mentionIndex]);

  // 输入被外部清空/替换（发送、编辑消息回填等）后，失效的 tokenStart 需要清理，
  // 否则菜单会挂在错误的插入位置上。
  useEffect(() => {
    if (mention && (mention.tokenStart >= input.length || input[mention.tokenStart] !== "@")) setMention(undefined);
  }, [input, mention]);

  useEffect(() => {
    const workspace = data.workspace;
    if (!mention || !workspace || mentionToken === mentionDismissedToken) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.piDesktop.searchWorkspaceFiles(workspace, mention.query)
        .then((result) => { if (!cancelled) setMentionResults(result.entries); })
        .catch(() => { if (!cancelled) setMentionResults([]); });
    }, 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [mention, mentionToken, mentionDismissedToken, data.workspace]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mentionToken]);

  // 菜单关闭时清空旧结果，避免下次弹开瞬间闪现上一次的列表；
  // 打开状态下连续输入时保留旧列表直到新结果到达（标准自动补全体验）。
  useEffect(() => {
    if (!mention) setMentionResults([]);
  }, [mention]);

  // composer 高度变量写入自己的 parent（每格独立，QuestionPanel 锚定用）。
  useEffect(() => {
    if (!ready) return;
    const composer = composerRef.current;
    const pane = composer?.parentElement;
    if (!composer || !pane) return;
    const update = (): void => {
      const height = composer.getBoundingClientRect().height;
      pane.style.setProperty("--composer-space", `${height + 40}px`);
      // 提问面板锚定在输入栏正上方，需要输入栏的精确高度。
      pane.style.setProperty("--composer-height", `${height}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      pane.style.removeProperty("--composer-space");
      pane.style.removeProperty("--composer-height");
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
    const sessionChanged = previousSessionIdRef.current !== sessionId;
    previousSessionIdRef.current = sessionId;
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
    // 分屏格子（compact）数据更新一律瞬跳到底（auto）：它打开/水合时自带一次大的
    // 平滑滚动，正是“从头滚到尾部”动画的来源；单窗口 idle 则保留 smooth。
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: data.busy || compact ? "auto" : "smooth" });
  }, [data.messages, data.busy, data.sessionId, sessionId, compact]);

  useEffect(() => {
    if (!data.busy) setLocalTurn(undefined);
  }, [data.busy]);

  // 会话切换：草稿属于会话（存/取互逆）；Skill 选择与编辑态复位（沿用单窗口语义）。
  // 独立 ref：滚动 effect（useLayoutEffect 先执行）也写 previousSessionIdRef，
  // 共用会让这里的“已切换”判断永远命中而跳过草稿存取。
  useEffect(() => {
    if (previousDraftSessionIdRef.current === sessionId) return;
    const previous = previousDraftSessionIdRef.current;
    previousDraftSessionIdRef.current = sessionId;
    if (previous !== undefined && draftStore) draftStore.save(previous, inputRef.current);
    setInput(sessionId !== undefined ? draftStore?.load(sessionId) ?? "" : "");
    setSelectedSkill(undefined);
    setEditingMessageTimestamp(undefined);
  }, [sessionId, draftStore]);

  // 卸载时保存草稿。
  useEffect(() => {
    const store = draftStore;
    const currentSessionId = sessionId;
    return () => {
      if (store && currentSessionId !== undefined) store.save(currentSessionId, inputRef.current);
    };
  }, [draftStore, sessionId]);

  // 草稿持续落盘（ref 写入，不触发 App 重渲染）。
  useEffect(() => {
    if (sessionId !== undefined) draftStore?.save(sessionId, input);
  }, [input, sessionId, draftStore]);

  // 注册 App 层主动写入通道。
  useEffect(() => {
    if (!registerComposerApi) return;
    const focus = (): void => {
      window.setTimeout(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }, 0);
    };
    const api: PaneComposerApi = {
      focus,
      insertText: (text) => {
        setInput((current) => current.trim() ? `${current.trim()}\n${text}` : text);
        setSelectedSkill(undefined);
        setEditingMessageTimestamp(undefined);
        focus();
      }
    };
    registerComposerApi(api, sessionId);
    return () => registerComposerApi(undefined, sessionId);
  }, [registerComposerApi, sessionId]);

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
    if (composerMenu !== "model") return;
    const active = modelMenuRef.current?.querySelector<HTMLButtonElement>("button.active");
    active?.scrollIntoView({ block: "nearest" });
  }, [composerMenu]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const text = input.trim();
    if (!text && attachments.length === 0 && !selectedSkill && mentionedFiles.length === 0) return;
    // 客户端执行的固定指令：不透传给 Pi（会话层会当噪声），直接发协议命令。
    // /new 在生成中也可用：新会话独立于正在运行的旧会话。
    if (!selectedSkill && text === "/new") {
      try {
        await onNewSession();
        setInput("");
        setAttachments([]);
        setMentionedFiles([]);
        setSelectedSkill(undefined);
        setEditingMessageTimestamp(undefined);
      } catch (error) {
        onActionError(error instanceof Error ? error.message : "新建话题失败");
      }
      return;
    }
    if (!selectedSkill && (text === "/compact" || text.startsWith("/compact "))) {
      const instructions = text.startsWith("/compact ") ? text.slice("/compact ".length).trim() || undefined : undefined;
      try {
        await window.piDesktop.send({ type: "session.compact", instructions, sessionId: data.sessionId });
        setInput("");
        setAttachments([]);
        setEditingMessageTimestamp(undefined);
      } catch (error) {
        onActionError(error instanceof Error ? error.message : "压缩上下文失败");
      }
      return;
    }
    const skillMatch = selectedSkill ? undefined : text.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/u);
    // @ 提及在发送时拼回文本末尾——模型拿到的是可读的完整上下文。
    const composedText = [text, ...mentionedFiles.map((entry) => `@${entry.relativePath}`)].filter(Boolean).join("\n\n");
    const skillName = selectedSkill ?? skillMatch?.[1];
    const skillInstructions = selectedSkill ? composedText || undefined : skillMatch?.[2]?.trim() || undefined;
    if (attachments.some((item) => item.kind === "image") && !modelAcceptsImages && !visionFallbackAvailable) { setAttachmentError("当前模型不支持图片输入，请先切换多模态模型，或在设置的模型服务中启用视觉识别"); return; }
    // 生成中回车不丢弃输入：进入输入框上方的待发送队列，默认在本轮回复
    // 结束后作为下一轮消息发出，可编辑、立即发送或删除。
    if (data.busy) {
      if (editingMessageTimestamp !== undefined) return; // 编辑重发要求会话空闲，不排队
      try {
        await window.piDesktop.send({ type: "session.queue.add", text: skillName ? skillInstructions ?? "" : composedText, skillName, attachments, sessionId: data.sessionId });
        setInput("");
        setSelectedSkill(undefined);
        setAttachments([]);
        setMentionedFiles([]);
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : "消息排队失败");
      }
      return;
    }
    setLocalTurn({ startedAt: Date.now(), sessionId: data.sessionId });
    try {
      if (editingMessageTimestamp !== undefined) {
        await window.piDesktop.send({ type: "session.regenerate", text: composedText, timestamp: editingMessageTimestamp, skillName, attachments, sessionId: data.sessionId });
      } else if (skillName) {
        await window.piDesktop.send({ type: "session.skill", name: skillName, instructions: skillInstructions, attachments, sessionId: data.sessionId });
      } else {
        await window.piDesktop.send({ type: "session.prompt", text: composedText, attachments, sessionId: data.sessionId });
      }
      setInput("");
      setSelectedSkill(undefined);
      setAttachments([]);
      setMentionedFiles([]);
      setEditingMessageTimestamp(undefined);
    } catch (error) {
      setLocalTurn(undefined);
      setAttachmentError(error instanceof Error ? error.message : "附件发送失败");
    }
  }

  const copyMessage = useCallback(async (message: ChatMessage): Promise<void> => {
    const text = messageText(message);
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      onActionError("复制失败，请检查剪贴板权限");
    }
  }, [onActionError]);

  const shareMessage = useCallback(async (_message: ChatMessage, target: HTMLElement): Promise<void> => {
    onActionError(undefined);
    try {
      await shareElementAsImage(target);
    } catch (error) {
      onActionError(error instanceof Error ? `分享失败：${error.message}` : "分享失败，请重试");
      throw error;
    }
  }, [onActionError]);

  const editMessage = useCallback((message: ChatMessage): void => {
    setInput(messageText(message));
    setSelectedSkill(message.skill?.name);
    setAttachments([]);
    setMentionedFiles([]);
    setEditingMessageTimestamp(message.timestamp);
    onActionError(undefined);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [onActionError]);

  /** 编辑排队消息：文本回填输入框（Skill 消息回填展开后的提示词），同时从队列移除。 */
  function editQueuedMessage(item: QueuedMessage): void {
    setInput(item.text);
    setSelectedSkill(undefined);
    setAttachments([]);
    setMentionedFiles([]);
    setEditingMessageTimestamp(undefined);
    removeQueuedMessage(item);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }

  /** 立即发送：升级为 steering，AI 在当前回合下一次模型调用前就能读到，不打断正在执行的工具。 */
  function sendQueuedMessageNow(item: QueuedMessage): void {
    void window.piDesktop.send({ type: "session.queue.sendNow", kind: item.kind, index: item.index, text: item.text, sessionId: data.sessionId }).catch((error) => {
      onActionError(error instanceof Error ? error.message : "立即发送失败");
    });
  }

  function removeQueuedMessage(item: QueuedMessage): void {
    void window.piDesktop.send({ type: "session.queue.remove", kind: item.kind, index: item.index, text: item.text, sessionId: data.sessionId }).catch((error) => {
      onActionError(error instanceof Error ? error.message : "移除排队消息失败");
    });
  }

  function stopGeneration(): void {
    // 先取队列再发中断：主进程 abort 会清空队列，这里把文本回填输入框供编辑
    // 重发；输入框已有草稿时追加在草稿之后，不丢内容。
    const pending = data.queuedMessages;
    void window.piDesktop.send({ type: "session.abort", sessionId: data.sessionId }).catch((error) => {
      onActionError(error instanceof Error ? error.message : "停止失败");
    });
    if (pending.length > 0) setInput((current) => current.trim() ? `${current}\n\n${pending.map((item) => item.text).join("\n\n")}` : pending.map((item) => item.text).join("\n\n"));
  }

  // Latest data ref so regenerateMessage keeps a stable identity instead of
  // rebuilding on every streaming frame — rebuilding it would hand a new
  // onRegenerate to every MessageView and bust their memo during streaming.
  const latestDataRef = useRef(data);
  latestDataRef.current = data;
  const regenerateMessage = useCallback(async (message: ChatMessage): Promise<void> => {
    const { busy, messages } = latestDataRef.current;
    if (busy) return;
    const index = messages.findIndex((item) => item.id === message.id);
    const previousUser = index > 0 ? [...messages.slice(0, index)].reverse().find((item) => item.role === "user") : undefined;
    const text = previousUser ? messageText(previousUser) : "";
    if (!text && !previousUser?.skill) return;
    setLocalTurn({ startedAt: Date.now(), sessionId: latestDataRef.current.sessionId });
    try {
      await window.piDesktop.send({ type: "session.regenerate", text, timestamp: previousUser?.timestamp, skillName: previousUser?.skill?.name, sessionId: latestDataRef.current.sessionId });
    } catch (error) {
      setLocalTurn(undefined);
      onActionError(error instanceof Error ? error.message : "重新生成失败");
    }
  }, [onActionError]);

  async function addAttachments(): Promise<void> {
    let selected: PromptAttachment[];
    try {
      selected = await window.piDesktop.chooseAttachments(data.workspace);
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
    const accepted: PromptAttachment[] = [];
    for (const file of Array.from(files).slice(0, remaining)) {
      if (file.size > 20 * 1024 * 1024) { setAttachmentError(`${file.name} 超过 20 MB 限制`); continue; }
      const isImage = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type);
      if (isImage) {
        const data = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? ""); reader.readAsDataURL(file); });
        accepted.push({ kind: "image", name: file.name, mimeType: file.type, size: file.size, data });
      } else if ((file as File & { path?: string }).path) {
        const path = (file as File & { path: string }).path;
        if (data.workspace) {
          const root = data.workspace.replace(/[\\/]+$/u, "").replaceAll("\\", "/");
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
    // 部分来源的图片只出现在 items 里（files 为空），用 getAsFile 补齐。
    const pastedFiles = files.length ? files : Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((item): item is File => item !== null);
    if (pastedFiles.length) { event.preventDefault(); void addLocalFiles(pastedFiles); return; }
    // 无文件也无文本（微信/QQ 截图、浏览器“复制图片”只写位图格式）：交给主进程
    // 读系统剪贴板兜底，同时拦截原生粘贴，避免系统弹“不支持图片插入”提示。
    if (!event.clipboardData.getData("text/plain").trim()) {
      event.preventDefault();
      void pasteClipboardImage();
    }
  }

  async function pasteClipboardImage(): Promise<void> {
    try {
      const image = await window.piDesktop.readClipboardImage();
      if (!image?.data) return;
      const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0));
      if (bytes.byteLength === 0) return;
      const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      // lucide-react 的 File 图标遮蔽了 DOM 构造器，这里走 window.File。
      const file = new window.File([bytes], `剪贴板图片 ${stamp}.png`, { type: "image/png" });
      await addLocalFiles([file]);
    } catch {
      /* 剪贴板不可读时保持静默，等价于无图可贴 */
    }
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
      setMentionedFiles([]);
      setSlashIndex(0);
      window.setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }
    if (command.kind === "new") {
      setSelectedSkill(undefined);
      setInput("");
      setAttachments([]);
      setMentionedFiles([]);
      setSlashIndex(0);
      void onNewSession();
      return;
    }
    if (data.busy) return;
    setSelectedSkill(undefined);
    setInput("");
    setAttachments([]);
    setMentionedFiles([]);
    setSlashIndex(0);
    void window.piDesktop.send({ ...command.command, sessionId: data.sessionId }).catch((error) => {
      onActionError(error instanceof Error ? error.message : "指令执行失败");
    });
  }

  /** 从光标位置反推 @token：@ 必须位于行首或空白之后，避免误伤邮箱类文本。 */
  function updateMentionFromCaret(target: HTMLTextAreaElement): void {
    const caret = target.selectionStart ?? 0;
    const match = /(?:^|\s)@([^\s@]*)$/u.exec(target.value.slice(0, caret));
    if (!match) {
      setMention(undefined);
      return;
    }
    const query = match[1]!;
    setMention({ query, tokenStart: caret - query.length - 1 });
  }

  function applyMention(entry: WorkspaceFileSearchEntry): void {
    const textarea = textareaRef.current;
    if (!textarea || !mention) return;
    const caret = textarea.selectionStart ?? input.length;
    if (caret < mention.tokenStart || input[mention.tokenStart] !== "@") return;
    // 目录以 / 结尾且不补空格：token 未断开，菜单继续列出该目录的子级，可逐层钻取。
    if (entry.kind === "directory") {
      const insert = `${entry.relativePath}/`;
      const nextValue = `${input.slice(0, mention.tokenStart)}${insert}${input.slice(caret)}`;
      const nextCaret = mention.tokenStart + insert.length;
      setInput(nextValue);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(nextCaret, nextCaret);
      });
      setMention({ query: insert, tokenStart: mention.tokenStart });
      return;
    }
    // 文件：从文本中摘除整个 @token，转为输入框内的引用 chip；
    // 发送时再把 @相对路径拼回 prompt，文本里不留痕迹。
    const nextValue = `${input.slice(0, mention.tokenStart)}${input.slice(caret)}`;
    setInput(nextValue);
    setMentionedFiles((current) => current.some((item) => item.relativePath === entry.relativePath) ? current : [...current, entry]);
    setMention(undefined);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(mention.tokenStart, mention.tokenStart);
    });
  }

  function handleComposerKey(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // IME 组合期（拼音候选、回车上屏）不劫持按键，避免选词被菜单吞掉。
    if (mentionOpen && !event.nativeEvent.isComposing) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((current) => (current + 1) % mentionResults.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex((current) => (current - 1 + mentionResults.length) % mentionResults.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        const selected = mentionResults[activeMentionIndex];
        if (selected) applyMention(selected);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionDismissedToken(mentionToken);
        return;
      }
    }
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
    await window.piDesktop.send({ type: "model.select", provider: value.slice(0, slash), id: value.slice(slash + 1), sessionId: data.sessionId });
  }

  /** 计划模式是独立于访问模式的协作轴：下拉项只做开关入口，不写 settings。 */
  function togglePlanMode(): void {
    setAccessModeMenuOpen(false);
    setComposerMenu(undefined);
    void window.piDesktop.send({ type: "session.planMode", enabled: !data.planMode, sessionId: data.sessionId }).catch((error) => {
      onActionError(error instanceof Error ? error.message : "计划模式切换失败");
    });
  }

  async function selectAccessMode(value: AccessMode): Promise<void> {
    setAccessModeMenuOpen(false);
    setComposerMenu(undefined);
    if (value === settings.accessMode) return;
    const previousSettings = settings;
    const nextSettings = { ...settings, accessMode: value };
    useDesktopStore.setState({ settings: nextSettings });
    try {
      await window.piDesktop.send({ type: "settings.save", settings: { model: nextSettings.model, thinkingLevel: nextSettings.thinkingLevel, accessMode: value, appearance: nextSettings.appearance, browser: nextSettings.browser } });
    } catch (error) {
      useDesktopStore.setState({ settings: previousSettings });
      onActionError(error instanceof Error ? error.message : "访问模式切换失败");
    }
  }

  async function selectThinkingLevel(level: ThinkingLevel): Promise<void> {
    setComposerMenu(undefined);
    await window.piDesktop.send({ type: "thinking.select", level, sessionId: data.sessionId });
  }

  // 分屏格子的会话数据未水合（session.state 未到）时短暂出现：占位而不是
  // 误渲染“打开一个项目”落地页——格子必然绑定已有会话，只是数据在路上。
  const awaitingHydration = !data.workspace && sessionId !== undefined;

  // 根级主题状态 data-ui-attachments 由焦点格投影（主题契约：语义 = 焦点格
  // 输入框有附件）；非焦点格不触碰，焦点切换时 cleanup + 重新投影自然交接。
  useEffect(() => {
    if (!focused) return;
    const root = document.documentElement;
    if (attachments.length > 0) root.setAttribute("data-ui-attachments", "");
    else root.removeAttribute("data-ui-attachments");
    return () => root.removeAttribute("data-ui-attachments");
  }, [focused, attachments.length]);

  /** 气泡内 HTML 动作回填：文本追加进本格草稿，已选 Skill/编辑态复位。 */
  const handleHtmlAction = useCallback((text: string): void => {
    setInput((current) => current.trim() ? `${current.trim()}\n${text}` : text);
    setSelectedSkill(undefined);
    setEditingMessageTimestamp(undefined);
    onActionError(undefined);
  }, [onActionError]);

  async function openWorkspace(): Promise<void> {
    const path = await window.piDesktop.chooseWorkspace();
    if (path) await window.piDesktop.send({ type: "workspace.open", path });
  }

  const headerTiming = isGenerating && activeTurnTiming ? formatDuration(activeTurnTiming.startedAt, now) : undefined;

  return (
    <section className={`conversation-pane${compact ? " pane-compact" : ""}`} data-pane="conversation" data-pane-active={focused || undefined} onPointerDownCapture={onFocus ? (event) => {
      // 关闭按钮点击不应先聚焦激活该格：关闭动作与「点击即聚焦」解耦。
      // 否则关闭非焦点格会先 focusPane（异步 session.open 激活它）再 removePane，
      // 产生两次激活竞态，用户会感知为「关错格」。最大化按钮仍要聚焦（用户想专注看它）。
      if ((event.target as Element).closest('[data-control="pane-close"]')) return;
      onFocus();
    } : undefined}>
      {compact && (
        <header className="split-pane-header">
          <span className="split-pane-title" title={title ?? data.sessionId ?? ""}>
            {data.busy
              ? <LoaderCircle size={13} className="spinning split-pane-status-icon" />
              : runStatus
                ? <i className={`session-status-dot ${runStatus}`} title={sessionRunStatusLabels[runStatus]} aria-label={sessionRunStatusLabels[runStatus]!} />
                : <MessageCircle size={13} className="split-pane-status-icon" />}
            <strong>{title ?? "会话"}</strong>
            {data.busy && <small className="split-pane-status-text">{data.status}{headerTiming ? ` · ${headerTiming}` : ""}</small>}
          </span>
          <span className="split-pane-actions">
            <button type="button" data-control="pane-maximize" title={maximized ? "还原分屏" : "最大化此会话"} aria-label={maximized ? "还原分屏" : "最大化此会话"} disabled={!onToggleMaximize} onClick={onToggleMaximize}>{maximized ? <CodeXml size={13} /> : <Layers size={13} />}</button>
            <button type="button" data-control="pane-close" title="关闭此分屏" aria-label="关闭此分屏" disabled={!onClose} onClick={onClose}><X size={13} /></button>
          </span>
        </header>
      )}
      {showDock && <PanelDock />}
      <div className="timeline" data-pane="timeline" ref={timelineRef}>
        {awaitingHydration ? (
          <div className="empty-conversation" data-pane="landing"><div className="empty-icon"><LoaderCircle size={22} className="spinning" /></div><h1>正在载入会话{title ? `「${title}」` : ""}…</h1></div>
        ) : !data.workspace ? (
          <div className="empty-workspace" data-pane="landing"><div className="empty-icon"><FolderOpen size={27} /></div><h1>打开一个项目</h1><button className="primary-button" data-control="workspace-open" type="button" onClick={() => void openWorkspace()}><FolderOpen size={16} />选择文件夹</button></div>
        ) : displayMessages.length === 0 && !isGenerating ? (
          <div className="empty-conversation" data-pane="landing"><div className="empty-icon"><CodeXml size={27} /></div><h1>今天想开发什么？</h1></div>
        ) : <>
          {displayMessages.map((message, index) => {
            const timing = showTurnTimingOnLatest && index === latestAssistantMessageIndex && message.role === "assistant" ? data.turnTiming : undefined;
            const turnActive = data.busy && index === latestAssistantMessageIndex && message.role === "assistant";
            return <MessageView key={message.uuid ?? message.id} message={message} executions={data.executions} onOpenArtifact={onOpenArtifact} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} onHtmlAction={handleHtmlAction} onCopy={copyMessage} onEdit={editMessage} onRegenerate={regenerateMessage} onShare={shareMessage} showThinking={showThinking} busy={data.busy} turnActive={turnActive} timing={timing} now={timing ? now : undefined} />;
          })}
          {isGenerating && (assistantBubbleVisible ? <div className="response-progress response-progress-inline"><LoaderCircle size={14} className="spinning" /><span>{workingLabel}</span>{activeTurnTiming && <TimingMeta timing={activeTurnTiming} now={now} />}</div> : <PendingResponse label={workingLabel} timing={activeTurnTiming} now={now} />)}
        </>}
      </div>
      {question && <QuestionPanel request={question} onOpenDetail={onOpenPlanDetail} />}
      <form ref={composerRef} className={`composer${data.queuedMessages.length > 0 ? " has-queue" : ""}${data.planMode ? " has-plan" : ""}`} data-pane="composer" onSubmit={submit} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
        {data.planMode && (
          <div className="composer-plan-banner" data-composer-zone="plan" role="status" title="计划模式：先产出计划，审查批准后才实施。退出请使用访问权限下拉或 /plan">
            <ClipboardList size={12} />
            <span className="composer-plan-banner-title">计划模式</span>
          </div>
        )}
        {data.queuedMessages.length > 0 && (
          <div className="composer-queue" role="list" aria-label="排队输入" data-composer-zone="queue">
            <div className="composer-queue-caption"><Clock size={11} /><span>排队输入 {data.queuedMessages.length} 条 · 本轮回复结束后自动发出</span></div>
            {data.queuedMessages.map((item) => (
              <div className="composer-queue-item" role="listitem" data-queue-kind={item.kind} key={`${item.kind}:${item.index}`} title={item.text}>
                {item.kind === "steering" && <span className="composer-queue-badge">即将插入</span>}
                <span className="composer-queue-text">{item.text}</span>
                <span className="composer-queue-actions">
                  <button type="button" className="composer-queue-send" data-control="queue-send-now" title="立即发送：AI 下一轮模型调用前插入，不打断工具执行" aria-label="立即发送这条消息" onClick={() => sendQueuedMessageNow(item)}><Zap size={11} />立即</button>
                  <button type="button" data-control="queue-edit" title="编辑这条排队消息" aria-label="编辑排队消息" onClick={() => editQueuedMessage(item)}><Pencil size={12} /></button>
                  <button type="button" data-control="queue-remove" title="删除这条排队消息" aria-label="删除排队消息" onClick={() => removeQueuedMessage(item)}><Trash2 size={12} /></button>
                </span>
              </div>
            ))}
          </div>
        )}
        {attachments.length > 0 && <div className="attachment-list" data-composer-zone="attachments">{attachments.map((attachment, index) => <span className="attachment-chip" key={`${attachment.name}-${index}`}>{attachment.kind === "image" ? <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt="" /> : <FileDiff size={12} />}<span>{attachment.name}</span>{attachment.kind === "image" && !modelAcceptsImages && visionFallbackAvailable && <small className="attachment-chip-note" title="当前模型不支持图片，将自动调用视觉模型识别">视觉识别</small>}<button type="button" title="移除附件" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={12} /></button></span>)}</div>}
        {attachmentError && <div className="attachment-error" data-composer-zone="error" role="alert">{attachmentError}<button type="button" title="关闭提示" aria-label="关闭附件提示" onClick={() => setAttachmentError(undefined)}><X size={12} /></button></div>}
        <input ref={fileInputRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.css,.html" onChange={(event) => { void addLocalFiles(event.target.files ?? []); event.currentTarget.value = ""; }} />
        {slashOpen && (
          <div className="slash-menu" role="listbox" aria-label="斜杠指令" data-composer-zone="popup">
            {slashGroups.map((group) => (
              <div className="composer-menu-group slash-menu-group" role="group" aria-label={group.title} key={group.key}>
                <small>{group.title}</small>
                {group.items.map(({ cmd, flatIndex }) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={flatIndex === activeSlashIndex}
                    key={`${cmd.kind}:${cmd.trigger}`}
                    className={`slash-menu-item${flatIndex === activeSlashIndex ? " active" : ""}`}
                    disabled={cmd.kind === "command" && data.busy}
                    onMouseEnter={() => setSlashIndex(flatIndex)}
                    onClick={() => applySlashCommand(cmd)}
                  >
                    <span className="slash-menu-icon">{cmd.kind === "skill" ? <Puzzle size={14} /> : cmd.kind === "new" ? <MessageSquarePlus size={14} /> : <Layers size={14} />}</span>
                    <span className="slash-menu-copy"><strong>{cmd.label}</strong><small>{cmd.description}</small></span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        {mentionOpen && (
          <div className="slash-menu mention-menu" role="listbox" aria-label="引用工作区文件" data-composer-zone="popup">
            {mentionResults.map((entry, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === activeMentionIndex}
                key={entry.relativePath}
                className={`slash-menu-item${index === activeMentionIndex ? " active" : ""}`}
                onMouseEnter={() => setMentionIndex(index)}
                onClick={() => applyMention(entry)}
              >
                <span className="slash-menu-icon">{entry.kind === "directory" ? <Folder size={14} /> : <File size={14} />}</span>
                <span className="slash-menu-copy"><strong>{entry.name}</strong><small>{entry.relativePath.includes("/") ? entry.relativePath.slice(0, entry.relativePath.lastIndexOf("/")) : "工作区根目录"}</small></span>
              </button>
            ))}
          </div>
        )}

        <div className="composer-input-row" data-composer-zone="input">
          {selectedSkill && <span className="composer-skill-chip"><Puzzle size={13} /><strong>{selectedSkill}</strong><button type="button" title="取消 Skill" aria-label={`取消 Skill ${selectedSkill}`} onClick={() => setSelectedSkill(undefined)}><X size={12} /></button></span>}
          {mentionedFiles.length > 0 && (
            <span className="composer-mention-chips">
              {mentionedFiles.map((entry) => (
                <span className="composer-skill-chip" key={entry.relativePath} title={entry.relativePath}>
                  <File size={13} />
                  <strong>{entry.name}</strong>
                  <button type="button" title="移除引用" aria-label={`移除引用 ${entry.relativePath}`} onClick={() => setMentionedFiles((current) => current.filter((item) => item.relativePath !== entry.relativePath))}><X size={12} /></button>
                </span>
              ))}
            </span>
          )}
          <textarea
            ref={textareaRef}
            value={input}
            rows={1}
            disabled={!data.workspace}
            placeholder={composerPlaceholder}
            onKeyDown={handleComposerKey}
            onPaste={handlePaste}
            onChange={(event) => { setInput(event.target.value); updateMentionFromCaret(event.target); }}
            onSelect={(event) => updateMentionFromCaret(event.currentTarget)}
          />
        </div>
        <div className="composer-footer" data-composer-zone="footer">
          <div className="composer-footer-left">
            <button className="icon-button attach-button" data-control="attach" type="button" title="添加附件" aria-label="添加附件" disabled={data.busy || attachments.length >= 5} onClick={() => void addAttachments()}><Plus size={18} /></button>
            <div className="access-mode-menu-shell" ref={accessModeMenuRef}>
              <button className={`access-mode-button${settings.accessMode === "full" ? " full" : ""}`} data-control="access-mode" type="button" aria-haspopup="menu" aria-expanded={accessModeMenuOpen} onClick={() => { setComposerMenu(undefined); setAccessModeMenuOpen((open) => !open); }}>{settings.accessMode === "full" ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}<span>{accessModeOptions.find((option) => option.value === settings.accessMode)?.label ?? "访问模式"}</span><ChevronDown size={13} /></button>
              {accessModeMenuOpen && <div className="access-mode-menu" data-composer-zone="popup" role="menu" aria-label="访问模式">
                {accessModeOptions.map((option) => <button className={`access-mode-menu-item${option.value === settings.accessMode ? " active" : ""}${option.value === "full" ? " full" : ""}`} type="button" role="menuitemradio" aria-checked={option.value === settings.accessMode} key={option.value} onClick={() => void selectAccessMode(option.value)}>{option.value === "full" ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}<span><strong>{option.label}</strong><small>{accessModeDescriptions[option.value]}</small></span>{option.value === settings.accessMode && <Check size={14} />}</button>)}
                <div className="access-mode-menu-divider" />
                <button className={`access-mode-menu-item plan-mode${data.planMode ? " active" : ""}`} data-control="plan-toggle" type="button" role="menuitemcheckbox" aria-checked={data.planMode} onClick={togglePlanMode}><ClipboardList size={15} /><span><strong>计划模式</strong><small>{data.planMode ? "已开启：先产出计划，批准后才实施" : "先产出计划，批准后才实施"}</small></span>{data.planMode && <Check size={14} />}</button>
              </div>}
            </div>
            {data.contextUsage && (
              <div className={`context-usage-chip tone-${contextUsageTone(data.contextUsage)}`} data-control="context-usage" role="status" title={contextUsageTooltip(data.contextUsage)} aria-label={`上下文占用 ${contextUsagePercentLabel(data.contextUsage)}`}>
                <span>上下文</span><strong>{contextUsagePercentLabel(data.contextUsage)}</strong>
                {data.contextUsage.cacheHitRate != null && <span className="context-usage-cache">缓存 {contextUsageCacheLabel(data.contextUsage)}</span>}
              </div>
            )}
          </div>
          <div className="composer-footer-right">
            <div className="composer-control-menu">
              <button className="composer-menu-trigger" data-control="model-select" type="button" title="模型快捷切换" aria-label="模型快捷切换" aria-haspopup="menu" aria-expanded={composerMenu === "model"} disabled={data.busy} onClick={() => { setAccessModeMenuOpen(false); setComposerMenu((current) => current === "model" ? undefined : "model"); }}><Bot size={14} /><span>{selectedModelOption?.name ?? data.model?.id ?? "选择模型"}</span><ChevronDown size={13} /></button>
              {composerMenu === "model" && <div className="composer-select-menu model-select-menu" data-composer-zone="popup" ref={modelMenuRef} role="menu" aria-label="模型快捷切换">
                {Array.from(new Set(availableModels.map((model) => model.provider))).map((providerId) => <div className="composer-menu-group" key={providerId}><small>{providers.find((provider) => provider.id === providerId)?.name ?? providerId}</small>{availableModels.filter((model) => model.provider === providerId).map((model) => { const value = `${model.provider}/${model.id}`; return <button className={value === selectedModel ? "active" : ""} type="button" role="menuitemradio" aria-checked={value === selectedModel} key={value} onClick={() => void selectModel(value)}><span>{model.name}</span>{value === selectedModel && <Check size={13} />}</button>; })}</div>)}
              </div>}
            </div>
            <div className="composer-control-menu thinking-control">
              <button className="composer-menu-trigger" data-control="thinking-select" type="button" title="思考级别" aria-label="思考级别" aria-haspopup="menu" aria-expanded={composerMenu === "thinking"} disabled={data.busy} onClick={() => { setAccessModeMenuOpen(false); setComposerMenu((current) => current === "thinking" ? undefined : "thinking"); }}><span>思考</span><strong>{thinkingLevelLabels[data.thinkingLevel]}</strong><ChevronDown size={13} /></button>
              {composerMenu === "thinking" && <div className="composer-select-menu thinking-select-menu" data-composer-zone="popup" role="menu" aria-label="思考级别">{thinkingLevels.map((level) => <button className={level === data.thinkingLevel ? "active" : ""} type="button" role="menuitemradio" aria-checked={level === data.thinkingLevel} key={level} onClick={() => void selectThinkingLevel(level)}><span>{thinkingLevelLabels[level]}</span>{level === data.thinkingLevel && <Check size={13} />}</button>)}</div>}
            </div>
            {data.busy ? (
              <button className="stop-button" data-control="stop" type="button" title="停止" aria-label="停止" onClick={stopGeneration}><CircleStop size={18} /></button>
            ) : (
              <button className="send-button" data-control="send" type="submit" title="发送" aria-label="发送" disabled={!canSubmit}><Play size={17} fill="currentColor" /></button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
