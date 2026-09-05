import { Maximize, Redo2, Send, Undo2, ZoomIn, ZoomOut, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { applyDesignOps, cloneNodeWithNewIds, findNode, summarizeNode, type DesignDoc, type DesignNode, type DesignOp, type DesignNodePatch } from "../../../shared/design-schema.js";
import { useDesktopStore } from "../store";
import { absoluteRects, boundingBox } from "./design-geometry.js";
import { DesignCanvas, MAX_ZOOM, MIN_ZOOM } from "./DesignCanvas.js";
import { DesignInspector } from "./DesignInspector.js";
import { DesignLayers } from "./DesignLayers.js";

/**
 * 设计工作台外壳：顶部工具栏 + 左侧图层树 + 画布 + 右侧属性检查器。
 *
 * 编辑流（乐观更新 + 单管道）：用户操作先本地应用 applyDesignOps（拖动/输入即时
 * 可见），变更按收敛时机（拖动结束 / 属性输入防抖 300ms）以 design.edit 发送；
 * utility 写盘后 revision+1 回推 design.state——发送期间挂起的回声按 pendingEdits
 * 计数消费（本地已含该变更，不再重渲）；非回声推送视为 AI/外部修改，采纳前入
 * undo 快照栈，因此 AI 与用户的改动都可 Ctrl+Z 撤销（undo 用 replace 整树回写）。
 */

const UNDO_LIMIT = 50;
const FLUSH_DELAY_MS = 300;

export function DesignStudio({ onSendToAi }: { onSendToAi(text: string): void }): ReactNode {
  const remote = useDesktopStore((state) => state.designDoc);
  const designDocs = useDesktopStore((state) => state.designDocs);

  const [workingDoc, setWorkingDoc] = useState<DesignDoc | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [newDraft, setNewDraft] = useState({ name: "未命名设计", width: 1440, height: 1024 });
  const [busy, setBusy] = useState(false);

  const workingDocRef = useRef<DesignDoc | undefined>(undefined);
  workingDocRef.current = workingDoc;
  const selectedIdRef = useRef<string | undefined>(undefined);
  selectedIdRef.current = selectedId;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const undoRef = useRef<DesignDoc[]>([]);
  const redoRef = useRef<DesignDoc[]>([]);
  const pendingEditsRef = useRef(0);
  const pendingPatchRef = useRef<{ preDoc: DesignDoc; ops: Extract<DesignOp, { op: "update" }>[] } | null | undefined>(undefined);
  const flushTimerRef = useRef<number | undefined>(undefined);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // —— 远程推送同步（回声消费 / 外部修改采纳） ——
  useEffect(() => {
    if (!remote) {
      setWorkingDoc(undefined);
      setSelectedId(undefined);
      return;
    }
    setWorkingDoc((current) => {
      const pushed: DesignDoc = { id: remote.docId, version: 1, name: remote.name, canvas: remote.canvas, nodes: remote.nodes, revision: remote.revision };
      if (!current || current.id !== remote.docId) {
        undoRef.current = [];
        redoRef.current = [];
        pendingEditsRef.current = 0;
        return pushed;
      }
      if (remote.revision > current.revision) {
        if (pendingEditsRef.current > 0) {
          // 自己发出的 design.edit 的回声：本地已含该变更，只对齐 revision。
          pendingEditsRef.current -= 1;
          return { ...current, revision: remote.revision };
        }
        // AI / 其他来源的修改：当前状态入 undo 栈（可撤销 AI 改动），采纳推送。
        undoRef.current = [...undoRef.current.slice(-UNDO_LIMIT + 1), structuredClone(current)];
        redoRef.current = [];
        return pushed;
      }
      return current;
    });
  }, [remote]);

  // 画布视口尺寸（fit 计算 + ResizeObserver 跟随窗口）。
  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setViewport({ w: rect.width, h: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    const doc = workingDocRef.current;
    if (!doc || viewport.w <= 0 || viewport.h <= 0) return;
    const rects = [...absoluteRects(doc.nodes).values()];
    const box = rects.length > 0 ? boundingBox(rects) : { id: "", x: 0, y: 0, w: doc.canvas.width, h: doc.canvas.height };
    if (!box) return;
    const pad = 48;
    const next = clamp(Math.min((viewport.w - pad * 2) / Math.max(box.w, 1), (viewport.h - pad * 2) / Math.max(box.h, 1)), MIN_ZOOM, 1);
    setZoom(next);
    setPan({ x: (viewport.w - box.w * next) / 2 - box.x * next, y: (viewport.h - box.h * next) / 2 - box.y * next });
  }, [viewport]);

  // 切换文档时标记待适配；视口就绪后 fit 一次（首次加载视口测晚于文档到达）。
  const docIdRef = useRef<string | undefined>(undefined);
  const fitPendingRef = useRef(false);
  useEffect(() => {
    if (workingDoc?.id === docIdRef.current) return;
    docIdRef.current = workingDoc?.id;
    fitPendingRef.current = true;
    // 默认展开全部 frame。
    const expanded = new Set<string>();
    const walk = (nodes: readonly DesignNode[]): void => {
      for (const node of nodes) {
        if (node.children && node.children.length > 0) {
          expanded.add(node.id);
          walk(node.children);
        }
      }
    };
    walk(workingDoc?.nodes ?? []);
    setExpandedIds(expanded);
  }, [workingDoc]);
  useEffect(() => {
    if (!fitPendingRef.current || viewport.w <= 0 || viewport.h <= 0 || !workingDoc) return;
    fitPendingRef.current = false;
    fit();
  }, [viewport, workingDoc, fit]);

  // 挂载/激活时刷新文档列表（空态「打开」列表用）。
  useEffect(() => {
    void window.piDesktop.send({ type: "design.list" }).catch(() => undefined);
  }, []);

  const send = useCallback((command: Extract<import("../../../shared/protocol.js").RuntimeCommand, { type: `design.${string}` }>): void => {
    void window.piDesktop.send(command).catch(() => undefined);
  }, []);

  // —— 提交管线 ——
  const commitOps = useCallback((ops: DesignOp[], options?: { preDoc?: DesignDoc; skipApply?: boolean }) => {
    if (ops.length === 0) return;
    if (options?.preDoc) {
      undoRef.current = [...undoRef.current.slice(-UNDO_LIMIT + 1), options.preDoc];
      redoRef.current = [];
    }
    if (!options?.skipApply) {
      setWorkingDoc((current) => {
        if (!current) return current;
        const applied = applyDesignOps(current, ops);
        return applied.ok ? applied.doc : current;
      });
    }
    pendingEditsRef.current += 1;
    send({ type: "design.edit", ops });
  }, [send]);

  const flushPending = useCallback(() => {
    const pending = pendingPatchRef.current;
    pendingPatchRef.current = undefined;
    if (!pending || pending.ops.length === 0) return;
    commitOps(pending.ops, { preDoc: pending.preDoc, skipApply: true });
  }, [commitOps]);

  const flushPendingRef = useRef<() => void>(() => undefined);
  flushPendingRef.current = flushPending;

  /** 属性/拖动的流式变更：立即本地应用，300ms 防抖合并发送（拖动结束可 immediate）。 */
  const stagePatch = useCallback((nodeId: string, patch: DesignNodePatch, immediate = false) => {
    const current = workingDocRef.current;
    if (!current) return;
    if (!pendingPatchRef.current) pendingPatchRef.current = { preDoc: structuredClone(current), ops: [] };
    const existing = pendingPatchRef.current.ops.find((op) => op.id === nodeId);
    if (existing) existing.patch = { ...existing.patch, ...patch };
    else pendingPatchRef.current.ops.push({ op: "update", id: nodeId, patch });
    setWorkingDoc((doc) => {
      if (!doc) return doc;
      const applied = applyDesignOps(doc, [{ op: "update", id: nodeId, patch }]);
      return applied.ok ? applied.doc : doc;
    });
    if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = window.setTimeout(() => flushPendingRef.current(), immediate ? 0 : FLUSH_DELAY_MS);
  }, []);

  // —— 画布尺寸调整（检查器数字框键入）：与节点 patch 同款防抖收敛，一次落盘 ——
  const pendingCanvasRef = useRef<{ preDoc: DesignDoc; patch: { width?: number; height?: number } } | null>(null);
  const canvasTimerRef = useRef<number | undefined>(undefined);
  const resizeCanvas = useCallback((patch: { width?: number; height?: number }): void => {
    const current = workingDocRef.current;
    if (!current) return;
    if (!pendingCanvasRef.current) pendingCanvasRef.current = { preDoc: structuredClone(current), patch: {} };
    pendingCanvasRef.current.patch = { ...pendingCanvasRef.current.patch, ...patch };
    const merged = pendingCanvasRef.current.patch;
    setWorkingDoc((doc) => (doc ? { ...doc, canvas: { ...doc.canvas, ...merged } } : doc));
    if (canvasTimerRef.current) window.clearTimeout(canvasTimerRef.current);
    canvasTimerRef.current = window.setTimeout(() => {
      const pending = pendingCanvasRef.current;
      pendingCanvasRef.current = null;
      if (!pending) return;
      commitOps([{ op: "resize", ...pending.patch }], { preDoc: pending.preDoc, skipApply: true });
    }, FLUSH_DELAY_MS);
  }, [commitOps]);

  // —— undo / redo（replace 整树回写，AI 与用户改动都可撤销） ——
  const applyWholeDoc = useCallback((doc: DesignDoc): void => {
    setWorkingDoc(doc);
    pendingEditsRef.current += 1;
    send({ type: "design.edit", ops: [{ op: "replace", nodes: doc.nodes }] });
  }, [send]);

  const undo = useCallback((): void => {
    const current = workingDocRef.current;
    const previous = undoRef.current.pop();
    if (!current || !previous) return;
    redoRef.current.push(structuredClone(current));
    applyWholeDoc(previous);
  }, [applyWholeDoc]);

  const redo = useCallback((): void => {
    const current = workingDocRef.current;
    const next = redoRef.current.pop();
    if (!current || !next) return;
    undoRef.current.push(structuredClone(current));
    applyWholeDoc(next);
  }, [applyWholeDoc]);

  const deleteSelected = useCallback((): void => {
    const doc = workingDocRef.current;
    const id = selectedIdRef.current;
    if (!doc || !id) return;
    commitOps([{ op: "delete", id }], { preDoc: structuredClone(doc) });
    setSelectedId(undefined);
  }, [commitOps]);

  const duplicateSelected = useCallback((): void => {
    const doc = workingDocRef.current;
    const id = selectedIdRef.current;
    if (!doc || !id) return;
    const found = findNode(doc.nodes, id);
    if (!found) return;
    const clone = cloneNodeWithNewIds(found.node);
    commitOps([{ op: "create", parentId: found.parent?.id ?? null, index: found.index + 1, node: clone }], { preDoc: structuredClone(doc) });
    setSelectedId(clone.id);
  }, [commitOps]);

  // 键盘快捷键（文本输入聚焦时不劫持）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTextInput(document.activeElement)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (mod && (event.key.toLowerCase() === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))) {
        event.preventDefault();
        redo();
      } else if (mod && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicateSelected();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        if (selectedIdRef.current) {
          event.preventDefault();
          deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, duplicateSelected, deleteSelected]);

  const handleZoomChange = useCallback((nextRaw: number, anchor?: { x: number; y: number }): void => {
    const next = clamp(nextRaw, MIN_ZOOM, MAX_ZOOM);
    const previous = zoomRef.current;
    setZoom(next);
    if (!anchor || next === previous) return;
    setPan((current) => ({ x: anchor.x - ((anchor.x - current.x) * next) / previous, y: anchor.y - ((anchor.y - current.y) * next) / previous }));
  }, []);

  const selected = workingDoc && selectedId ? findNode(workingDoc.nodes, selectedId)?.node : undefined;

  const sendSelectionToAi = useCallback((): void => {
    const doc = workingDocRef.current;
    const id = selectedIdRef.current;
    if (!doc || !id) return;
    const found = findNode(doc.nodes, id);
    if (!found) return;
    onSendToAi(`【来自设计画布】文档「${doc.name}」中选中的节点（含子树）：\n${summarizeNode(found.node)}\n\n请用 design_update 修改该节点。`);
  }, [onSendToAi]);

  async function run(command: import("../../../shared/protocol.js").RuntimeCommand): Promise<void> {
    setBusy(true);
    try {
      await window.piDesktop.send(command);
    } finally {
      setBusy(false);
    }
  }

  function closeDoc(): void {
    const docId = workingDoc?.id;
    undoRef.current = [];
    redoRef.current = [];
    pendingEditsRef.current = 0;
    setSelectedId(undefined);
    // 清掉该文档的 seen revision：重开同一文档（revision 可能不增）的推送不被去重丢弃。
    useDesktopStore.setState((state) => {
      if (!docId) return { designDoc: undefined };
      const seen = { ...state.seenDesignRevisions };
      delete seen[docId];
      return { designDoc: undefined, seenDesignRevisions: seen };
    });
    send({ type: "design.close" });
  }

  if (!workingDoc) {
    return (
      <div className="design-studio" data-pane="design">
        <div className="design-empty">
          <h2>设计模式</h2>
          <p>AI 原生前端设计工作台——让 AI 直接读写结构化设计稿，画布实时渲染，导出 HTML 单文件。</p>
          <form
            className="design-empty-create"
            onSubmit={(event) => {
              event.preventDefault();
              void run({ type: "design.new", name: newDraft.name.trim() || "未命名设计", width: newDraft.width, height: newDraft.height });
            }}
          >
            <input value={newDraft.name} placeholder="设计名" aria-label="设计名" onChange={(event) => setNewDraft((draft) => ({ ...draft, name: event.target.value }))} />
            <input type="number" value={newDraft.width} aria-label="画布宽" onChange={(event) => setNewDraft((draft) => ({ ...draft, width: Math.max(1, Math.round(Number(event.target.value) || 0)) }))} />
            <span>×</span>
            <input type="number" value={newDraft.height} aria-label="画布高" onChange={(event) => setNewDraft((draft) => ({ ...draft, height: Math.max(1, Math.round(Number(event.target.value) || 0)) }))} />
            <button className="primary-button" type="submit" disabled={busy}>新建设计</button>
          </form>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => onSendToAi("请用 design_create 新建一个设计文档，然后用 design_update 画一个简洁的登录页：浅灰背景、居中白色卡片（frame auto-layout）、标题、两个输入框与一个主按钮，为每个节点起 name。画布完成后用 design_export 导出 HTML。")}
          >
            用 AI 生成一个页面
          </button>
          {designDocs.length > 0 && (
            <div className="design-empty-open">
              <div className="design-empty-open-heading">或打开已有文档</div>
              <div className="design-empty-open-list">
                {designDocs.map((entry) => (
                  <button key={entry.id} type="button" className="design-empty-open-item" disabled={busy} title={entry.relativePath} onClick={() => void run({ type: "design.open", name: entry.name })}>
                    <strong>{entry.name}</strong>
                    <em>{entry.width}×{entry.height} · {entry.nodeCount} 节点</em>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="design-studio" data-pane="design">
      <div className="design-toolbar" data-pane="design-toolbar">
        <span className="design-toolbar-doc" title={workingDoc.name}>{workingDoc.name}</span>
        <span className="design-toolbar-revision">r{workingDoc.revision}</span>
        <span className="design-toolbar-sep" />
        <button className="icon-button" type="button" data-control="design-undo" title="撤销 (Ctrl+Z)" aria-label="撤销" disabled={undoRef.current.length === 0} onClick={() => undo()}><Undo2 size={15} /></button>
        <button className="icon-button" type="button" data-control="design-redo" title="重做 (Ctrl+Y)" aria-label="重做" disabled={redoRef.current.length === 0} onClick={() => redo()}><Redo2 size={15} /></button>
        <span className="design-toolbar-sep" />
        <button className="icon-button" type="button" title="缩小" aria-label="缩小" onClick={() => handleZoomChange(zoom / 1.25)}><ZoomOut size={15} /></button>
        <span className="design-toolbar-zoom">{Math.round(zoom * 100)}%</span>
        <button className="icon-button" type="button" title="放大" aria-label="放大" onClick={() => handleZoomChange(zoom * 1.25)}><ZoomIn size={15} /></button>
        <button className="icon-button" type="button" title="适配内容" aria-label="适配内容" onClick={fit}><Maximize size={15} /></button>
        <span className="design-toolbar-flex" />
        <button className="icon-button" type="button" data-control="design-send-ai" title="把选中节点发给 AI 修改" aria-label="发给 AI" disabled={!selectedId} onClick={sendSelectionToAi}><Send size={15} /></button>
        <button className="secondary-button compact-button" type="button" data-control="design-export" disabled={busy} onClick={() => void run({ type: "design.export" })}>导出 HTML</button>
        <button className="icon-button" type="button" title="关闭文档" aria-label="关闭文档" disabled={busy} onClick={closeDoc}><X size={15} /></button>
      </div>
      <div className="design-body">
        <DesignLayers
          nodes={workingDoc.nodes}
          selectedId={selectedId}
          expandedIds={expandedIds}
          onSelect={(nodeId) => setSelectedId(nodeId)}
          onToggleVisible={(node) => {
            const doc = workingDocRef.current;
            commitOps([{ op: "update", id: node.id, patch: { visible: node.visible === false ? true : false } }], doc ? { preDoc: structuredClone(doc) } : undefined);
          }}
        />
        <div className="design-canvas-wrapper" ref={wrapperRef}>
          <DesignCanvas
            doc={workingDoc}
            zoom={zoom}
            pan={pan}
            onPanChange={setPan}
            onZoomChange={handleZoomChange}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onNodePatch={(nodeId, patch, immediate) => stagePatch(nodeId, patch, immediate)}
            onGestureEnd={() => flushPendingRef.current()}
          />
        </div>
        <DesignInspector doc={workingDoc} selected={selected} onPatch={(nodeId, patch) => stagePatch(nodeId, patch)} onCanvasPatch={resizeCanvas} />
      </div>
    </div>
  );
}

function isTextInput(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (element as HTMLElement).isContentEditable;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
