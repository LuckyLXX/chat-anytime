import "vditor/dist/index.css";
import Vditor from "vditor";
import { AlertCircle } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/**
 * 远程内容加载信号。父组件在 AI 修改了同一文件、且本地无未保存改动时，递增 nonce 并
 * 带上最新内容，触发编辑器整体替换为 AI 版本。nonce 变化才生效，相同 nonce 被忽略。
 */
export interface MarkdownEditorRemoteReload {
  content: string;
  nonce: number;
}

export interface MarkdownEditorProps {
  relativePath: string;
  initialContent: string;
  workspace?: string;
  /** 外部（AI）修改了该文件且本地有未保存改动时置 true，显示冲突提示条。 */
  externalConflict?: boolean;
  remoteReload?: MarkdownEditorRemoteReload;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
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

/**
 * Typora 风格的即时渲染（IR）Markdown 编辑器。基于 Vditor，光标所在块显示源码、其余
 * 块直接渲染；停顿 800ms 自动写盘，Ctrl+S 立即写盘；支持 AI 变更的智能合并。
 */
export function MarkdownEditor(props: MarkdownEditorProps): ReactNode {
  const { relativePath, initialContent, externalConflict, remoteReload } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const vditorRef = useRef<Vditor | null>(null);
  const readyRef = useRef(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 把会随渲染变化的值存进 ref，避免重建 Vditor 或让 input 回调读到过期闭包。
  const relativePathRef = useRef(relativePath);
  relativePathRef.current = relativePath;
  const workspaceRef = useRef(props.workspace);
  workspaceRef.current = props.workspace;
  const onDirtyChangeRef = useRef(props.onDirtyChange);
  onDirtyChangeRef.current = props.onDirtyChange;
  const onSavedRef = useRef(props.onSaved);
  onSavedRef.current = props.onSaved;
  const onSaveErrorRef = useRef(props.onSaveError);
  onSaveErrorRef.current = props.onSaveError;

  function persist(value: string): Promise<void> {
    if (savingRef.current) return Promise.resolve();
    savingRef.current = true;
    return window.piDesktop
      .writeWorkspaceFile(relativePathRef.current, value, workspaceRef.current)
      .then(() => {
        dirtyRef.current = false;
        onDirtyChangeRef.current?.(false);
        onSavedRef.current?.();
      })
      .catch((error: unknown) => {
        onSaveErrorRef.current?.(error instanceof Error ? error.message : "保存文件失败");
      })
      .finally(() => {
        savingRef.current = false;
      });
  }

  function scheduleSave(value: string): void {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persist(value);
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  // 初始化 Vditor（仅一次；不同文件由父组件用 key 区分，会重新挂载）。
  useEffect(() => {
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
      },
      input: (value: string) => {
        if (!dirtyRef.current) {
          dirtyRef.current = true;
          onDirtyChangeRef.current?.(true);
        }
        scheduleSave(value);
      }
    });
    vditorRef.current = vditor;
    return () => {
      if (saveTimerRef.current) {
        // 卸载前立即落盘未保存的改动（避免切 tab 时丢失 800ms 防抖窗口内的输入）
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        try {
          void persist(vditor.getValue());
        } catch {
          /* 编辑器已销毁则忽略 */
        }
      }
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
        const vditor = vditorRef.current;
        if (vditor) void persist(vditor.getValue());
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
  useEffect(() => {
    if (!remoteReload || remoteReload.nonce === lastNonceRef.current) return;
    lastNonceRef.current = remoteReload.nonce;
    const vditor = vditorRef.current;
    if (!vditor || !readyRef.current) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    vditor.setValue(remoteReload.content);
    dirtyRef.current = false;
    onDirtyChangeRef.current?.(false);
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
      <div className="markdown-editor-host" ref={containerRef} />
    </div>
  );
}
