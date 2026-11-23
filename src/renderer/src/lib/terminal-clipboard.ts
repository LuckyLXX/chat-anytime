/**
 * 终端剪贴板与选区（2026-11-23「SSH 终端选区与剪贴板优化」）。
 *
 * 背景：xterm.js **不会**自己处理 Ctrl+C/V —— 它把裸 Ctrl+C 当 `^C`（SIGINT）、
 * 裸 Ctrl+V 当 `^V` 送给 shell，Electron 也没有给终端配编辑菜单。于是远端/本机
 * 终端里「复制粘贴」全靠鼠标右键菜单或浏览器默认行为，用户报「SSH 里拖选后
 * Ctrl+C 把命令打断了」「粘贴不进去」。本模块把判定收成纯函数，`XtermView`
 * 只做接线，测试可以直接钉住矩阵：
 *
 * - Windows/Linux：Ctrl+C **有选区时复制**（复制成功后清选区，下一次 Ctrl+C
 *   才能中断；长按复制键的 repeat 事件不许退化成中断），无选区时原样交给 shell；
 *   Ctrl+V、Ctrl+Shift+C/V、Ctrl+Insert（复制）、Shift+Insert（粘贴）。
 * - macOS：Cmd+C/V（含 Cmd+Shift+C/V），**裸 Ctrl+C 保留终端控制语义**（^C 中断，
 *   Ctrl+V 仍是 ^V）——mac 用户的心智模型是 Cmd 才管剪贴板。
 * - Ctrl+A 一律不抢：shell 里那是「行首」（xterm 自己还会顺带全选缓冲区），
 *   界面上「全选」放进右键菜单。
 * - IME（`isComposing` / `key === "Process"`）、AltGraph、Alt 组合一律不认——
 *   AltGr 在部分键盘布局上表现为 Ctrl+Alt，误判会把 `@`、`{}` 这类字符变成粘贴。
 *
 * 粘贴文本边界：空文本（只有 `""`）忽略；**任何** `\r` / `\n`（含 CRLF 与末尾
 * 换行——末尾换行粘贴后就是「立刻回车执行」）都要先确认；单行直接粘贴。
 * 换行归一化与 bracketed paste 交给 `terminal.paste()`（xterm 自己按
 * `\r?\n → \r` 处理并补 `\e[200~…\e[201~`），这里绝不自己拼转义序列。
 */

/** 判定用的按键事件形状（`KeyboardEvent` 的结构子集，测试可以手搓）。 */
export interface TerminalKeyEventLike {
  /** keydown / keypress / keyup；只认 keydown，其余阶段一律不接管。 */
  type?: string;
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** 长按 repeat：复制成功后不许落到 shell 变成中断。 */
  repeat?: boolean;
  /** 输入法合成中。 */
  isComposing?: boolean;
  getModifierState?(key: string): boolean;
}

/** 终端自己的剪贴板动作。 */
export type TerminalClipboardCommand = "copy" | "paste";

/**
 * 是否是 macOS（渲染端不碰 Node，按 UA/platform 判；两者在 Electron 里都反映宿主系统）。
 * 传参而不是直接读全局，测试才能两个平台都钉。
 */
export function isMacPlatform(platform: string | undefined, userAgent: string | undefined): boolean {
  const platformText = platform ?? "";
  const agent = userAgent ?? "";
  return /mac/i.test(platformText) || /Mac OS X|Macintosh/i.test(agent);
}

/** 输入法/AltGraph 这类「看着像快捷键、其实在输入字符」的事件。 */
function isInputComposition(event: TerminalKeyEventLike): boolean {
  if (event.isComposing === true) return true;
  if (event.key === "Process" || event.key === "Dead" || event.key === "Unidentified" || event.key === "AltGraph") return true;
  // AltGr 在 Windows 上就是 Ctrl+Alt，必须排除（否则 `AltGr+V` 会变成粘贴）。
  return event.getModifierState?.("AltGraph") === true;
}

/**
 * 把一次终端内的按键映射成剪贴板动作；不是我们的组合键时返回 undefined
 * （调用方原样交给 xterm → shell）。
 */
export function matchTerminalClipboardShortcut(event: TerminalKeyEventLike, mac: boolean): TerminalClipboardCommand | undefined {
  // 只在真正的 keydown 阶段接管（keypress/keyup 交给 xterm，避免同一次按键处理两遍）。
  if (event.type !== undefined && event.type !== "keydown") return undefined;
  if (isInputComposition(event)) return undefined;
  if (event.altKey === true) return undefined;
  const key = event.key;
  // 在非拉丁键盘上，key 可能是本地字母。只有不是拉丁字母时才按物理键补识别。
  const logical = key.toLowerCase();
  const lower = /^[a-z]$/.test(logical) ? logical : event.code === "KeyC" ? "c" : event.code === "KeyV" ? "v" : logical;

  if (mac) {
    // Cmd 系（Cmd+Shift+C/V 同义）；Ctrl / Ctrl+Shift 一律不抢。
    if (event.metaKey === true && event.ctrlKey !== true) {
      if (lower === "c") return "copy";
      if (lower === "v") return "paste";
      return undefined;
    }
    if (event.shiftKey === true && event.metaKey !== true && event.ctrlKey !== true && key === "Insert") return "paste";
    return undefined;
  }

  if (event.metaKey === true) return undefined;
  if (event.ctrlKey === true) {
    if (lower === "c") return "copy";
    if (lower === "v") return "paste";
    if (key === "Insert") return "copy";
    return undefined;
  }
  if (event.shiftKey === true && key === "Insert") return "paste";
  return undefined;
}

/** 粘贴文本的处置结论：忽略 / 直接粘贴 / 先确认。 */
export type TerminalPasteDecision = "ignore" | "paste" | "confirm";

/**
 * 粘贴前的文本边界判定。空字符串忽略；任何换行（CRLF、LF、CR，含末尾换行）先确认。
 * 只判定、不改写 —— 真正送进终端的内容始终是剪贴板原文。
 */
export function classifyTerminalPaste(text: string): TerminalPasteDecision {
  if (!text) return "ignore";
  return /[\r\n]/.test(text) ? "confirm" : "paste";
}

/** 待粘贴文本的行数（确认框只说「N 行」，不显示正文——剪贴板里可能是密码）。 */
export function countTerminalPasteLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

/** 界面上的快捷键提示（右键菜单与鼠标接管提示共用一份文案，平台差异只在这里）。 */
export function terminalClipboardHints(mac: boolean): { copy: string; paste: string; forceSelection: string } {
  return mac
    ? { copy: "⌘C", paste: "⌘V", forceSelection: "Option+拖选" }
    : { copy: "Ctrl+C", paste: "Ctrl+V", forceSelection: "Shift+拖选" };
}

/** 远端程序接管鼠标时给用户的提示（右键菜单与终端角落共用）。 */
export function terminalMouseHint(mac: boolean): string {
  const hints = terminalClipboardHints(mac);
  return `远端程序正在接管鼠标：${hints.forceSelection}可选文本，${mac ? "Option" : "Shift"}+右键打开本地菜单`;
}

export async function readClipboardText(): Promise<string> {
  return navigator.clipboard.readText();
}

export async function writeClipboardText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
