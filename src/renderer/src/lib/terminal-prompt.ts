import type { ITheme } from "@xterm/xterm";
import { parseCssColor } from "./terminal-theme";

/**
 * 提示符（prompt）着色 —— 让 SSH 远程终端里的「用户@主机:路径」从一片白字里
 * 跳出来（2026-10-10 用户需求：「用户路径这些和执行颜色区分」）。
 *
 * 为什么在**渲染端**做而不是改远端：用户的服务器 `.bashrc` 里 PS1 就是无色白字，
 * 而他不希望动服务器。着色在数据进 xterm 之前插入 SGR 序列完成，主进程那条
 * 「AI 命令完成检测」的 OSC 633 marker 通路完全在渲染前，**不受影响**。
 *
 * 安全性依据：SGR 是**零宽**序列，不占字符格、不移动光标 —— 远端 bash/zsh 自己
 * 计算的 PS1 可见宽度与终端实际显示仍然一致，所以插入颜色不会打乱 readline 的
 * 行列计算（这是本方案敢做的根本原因）。另外只在**行首**匹配、且匹配失败一律
 * 原样透传（渐进增强：最坏情况 = 现在的白字提示符，绝不会花屏）。
 *
 * 已知边界（刻意接受，不做缓冲换延迟）：
 * - 提示符若被切在 chunk 边界中间（主进程 10ms/64KB 批量 flush，实际几乎不会），
 *   该行不着色；
 * - 行首已带**设色** SGR 时（远端自己配了彩色 PS1）一律不动，尊重远端配色；
 * - 只认含 `@` 的提示符形态（`user@host:path$` / `[user@host dir]#` / `(venv) u@h:p$`），
 *   纯 `bash-5.1#` 这类不着色。
 */

export interface PromptPalette {
  /** `user@host` 段（默认取主题 accent）。 */
  host: string;
  /** 路径与括号段（默认取色板 cyan）。 */
  path: string;
  /** root 提示符 `#` 的颜色（默认取色板 red）。 */
  rootSigil: string;
  /** 普通用户提示符 `$` / `%` / `>` 的颜色（默认取色板 green）。 */
  userSigil: string;
}

export const PROMPT_FALLBACK_PALETTE: PromptPalette = {
  host: "#4f46e5",
  path: "#0e7490",
  rootSigil: "#b3261e",
  userSigil: "#2e7d32"
};

/** 只重置前景色（`\x1b[0m` 会把远端可能设置的背景/粗体一起清掉）。 */
const RESET_FOREGROUND = "\x1b[39m";

/** 从已装配好的 xterm 主题派生提示符配色 —— 与远端输出用同一套色板，风格自洽。 */
export function readPromptPalette(theme: ITheme): PromptPalette {
  return {
    host: theme.cursor ?? PROMPT_FALLBACK_PALETTE.host,
    path: theme.cyan ?? PROMPT_FALLBACK_PALETTE.path,
    rootSigil: theme.red ?? PROMPT_FALLBACK_PALETTE.rootSigil,
    userSigil: theme.green ?? PROMPT_FALLBACK_PALETTE.userSigil
  };
}

/**
 * 行首提示符形态。head 两分支：
 * - `[...]`：`[root@iZbp1xxxx ~]#`（方括号内允许空格）；
 * - 非空白串：`user@host:~/app$`、`root@host#`。
 * sigil 后必须是空格或行尾，避免把 `a@b#tag` 这类输出当提示符。
 */
export const PROMPT_LINE_RE =
  /^(?<venv>(?:\([^()\s]{1,24}\)[ \t]+)?)(?<head>\[[^[\]\n]{1,80}\]|[^\s#$%>\n]{1,120})(?<gap>[ \t]?)(?<sigil>[$#%>])(?=[ \t]|$)/;

/** 把 head 拆成「user@host」与前后缀；不含 `@` 或 `@` 两侧带空白时返回 undefined。 */
export function splitPromptHead(head: string): { before: string; user: string; after: string } | undefined {
  const bracketed = /^\[([^[\]\n]*)\]$/.exec(head);
  const inner = bracketed ? bracketed[1] ?? "" : head;
  const open = bracketed ? "[" : "";
  const close = bracketed ? "]" : "";
  const at = inner.indexOf("@");
  if (at <= 0) return undefined;
  let start = 0;
  for (const separator of [" ", "(", "["]) {
    const found = inner.lastIndexOf(separator, at - 1);
    if (found >= start - 1 && found + 1 > start) start = found + 1;
  }
  let end = inner.length;
  for (const separator of [":", " "]) {
    const found = inner.indexOf(separator, at);
    if (found >= 0 && found < end) end = found;
  }
  const user = inner.slice(start, end);
  if (!/^[^\s@]+@[^\s@]+$/.test(user)) return undefined;
  return { before: open + inner.slice(0, start), user, after: inner.slice(end) + close };
}

function sgrForeground(color: string): string {
  const parsed = parseCssColor(color);
  if (!parsed) return "";
  return `\x1b[38;2;${parsed.r};${parsed.g};${parsed.b}m`;
}

const ZERO_WIDTH_SEQUENCE =
  /^(?:\x1b\[[0-9;?<=>!]*[A-Za-z@`~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78NODMHc])/;
const COLOR_SGR = /^\x1b\[([0-9;]*)m$/;

/** 剥离行首的零宽序列（CSI / OSC / 字符集切换），并报告其中是否含「设色」SGR。 */
function splitLeadingZeroWidth(text: string): { sequences: string; rest: string; hasColor: boolean } {
  let sequences = "";
  let rest = text;
  let hasColor = false;
  for (let step = 0; step < 8; step += 1) {
    const matched = ZERO_WIDTH_SEQUENCE.exec(rest);
    if (!matched) break;
    const sequence = matched[0] ?? "";
    const colorSgr = COLOR_SGR.exec(sequence);
    if (colorSgr && (colorSgr[1] ?? "") !== "" && !/^0+$/.test(colorSgr[1] ?? "")) hasColor = true;
    sequences += sequence;
    rest = rest.slice(sequence.length);
  }
  return { sequences, rest, hasColor };
}

/**
 * 给一行文本的行首提示符上色；不是提示符行（或任何解析异常）返回 undefined，
 * 调用方原样透传。返回的字符串长度上比输入多出的只是零宽 SGR。
 */
export function paintPromptLine(text: string, palette: PromptPalette): string | undefined {
  if (!text || text.length > 260) return undefined;
  const lead = splitLeadingZeroWidth(text);
  if (lead.hasColor) return undefined;
  const matched = PROMPT_LINE_RE.exec(lead.rest);
  const groups = matched?.groups;
  if (!matched || !groups) return undefined;
  const split = splitPromptHead(groups.head ?? "");
  if (!split) return undefined;

  const sigil = groups.sigil ?? "";
  const hostColor = sgrForeground(palette.host);
  const pathColor = sgrForeground(palette.path);
  const sigilColor = sgrForeground(sigil === "#" ? palette.rootSigil : palette.userSigil);
  if (!hostColor && !pathColor && !sigilColor) return undefined;

  const painted =
    pathColor +
    (groups.venv ?? "") +
    split.before +
    hostColor +
    split.user +
    pathColor +
    split.after +
    sigilColor +
    sigil +
    RESET_FOREGROUND +
    (groups.gap ?? "");
  return lead.sequences + painted + lead.rest.slice(matched[0].length);
}

/**
 * 有状态的提示符着色器：维护「是否处在行首」，逐 chunk 把远端数据流改写后交给
 * xterm。同一实例必须只服务一条终端流（状态不可跨终端复用）。
 */
export function createPromptHighlighter(readPalette: () => PromptPalette): (data: string) => string {
  let atLineStart = true;
  return (data: string): string => {
    if (!data) return data;
    // 快路径：不在行首且整块没有换行 —— 绝大多数 chunk 走这里，零额外开销。
    if (!atLineStart && !/[\r\n]/.test(data)) return data;
    let out = "";
    let index = 0;
    while (index < data.length) {
      let end = index;
      while (end < data.length && data[end] !== "\n" && data[end] !== "\r") end += 1;
      const segment = data.slice(index, end);
      if (segment) {
        out += atLineStart ? paintPromptLine(segment, readPalette()) ?? segment : segment;
        atLineStart = false;
      }
      if (end >= data.length) break;
      if (data[end] === "\r" && data[end + 1] === "\n") {
        out += "\r\n";
        index = end + 2;
      } else {
        out += data[end];
        index = end + 1;
      }
      // 换行（含 readline 的 `\r` 整行重绘）之后又是一个新的行首。
      atLineStart = true;
    }
    return out;
  };
}
