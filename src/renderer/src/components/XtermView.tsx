import { useEffect, useRef, type ReactNode } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { TERMINAL_FONT_FAMILY } from "../lib/terminal-font";
import { createPromptHighlighter, readPromptPalette, PROMPT_FALLBACK_PALETTE, type PromptPalette } from "../lib/terminal-prompt";
import { readTerminalTheme, TERMINAL_OPTIONS } from "../lib/terminal-theme";
import "@xterm/xterm/css/xterm.css";

/**
 * xterm.js 实例的共享生命周期宿主（本地 PTY 终端与 SSH 远程终端复用）：
 * 负责 xterm 初始化、FitAddon、ResizeObserver（隐藏面板零尺寸不 fit）、
 * 主题令牌联动与 Escape 拦截（预览标签把 Esc 绑定到关闭自己，而终端里
 * Esc 属于 shell——vim/REPL）。连接发起与事件订阅由父组件通过回调处理。
 *
 * 外观与配色（2026-10-10）：装配逻辑全部在 `lib/terminal-theme.ts`（完整 ANSI
 * 16 色板 + 现代观感参数 + minimumContrastRatio 可读性兜底），这里只接线并在
 * 主题切换时重读。`highlightPrompt` 只给 SSH 远终端开：远端 PS1 普遍是无色白字，
 * 由 `lib/terminal-prompt.ts` 在数据进 xterm 前把「用户@主机:路径」着色（零宽
 * SGR，不改可见文本、不影响主进程的 marker 命令检测）。本地 PTY 终端不开，
 * 因为它的提示符格式由本机 shell 决定、误判风险不值得。
 */
export interface XtermApi {
  terminal: Terminal;
  write(data: string): void;
}

export function XtermView({
  onReady,
  onInput,
  onResize,
  focus,
  highlightPrompt = false
}: {
  /** mount 后调用一次；引用变化不重建实例。 */
  onReady(api: XtermApi): void;
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  /** mount 后聚焦终端（连接/重连时把键盘焦点交给终端）。 */
  focus?: boolean;
  /** 是否对行首提示符着色（SSH 远终端开，本地 PTY 终端不开）。 */
  highlightPrompt?: boolean;
}): ReactNode {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const readyRef = useRef(onReady);
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);
  // 提示符配色与主题同源（远端输出用同一套色板），主题切换时就地更新，
  // 着色器只通过这个 ref 读颜色 —— 重建着色器会丢掉「是否在行首」的状态。
  const promptPaletteRef = useRef<PromptPalette>(PROMPT_FALLBACK_PALETTE);
  // 回调引用每次渲染后同步（不在渲染期间写 ref，React 严格模式纪律）。
  useEffect(() => {
    readyRef.current = onReady;
    inputRef.current = onInput;
    resizeRef.current = onResize;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const theme = readTerminalTheme();
    promptPaletteRef.current = readPromptPalette(theme);
    const highlighter = highlightPrompt ? createPromptHighlighter(() => promptPaletteRef.current) : undefined;
    const terminal = new Terminal({
      ...TERMINAL_OPTIONS,
      convertEol: false,
      fontFamily: TERMINAL_FONT_FAMILY,
      theme
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
        terminal.write(highlighter ? highlighter(data) : data);
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
  }, [focus, highlightPrompt]);

  // Re-read theme tokens when the active theme changes; themes own all colors.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const theme = readTerminalTheme();
      terminal.options.theme = theme;
      promptPaletteRef.current = readPromptPalette(theme);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-effective", "data-theme-preset", "data-theme-custom", "data-theme-wallpaper"] });
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className="terminal-xterm" />;
}
