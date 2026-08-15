import "vditor/dist/index.css";
import Vditor from "vditor";
import { AlertCircle, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/** 编辑器保存状态，用于预览面板右上角的反馈指示器。 */
export type EditorSaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

/**
 * 远程内容加载信号。父组件在 AI 修改了同一文件、且本地无未保存改动时，递增 nonce 并
 * 带上最新内容，触发编辑器整体替换为 AI 版本。nonce 变化才生效，相同 nonce 被忽略。
 */
export interface MarkdownEditorRemoteReload {
  content: string;
  nonce: number;
}

export interface MarkdownEditorProps {
  /** 所属预览 tab 的 id，所有上报回调都会带上它，避免异步完成后写错 tab。 */
  tabId: string;
  relativePath: string;
  initialContent: string;
  workspace?: string;
  /**
   * initialContent 是否来自磁盘（或已成功落盘）。父组件对正在编辑的 tab 维护乐观
   * 快照：切走再切回时 initialContent 可能含尚未写盘的改动，此时置 false，避免
   * 重挂载后把未保存内容误判为“已保存”。默认 true。
   */
  contentPersisted?: boolean;
  /** 外部（AI）修改了该文件且本地有未保存改动时置 true，显示冲突提示条。 */
  externalConflict?: boolean;
  remoteReload?: MarkdownEditorRemoteReload;
  onDirtyChange?: (dirty: boolean) => void;
  /** 内容变化即上报（乐观同步：父组件据此刷新预览 tab 快照，切走再切回不丢内容）。 */
  onContentChange?: (tabId: string, content: string) => void;
  /** 落盘成功后回调，content 为刚写入的内容（父组件据此同步预览 tab 的文件快照）。 */
  onSaved?: (tabId: string, content: string) => void;
  /** 保存状态变化（用于右上角“保存中…/已保存/保存失败”指示器）。 */
  onStatusChange?: (tabId: string, status: EditorSaveStatus) => void;
  onSaveError?: (message: string) => void;
  onResolveConflict?: (choice: "keep-local" | "load-remote") => void;
}

/** dev 走 vite dev server 的 /lib/vditor；打包后 file:// 走相对路径 ./lib/vditor。 */
function vditorCdn(): string {
  return import.meta.env.DEV ? "/lib/vditor" : "./lib/vditor";
}

/** 应用当前有效主题（App.tsx 会把结果写到 documentElement 的 data-theme-effective）。 */
function effectiveTheme(): "dark" | "classic" {
  return document.documentElement.dataset.themeEffective === "dark" ? "dark" : "classic";
}

/** 代码块高亮主题跟随亮/暗：亮色用 github，暗色用 github-dark。 */
function hljsStyle(): string {
  return effectiveTheme() === "dark" ? "github-dark" : "github";
}

const AUTOSAVE_DEBOUNCE_MS = 800;
/** 观察器兜底的节流间隔：Vditor IR 模式每次按键都会重绘 DOM，无需每次都取全文。 */
const OBSERVER_THROTTLE_MS = 120;

/**
 * Typora 风格的即时渲染（IR）Markdown 编辑器。基于 Vditor，光标所在块显示源码、其余
 * 块直接渲染；停顿 800ms 自动写盘，Ctrl+S 立即写盘；支持 AI 变更的智能合并。
 *
 * 保存管线（相对旧版修复的问题）：
 * - 不再只依赖 Vditor 的 input 回调：IR 模式对 setext 标题/分割线等编辑会直接 return
 *   不触发回调，这里用 MutationObserver 兜底，任何 DOM 变化都会同步值并安排保存。
 * - persist 采用“写完后追赶最新值”的循环：写盘期间的新输入在 finally 里补写，不会丢尾部。
 * - 每次内容变化即时上报父组件（乐观快照），切 tab/切预览不会回退到旧内容。
 * - 保存状态（保存中/已保存/保存失败）上报给父组件，在预览面板右上角展示。
 */
export function MarkdownEditor(props: MarkdownEditorProps): ReactNode {
  const { tabId, relativePath, initialContent, externalConflict, remoteReload } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const vditorRef = useRef<Vditor | null>(null);
  const readyRef = useRef(false);
  const aliveRef = useRef(true);
  const dirtyRef = useRef(false);
  const writingRef = useRef(false);
  const composingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastObserverSyncRef = useRef(0);
  // 编辑器当前内容始终走这里：写盘取最新值，写盘期间的新输入不会被丢弃。
  const latestValueRef = useRef(initialContent);
  // 最后一次已知的磁盘内容（成功落盘或从磁盘加载）。undefined 表示初始内容尚未
  // 落盘（父组件乐观快照重挂载）：任何内容都被视为未保存，Ctrl+S 会真实写盘。
  const lastSavedRef = useRef<string | undefined>(props.contentPersisted !== false ? initialContent : undefined);
  // 父组件标记的“初始内容已落盘”状态；after 里据此决定 lastSavedRef 的基准。
  const persistedRef = useRef(props.contentPersisted !== false);
  persistedRef.current = props.contentPersisted !== false;
  const [saveError, setSaveError] = useState<string>();

  // 把会随渲染变化的值存进 ref，避免重建 Vditor 或让回调读到过期闭包。
  const relativePathRef = useRef(relativePath);
  relativePathRef.current = relativePath;
  const workspaceRef = useRef(props.workspace);
  workspaceRef.current = props.workspace;
  const onDirtyChangeRef = useRef(props.onDirtyChange);
  onDirtyChangeRef.current = props.onDirtyChange;
  const onContentChangeRef = useRef(props.onContentChange);
  onContentChangeRef.current = props.onContentChange;
  const onSavedRef = useRef(props.onSaved);
  onSavedRef.current = props.onSaved;
  const onStatusChangeRef = useRef(props.onStatusChange);
  onStatusChangeRef.current = props.onStatusChange;
  const onSaveErrorRef = useRef(props.onSaveError);
  onSaveErrorRef.current = props.onSaveError;

  function reportStatus(status: EditorSaveStatus): void {
    // 卸载后仍上报（父组件靠它收起指示器），只是不再触碰本组件状态。
    onStatusChangeRef.current?.(tabId, status);
  }

  function markDirty(): void {
    if (!dirtyRef.current) {
      dirtyRef.current = true;
      onDirtyChangeRef.current?.(true);
    }
    reportStatus("dirty");
  }

  /** 落盘最新值。写盘期间再次调用会返回，由成功后的追赶逻辑补写；无变化时直接清理 dirty。 */
  function persist(): void {
    if (writingRef.current) return;
    const value = latestValueRef.current;
    if (value === lastSavedRef.current) {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        onDirtyChangeRef.current?.(false);
        reportStatus("idle");
      }
      return;
    }
    writingRef.current = true;
    reportStatus("saving");
    window.piDesktop
      .writeWorkspaceFile(relativePathRef.current, value, workspaceRef.current)
      .then(() => {
        lastSavedRef.current = value;
        dirtyRef.current = false;
        onDirtyChangeRef.current?.(false);
        onSavedRef.current?.(tabId, value);
        writingRef.current = false;
        // 写盘期间又有新输入 → 立即补写一次，避免尾部改动被丢弃。仅成功路径
        // 补写：失败时保留“保存失败”状态等待用户重试，避免无限重试循环。
        if (latestValueRef.current !== lastSavedRef.current) {
          persist();
          return;
        }
        reportStatus("saved");
      })
      .catch((error: unknown) => {
        writingRef.current = false;
        const message = error instanceof Error ? error.message : "保存文件失败";
        if (aliveRef.current) setSaveError(message);
        reportStatus("error");
        onSaveErrorRef.current?.(message);
      });
  }

  function scheduleSave(): void {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      persist();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function syncLatestFromEditor(): void {
    try {
      latestValueRef.current = vditorRef.current?.getValue() ?? latestValueRef.current;
    } catch {
      /* 编辑器已销毁则保留已知值 */
    }
  }

  // 初始化 Vditor（仅一次；不同文件由父组件用 key 区分，会重新挂载）。
  useEffect(() => {
    aliveRef.current = true;
    const el = containerRef.current;
    if (!el) return;
    readyRef.current = false;
    const vditor = new Vditor(el, {
      mode: "ir",
      cdn: vditorCdn(),
      theme: effectiveTheme(),
      value: initialContent,
      height: "100%",
      cache: { enable: false },
      toolbar: [
        "headings", "bold", "italic", "|",
        "strike", "quote", "|",
        "list", "ordered-list", "check", "|",
        "code", "inline-code", "link", "table", "|",
        "undo", "redo"
      ],
      toolbarConfig: { pin: true },
      preview: { hljs: { lineNumber: true, style: hljsStyle() } },
      after: () => {
        readyRef.current = true;
        // 以编辑器当前内容为准：Vditor IR 的 getValue() 是 Lute 的往返转换（行尾
        // 归一化、补末尾换行等），且初始化期间用户的输入也会体现在这里。
        let current = latestValueRef.current;
        try {
          current = vditor.getValue() ?? latestValueRef.current;
        } catch {
          /* 编辑器尚未就绪则保留已知值 */
        }
        latestValueRef.current = current;
        if (!persistedRef.current) {
          // 父组件标记初始内容尚未落盘（乐观快照重挂载）：一律视为未保存。
          lastSavedRef.current = undefined;
          markDirty();
        } else if (dirtyRef.current) {
          // 初始化期间已有输入：当前值包含未落盘的编辑，磁盘基准仍是初始内容。
          // 绝不能把含编辑的内容标记为“已保存”，否则 Ctrl+S 会假保存丢改动。
          lastSavedRef.current = initialContent;
          markDirty();
        } else {
          // 无输入时的差异只是编辑器规范化（行尾/末尾换行等）：以规范值为基准，
          // 避免打开 CRLF 文件误报“未保存”，或未编辑时切走被静默改写行尾。
          lastSavedRef.current = current;
        }
        // 初始化期间到达的 AI 变更在此补应用（effect 就绪前不会消费其 nonce）。
        const pendingReload = remoteReloadRef.current;
        if (pendingReload && pendingReload.nonce !== lastNonceRef.current) applyRemoteReload(pendingReload);
      },
      input: (value: string) => {
        latestValueRef.current = value;
        if (aliveRef.current) setSaveError(undefined);
        markDirty();
        onContentChangeRef.current?.(tabId, value);
        scheduleSave();
      }
    });
    vditorRef.current = vditor;

    // IME 组合期间不安排保存，避免把拼音中间态写盘。
    const onCompositionStart = (): void => { composingRef.current = true; };
    const onCompositionEnd = (): void => { composingRef.current = false; };
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);

    // 兜底：Vditor IR 模式对部分编辑（setext 标题、分割线等）不触发 input 回调，
    // 观察 DOM 变化后同步值并安排保存，保证任何改动都不会静默丢失。
    const observer = new MutationObserver(() => {
      if (!readyRef.current || composingRef.current) return;
      const now = Date.now();
      if (now - lastObserverSyncRef.current < OBSERVER_THROTTLE_MS) return;
      lastObserverSyncRef.current = now;
      let value: string;
      try {
        value = vditor.getValue();
      } catch {
        return;
      }
      if (value === latestValueRef.current) return;
      latestValueRef.current = value;
      markDirty();
      onContentChangeRef.current?.(tabId, value);
      scheduleSave();
    });
    observer.observe(el, { childList: true, subtree: true, characterData: true });

    return () => {
      aliveRef.current = false;
      composingRef.current = false;
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
      observer.disconnect();
      if (saveTimerRef.current) {
        // 卸载前立即落盘未保存的改动（避免切 tab 时丢失 800ms 防抖窗口内的输入）
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      syncLatestFromEditor();
      persist();
      try {
        vditor.destroy();
      } catch {
        /* 编辑器已销毁则忽略 */
      }
      vditorRef.current = null;
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl/Cmd+S 立即保存（取消挂起的防抖保存）。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        syncLatestFromEditor();
        if (latestValueRef.current === lastSavedRef.current) {
          // 已是最新内容：仍给出“已保存”反馈。
          reportStatus("saved");
        } else {
          persist();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 应用主题切换时同步编辑器主题（Vditor 的 vditor--dark 类 + 代码高亮主题），无需重建编辑器。
  useEffect(() => {
    let lastTheme = effectiveTheme();
    const observer = new MutationObserver(() => {
      const next = effectiveTheme();
      if (next === lastTheme) return;
      lastTheme = next;
      const vditor = vditorRef.current;
      if (!vditor || !readyRef.current) return;
      vditor.setTheme(next, undefined, hljsStyle());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-effective"] });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AI 变更同步：nonce 变化时整体替换内容（仅在外部触发、本地无未保存改动时由父组件发出）。
  const lastNonceRef = useRef<number | undefined>(remoteReload?.nonce);
  const remoteReloadRef = useRef(remoteReload);
  remoteReloadRef.current = remoteReload;
  function applyRemoteReload(remote: MarkdownEditorRemoteReload): void {
    if (remote.nonce === lastNonceRef.current) return;
    lastNonceRef.current = remote.nonce;
    const vditor = vditorRef.current;
    // 编辑器尚未就绪时不消费 nonce：after 回调会再次尝试应用，避免重载被丢弃。
    if (!vditor || !readyRef.current) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    latestValueRef.current = remote.content;
    // AI 已把内容写入磁盘，编辑器与磁盘一致，无需再写盘。
    lastSavedRef.current = remote.content;
    vditor.setValue(remote.content);
    dirtyRef.current = false;
    onDirtyChangeRef.current?.(false);
    onContentChangeRef.current?.(tabId, remote.content);
    reportStatus("idle");
  }
  useEffect(() => {
    if (!remoteReload) return;
    applyRemoteReload(remoteReload);
  }, [remoteReload]);

  return (
    <div className="markdown-editor">
      {externalConflict && (
        <div className="markdown-editor-conflict" role="alert">
          <AlertCircle size={14} />
          <span>该文件已被 AI 修改</span>
          <button type="button" className="markdown-editor-conflict-btn" onClick={() => props.onResolveConflict?.("keep-local")}>保留我的</button>
          <button type="button" className="markdown-editor-conflict-btn primary" onClick={() => props.onResolveConflict?.("load-remote")}>加载 AI 版本</button>
        </div>
      )}
      {saveError && (
        <div className="markdown-editor-conflict markdown-editor-save-error" role="alert">
          <AlertCircle size={14} />
          <span>{`保存失败：${saveError}`}</span>
          <button type="button" className="markdown-editor-conflict-btn primary" onClick={() => { setSaveError(undefined); persist(); }}>重试</button>
          <button type="button" className="markdown-editor-conflict-btn" aria-label="关闭保存失败提示" onClick={() => setSaveError(undefined)}><X size={12} /></button>
        </div>
      )}
      <div className="markdown-editor-host" ref={containerRef} />
    </div>
  );
}
