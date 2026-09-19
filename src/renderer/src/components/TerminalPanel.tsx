import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { XtermView, type XtermApi } from "./XtermView";

type EndedState = { kind: "exit"; code?: number } | { kind: "error"; message: string } | undefined;

/**
 * xterm.js view over a main-process PTY. The PTY outlives this component
 * (tab switches, panel close/reopen): unmounting only disposes the renderer,
 * and the next mount reconnects via `create` which replays the scrollback
 * kept in the main process. Killing the PTY happens on tab close in App.
 */
export function TerminalPanel({ terminalId, workspace }: { terminalId: string; workspace?: string }): ReactNode {
  const [ended, setEnded] = useState<EndedState>(undefined);
  const [restartNonce, setRestartNonce] = useState(0);
  const apiRef = useRef<XtermApi | undefined>(undefined);

  useEffect(() => {
    setEnded(undefined);
    // 注意：绝不能在这里清 apiRef——XtermView（子组件）的 effect 先于本 effect
    // 执行，onReady 已经把新 api 存进去；此处清空会把后续所有 data 事件丢弃
    //（2026-09-19 终端空白的根因：光标闪、无输出）。key 重建时新实例会覆盖。
  }, [terminalId, workspace, restartNonce]);

  const handleReady = useCallback((api: XtermApi): void => {
    apiRef.current = api;
    void window.piDesktop.terminal({
      type: "create",
      terminalId,
      cwd: workspace?.trim() ? workspace : undefined,
      cols: Math.max(2, api.terminal.cols),
      rows: Math.max(2, api.terminal.rows)
    });
  }, [terminalId, workspace]);

  const handleInput = useCallback((data: string): void => {
    void window.piDesktop.terminal({ type: "input", terminalId, data });
  }, [terminalId]);

  const handleResize = useCallback((cols: number, rows: number): void => {
    void window.piDesktop.terminal({ type: "resize", terminalId, cols, rows });
  }, [terminalId]);

  useEffect(() => {
    const unsubscribe = window.piDesktop.onTerminalData(terminalId, (event) => {
      const api = apiRef.current;
      if (!api) return;
      if (event.type === "data") api.write(event.data);
      else if (event.type === "exit") setEnded({ kind: "exit", code: event.exitCode });
      else setEnded({ kind: "error", message: event.message });
    });
    return unsubscribe;
  }, [terminalId]);

  return (
    <div className="terminal-pane" data-pane="terminal">
      {/* key 重建视图：ended 清理 + create 重发（重连按钮） */}
      <XtermView key={`${terminalId}-${restartNonce}`} onReady={handleReady} onInput={handleInput} onResize={handleResize} focus />
      {ended && (
        <div className="terminal-ended">
          {ended.kind === "exit" ? <strong>进程已退出{typeof ended.code === "number" ? `（代码 ${ended.code}）` : ""}</strong> : <strong>终端不可用</strong>}
          {ended.kind === "error" && <span>{ended.message}</span>}
          <button type="button" className="primary-button" onClick={() => setRestartNonce((nonce) => nonce + 1)}><RotateCw size={14} />重新启动</button>
        </div>
      )}
    </div>
  );
}
