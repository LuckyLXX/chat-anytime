import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  classifyTerminalPaste,
  countTerminalPasteLines,
  isMacPlatform,
  matchTerminalClipboardShortcut,
  readClipboardText,
  terminalClipboardHints,
  terminalMouseHint,
  writeClipboardText
} from "../lib/terminal-clipboard";
import { TERMINAL_FONT_FAMILY } from "../lib/terminal-font";
import { createPromptHighlighter, readPromptPalette, PROMPT_FALLBACK_PALETTE, type PromptPalette } from "../lib/terminal-prompt";
import { readTerminalTheme, TERMINAL_OPTIONS } from "../lib/terminal-theme";
import "@xterm/xterm/css/xterm.css";

/**
 * xterm.js 实例的共享生命周期宿主（本地 PTY 终端与 SSH 远程终端复用）：
 * 负责 xterm 初始化、FitAddon、ResizeObserver（隐藏面板零尺寸不 fit）、
 * 主题令牌联动、剪贴板/选区（复制粘贴菜单与快捷键）、Escape 拦截（预览标签把
 * Esc 绑定到关闭自己，而终端里 Esc 属于 shell——vim/REPL）。连接发起与事件
 * 订阅由父组件通过回调处理。
 *
 * 外观与配色（2026-10-10）：装配逻辑全部在 `lib/terminal-theme.ts`（完整 ANSI
 * 16 色板 + 现代观感参数 + minimumContrastRatio 可读性兜底），这里只接线并在
 * 主题切换时重读。`highlightPrompt` 只给 SSH 远终端开：远端 PS1 普遍是无色白字，
 * 由 `lib/terminal-prompt.ts` 在数据进 xterm 前把「用户@主机:路径」着色（零宽
 * SGR，不改可见文本、不影响主进程的 marker 命令检测）。本地 PTY 终端不开，
 * 因为它的提示符格式由本机 shell 决定、误判风险不值得。
 *
 * 剪贴板（2026-11-23「SSH 终端选区与剪贴板优化」）：xterm 自己不处理 Ctrl+C/V
 * （裸键一律进 shell），所以判定与文本边界都在 `lib/terminal-clipboard.ts`，这里
 * 只做三件事：接自定义按键、接原生 `paste` 事件、把菜单动作接到同一套入口。
 * 三条入口（快捷键 / 右键菜单 / DOM paste）都收敛到 `deliverPaste()`：
 * - 一次触发一个令牌，异步读剪贴板或确认框等待期间，切标签/断线/重连/卸载都会
 *   作废令牌，旧内容绝不会写进另一条连接；
 * - 空文本忽略，单行直接 `terminal.paste()`（换行归一化与 bracketed paste 由
 *   xterm 负责），含任何换行先确认；
 * - 界面提示只用固定文案，绝不显示剪贴板正文（里面可能是密码）。
 */
export interface XtermApi {
  terminal: Terminal;
  write(data: string): void;
}

interface TerminalMenu {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/** 复制/粘贴提示的显示时长（毫秒）。 */
const NOTICE_TIMEOUT_MS = 4000;
/** 「远端接管鼠标」提示的停留时长：够看清，又不长期盖住终端首行。 */
const MOUSE_HINT_TIMEOUT_MS = 8000;

export function XtermView({
  onReady,
  onInput,
  onResize,
  focus,
  highlightPrompt = false,
  canPaste = true
}: {
  /** mount 后调用一次；引用变化不重建实例。 */
  onReady(api: XtermApi): void;
  onInput(data: string): void;
  onResize(cols: number, rows: number): void;
  /** mount 后聚焦终端（连接/重连时把键盘焦点交给终端）。 */
  focus?: boolean;
  /** 是否对行首提示符着色（SSH 远终端开，本地 PTY 终端不开）。 */
  highlightPrompt?: boolean;
  /** 当前连接是否可写入：断线/重连中为 false，粘贴入口整体禁用（选区与复制仍可用）。 */
  canPaste?: boolean;
}): ReactNode {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const readyRef = useRef(onReady);
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);
  // 提示符配色与主题同源（远端输出用同一套色板），主题切换时就地更新，
  // 着色器只通过这个 ref 读颜色 —— 重建着色器会丢掉「是否在行首」的状态。
  const promptPaletteRef = useRef<PromptPalette>(PROMPT_FALLBACK_PALETTE);
  const canPasteRef = useRef(canPaste);
  // 待粘贴内容（多行确认期间）与作废令牌：异步读剪贴板、确认提交时逐项复核。
  const pasteTokenRef = useRef(0);
  const pendingPasteRef = useRef<{ token: number; text: string } | null>(null);
  /** 刚刚用来复制的那个和弦是否还按着（长按 repeat 不许落到 shell 变中断）。 */
  const copyChordRef = useRef(false);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef(false);
  /** 菜单或确认框是否开着（Esc 路由要用，纯 ref 避免重建监听）。 */
  const overlayRef = useRef(false);
  const [menu, setMenu] = useState<TerminalMenu | undefined>(undefined);
  const [confirm, setConfirm] = useState<{ lines: number } | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [mouseCaptured, setMouseCaptured] = useState(false);
  // 鼠标接管提示不是常驻横幅（会盖住第一行输出）：只在刚刚发生时提醒一次。
  const [mouseHintVisible, setMouseHintVisible] = useState(false);
  const mouseHintTimerRef = useRef<number | undefined>(undefined);
  // mac 的提示文案要跟着平台走（Cmd / Option），每次渲染算一次即可（纯字符串判断）。
  const mac = isMacPlatform(typeof navigator === "undefined" ? undefined : navigator.platform, typeof navigator === "undefined" ? undefined : navigator.userAgent);
  const hints = terminalClipboardHints(mac);

  // 回调引用每次渲染后同步（不在渲染期间写 ref，React 严格模式纪律）。
  useEffect(() => {
    readyRef.current = onReady;
    inputRef.current = onInput;
    resizeRef.current = onResize;
  });

  const noticeTimerRef = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    menuRef.current = menu !== undefined;
    overlayRef.current = menu !== undefined || confirm !== undefined;
    if (menu) shellRef.current?.querySelector<HTMLButtonElement>(".context-menu-item:not(:disabled)")?.focus();
  }, [menu, confirm]);

  useLayoutEffect(() => {
    cancelButtonRef.current?.focus();
  }, [confirm]);

  useEffect(() => () => window.clearTimeout(noticeTimerRef.current), []);

  useEffect(() => {
    window.clearTimeout(mouseHintTimerRef.current);
    if (!mouseCaptured) {
      setMouseHintVisible(false);
      return;
    }
    setMouseHintVisible(true);
    mouseHintTimerRef.current = window.setTimeout(() => setMouseHintVisible(false), MOUSE_HINT_TIMEOUT_MS);
    return () => window.clearTimeout(mouseHintTimerRef.current);
  }, [mouseCaptured]);

  const showNotice = useCallback((message: string): void => {
    setNotice(message);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(undefined), NOTICE_TIMEOUT_MS);
  }, []);

  /** 作废所有待粘贴内容（断线、重连、取消、卸载、切标签）。 */
  const invalidatePaste = useCallback((): void => {
    pasteTokenRef.current += 1;
    pendingPasteRef.current = null;
    setConfirm(undefined);
  }, []);

  useLayoutEffect(() => {
    canPasteRef.current = canPaste;
    if (!canPaste) {
      if (pendingPasteRef.current && shellRef.current?.contains(document.activeElement)) terminalRef.current?.focus();
      invalidatePaste();
      setMenu(undefined);
    }
  }, [canPaste, invalidatePaste]);

  /** 校验令牌、实例和连接可写状态，再提交文本或显示确认。 */
  const deliverPaste = useCallback((text: string, token: number, instance: Terminal): void => {
    if (token !== pasteTokenRef.current) return;
    if (terminalRef.current !== instance) return;
    if (!canPasteRef.current) return;
    const decision = classifyTerminalPaste(text);
    if (decision === "ignore") {
      pendingPasteRef.current = null;
      setConfirm(undefined);
      return;
    }
    if (decision === "confirm") {
      pendingPasteRef.current = { token, text };
      setConfirm({ lines: countTerminalPasteLines(text) });
      return;
    }
    pendingPasteRef.current = null;
    setConfirm(undefined);
    instance.paste(text);
  }, []);

  /** 快捷键/菜单：读系统剪贴板后走统一入口。 */
  const pasteFromClipboard = useCallback((): void => {
    const instance = terminalRef.current;
    if (!instance || !canPasteRef.current) return;
    // 新触发即换令牌：上一次还没落地的读取/确认一律作废（各入口最多粘一次）。
    const token = pasteTokenRef.current + 1;
    pasteTokenRef.current = token;
    pendingPasteRef.current = null;
    setConfirm(undefined);
    void readClipboardText().then(
      (text) => deliverPaste(text, token, instance),
      () => {
        if (token === pasteTokenRef.current) showNotice("无法读取剪贴板，粘贴已取消");
      }
    );
  }, [deliverPaste, showNotice]);

  /** 原生 paste 事件（以及已确认的多行文本）：内容已在手上，直接走统一入口。 */
  const pasteText = useCallback((text: string): void => {
    const instance = terminalRef.current;
    if (!instance || !canPasteRef.current) return;
    const token = pasteTokenRef.current + 1;
    pasteTokenRef.current = token;
    deliverPaste(text, token, instance);
  }, [deliverPaste]);

  /** 确认框「粘贴」：只提交当前待粘贴内容，提交前再复核一遍连接与实例。 */
  const confirmPaste = useCallback((): void => {
    const pending = pendingPasteRef.current;
    pendingPasteRef.current = null;
    setConfirm(undefined);
    const instance = terminalRef.current;
    if (!pending || !instance || !canPasteRef.current) return;
    if (pending.token !== pasteTokenRef.current) return;
    instance.paste(pending.text);
    instance.focus();
  }, []);

  const cancelPaste = useCallback((): void => {
    pendingPasteRef.current = null;
    // 令牌也一起换掉：飞行中的读取不会在取消之后偷偷落地。
    pasteTokenRef.current += 1;
    setConfirm(undefined);
  }, []);

  const copyText = useCallback((text: string, instance: Terminal): void => {
    void writeClipboardText(text).then(
      () => {
        // 复制成功才清选区：失败保留选区，让用户可以直接重试（而不是被当成中断）。
        if (terminalRef.current === instance && instance.getSelection() === text) instance.clearSelection();
      },
      () => showNotice("复制失败，请重试")
    );
  }, [showNotice]);

  /** 复制当前选区；无选区返回 false（调用方决定是否把按键让给 shell）。 */
  const copySelection = useCallback((): boolean => {
    const instance = terminalRef.current;
    if (!instance) return false;
    const text = instance.getSelection();
    if (!text) return false;
    copyText(text, instance);
    return true;
  }, [copyText]);

  const closeMenu = useCallback((): void => {
    setMenu(undefined);
    terminalRef.current?.focus();
  }, []);

  const openMenu = useCallback((x: number, y: number): void => {
    const instance = terminalRef.current;
    if (!instance) return;
    const items: ContextMenuItem[] = [
      { label: "复制", hint: hints.copy, disabled: !instance.hasSelection(), onClick: () => { copySelection(); } },
      { label: "粘贴", hint: hints.paste, disabled: !canPasteRef.current, onClick: pasteFromClipboard },
      // Ctrl+A 留给 shell 的「行首」，全选只能从菜单进（xterm 的 selectAll 选整个缓冲区）。
      { label: "全选", onClick: () => { terminalRef.current?.selectAll(); } }
    ];
    setMenu({ x, y, items });
  }, [copySelection, hints.copy, hints.paste, pasteFromClipboard]);

  useEffect(() => {
    const container = containerRef.current;
    const shell = shellRef.current;
    if (!container || !shell) return;
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

    // 自定义按键：只处理剪贴板和弦，其余（含裸 Ctrl+C 的 ^C、Ctrl+A 的行首）原样交给 xterm。
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keyup") {
        copyChordRef.current = false;
        return true;
      }
      // keypress 阶段不接管：同一次按键只处理一遍（_keyPress 对带修饰键的事件本来也不发数据）。
      if (event.type !== "keydown") return true;
      const command = matchTerminalClipboardShortcut(event, mac);
      if (!command) return true;
      if (command === "copy") {
        // 长按复制成功后不可退化成中断，也不能重复尝试写系统剪贴板。
        if (event.repeat && copyChordRef.current) {
          event.preventDefault();
          return false;
        }
        if (copySelection()) {
          copyChordRef.current = true;
          event.preventDefault();
          return false;
        }
        copyChordRef.current = false;
        return true;
      }
      // 取消 Chromium 的原生按键动作。独立的原生 PasteEvent 仍可走下方入口。
      event.preventDefault();
      if (!event.repeat) pasteFromClipboard();
      return false;
    });

    // 原生 paste 接管：xterm 在 textarea 和根节点各自注册了监听，只 preventDefault
    // 还会被它直接发送，所以捕获阶段连传播一起停住，再走统一入口。
    const onPasteCapture = (event: ClipboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (!overlayRef.current) pasteText(event.clipboardData?.getData("text/plain") ?? "");
    };
    container.addEventListener("paste", onPasteCapture, true);

    // Esc 路由：确认框/菜单开着时先关它们（必须抢在 xterm 之前，否则 vim 会收到一个 Esc）；
    // 其余情况让 Esc 先到 xterm —— 它的 keydown 监听挂在 textarea（事件的**目标**）上，
    // 祖先在捕获阶段 stopPropagation 会把它整个挡掉（旧实现的坑），所以这里只在冒泡
    // 阶段停下，避免预览标签把终端里的 Esc 当成「关闭预览」。
    const onKeyDownCapture = (event: KeyboardEvent): void => {
      if (!overlayRef.current) return;
      if (event.key !== "Escape") {
        // 菜单焦点仍在 xterm，浮层打开时拦下写入终端的按键。
        if (container.contains(event.target as Node) && (menuRef.current || pendingPasteRef.current)) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setMenu(undefined);
      cancelPaste();
      terminal.focus();
    };
    const onKeyDownBubble = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
    };
    shell.addEventListener("keydown", onKeyDownCapture, true);
    shell.addEventListener("keydown", onKeyDownBubble);

    // xterm 以 Shift（macOS 为 Option）强制拖选。本地菜单还接受 Shift+右键。
    const wantsLocalMenu = (event: MouseEvent): boolean => event.shiftKey || (mac && event.altKey);
    const onMouseDownCapture = (event: MouseEvent): void => {
      copyChordRef.current = false;
      if (event.button === 2 && terminal.modes.mouseTrackingMode !== "none" && wantsLocalMenu(event)) {
        // 阻止 xterm 把本地菜单的右键发给远端。
        event.stopPropagation();
      }
    };
    const onContextMenu = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (terminal.modes.mouseTrackingMode === "none" || wantsLocalMenu(event)) openMenu(event.clientX, event.clientY);
    };
    container.addEventListener("mousedown", onMouseDownCapture, true);
    container.addEventListener("contextmenu", onContextMenu, true);

    // 鼠标追踪状态没有公开事件，靠「解析完一次写入」这个钩子同步一次（值不变时 setState 会 bail）。
    const syncMouseCapture = (): void => {
      const captured = terminal.modes.mouseTrackingMode !== "none";
      setMouseCaptured((previous) => (previous === captured ? previous : captured));
    };
    const writeParsedSubscription = terminal.onWriteParsed(syncMouseCapture);

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
      pasteTokenRef.current += 1;
      pendingPasteRef.current = null;
      container.removeEventListener("paste", onPasteCapture, true);
      shell.removeEventListener("keydown", onKeyDownCapture, true);
      shell.removeEventListener("keydown", onKeyDownBubble);
      container.removeEventListener("mousedown", onMouseDownCapture, true);
      container.removeEventListener("contextmenu", onContextMenu, true);
      writeParsedSubscription.dispose();
      dataSubscription.dispose();
      terminal.dispose();
      terminalRef.current = null;
    };
    // 依赖只留「会改变终端实例本身」的项：本作用域内的回调全是稳定 useCallback，
    // 挂进来反而会在某次 identity 变化时把整台终端重建、丢掉 scrollback。
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

  return (
    <div className="terminal-shell" ref={shellRef}>
      <div ref={containerRef} className="terminal-xterm" />
      {mouseCaptured && mouseHintVisible && (
        <div className="terminal-mouse-hint" role="status">{terminalMouseHint(mac)}</div>
      )}
      {notice && <div className="terminal-clipboard-notice" role="status">{notice}</div>}
      {confirm && (
        <div className="terminal-paste-confirm" role="dialog" aria-label="确认粘贴多行内容">
          <span className="terminal-paste-confirm-text">剪贴板内容共 {confirm.lines} 行，粘贴后可能立即执行。</span>
          <div className="terminal-paste-confirm-actions">
            <button type="button" className="primary-button" onClick={confirmPaste}>粘贴</button>
            <button ref={cancelButtonRef} type="button" className="ghost-button" onClick={() => { cancelPaste(); terminalRef.current?.focus(); }}>取消</button>
          </div>
        </div>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </div>
  );
}
