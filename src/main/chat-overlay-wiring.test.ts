import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 会话级确认框「只在聊天区内居中」的接线契约（2026-10-04，源码断言型）。
 *
 * 背景：内置浏览器的预览标签是 Electron 原生 `WebContentsView`，永远画在所有 DOM
 * 之上（`overlay-layers.ts` 记的是同一条事实）。删除会话弹窗被它盖掉，既有通路
 *（弹层计数 → `browserSuspended` 隐藏原生视图）能治，但确认框是一次性小弹窗，
 * 让整块浏览器面板跟着闪不划算。这里的解法是**让弹窗不与面板重叠**：量出会话区
 * 矩形写进 CSS 变量，`.modal-backdrop.in-chat` 用它把遮罩收进聊天区。
 *
 * 为什么用源码断言：真正的几何（原生视图的 bounds、浏览器里 CSS 变量的实际取值）
 * 在 happy-dom 里都不存在，测得到的只有写法——而写法恰恰最容易漏：量了变量却没人
 * 用、加了 class 却没接变量，功能看起来完整、遮挡一模一样。计数/几何的纯逻辑由
 * `src/renderer/src/lib/chat-overlay-region.test.tsx` 覆盖。
 *
 * ⚠️ 多行片段断言前必须归一化行尾（仓库是 CRLF，CI 检出行为不同，先例见
 * `panel-wiring.test.ts` 的注释）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n/gu, "\n");

const app = read("../renderer/src/App.tsx");
const workspaceTree = read("../renderer/src/components/WorkspaceTree.tsx");
const galleryDialogs = read("../renderer/src/components/GalleryDialogs.tsx");
const styles = read("../renderer/src/styles.css");

/** 取出某条 CSS 规则的声明体（选择器字面量匹配，取其后第一对花括号）。 */
function ruleBody(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`找不到 CSS 规则：${selector}`);
  const open = styles.indexOf("{", start);
  return styles.slice(open + 1, styles.indexOf("}", open));
}

describe("聊天区遮罩的接线契约", () => {
  it("App 常驻量测会话区并把矩形挂到 work-area 的 ref 上", () => {
    expect(app).toContain('from "./lib/chat-overlay-region"');
    expect(app).toContain("useChatOverlayRegion(workAreaRef)");
    // 不能挂在某个弹窗内部：工作区文件树的弹窗是 portal 出去的，谁开谁量必漏。
    expect(app).toContain('<div\n            ref={workAreaRef}');
  });

  it("样式层：in-chat 只改左右边界（top/bottom 仍是整窗）且带整窗缺省值", () => {
    const body = ruleBody(".modal-backdrop.in-chat");
    expect(body).toContain("left: var(--chat-overlay-left, 0px)");
    expect(body).toContain("right: var(--chat-overlay-right, 0px)");
    // 缺省值必须是「整窗」：量测没跑起来（未挂载会话区）时退回旧行为，不能塌成 0 宽。
    expect(body).not.toContain("var(--chat-overlay-left) ");
    // 弹窗宽度跟着区域走，否则窄聊天区里弹窗会溢出到面板那一侧。
    expect(styles).toContain(".modal-backdrop.in-chat > .permission-dialog, .modal-backdrop.in-chat > .extension-ui-dialog { width: min(480px, 100%); }");
  });

  it("四个 App 级确认框都带上 in-chat（删除 / 重命名 / 回滚 / 移除工作区）", () => {
    for (const anchor of ['aria-label="重命名会话"', 'aria-label="删除会话"', 'aria-label="回滚文件"', 'aria-label="移除工作区"']) {
      const at = app.indexOf(anchor);
      expect(at, `App.tsx 里找不到 ${anchor}`).toBeGreaterThan(-1);
      // 向前回看 backdrop 那一行，确认同一个弹层带了 in-chat。
      const backdrop = app.lastIndexOf('className="modal-backdrop permission-backdrop', at);
      expect(app.slice(backdrop, backdrop + 60), `${anchor} 的遮罩缺 in-chat`).toContain("permission-backdrop in-chat");
    }
  });

  it("工作区文件树的两个弹窗同样带 in-chat（它们 portal 到 body，只能靠根变量生效）", () => {
    expect(workspaceTree).not.toContain('className="modal-backdrop permission-backdrop"');
    expect(workspaceTree.match(/modal-backdrop permission-backdrop in-chat/gu)).toHaveLength(2);
  });

  it("叠了 in-chat 也照旧登记弹层计数：预览面板全屏时靠 browserSuspended 兜底", () => {
    expect(app).toContain("useOverlayLayer(renamePresence.rendered || deletePresence.rendered || rollbackPresence.rendered || removeWorkspacePresence.rendered || transcriptPresence.rendered)");
    // 文件树的弹窗是深层组件：同一计数通路（谁开谁登记）。
    expect(workspaceTree).toContain('from "../lib/overlay-layers"');
    expect(workspaceTree).toContain("useOverlayLayer(true)");
    // 作品墙 / 登记作品这两个大弹层不参与 in-chat 收窄，只能靠挂起原生视图。
    expect(galleryDialogs.match(/useOverlayLayer\(true\)/gu)).toHaveLength(2);
  });

  it("右下角提示条改挂聊天区右缘（它本来就落在预览面板那一侧）", () => {
    const body = ruleBody(".error-toast");
    expect(body).toContain("right: calc(var(--chat-overlay-right, 0px) + 18px)");
    // 聊天区被挤窄时提示条不能横向溢出到面板下面。
    expect(body).toContain("max-width: max(200px, calc(var(--chat-overlay-width, 100vw) - 36px))");
  });
});
