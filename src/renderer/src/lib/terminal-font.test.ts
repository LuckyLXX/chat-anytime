import { describe, expect, it } from "vitest";
import { TERMINAL_FONT_FAMILY, TERMINAL_NERD_FONT_FAMILIES } from "./terminal-font";

/**
 * 钉住终端字体链契约（2026-09-19 豆腐块事故的防回归）。
 *
 * 这是一个「静默失效」类缺陷：链里少了 Nerd Font 不会报错、不会 fail 构建，
 * 只是在真实终端里把每个图标渲染成方块，肉眼在自动化测试里看不见。
 * 所以这里把关键约束显式断言出来，重构时抹掉其中任何一条都会转红。
 */

/** 把 CSS font-family 链解析成裸字体名列表（去掉引号与多余空白）。 */
function parseChain(chain: string): string[] {
  return chain
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

describe("terminal font chain", () => {
  it("链首是 Nerd Font（PUA 图标字形所在），排在所有系统等宽字体之前", () => {
    const chain = parseChain(TERMINAL_FONT_FAMILY);
    // 系统自带等宽字体没有一个含 PUA 图标字形 —— 它们必须在 Nerd Font 之后。
    const systemMono = ["Cascadia Mono", "Cascadia Code", "JetBrains Mono", "Consolas", "Courier New", "monospace"];
    const firstNerd = chain.findIndex((name) => TERMINAL_NERD_FONT_FAMILIES.includes(name as never));
    const firstSystem = chain.findIndex((name) => systemMono.includes(name));

    expect(firstNerd).toBe(0);
    expect(firstSystem).toBeGreaterThan(firstNerd);
  });

  it("保留 Nerd Font 的 Mono 变体（Propo 是比例宽度，会破坏 xterm 等宽网格）", () => {
    const chain = parseChain(TERMINAL_FONT_FAMILY);
    for (const family of TERMINAL_NERD_FONT_FAMILIES) {
      expect(family.endsWith(" Mono")).toBe(true);
      expect(family).not.toContain("Propo");
    }
    // 至少一个 Nerd Font 名真的写进了链里（避免常量与链脱钩）。
    expect(chain.some((name) => TERMINAL_NERD_FONT_FAMILIES.includes(name as never))).toBe(true);
  });

  it("末尾保留 generic monospace 兜底，未装 Nerd Font 的机器仍有等宽字体", () => {
    const chain = parseChain(TERMINAL_FONT_FAMILY);
    expect(chain.at(-1)).toBe("monospace");
    // 全部 Nerd Font 名都缺失时（未安装），链仍然非空可渲染。
    const withoutNerd = chain.filter((name) => !TERMINAL_NERD_FONT_FAMILIES.includes(name as never));
    expect(withoutNerd.length).toBeGreaterThanOrEqual(2);
  });

  it("含空格的字体名用双引号包裹（否则 CSS 会把它切成多个无效名）", () => {
    for (const name of parseChain(TERMINAL_FONT_FAMILY)) {
      if (name.includes(" ")) expect(TERMINAL_FONT_FAMILY).toContain(`"${name}"`);
    }
  });
});
