import { AlertTriangle, Check, CircleStop, Copy, FilePlus2, Layers, ListTree, LoaderCircle, Play, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatMessage, WorkflowDiagnostic, WorkflowRunSummary, WorkflowSummary } from "../../shared/protocol";
import {
  MAX_WORKFLOW_INPUT_BYTES,
  validateWorkflowForRun,
  type WorkflowDefinition,
  type WorkflowExecutionStatus,
  type WorkflowNode,
  type WorkflowResolvedNodeConfig,
  type WorkflowRework,
  type WorkflowRun
} from "../../shared/workflow";
import { formatShortTime, workspaceDisplayName } from "./lib/automation-task-view";
import { useOverlayLayer } from "./lib/overlay-layers";
import {
  WORKFLOW_RUN_STATUS_LABELS,
  addWorkflowNode,
  cloneWorkflowDefinition,
  connectWorkflowNodes,
  createStarterWorkflow,
  estimateWorkflowExecutions,
  groupWorkflowIssues,
  isTerminalRunStatus,
  isWorkflowDraftDirty,
  moveWorkflowNode,
  removeWorkflowEdge,
  removeWorkflowNode,
  setWorkflowRework,
  updateWorkflowNode,
  workflowDraftFingerprint,
  workflowIssueText
} from "./lib/workflow-canvas";
import { belongsToOwner, deleteWorkflow, loadWorkflow, loadWorkflowCatalog, loadWorkflowNode, loadWorkflowRun, loadWorkflowRuns, saveWorkflow, startWorkflowRun, stopWorkflowRun, workflowFailureMessage, type WorkflowApi } from "./lib/workflow-client";
import { useDesktopStore } from "./store";
import { WorkflowCanvas } from "./components/WorkflowCanvas";
import { WorkflowNodeInspector, type WorkflowArtifactView } from "./components/WorkflowNodeInspector";
import { WorkflowRunDetails, type WorkflowNodeContent, type WorkflowTranscriptWindow } from "./components/WorkflowRunDetails";
import "./workflow.css";

/**
 * 工作流中心（方案 §9）。
 *
 * 布局：左侧列表 · 中间可滚动画布 · 右侧检查器；顶部两个视图页签
 * 「编辑」与「运行」，运行详情与编辑器**不共用一张图**——运行绑定的是
 * `workflow.run.get` 回读的冻结定义快照，编辑中的草稿再怎么改都不会给旧 run
 * 涂色（否则会给出错误的因果）。
 *
 * 状态口径：
 * - 详情、目录、产物全部走 `lib/workflow-client` 的 requestId 回执，本地状态有界
 *   （同一时刻只缓存一份运行详情 + 每执行的产物/转写按需加载）。
 * - 运行摘要由 props 传入（App 已按 owner 过滤），运行历史按需拉 `workflow.runs.list`。
 * - dirty 离开/切定义/关页一律「保存 / 放弃 / 取消」，运行按钮先保存并拿到成功
 *   回执才受理，冲突不运行旧稿。
 * - 离开本页（关页 / 其他中心 / 预览 / 设置 / 侧栏开关 / 命令面板）走**同一个**
 *   `onRegisterLeaveGuard` 守卫：App 拿到的不是「关不关」，而是「要不要先把草稿处理掉」，
 *   取消就真的留在原地（见 `WorkflowLeaveGuard`）。
 * - 画布叠加层只给「同 owner + 同定义内容」的运行着色（见 `overlayRun`）。
 */
export interface WorkflowCenterProps {
  workspace: string;
  onClose(): void;
  /** 当前 owner 会话的运行摘要（App 侧按 ownerSessionId 过滤后传入）。 */
  runs: WorkflowRunSummary[];
  /** 页面运行的 owner；缺省时需要 `onOwnerRequired` 现开一个。 */
  ownerSessionId?: string;
  agentId?: string;
  initialRunId?: string;
  /** 没有 owner 时现开一个会话并返回它的 id（不能伪造 session-pending）。 */
  onOwnerRequired?(): Promise<string>;
  /**
   * 工作区切换请求（App 发出）。App 把本页的 workspace **冻结**在打开时的那个，
   * 切工作区时只发请求：未保存的草稿必须先在组件里走过「保存 / 放弃 / 取消」，
   * 回 `onWorkspaceSwitch` 之后才真的换工作区。`requestId` 变一次 = 问一次。
   */
  workspaceSwitch?: { workspace: string; requestId: number };
  /** 切换落地：App 把中心的 workspace 换成这个（同时清掉请求）。 */
  onWorkspaceSwitch?(workspace: string): void;
  /**
   * 离开中心的**唯一**守卫（App 注册，卸载时用 `undefined` 注销）。
   *
   * App 侧所有会把本页从屏幕上拿掉的路径（侧栏/折叠栏开关、其它中心、预览、设置、
   * 命令面板入口）都先问这里：不脏就同步 `proceed()`；脏就先弹「保存 / 放弃 / 取消」，
   * 只有保存成功或明确放弃才 `proceed()`，取消时什么都不做（页面与草稿原样留着）。
   */
  onRegisterLeaveGuard?(guard: WorkflowLeaveGuard | undefined): void;
  /** 测试注入点；默认用 window.piDesktop。 */
  api?: WorkflowApi;
}

/** 离开守卫：参数是「用户同意离开后要执行的动作」，由本组件决定何时调用。 */
export type WorkflowLeaveGuard = (proceed: () => void) => void;

interface EditorState {
  /** 草稿所属工作区：保存/删除/运行都绑定它，工作区切换后不会误写到新工作区。 */
  workspace: string;
  /** 磁盘上的定义 id；未保存的新草稿为 undefined。 */
  workflowId?: string;
  baseHash?: string;
  draft: WorkflowDefinition;
  /** 磁盘上的版本（读取或保存成功后的定义）；新草稿为 undefined。 */
  saved?: WorkflowDefinition;
  issues: WorkflowDiagnostic[];
  resolvedNodes?: WorkflowResolvedNodeConfig[];
}

type PendingAction =
  | { kind: "select"; workflowId: string }
  | { kind: "new" }
  | { kind: "copy" }
  | { kind: "blank" }
  | { kind: "close" }
  | { kind: "workspace"; workspace: string }
  /** 外部（App）请求离开：用户选保存/放弃后用 `proceed` 真地离开。 */
  | { kind: "leave"; proceed: () => void };

interface RunDetailState {
  runId: string;
  loading: boolean;
  error?: string;
  run?: WorkflowRun;
  definition?: WorkflowDefinition;
  selectedExecutionId?: string;
  contents: Record<string, WorkflowNodeContent>;
}

/** 单次读取完整记录的条数上限（后端按字节另有一层上限）。 */
const TRANSCRIPT_PAGE_SIZE = 200;
/**
 * 一个执行的完整记录**窗口内**最多缓存几页：到窗口上限不叫「读完」，而是用「查看后续记录」
 * **推进并替换**窗口（旧窗口内容移出记忆），所以 `nextCursor` 存在就一定还能往前看。
 */
const MAX_TRANSCRIPT_PAGES = 5;
/** 可回退的窗口栈深度（按保存的窗口起点游标，有界）。最早的窗口会被丢弃，但「从头查看」永远可用。 */
const MAX_TRANSCRIPT_WINDOW_HISTORY = 5;
/** 产物/记录缓存有界：同一时刻只留最近读过的这么多个执行（按最近使用淘汰）。 */
const MAX_CONTENT_ENTRIES = 6;

/** 写入一条有界缓存：提升本次执行的最近使用顺序，超出上限淘汰最久未用的。 */
function putContent(contents: Record<string, WorkflowNodeContent>, executionId: string, entry: WorkflowNodeContent): Record<string, WorkflowNodeContent> {
  const next: Record<string, WorkflowNodeContent> = { ...contents };
  delete next[executionId];
  next[executionId] = entry;
  for (const key of Object.keys(next)) {
    if (Object.keys(next).length <= MAX_CONTENT_ENTRIES) break;
    if (key !== executionId) delete next[key];
  }
  return next;
}

/** 追加分页时去重（游标由后端给，按执行各自的全局序号重算 id，理论上不重叠；重复也不落两块）。 */
function appendMessages(existing: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const seen = new Set(existing.map((message) => message.id));
  return [...existing, ...incoming.filter((message) => !seen.has(message.id))];
}

/** 清掉整组窗口/游标/截断字段（每次读取都整组重算，不把上一窗口的状态留在这一窗口）。 */
function clearTranscriptFields(entry: WorkflowNodeContent): void {
  delete entry.messages;
  delete entry.nextCursor;
  delete entry.pages;
  delete entry.windowFull;
  delete entry.windowStartPage;
  delete entry.windowStartCursor;
  delete entry.hasEarlier;
  delete entry.windowBack;
  delete entry.transcriptTruncated;
}

/** 完整记录的读取意图：从头读 / 窗口内再读一页 / 回退上一窗口。 */
type TranscriptNav = "start" | "more" | "previous";

type View = "edit" | "runs";

export function WorkflowCenter({ workspace, onClose, runs, ownerSessionId, agentId, initialRunId, onOwnerRequired, workspaceSwitch, onWorkspaceSwitch, onRegisterLeaveGuard, api }: WorkflowCenterProps): ReactNode {
  const client = api ?? window.piDesktop;
  const models = useDesktopStore((state) => state.models);
  const providers = useDesktopStore((state) => state.providers);
  const subagents = useDesktopStore((state) => state.resources.subagents) ?? [];
  const [view, setView] = useState<View>(initialRunId ? "runs" : "edit");
  const [catalog, setCatalog] = useState<WorkflowSummary[]>([]);
  const [catalogDiagnostics, setCatalogDiagnostics] = useState<string[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string>();
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState>();
  const [editorLoading, setEditorLoading] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [saveNotice, setSaveNotice] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<{ workflowId: string; name: string }>();
  const [runInput, setRunInput] = useState<string>();
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string>();
  const [runNotice, setRunNotice] = useState<string>();
  const [historyRuns, setHistoryRuns] = useState<WorkflowRunSummary[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string>();
  const [runDetail, setRunDetail] = useState<RunDetailState>();
  const [stoppingRunId, setStoppingRunId] = useState<string>();
  const autoRunSignature = useRef<string>("");

  // 中心页是全幅 DOM 覆盖层：右侧预览的内置浏览器是原生 WebContentsView，不登记就会被盖。
  useOverlayLayer(true);

  const refreshCatalog = useCallback(async (): Promise<void> => {
    if (!workspace) return;
    setCatalogLoading(true);
    setCatalogError(undefined);
    const outcome = await loadWorkflowCatalog(client, workspace);
    setCatalogLoading(false);
    if (!outcome.ok) {
      setCatalogError(workflowFailureMessage(outcome, "读取工作流目录失败"));
      return;
    }
    setCatalog(outcome.result.workflows);
    setCatalogDiagnostics(outcome.result.diagnostics);
  }, [client, workspace]);

  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  const loadEditor = useCallback(async (workflowId: string): Promise<void> => {
    setEditorLoading(true);
    setSaveError(undefined);
    const outcome = await loadWorkflow(client, workspace, workflowId);
    setEditorLoading(false);
    if (!outcome.ok) {
      setSaveError(workflowFailureMessage(outcome, "读取工作流失败"));
      return;
    }
    const { definition, baseHash, issues, resolvedNodes } = outcome.result;
    setEditor({ workspace, workflowId, baseHash, draft: definition, saved: definition, issues, ...(resolvedNodes ? { resolvedNodes } : {}) });
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
    setSaveNotice(undefined);
  }, [client, workspace]);

  const loadHistory = useCallback(async (cursor?: string): Promise<void> => {
    if (!workspace) return;
    setHistoryLoading(true);
    setHistoryError(undefined);
    const outcome = await loadWorkflowRuns(client, { workspace, limit: 50, ...(cursor ? { cursor } : {}) });
    setHistoryLoading(false);
    if (!outcome.ok) {
      setHistoryError(workflowFailureMessage(outcome, "读取运行历史失败"));
      return;
    }
    setHistoryRuns((current) => {
      const merged = new Map(current.map((run) => [run.runId, run]));
      for (const run of outcome.result.runs) merged.set(run.runId, run);
      return [...merged.values()];
    });
    setHistoryCursor(outcome.result.nextCursor);
  }, [client, workspace]);

  const openRun = useCallback(async (runId: string): Promise<void> => {
    setRunDetail((current) => current?.runId === runId ? { ...current, loading: true, error: undefined } : { runId, loading: true, contents: {} });
    const outcome = await loadWorkflowRun(client, runId);
    if (!outcome.ok) {
      setRunDetail({ runId, loading: false, error: workflowFailureMessage(outcome, "读取运行记录失败"), contents: {} });
      return;
    }
    const { run, definition } = outcome.result;
    setRunDetail((current) => ({
      runId,
      loading: false,
      run,
      definition,
      contents: current?.runId === runId ? current.contents : {},
      ...(current?.runId === runId && current.selectedExecutionId ? { selectedExecutionId: current.selectedExecutionId } : {})
    }));
  }, [client]);

  // 初次进入：目录 + 历史；带 initialRunId 时直接打开那条运行。
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!initialRunId) return;
    setView("runs");
    void openRun(initialRunId);
  }, [initialRunId, openRun]);

  const mergedRuns = useMemo(() => {
    const merged = new Map<string, WorkflowRunSummary>();
    for (const run of historyRuns) merged.set(run.runId, run);
    for (const run of runs) merged.set(run.runId, run);
    return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt);
  }, [historyRuns, runs]);

  /**
   * 本页 owner 在这个定义上的运行（`mergedRuns` 已按开始时间倒序）：
   * - **owner 必须匹配**（分屏各看各的；不跨会话借用别人的运行状态）；
   * - workflowId 必须相同。
   * 运行中的排前面，其次才是最近一条终态（历史态可以继续看，但必须内容匹配才着色，
   * 见 `overlayRun`）。
   */
  const ownedRuns = useMemo(() => {
    const workflowId = editor?.workflowId;
    if (!workflowId) return [] as WorkflowRunSummary[];
    return mergedRuns.filter((run) => run.workflowId === workflowId && belongsToOwner(run, ownerSessionId));
  }, [editor?.workflowId, mergedRuns, ownerSessionId]);

  /** 正在跑的那条：停止按钮与「第 k/m 轮」读数用它，与草稿是否脏无关。 */
  const liveRun = useMemo(() => ownedRuns.find((run) => !isTerminalRunStatus(run.status)), [ownedRuns]);

  /** 需要回读 `run.get` 的那条：优先运行中的，否则最近一条终态。 */
  const overlayCandidate = liveRun ?? ownedRuns[0];

  // 节点状态/历史轮次要来自 run.get：按摘要签名去重，避免每条推送都重拉。
  useEffect(() => {
    if (!overlayCandidate) {
      autoRunSignature.current = "";
      return;
    }
    const signature = `${overlayCandidate.runId}|${overlayCandidate.status}|${overlayCandidate.currentAttempt}|${overlayCandidate.currentNodeId ?? ""}|${Object.values(overlayCandidate.nodeStates).join(",")}`;
    if (autoRunSignature.current === signature) return;
    autoRunSignature.current = signature;
    void openRun(overlayCandidate.runId);
  }, [overlayCandidate, openRun]);

  // 未保存的新草稿永远算脏（它没有磁盘版本可比，走了就等于丢内容）。
  const dirty = editor ? !editor.workflowId || isWorkflowDraftDirty(editor.saved, editor.draft) : false;
  const foreignWorkspace = editor !== undefined && editor.workspace !== workspace;

  /**
   * 画布叠加层：只有「同 owner + 屏幕上的草稿与这条运行启动时的冻结定义内容一致」才着色。
   *
   * 为什么不直接用摘要里的 `nodeStates`：运行绑定的是启动时冻结的定义。用户保存了一版
   * 新定义（或改了草稿）之后，旧 run 的节点状态就不能再涂到改过的图上——那是在编造因果
   * （方案 §9：不能在同一张已改图上错误着色旧 run）。历史运行始终以冻结快照展示在
   * 「运行历史」里。指纹不含 revision/updatedAt（保存元数据），包含节点位置（位置也是
   * 定义内容），宁可保守地不着色，也不给出错误的因果。
   */
  const overlayRun = useMemo(() => {
    const run = runDetail?.run;
    const frozen = runDetail?.definition;
    if (!run || !frozen || !editor?.workflowId) return undefined;
    if (!overlayCandidate || run.runId !== overlayCandidate.runId) return undefined;
    if (run.workflowId !== editor.workflowId) return undefined;
    // 与 `belongsToOwner` 同口径（run 记录没有摘要的两列，这里直接比 owner）。
    if (ownerSessionId && run.ownerSessionId !== ownerSessionId) return undefined;
    if (workflowDraftFingerprint(editor.draft) !== workflowDraftFingerprint(frozen)) return undefined;
    return run;
  }, [editor, overlayCandidate, ownerSessionId, runDetail]);

  /** 冻结运行里每个节点的最新状态（与运行详情同一事实源，不读摘要里的陈旧副本）。 */
  const overlayStates = useMemo(() => {
    const states: Record<string, WorkflowExecutionStatus> = {};
    for (const execution of overlayRun?.executions ?? []) states[execution.nodeId] = execution.status;
    return states;
  }, [overlayRun]);

  const overlayCurrentNodeId = useMemo(() => {
    if (!overlayRun?.currentExecutionId) return undefined;
    return overlayRun.executions.find((execution) => execution.executionId === overlayRun.currentExecutionId)?.nodeId;
  }, [overlayRun]);

  // 已经有这条运行的冻结快照，但内容/owner 对不上：明确说「不着色 + 去运行历史看」，
  // 不静默地又一个颜色都不给。
  const overlayMismatch = Boolean(overlayCandidate) && runDetail?.run?.runId === overlayCandidate?.runId && !overlayRun;

  /**
   * 离开守卫的唯一实现：App 侧所有「把中心页从屏幕上拿掉」的路径都经它。
   *
   * 两层 ref 是必须的：注册给 App 的必须是**身份稳定**的函数（App 的 effect 只在挂载
   * 时注册一次，注册时机可能早于任何一次编辑），而每次调用又必须读到**当前**那帧的
   * `dirty`/editor。所以对外暴露的是转发器，转发目标每帧重写。
   */
  const latestLeaveGuardRef = useRef<WorkflowLeaveGuard>((proceed) => { proceed(); });
  latestLeaveGuardRef.current = (proceed: () => void): void => { requestAction({ kind: "leave", proceed }); };
  const stableLeaveGuardRef = useRef<WorkflowLeaveGuard>((proceed: () => void): void => { latestLeaveGuardRef.current(proceed); });
  useEffect(() => {
    onRegisterLeaveGuard?.(stableLeaveGuardRef.current);
    return () => onRegisterLeaveGuard?.(undefined);
  }, [onRegisterLeaveGuard]);

  // 工作区被切换：不脏就直接收起草稿（避免在新目录上继续编辑旧定义）；脏草稿保留并显式提示，
  // 保存/运行仍写回它自己的工作区。
  useEffect(() => {
    setEditor((current) => current && current.workspace !== workspace && !isWorkflowDraftDirty(current.saved, current.draft) && current.workflowId ? undefined : current);
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
  }, [workspace]);

  // 工作区被切走（App 冻结了本页的 workspace，只发请求）：与切定义/关页同一道
  // dirty 守卫——保存（写回草稿自己的工作区）/ 放弃 / 取消，不脏就直接落地。
  const workspaceSwitchRequestId = workspaceSwitch?.requestId;
  useEffect(() => {
    if (!workspaceSwitch || workspaceSwitch.workspace === workspace) return;
    requestAction({ kind: "workspace", workspace: workspaceSwitch.workspace });
    // 只认 requestId：同一个请求不重复弹窗。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSwitchRequestId]);

  /** 本地校验 + 服务端回读问题：合并去重后按节点/边归位。 */
  const { issues, plan } = useMemo(() => {
    if (!editor) return { issues: [] as WorkflowDiagnostic[], plan: undefined };
    const availableModels = models.map((model) => ({ provider: model.provider, id: model.id }));
    const local = validateWorkflowForRun(editor.draft, { subagents, availableModels });
    const seen = new Set<string>();
    const merged: WorkflowDiagnostic[] = [];
    for (const issue of [...local.errors, ...editor.issues]) {
      const key = `${issue.code}|${issue.nodeId ?? ""}|${issue.edgeId ?? ""}|${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(issue);
    }
    return { issues: merged, plan: local.plan };
  }, [editor, models, subagents]);

  const groupedIssues = useMemo(() => groupWorkflowIssues(issues), [issues]);
  const plannedExecutions = plan ? estimateWorkflowExecutions(plan) : undefined;

  async function persistDraft(): Promise<{ ok: true; workflowId: string } | { ok: false }> {
    if (!editor) return { ok: false };
    setSaving(true);
    setSaveError(undefined);
    setSaveNotice(undefined);
    // 用草稿自己的工作区：App 切换工作区后不会把旧草稿写进新目录。
    const outcome = await saveWorkflow(client, editor.workspace, editor.draft, {
      ...(editor.workflowId ? { workflowId: editor.workflowId } : {}),
      ...(editor.baseHash ? { baseHash: editor.baseHash } : {})
    });
    setSaving(false);
    if (!outcome.ok) {
      // 乐观并发冲突：不覆盖、不切换，把问题摊在界面上让用户重新读取。
      setSaveError(outcome.code === "conflict" ? "保存冲突：这个工作流已被其他操作修改，请刷新后重新编辑（不会覆盖别人的改动）。" : workflowFailureMessage(outcome, "保存工作流失败"));
      return { ok: false };
    }
    const { definition, baseHash, issues: serverIssues, resolvedNodes } = outcome.result;
    setEditor({ workspace: editor.workspace, workflowId: definition.id, baseHash, draft: definition, saved: definition, issues: serverIssues, ...(resolvedNodes ? { resolvedNodes } : {}) });
    setSaveNotice("已保存");
    void refreshCatalog();
    return { ok: true, workflowId: definition.id };
  }

  function startNewDraft(definition: WorkflowDefinition): void {
    setEditor({ workspace, draft: definition, issues: [] });
    setSelectedNodeId(undefined);
    setSelectedEdgeId(undefined);
    setSaveError(undefined);
    setSaveNotice("未保存的新草稿");
    setView("edit");
  }

  function requestAction(action: PendingAction): void {
    if (dirty) {
      setPendingAction(action);
      return;
    }
    void applyAction(action);
  }

  async function applyAction(action: PendingAction): Promise<void> {
    setPendingAction(undefined);
    switch (action.kind) {
      case "select":
        await loadEditor(action.workflowId);
        setView("edit");
        return;
      case "new":
        startNewDraft(createStarterWorkflow(Date.now()));
        return;
      case "blank":
        startNewDraft({ ...createStarterWorkflow(Date.now()), name: "未命名工作流", description: undefined, inputHint: undefined, nodes: [], edges: [], rework: undefined });
        return;
      case "copy":
        if (!editor) return;
        startNewDraft(cloneWorkflowDefinition(editor.draft));
        return;
      case "close":
        onClose();
        return;
      case "workspace":
        onWorkspaceSwitch?.(action.workspace);
        return;
      case "leave":
        // 外部（App）发起的高开：用户已选保存成功或明确放弃，现在可以真的离开。
        action.proceed();
        return;
    }
  }

  async function saveThenContinue(): Promise<void> {
    const action = pendingAction;
    const saved = await persistDraft();
    if (!saved.ok) return;
    if (action) await applyAction(action);
  }

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(undefined);
    // 删除必须用读取时的 baseHash：文件被外部改过就报冲突，绝不盲删。
    const baseHash = editor?.workflowId === target.workflowId ? editor.baseHash : undefined;
    const targetWorkspace = editor?.workspace ?? workspace;
    const loaded = baseHash ? undefined : await loadWorkflow(client, targetWorkspace, target.workflowId);
    const hash = baseHash ?? (loaded?.ok ? loaded.result.baseHash : undefined);
    if (!hash) {
      setSaveError(loaded && !loaded.ok ? workflowFailureMessage(loaded, "读取工作流失败") : "找不到工作流的版本信息，请刷新后重试");
      return;
    }
    const outcome = await deleteWorkflow(client, targetWorkspace, target.workflowId, hash);
    if (!outcome.ok) {
      setSaveError(workflowFailureMessage(outcome, "删除工作流失败"));
      return;
    }
    if (editor?.workflowId === target.workflowId) {
      setEditor(undefined);
      setSelectedNodeId(undefined);
      setSelectedEdgeId(undefined);
    }
    void refreshCatalog();
  }

  async function startRun(): Promise<void> {
    if (!editor || runInput === undefined) return;
    setRunBusy(true);
    setRunError(undefined);
    setRunNotice(undefined);
    // ① 先把草稿存盘并拿到成功回执：冲突/失败都不运行旧稿。
    let workflowId = editor.workflowId;
    if (!workflowId || isWorkflowDraftDirty(editor.saved, editor.draft)) {
      const saved = await persistDraft();
      if (!saved.ok) {
        setRunBusy(false);
        setRunError("保存失败，已取消本次运行（不会用旧稿启动）。");
        return;
      }
      workflowId = saved.workflowId;
    }
    // ② owner：页面运行必须有真实 live owner，不能伪造 session-pending。
    let owner = ownerSessionId;
    if (!owner) {
      if (!onOwnerRequired) {
        setRunBusy(false);
        setRunError("没有可用的 owner 会话：请先在某个话题里打开工作流中心，或给 WorkflowCenter 传入 onOwnerRequired。");
        return;
      }
      try {
        owner = await onOwnerRequired();
      } catch (cause) {
        setRunBusy(false);
        setRunError(cause instanceof Error && cause.message.trim() ? cause.message : "新建 owner 会话失败");
        return;
      }
    }
    const outcome = await startWorkflowRun(client, { workspace: editor.workspace, ownerSessionId: owner, workflowId, input: runInput });
    setRunBusy(false);
    if (!outcome.ok) {
      setRunError(workflowFailureMessage(outcome, "工作流受理失败"));
      return;
    }
    setRunInput(undefined);
    setRunNotice(`已受理：${outcome.result.runId}（${WORKFLOW_RUN_STATUS_LABELS[outcome.result.status]}）`);
    void loadHistory();
  }

  async function stopActiveRun(runId: string): Promise<void> {
    setRunError(undefined);
    setStoppingRunId(runId);
    const outcome = await stopWorkflowRun(client, runId);
    setStoppingRunId(undefined);
    // 回执只代表「已受理（stopping）」；终态由摘要/run.get 推过来。
    if (!outcome.ok) setRunError(workflowFailureMessage(outcome, "停止工作流失败"));
  }

  // 读请求要拿「当前」的 run/游标：用 ref 镜像，避免 useCallback 依赖 runDetail 而在
  // 翻页途中拿到上一帧的游标（那会把两页都按第一页的游标去要）。
  const runDetailRef = useRef<RunDetailState | undefined>(undefined);
  runDetailRef.current = runDetail;

  /** 读产物：单次内联（后端超限会截断，并已给出运行目录里的文件引用）。 */
  const loadArtifact = useCallback(async (executionId: string): Promise<void> => {
    const run = runDetailRef.current?.run;
    if (!run || !run.executions.some((item) => item.executionId === executionId)) return;
    // 回执回来时可能已经切到另一条 run：只认发请求时那条（否则会把 A 的产物塞进 B）。
    const runId = run.runId;
    setRunDetail((current) => current && current.runId === runId ? {
      ...current,
      contents: putContent(current.contents, executionId, { ...current.contents[executionId], loading: true, error: undefined })
    } : current);
    const outcome = await loadWorkflowNode(client, runId, executionId, "artifact");
    setRunDetail((current) => {
      if (!current || current.runId !== runId) return current;
      const previous = current.contents[executionId] ?? {};
      if (!outcome.ok) {
        return { ...current, contents: putContent(current.contents, executionId, { ...previous, loading: false, error: workflowFailureMessage(outcome, "读取节点记录失败") }) };
      }
      return {
        ...current,
        contents: putContent(current.contents, executionId, {
          ...previous,
          loading: false,
          error: undefined,
          artifact: outcome.result.artifact ?? "",
          ...(outcome.result.truncated ? { truncated: true } : {})
        })
      };
    });
  }, [client]);

  /**
   * 读完整记录：**有界窗口分页**（窗口与游标按 executionId 各自持有）。
   *
   * 不同轮次是不同执行、不同会话文件，游标绝不共用（共用就会把上一轮的消息拼进这一轮）。
   * 窗口内最多累计 {@link MAX_TRANSCRIPT_PAGES} 页；窗口满了而 `nextCursor` 还在时，
   * 「查看后续记录」推进游标并**替换**窗口——不无限追加，也绝不停在第 5 页冒充完整。
   * 回退只依赖有界游标栈（{@link MAX_TRANSCRIPT_WINDOW_HISTORY}），「从头查看」永远可用。
   */
  const loadTranscriptPage = useCallback(async (executionId: string, nav: TranscriptNav = "start"): Promise<void> => {
    const current = runDetailRef.current;
    const run = current?.run;
    if (!current || !run || !run.executions.some((item) => item.executionId === executionId)) return;
    const previous = current.contents[executionId] ?? {};
    // 先按**当前窗口**状态算出这次读哪个游标：窗口内追加（保留已看内容）还是替换窗口。
    const priorPages = Math.max(1, previous.pages ?? 1);
    const priorStart = Math.max(1, previous.windowStartPage ?? 1);
    let cursor: string | undefined;
    let appending = false;
    let windowStartPage = 1;
    let windowStartCursor: string | undefined;
    let back: WorkflowTranscriptWindow[] = [];
    if (nav === "more") {
      // 没有下一页就什么都不做（绝不拿旧游标重读同一页）。
      if (previous.nextCursor === undefined) return;
      back = previous.windowBack ?? [];
      windowStartPage = priorStart;
      windowStartCursor = previous.windowStartCursor;
      cursor = previous.nextCursor;
      appending = priorPages < MAX_TRANSCRIPT_PAGES;
      if (!appending) {
        // 窗口满了：当前窗口起点压进有界回退栈，然后从 nextCursor 起**替换**窗口。
        back = [...back, { cursor: previous.windowStartCursor ?? "0", pageStart: priorStart }].slice(-MAX_TRANSCRIPT_WINDOW_HISTORY);
        windowStartPage = priorStart + priorPages;
        windowStartCursor = cursor;
      }
    } else if (nav === "previous") {
      const target = (previous.windowBack ?? []).at(-1);
      if (!target) return;
      back = (previous.windowBack ?? []).slice(0, -1);
      cursor = target.cursor;
      windowStartPage = target.pageStart;
      windowStartCursor = target.cursor;
    }
    // nav === "start"：从头读第一页（不传游标、清掉回退栈），上面三个变量保持初值。

    // 回执只写回发起时那条运行：切 run 之后不会被旧请求污染。
    const runId = run.runId;
    setRunDetail((current) => {
      if (!current || current.runId !== runId) return current;
      const entry: WorkflowNodeContent = { ...(current.contents[executionId] ?? {}) };
      delete entry.loading;
      delete entry.loadingMore;
      delete entry.error;
      // 替换窗口时先把旧窗口清掉：不把上一窗口的内容摆成这一窗口的。
      if (!appending) clearTranscriptFields(entry);
      if (appending) entry.loadingMore = true;
      else entry.loading = true;
      return {
        ...current,
        selectedExecutionId: current.selectedExecutionId ?? executionId,
        contents: putContent(current.contents, executionId, entry)
      };
    });
    const outcome = await loadWorkflowNode(client, runId, executionId, "transcript", { limit: TRANSCRIPT_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    setRunDetail((current) => {
      if (!current || current.runId !== runId) return current;
      const previous = current.contents[executionId] ?? {};
      const entry: WorkflowNodeContent = { ...previous };
      delete entry.loading;
      delete entry.loadingMore;
      delete entry.error;
      if (!outcome.ok) {
        entry.error = workflowFailureMessage(outcome, "读取节点记录失败");
        return { ...current, contents: putContent(current.contents, executionId, entry) };
      }
      const incoming = outcome.result.messages ?? [];
      const pages = appending ? priorPages + 1 : 1;
      // 追加用发起请求前的消息做基准（读取期间按钮禁用，窗口不会被别的请求改）。
      const messages = appending ? appendMessages(previous.messages ?? [], incoming) : incoming;
      const nextCursor = outcome.result.nextCursor;
      const windowFull = nextCursor !== undefined && pages >= MAX_TRANSCRIPT_PAGES;
      // transcript 的整组窗口字段重算（不把上一窗口的游标/截断标记留在这一窗口）。
      clearTranscriptFields(entry);
      entry.messages = messages;
      entry.pages = pages;
      entry.windowStartPage = windowStartPage;
      if (windowStartCursor !== undefined) entry.windowStartCursor = windowStartCursor;
      if (windowStartPage > 1) entry.hasEarlier = true;
      // 游标照样留着：存在就说明后面确实还有，界面据此给「加载更多」或「查看后续记录」。
      if (nextCursor !== undefined) entry.nextCursor = nextCursor;
      if (windowFull) entry.windowFull = true;
      if (back.length > 0) entry.windowBack = back;
      // 只有「没有后续」还带 truncated 才是真的按字节截断（有 nextCursor 时后端也置
      // truncated，那只是说明还有更多——不能据此谎报「消息被截断」）。
      if (outcome.result.truncated && nextCursor === undefined) entry.transcriptTruncated = true;
      return { ...current, contents: putContent(current.contents, executionId, entry) };
    });
  }, [client]);
  const inspectorArtifact: WorkflowArtifactView | undefined = useMemo(() => {
    if (!runDetail?.selectedExecutionId || !selectedNodeId) return undefined;
    const execution = runDetail.run?.executions.find((item) => item.executionId === runDetail.selectedExecutionId);
    if (!execution || execution.nodeId !== selectedNodeId) return undefined;
    const content = runDetail.contents[execution.executionId];
    if (!content) return undefined;
    return {
      executionId: execution.executionId,
      ...(content.loading ? { loading: true } : {}),
      ...(content.error ? { error: content.error } : {}),
      ...(content.artifact !== undefined ? { text: content.artifact } : {}),
      ...(content.truncated ? { truncated: true } : {})
    };
  }, [runDetail, selectedNodeId]);

  const nodeExecutions = useMemo(() => runDetail?.run?.executions ?? [], [runDetail]);
  /** 本次运行冻结的「实际生效模型」：停用/回落之后真正用的那个，不是节点写的那行。 */
  const resolvedModel = useMemo(() => {
    if (!selectedNodeId) return undefined;
    return runDetail?.run?.resolvedNodes.find((node) => node.nodeId === selectedNodeId)?.model;
  }, [runDetail, selectedNodeId]);

  function updateDraft(next: WorkflowDefinition): void {
    setEditor((current) => current ? { ...current, draft: next } : current);
    setSaveNotice(undefined);
  }

  function patchNode(nodeId: string, patch: Partial<Omit<WorkflowNode, "id">>): void {
    setEditor((current) => current ? { ...current, draft: updateWorkflowNode(current.draft, nodeId, patch) } : current);
  }

  function patchDefinition(patch: Partial<Pick<WorkflowDefinition, "name" | "description" | "whenToUse" | "inputHint">>): void {
    setEditor((current) => current ? { ...current, draft: { ...current.draft, ...patch } } : current);
  }

  function patchRework(rework: WorkflowRework | undefined): void {
    setEditor((current) => current ? { ...current, draft: setWorkflowRework(current.draft, rework) } : current);
  }

  function deleteNode(nodeId: string): void {
    setEditor((current) => current ? { ...current, draft: removeWorkflowNode(current.draft, nodeId) } : current);
    setSelectedNodeId((current) => current === nodeId ? undefined : current);
  }

  function connectNodes(fromId: string, toId: string): void {
    if (!editor) return;
    const result = connectWorkflowNodes(editor.draft, fromId, toId);
    if (!result.ok) {
      setSaveError(result.reason);
      return;
    }
    setSaveError(undefined);
    updateDraft(result.definition);
    setSelectedEdgeId(result.edge.id);
  }

  const filteredCatalog = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return catalog;
    return catalog.filter((item) => item.name.toLowerCase().includes(keyword) || (item.description ?? "").toLowerCase().includes(keyword) || (item.whenToUse ?? "").toLowerCase().includes(keyword));
  }, [catalog, query]);
  const runInputBytes = runInput === undefined ? 0 : new TextEncoder().encode(runInput).byteLength;

  return (
    <div className="workflow-center" data-pane="workflow-center">
      <header className="workflow-center-head">
        <div className="workflow-center-heading">
          <span className="workflow-center-icon"><Layers size={17} /></span>
          <div>
            <h2>工作流中心</h2>
            <p>
              {workspaceDisplayName(workspace) ?? "未选择工作区"}
              {` · ${catalog.length} 个工作流`}
              {mergedRuns.length > 0 ? ` · ${mergedRuns.length} 条运行记录` : ""}
              {editor ? ` · ${editor.draft.nodes.length} 节点${dirty ? " · 未保存" : ""}` : ""}
            </p>
          </div>
        </div>
        <div className="workflow-center-head-actions">
          <div className="workflow-center-views" role="tablist" aria-label="工作流视图">
            <button type="button" role="tab" aria-selected={view === "edit"} className={view === "edit" ? "active" : ""} data-control="workflow-view-edit" onClick={() => setView("edit")}>编辑</button>
            <button type="button" role="tab" aria-selected={view === "runs"} className={view === "runs" ? "active" : ""} data-control="workflow-view-runs" onClick={() => setView("runs")}>运行历史</button>
          </div>
          <button type="button" data-control="workflow-refresh" title="刷新工作流目录" onClick={() => void refreshCatalog()} disabled={catalogLoading}>
            <RefreshCw size={13} className={catalogLoading ? "spinning" : undefined} />
          </button>
          <button type="button" data-control="workflow-center-close" title="关闭工作流中心" aria-label="关闭工作流中心" onClick={() => requestAction({ kind: "close" })}><X size={15} /></button>
        </div>
      </header>
      <div className="workflow-center-body" data-view={view}>
        <section className="workflow-list" data-pane="workflow-list">
          <div className="workflow-list-toolbar">
            <label className="workflow-list-search">
              <Search size={12} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选名称或用途…" aria-label="筛选工作流" />
            </label>
            <button type="button" data-control="workflow-create" title="新建（六节点起步模板）" onClick={() => requestAction({ kind: "new" })}><Plus size={12} />新建</button>
            <button type="button" data-control="workflow-create-blank" title="新建空白工作流" onClick={() => requestAction({ kind: "blank" })}><FilePlus2 size={12} /></button>
          </div>
          <div className="workflow-list-rows">
            {filteredCatalog.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`workflow-list-row${editor?.workflowId === item.id ? " active" : ""}`}
                data-control="workflow-open"
                data-workflow-id={item.id}
                data-runnable={item.runnable ? "true" : "false"}
                onClick={() => requestAction({ kind: "select", workflowId: item.id })}
              >
                <span className="workflow-list-name">{item.name || "未命名工作流"}</span>
                <span className="workflow-list-meta">
                  {item.nodeCount} 节点 · {formatShortTime(item.updatedAt, Date.now())}
                  {item.runnable ? "" : ` · 草稿${item.issueCount > 0 ? `（${item.issueCount} 个问题）` : ""}`}
                </span>
                {(item.description || item.whenToUse) && <span className="workflow-list-desc">{item.description ?? item.whenToUse}</span>}
              </button>
            ))}
            {filteredCatalog.length === 0 && !catalogLoading && (
              <p className="workflow-list-empty">
                {workspace ? "这个工作区还没有工作流。点「新建」得到六节点起步模板（规划 / 实施 / 审查 / 测试 / 验收 / 整理）。" : "先在左侧选一个工作区。"}
              </p>
            )}
          </div>
          {catalogError && <p className="workflow-error"><AlertTriangle size={12} />{catalogError}</p>}
          {catalogDiagnostics.length > 0 && (
            <ul className="workflow-list-diagnostics">
              {catalogDiagnostics.slice(0, 5).map((diagnostic) => <li key={diagnostic}><AlertTriangle size={11} />{diagnostic}</li>)}
            </ul>
          )}
          {editor && (
            <div className="workflow-list-actions">
              <button type="button" data-control="workflow-copy" title="复制当前工作流" onClick={() => requestAction({ kind: "copy" })}><Copy size={12} />复制</button>
              <button
                type="button"
                className="danger ghost"
                data-control="workflow-delete"
                title="删除这个定义（不影响已有运行记录）"
                onClick={() => editor.workflowId && setDeleteTarget({ workflowId: editor.workflowId, name: editor.draft.name })}
                disabled={!editor.workflowId}
              >
                <Trash2 size={12} />删除
              </button>
            </div>
          )}
        </section>
        {view === "edit" ? (
          <section className="workflow-main" data-pane="workflow-main">
            {!editor ? (
              <div className="workflow-main-empty">
                <Layers size={20} />
                <p>{editorLoading ? "正在读取…" : "左侧选一个工作流，或新建一个。"}</p>
              </div>
            ) : (
              <>
                <div className="workflow-main-bar">
                  <input
                    className="workflow-main-name"
                    value={editor.draft.name}
                    maxLength={64}
                    aria-label="工作流名称"
                    onChange={(event) => patchDefinition({ name: event.target.value.slice(0, 64) })}
                  />
                  <span className={`workflow-badge${dirty ? " is-dirty" : ""}`}>{dirty ? "未保存" : "已保存"}</span>
                  {issues.length > 0 && <span className="workflow-badge is-issue"><AlertTriangle size={11} />{issues.length} 个运行问题</span>}
                  {plannedExecutions !== undefined && <span className="workflow-badge">最多 {plannedExecutions} 次节点执行</span>}
                  <span className="workflow-main-spacer" />
                  <button type="button" data-control="workflow-save" disabled={saving || !dirty} onClick={() => void persistDraft()}>
                    {saving ? <LoaderCircle size={12} className="spinning" /> : <Save size={12} />}保存
                  </button>
                  <button type="button" className="primary" data-control="workflow-run" disabled={runBusy} onClick={() => { setRunError(undefined); setRunInput(""); }}>
                    {runBusy ? <LoaderCircle size={12} className="spinning" /> : <Play size={12} />}运行
                  </button>
                  {liveRun && (
                    <button
                      type="button"
                      className="danger ghost"
                      data-control="workflow-stop"
                      disabled={stoppingRunId === liveRun.runId || liveRun.status === "stopping"}
                      onClick={() => void stopActiveRun(liveRun.runId)}
                      title="停止这次运行：先取消本 run 的权限等待与当前节点，不影响 owner 会话自己的回合"
                    >
                      <CircleStop size={12} />{stoppingRunId === liveRun.runId || liveRun.status === "stopping" ? "停止中…" : "停止运行"}
                    </button>
                  )}
                </div>
                {foreignWorkspace && (
                  <p className="workflow-notice is-warning" data-workflow-foreign-workspace="true">
                    <AlertTriangle size={12} />当前草稿属于「{workspaceDisplayName(editor.workspace) ?? editor.workspace}」：保存、删除与运行都仍写回那个工作区；要编辑新工作区的工作流请先在左侧重新选择。
                  </p>
                )}
                {overlayMismatch && (
                  <p className="workflow-notice is-warning" data-workflow-run-snapshot-mismatch="true">
                    <AlertTriangle size={12} />画布不着色：这条运行（{overlayCandidate?.workflowName}）启动时的定义与当前草稿/已存版本不一致，或它属于别的会话。运行状态以冻结快照为准，请到「运行历史」查看。
                  </p>
                )}
                {saveError && <p className="workflow-error"><AlertTriangle size={12} />{saveError}<button type="button" className="workflow-link" onClick={() => setSaveError(undefined)}>知道了</button></p>}
                {saveNotice && <p className="workflow-notice"><Check size={12} />{saveNotice}</p>}
                {runError && <p className="workflow-error"><AlertTriangle size={12} />{runError}</p>}
                {runNotice && <p className="workflow-notice"><Check size={12} />{runNotice}<button type="button" className="workflow-link" onClick={() => setView("runs")}>查看运行</button></p>}
                <div className="workflow-main-columns">
                  <WorkflowCanvas
                    definition={editor.draft}
                    {...(selectedNodeId ? { selectedNodeId } : {})}
                    {...(selectedEdgeId ? { selectedEdgeId } : {})}
                    issues={issues}
                    {...(overlayRun ? {
                      run: {
                        nodeStates: overlayStates,
                        ...(overlayCurrentNodeId ? { currentNodeId: overlayCurrentNodeId } : {}),
                        attempt: overlayRun.currentAttempt,
                        maxAttempts: overlayRun.maxAttempts
                      }
                    } : {})}
                    onSelectNode={(nodeId) => { setSelectedNodeId(nodeId); if (nodeId) setSelectedEdgeId(undefined); }}
                    onSelectEdge={(edgeId) => { setSelectedEdgeId(edgeId); if (edgeId) setSelectedNodeId(undefined); }}
                    onMoveNode={(nodeId, position) => setEditor((current) => current ? { ...current, draft: moveWorkflowNode(current.draft, nodeId, position) } : current)}
                    onAddNode={(kind) => {
                      const { definition, node } = addWorkflowNode(editor.draft, kind ? { kind } : {});
                      updateDraft(definition);
                      setSelectedNodeId(node.id);
                      setSelectedEdgeId(undefined);
                    }}
                    onDeleteNode={deleteNode}
                    onDeleteEdge={(edgeId) => setEditor((current) => current ? { ...current, draft: removeWorkflowEdge(current.draft, edgeId) } : current)}
                    onConnect={connectNodes}
                  />
                  <WorkflowNodeInspector
                    definition={editor.draft}
                    {...(selectedNodeId ? { nodeId: selectedNodeId } : {})}
                    models={models}
                    providers={providers}
                    subagents={subagents}
                    issues={issues}
                    {...(plannedExecutions !== undefined ? { planExecutions: plannedExecutions } : {})}
                    {...(nodeExecutions.length > 0 ? { executions: nodeExecutions } : {})}
                    {...(runDetail?.selectedExecutionId ? { selectedExecutionId: runDetail.selectedExecutionId } : {})}
                    {...(inspectorArtifact ? { artifact: inspectorArtifact } : {})}
                    {...(resolvedModel ? { resolvedModel } : {})}
                    onChangeNode={(patch) => selectedNodeId && patchNode(selectedNodeId, patch)}
                    onChangeDefinition={patchDefinition}
                    onChangeRework={patchRework}
                    onDeleteNode={() => selectedNodeId && deleteNode(selectedNodeId)}
                    onDeselectNode={() => setSelectedNodeId(undefined)}
                    onSelectExecution={(executionId) => {
                      setRunDetail((current) => current ? { ...current, selectedExecutionId: executionId } : current);
                      if (runDetail?.contents[executionId]?.artifact === undefined) void loadArtifact(executionId);
                    }}
                    onOpenRunDetails={() => setView("runs")}
                  />
                </div>
              </>
            )}
          </section>
        ) : (
          <section className="workflow-runs" data-pane="workflow-runs">
            <div className="workflow-runs-list">
              <div className="workflow-runs-toolbar">
                <strong>运行记录</strong>
                <button type="button" data-control="workflow-runs-refresh" disabled={historyLoading} onClick={() => void loadHistory()}>
                  <RefreshCw size={11} className={historyLoading ? "spinning" : undefined} />刷新
                </button>
              </div>
              {mergedRuns.map((run) => (
                <button
                  type="button"
                  key={run.runId}
                  className={`workflow-runs-row${runDetail?.runId === run.runId ? " active" : ""}`}
                  data-control="workflow-run-open"
                  data-run-id={run.runId}
                  onClick={() => void openRun(run.runId)}
                >
                  <span className="workflow-runs-name">{run.workflowName}</span>
                  <span className={`workflow-run-status status-${run.status}`}>{WORKFLOW_RUN_STATUS_LABELS[run.status]}</span>
                  <span className="workflow-runs-meta">
                    {formatShortTime(run.startedAt, Date.now())}
                    {run.maxAttempts > 1 ? ` · 第 ${run.currentAttempt}/${run.maxAttempts} 轮` : ""}
                    {agentId && run.agentId !== agentId ? " · 其他助手" : ""}
                    {run.external ? " · 其他实例" : ""}
                  </span>
                </button>
              ))}
              {mergedRuns.length === 0 && !historyLoading && <p className="workflow-list-empty">还没有运行记录。运行一次后这里会列出每轮的节点与产物。</p>}
              {historyError && <p className="workflow-error"><AlertTriangle size={12} />{historyError}</p>}
              {historyCursor && (
                <button type="button" className="workflow-link" data-control="workflow-runs-more" onClick={() => void loadHistory(historyCursor)}>加载更多</button>
              )}
            </div>
            <div className="workflow-runs-detail">
              {runDetail?.run && runDetail.definition ? (
                <WorkflowRunDetails
                  run={runDetail.run}
                  definition={runDetail.definition}
                  loading={runDetail.loading}
                  {...(runDetail.error ? { error: runDetail.error } : {})}
                  {...(runDetail.selectedExecutionId ? { selectedExecutionId: runDetail.selectedExecutionId } : {})}
                  contents={runDetail.contents}
                  onSelectExecution={(executionId) => setRunDetail((current) => current ? { ...current, selectedExecutionId: executionId } : current)}
                  onLoadArtifact={(executionId) => void loadArtifact(executionId)}
                  onLoadTranscript={(executionId) => void loadTranscriptPage(executionId, "start")}
                  onLoadMoreTranscript={(executionId) => void loadTranscriptPage(executionId, "more")}
                  onLoadNextWindow={(executionId) => void loadTranscriptPage(executionId, "more")}
                  onLoadPreviousWindow={(executionId) => void loadTranscriptPage(executionId, "previous")}
                  onRestartTranscript={(executionId) => void loadTranscriptPage(executionId, "start")}
                  onStop={() => void stopActiveRun(runDetail.run!.runId)}
                  stopping={stoppingRunId === runDetail.run.runId || runDetail.run.status === "stopping"}
                  onClose={() => setRunDetail(undefined)}
                />
              ) : (
                <div className="workflow-main-empty">
                  {runDetail?.loading ? <LoaderCircle size={18} className="spinning" /> : <ListTree size={18} />}
                  <p>{runDetail?.error ?? (runDetail?.loading ? "正在读取运行记录…" : "选一条运行记录查看每轮节点、gate 裁决与产物。")}</p>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
      {pendingAction && (
        <div className="workflow-dialog-backdrop" onClick={() => setPendingAction(undefined)}>
          <div className="workflow-dialog" role="dialog" aria-modal="true" aria-label="有未保存的修改" onClick={(event) => event.stopPropagation()}>
            <h3>有未保存的修改</h3>
            <p>「{editor?.draft.name}」有未保存的修改。要先保存吗？</p>
            <div className="workflow-dialog-actions">
              <button type="button" className="primary" data-control="workflow-dirty-save" disabled={saving} onClick={() => void saveThenContinue()}>
                {saving ? <LoaderCircle size={12} className="spinning" /> : <Save size={12} />}保存并继续
              </button>
              <button type="button" data-control="workflow-dirty-discard" onClick={() => void applyAction(pendingAction)}>放弃修改</button>
              <button type="button" data-control="workflow-dirty-cancel" onClick={() => setPendingAction(undefined)}>取消</button>
            </div>
            {saveError && <p className="workflow-error"><AlertTriangle size={12} />{saveError}</p>}
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className="workflow-dialog-backdrop" onClick={() => setDeleteTarget(undefined)}>
          <div className="workflow-dialog" role="dialog" aria-modal="true" aria-label="删除工作流" onClick={(event) => event.stopPropagation()}>
            <h3>删除工作流</h3>
            <p>要删除「{deleteTarget.name}」吗？只删定义文件，已有运行记录与产物保留。</p>
            <div className="workflow-dialog-actions">
              <button type="button" className="danger" data-control="workflow-delete-confirm" onClick={() => void confirmDelete()}><Trash2 size={12} />确认删除</button>
              <button type="button" data-control="workflow-delete-cancel" onClick={() => setDeleteTarget(undefined)}>取消</button>
            </div>
          </div>
        </div>
      )}
      {runInput !== undefined && editor && (
        <div className="workflow-dialog-backdrop" onClick={() => setRunInput(undefined)}>
          <div className="workflow-dialog workflow-run-dialog" role="dialog" aria-modal="true" aria-label="运行工作流" onClick={(event) => event.stopPropagation()}>
            <h3>运行「{editor.draft.name}」</h3>
            <p className="workflow-field-note">{editor.draft.inputHint || "这次要完成的需求与验收标准；会作为 {{input}} 注入每个节点。"}</p>
            <textarea
              className="workflow-run-input"
              value={runInput}
              rows={7}
              aria-label="运行输入"
              data-control="workflow-run-input"
              placeholder="要做什么、涉及哪些文件、怎样算通过…"
              onChange={(event) => setRunInput(event.target.value)}
            />
            <p className={`workflow-field-note${runInputBytes > MAX_WORKFLOW_INPUT_BYTES ? " is-error" : ""}`}>
              {(runInputBytes / 1024).toFixed(1)} KiB / 16 KiB
              {ownerSessionId ? "" : " · 没有现成的 owner 会话，受理时会新建一个"}
              {` · 运行前会先把草稿保存成功再受理`}
            </p>
            {runError && <p className="workflow-error"><AlertTriangle size={12} />{runError}</p>}
            <div className="workflow-dialog-actions">
              <button type="button" className="primary" data-control="workflow-run-start" disabled={runBusy || runInputBytes > MAX_WORKFLOW_INPUT_BYTES} onClick={() => void startRun()}>
                {runBusy ? <LoaderCircle size={12} className="spinning" /> : <Play size={12} />}开始运行
              </button>
              <button type="button" data-control="workflow-run-cancel" onClick={() => setRunInput(undefined)}>取消</button>
            </div>
            {groupedIssues.general.length > 0 && (
              <ul className="workflow-inspector-issues">
                {groupedIssues.general.slice(0, 4).map((issue, index) => <li key={`${issue.code}-${index}`}><AlertTriangle size={11} />{workflowIssueText(issue)}</li>)}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
