import { useEffect, useRef, type ReactNode } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { TERMINAL_FONT_FAMILY } from "../lib/terminal-font";
import "@xterm/xterm/css/xterm.css";

/**
 * xterm.js 实例的共享生命周期宿主（本地 PTY 终端与 SSH 远程终端复用）：
 * 负责 xterm 初始化、FitAddon、ResizeObserver（隐藏面板零尺寸不 fit）、
 * 主题令牌联动与 Escape 拦截（预览标签把 Esc 绑定到关闭自己，而终端里
 * Esc 属于 shell——vim/REPL）。连接发起与事件订阅由父组件通过回调处理。
 */
export interface XtermApi {
  terminal: Terminal;
  write(data: string): void;
}

export function XtermView({
  onReady,
  onInput,
  onResize,
  focus
}: {
  /** mount 后调用一次；引用变化不重建实例。 */
  onReady(api: XtermApi): void;
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  /** mount 后聚焦终端（连接/重连时把键盘焦点交给终端）。 */
  focus?: boolean;
}): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const readyRef = useRef(onReady);
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);
  // 回调引用每次渲染后同步（不在渲染期间写 ref，React 严格模式纪律）。
  useEffect(() => {
    readyRef.current = onReady;
    inputRef.current = onInput;
    resizeRef.current = onResize;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      scrollback: 4000,
      theme: readXtermTheme()
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    const dataSubscription = terminal.onData((data) => inputRef.current(data));
    const keepEscapeInTerminal = (event: KeyboardEvent): void => {
      if (event.key === "Escape") event.stopPropagation();
    };
    container.addEventListener("keydown", keepEscapeInTerminal, true);
    readyRef.current({
      terminal,
      write: (data: string): void => {
        terminal.write(data);
      }
    });
    if (focus) terminal.focus();

    let resizeTimer: number | undefined;
    const observer = new ResizeObserver(() => {
      // Hidden panels report zero size; fitting then would collapse the grid.
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fitAddon.fit();
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeRef.current(Math.max(2, terminal.cols), Math.max(2, terminal.rows));
      }, 100);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      container.removeEventListener("keydown", keepEscapeInTerminal, true);
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [focus]);

  // Re-read theme tokens when the active theme changes; themes own all colors.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const terminal = terminalRef.current;
      if (terminal) terminal.options.theme = readXtermTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-effective", "data-theme-preset", "data-theme-custom", "data-theme-wallpaper"] });
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className="terminal-xterm" />;
}

export function readXtermTheme(): { background: string; foreground: string; cursor: string; cursorAccent: string; selectionBackground: string } {
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
