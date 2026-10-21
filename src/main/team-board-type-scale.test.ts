import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 团队看板字号下限契约（源码断言型测试，2026-10-20）。
 *
 * 背景：用户反馈「团队看板字体很小看不清楚，全屏后也是这样」——看板首版把整块
 * 字号写死在 8–12px（8px 徽标、8.5px 统计、9.5px 步骤名），全屏工作台只是换布局、
 * 字号一点没变。修复后字号统一走 `.team-board` 上的 `--tb-fs-*` 四档变量，并在
 * `.team-board.full` 里整体上调一档；控件高度走 `--tb-ctl-h` / `--tb-icon-btn`。
 *
 * 为什么是源码断言：字号在 happy-dom 里量不到（不解析外部样式表），真值要截图看，
 * 但「有没有再掉回 8px」这条用文本就能钉死。放 main 侧与 agent-settings-style.test.ts
 * 同一先例（渲染端测试无 node 类型）。styles.css 的团队看板规则都在文件末尾，
 * 从 `.team-board {` 切到结尾即可。
 */
const here = dirname(fileURLToPath(import.meta.url));
// 读入即归一化行尾：CI（Windows runner，core.autocrlf=true）检出的是 CRLF，本地是 LF。
const css = readFileSync(join(here, "../renderer/src/styles.css"), "utf8").replace(/\r\n/gu, "\n");

// `\n.team-board {` 而不是 `.team-board {`：`.conversation-pane.team-board-full .team-board {`
// 也含这串字符，会切到看板块之前（连带 composer 里的团队按钮）。
const start = css.indexOf("\n.team-board {");
const block = start >= 0 ? css.slice(start + 1) : "";

describe("团队看板字号契约", () => {
  it("存在团队看板样式块与四档字号变量", () => {
    expect(start, "styles.css 里必须存在 .team-board 规则").toBeGreaterThan(-1);
    for (const token of ["--tb-fs-title", "--tb-fs-body", "--tb-fs-label", "--tb-fs-micro"]) {
      expect(block).toContain(`${token}:`);
    }
  });

  it("字号不低于 10px，且规则都走变量（不留写死的 px 字号）", () => {
    const sizes = [...block.matchAll(/font-size:\s*([0-9.]+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length, "字号变量应覆盖看板内全部文字").toBe(0);
    expect(block).toContain("font-size: var(--tb-fs-");
  });

  it("全屏工作台整体上调一档字号并放宽三栏宽度", () => {
    const full = block.match(/\.team-board\.full \{[^}]*\}/);
    expect(full, "必须存在 .team-board.full 规则").not.toBeNull();
    expect(full![0]).toContain("--tb-fs-title: 15px");
    expect(full![0]).toContain("--tb-fs-body: 13.5px");
    expect(block).toMatch(/\.team-formation-main \{[^}]*grid-template-columns/);
    expect(block).toContain("@container (max-width: 1180px)");
  });
});
