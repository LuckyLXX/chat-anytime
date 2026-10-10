import { describe, expect, it } from "vitest";
import { createPromptHighlighter, paintPromptLine, readPromptPalette, splitPromptHead, type PromptPalette } from "./terminal-prompt";
import { resolveXtermTheme } from "./terminal-theme";

/**
 * 提示符着色契约（2026-10-10）。
 * 最重要的一条不是「能上色」，而是**上色后可见文本一字不变**：SGR 必须零宽，
 * 否则远端 bash 的 readline 行列计算会和显示错位。每个用例都钉这条不变量。
 */

const palette: PromptPalette = { host: "#ff0000", path: "#00ff00", rootSigil: "#0000ff", userSigil: "#ffff00" };

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");
const hostPaint = "\x1b[38;2;255;0;0m";
const pathPaint = "\x1b[38;2;0;255;0m";

function painted(line: string): string {
  const result = paintPromptLine(line, palette);
  expect(result, `expected a painted prompt for ${JSON.stringify(line)}`).toBeDefined();
  expect(stripAnsi(result!)).toBe(line);
  return result!;
}

describe("splitPromptHead", () => {
  it("splits user@host from the bracketed form", () => {
    expect(splitPromptHead("[root@iZbp1xxxx ~]")).toEqual({ before: "[", user: "root@iZbp1xxxx", after: " ~]" });
  });

  it("splits user@host from the colon/path form", () => {
    expect(splitPromptHead("deploy@web-01:~/app")).toEqual({ before: "", user: "deploy@web-01", after: ":~/app" });
  });

  it("rejects heads without a usable user@host pair", () => {
    expect(splitPromptHead("total")).toBeUndefined();
    expect(splitPromptHead("user @host")).toBeUndefined();
    expect(splitPromptHead("@host")).toBeUndefined();
  });
});

describe("paintPromptLine", () => {
  it("colours root@host path# prompts", () => {
    const result = painted("root@iZbp1xxxx:/var/www# ");
    expect(result).toContain(`${hostPaint}root@iZbp1xxxx`);
    expect(result).toContain(`${pathPaint}:/var/www`);
    expect(result).toContain("\x1b[38;2;0;0;255m#");
    expect(result.endsWith("\x1b[39m ")).toBe(true);
  });

  it("colours bracketed prompts and unix sigils", () => {
    const result = painted("[deploy@web-01 ~]$ ");
    expect(result).toContain(`${hostPaint}deploy@web-01`);
    expect(result).toContain(`${pathPaint} ~]`);
    expect(result).toContain("\x1b[38;2;255;255;0m$");
  });

  it("colours the distro default `[\\u@\\h \\W]\\$` root prompt", () => {
    // 云主机最常见的默认 PS1（用户 2026-10-10 确认自己就是这种形态）。
    const result = painted("[root@iZbp1xxxx ~]# ");
    expect(result).toContain(`${hostPaint}root@iZbp1xxxx`);
    expect(result).toContain(`${pathPaint} ~]`);
    expect(result).toContain("\x1b[38;2;0;0;255m#");
  });

  it("keeps a command typed after the prompt untouched", () => {
    const result = painted("deploy@web-01:~/app$ ls -la --color=auto");
    expect(stripAnsi(result)).toBe("deploy@web-01:~/app$ ls -la --color=auto");
    expect(result).toContain("\x1b[39m ls -la --color=auto");
  });

  it("keeps zero-width control sequences that precede the prompt", () => {
    const result = painted("\x1b[Kdeploy@web-01:~$ ");
    expect(result.startsWith("\x1b[K")).toBe(true);
    expect(stripAnsi(result)).toBe("\x1b[Kdeploy@web-01:~$ ");
  });

  it("leaves ordinary output alone", () => {
    for (const line of [
      "total 24",
      "drwxr-xr-x 2 root root 4096 Oct 10 12:00 docs",
      "-rw-r--r-- 1 root root  512 .bashrc",
      "root@host#tag without a space",
      "  indented output",
      "warning: see https://example.com/@user#anchor"
    ]) {
      expect(paintPromptLine(line, palette), line).toBeUndefined();
    }
  });

  it("does not fight a prompt the server already coloured", () => {
    expect(paintPromptLine("\x1b[32mroot@host:/# \x1b[0m", palette)).toBeUndefined();
    expect(paintPromptLine("\x1b[1;36mroot@host:/# ", palette)).toBeUndefined();
    // 纯重置序列不算设色，仍可着色。
    expect(paintPromptLine("\x1b[0mroot@host:/# ", palette)).toBeDefined();
  });
});

describe("createPromptHighlighter", () => {
  it("paints only line starts and passes output through byte-for-byte", () => {
    const highlight = createPromptHighlighter(() => palette);
    const banner = highlight("root@host:/# ls -la\r\n");
    const output = "total 8\r\n";
    expect(banner).toContain(hostPaint);
    expect(highlight(output)).toBe(output);
    const prompt = highlight("root@host:/# ");
    expect(prompt).toContain(hostPaint);
  });

  it("re-paints after a readline redraw (`\\r` + erase line)", () => {
    const highlight = createPromptHighlighter(() => palette);
    highlight("root@host:/# ls");
    const redraw = highlight("\r\x1b[Kroot@host:/# ls -la");
    expect(redraw).toContain(`${hostPaint}root@host`);
  });

  it("gives up on a prompt split across chunk boundaries instead of corrupting it", () => {
    const highlight = createPromptHighlighter(() => palette);
    expect(highlight("ro")).toBe("ro");
    expect(highlight("ot@host:/# ")).toBe("ot@host:/# ");
  });

  it("threads state across chunks for multi-line payloads", () => {
    const highlight = createPromptHighlighter(() => palette);
    const payload = "root@host:/# echo hi\rc\rc\recho hi\r\nhi\r\nroot@host:/# ";
    const result = highlight(payload);
    expect(stripAnsi(result)).toBe(payload);
    expect(result.match(/38;2;255;0;0m/g)?.length).toBe(2);
  });
});

describe("readPromptPalette", () => {
  it("reuses the xterm palette so prompts match remote output", () => {
    const theme = resolveXtermTheme({ background: "#0b1220", foreground: "#e5e7eb", accent: "#ffa757", border: "#24444e" });
    const derived = readPromptPalette(theme);
    expect(derived.host).toBe("#ffa757");
    expect(derived.path).toBe(theme.cyan);
    expect(derived.rootSigil).toBe(theme.red);
    expect(derived.userSigil).toBe(theme.green);
  });
});
