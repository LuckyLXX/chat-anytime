import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 钉住 SSH 文件面板的**布局契约**（2026-09-19 覆盖层事故的防回归）。
 *
 * 初版把文件面板做成 `position: absolute; inset: 0; z-index: 8` 的覆盖层，而
 * 开关按钮是 `z-index: 7` 的绝对定位元素 —— 打开面板后它**盖住了自己的开关**，
 * 用户再也点不回终端，只能关掉整个 tab。这是一个纯 CSS/结构层面的死路，
 * jsdom 测不出、肉眼也要开真机才撞得到（用户实操发现）。
 *
 * 所以这里把约束直接钉在样式与组件结构文本上：面板必须是与终端同级的 flex 项
 * （分屏），开关必须在操作条里（而不是被面板包住），且不得出现 absolute 覆盖写法。
 *
 * 放在 `src/main/` 而非 `src/renderer/`：渲染端工程的 tsconfig 不含 node 类型
 *（没有 `node:fs` / `__dirname`），这仓库已有同类陷阱的先例。
 */

const styles = readFileSync(join(__dirname, "..", "renderer", "src", "styles.css"), "utf8");
const panelSource = readFileSync(join(__dirname, "..", "renderer", "src", "components", "SshFilesPanel.tsx"), "utf8");
const terminalSource = readFileSync(join(__dirname, "..", "renderer", "src", "components", "SshTerminalPanel.tsx"), "utf8");

/** 取出某条 CSS 规则的声明体（选择器做字面量匹配，取其后第一对花括号）。 */
function ruleBody(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`找不到 CSS 规则：${selector}`);
  const open = styles.indexOf("{", start);
  const close = styles.indexOf("}", open);
  return styles.slice(open + 1, close);
}

describe("SSH files panel layout contract", () => {
  it("文件面板是与终端同级的 flex 分屏项，不是覆盖层", () => {
    const drawer = ruleBody(".ssh-files-drawer");
    // 覆盖层的两个特征：绝对定位 + inset 铺满 —— 二者都会让它盖住开关。
    expect(drawer).not.toContain("position: absolute");
    expect(drawer).not.toContain("inset: 0");
    // 必须是参与 flex 布局的项。
    expect(drawer).toContain("flex:");
  });

  it("终端区域是竖向 flex，终端本体可伸缩（分屏后自动让出高度）", () => {
    expect(ruleBody(".ssh-terminal-pane")).toContain("flex-direction: column");
    // 终端本体必须 flex 伸缩且 min-height:0，否则内容撑开导致面板被挤出视口。
    const xterm = ruleBody(".ssh-terminal-pane .terminal-xterm");
    expect(xterm).toContain("flex: 1 1 auto");
    expect(xterm).toContain("min-height: 0");
  });

  it("开关在操作条里，且操作条与面板同级（永不被面板遮住）", () => {
    // 组件结构：操作条包含开关，且与面板是兄弟节点。
    const bar = terminalSource.indexOf('className="ssh-actions-bar"');
    const toggle = terminalSource.indexOf('data-control="ssh-files-toggle"');
    const drawer = terminalSource.indexOf('className="ssh-files-drawer"');
    expect(bar).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(bar);
    expect(drawer).toBeGreaterThan(toggle);
    // 开关**不能**是绝对定位（否则又回到「浮在终端上、可能被别的层盖住」的老路）。
    expect(ruleBody(".ssh-files-toggle")).not.toContain("position: absolute");
  });

  it("错误提示条不遮挡面板操作（不做成绝对定位浮层）", () => {
    expect(ruleBody(".ssh-files-error")).not.toContain("position: absolute");
  });

  it("面板根节点声明 data-pane=ssh-files（主题区域钩子）", () => {
    expect(panelSource).toContain('data-pane="ssh-files"');
  });
});
