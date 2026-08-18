import { RotateCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type EndedState = { kind: "exit"; code?: number } | { kind: "error"; message: string } | undefined;

/**
 * xterm.js view over a main-process PTY. The PTY outlives this component
 * (tab switches, panel close/reopen): unmounting only disposes the renderer,
 * and the next mount reconnects via `create` which replays the scrollback
 * kept in the main process. Killing the PTY happens on tab close in App.
 */
export function TerminalPanel({ terminalId, workspace }: { terminalId: string; workspace?: string }): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [ended, setEnded] = useState<EndedState>(undefined);
  const [restartNonce, setRestartNonce] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setEnded(undefined);

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 13,
      scrollback: 4000,
      theme: readXtermTheme()
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddon.fit();
    void window.piDesktop.terminal({
      type: "create",
      terminalId,
      cwd: workspace?.trim() ? workspace : undefined,
      cols: Math.max(2, terminal.cols),
      rows: Math.max(2, terminal.rows)
    });

    const dataSubscription = terminal.onData((data) => {
      void window.piDesktop.terminal({ type: "input", terminalId, data });
    });
    // The preview tab binds Escape to closing itself; inside a terminal Escape
    // belongs to the shell (vim/REPL), so keep it from bubbling to window.
    const keepEscapeInTerminal = (event: KeyboardEvent): void => {
      if (event.key === "Escape") event.stopPropagation();
    };
    container.addEventListener("keydown", keepEscapeInTerminal, true);
    const unsubscribe = window.piDesktop.onTerminalData(terminalId, (event) => {
      if (event.type === "data") terminal.write(event.data);
      else if (event.type === "exit") setEnded({ kind: "exit", code: event.exitCode });
      else setEnded({ kind: "error", message: event.message });
    });

    let resizeTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      // Hidden panels report zero size; fitting then would collapse the grid.
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fitAddon.fit();
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        void window.piDesktop.terminal({ type: "resize", terminalId, cols: terminal.cols, rows: terminal.rows });
      }, 100);
    });
    observer.observe(container);
    terminal.focus();

    return () => {
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      container.removeEventListener("keydown", keepEscapeInTerminal, true);
      unsubscribe();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [terminalId, workspace, restartNonce]);

  // Re-read theme tokens when the active theme changes; themes own all colors.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const terminal = terminalRef.current;
      if (terminal) terminal.options.theme = readXtermTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-effective", "data-theme-preset", "data-theme-custom", "data-theme-wallpaper"] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="terminal-pane" data-pane="terminal">
      <div ref={containerRef} className="terminal-xterm" />
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

function readXtermTheme(): { background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string } {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: value("--code-surface", "#0b1220"),
    foreground: value("--code-text", "#e5e7eb"),
    cursor: value("--code-text", "#e5e7eb"),
    cursorAccent: value("--code-surface", "#0b1220"),
    selectionBackground: value("--selection-bg", "#c7d2fe")
  };
}
