import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 上下文中心的接线契约（源码断言型，2026-11-13）。
 *
 * 纯函数与组件测试都证明不了「用上了」：协议、utility 的命令分支、store 认领、
 * App 的三个入口、弹层按钮、主题契约，任何一处掉了都会让功能静默消失。
 * 这里逐点钉住，反向验证：删掉任意一处，对应用例转红。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

const protocol = read("src/shared/protocol.ts");
const runtime = read("src/main/pi-runtime.ts");
const store = read("src/renderer/src/store.ts");
const app = read("src/renderer/src/App.tsx");
const pane = read("src/renderer/src/ConversationPane.tsx");
const center = read("src/renderer/src/ContextCenter.tsx");
const styles = read("src/renderer/src/styles.css");
const themeGuide = read("docs/theme-guide.md");

/** 取函数/分支体的粗略切片：从标记开始到下一个顶层声明，够做「里面有没有」断言。 */
function sliceFrom(source: string, marker: string, length = 2600): string {
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`缺少标记：${marker}`);
  return source.slice(index, index + length);
}

describe("上下文中心接线", () => {
  it("协议同时声明命令、结果消息与投影类型", () => {
    expect(protocol).toContain("export interface ContextInspection {");
    expect(protocol).toContain("session.inspect\"; requestId: string; sessionId?: string");
    expect(protocol).toContain("session.inspect-result\"; requestId: string; sessionId?: string; inspection?: ContextInspection; error?: string");
  });

  it("utility 侧按目标会话组装，并把结果原样带回 requestId", () => {
    const body = sliceFrom(runtime, 'case "session.inspect":', 2600);
    expect(body).toContain("resolveTargetRecord(command.sessionId)");
    expect(body).toContain("contextInspection.buildContextInspection");
    expect(body).toContain("session.systemPrompt");
    expect(body).toContain("session.state.tools");
    expect(body).toContain("session.getAllTools()");
    expect(body).toContain("type: \"session.inspect-result\"");
    // 会话不在运行中时也要回帧，否则页面永远转圈
    expect(body).toContain("error: errorText(error)");
    // 不进快照：命令行里不出现 emitState / snapshot 构造
    expect(body).not.toContain("emitState");
  });

  it("store 只认当前 requestId，冲突帧整帧丢弃", () => {
    const body = sliceFrom(store, 'case "session.inspect-result":', 900);
    expect(body).toContain("current.requestId !== message.requestId");
    expect(body).toContain("loading: false");
  });

  it("App 渲染页面并接上三个入口（侧栏、折叠窄条、命令面板）", () => {
    expect(app).toContain("import { ContextCenter } from \"./ContextCenter\"");
    expect(app).toContain("<ContextCenter onClose={closeContextCenter} />");
    expect(app).toContain('data-control="context-center-open-nav"');
    const entries = app.match(/data-control="context-center-open-nav"/gu) ?? [];
    expect(entries.length).toBeGreaterThanOrEqual(2); // 展开侧栏 + 折叠窄条
    expect(app).toContain('id: "view.context"');
    expect(app).toContain("context-center-open\"");
    expect(app).toContain("onOpenContextCenter={openContextCenter}");
    expect(app).toContain("context-center-open\" : \"\"");
  });

  it("输入框上下文弹层底部有「查看全部成分」按钮", () => {
    expect(pane).toContain("onOpenContextCenter?(): void");
    expect(pane).toContain('data-control="context-center-open"');
    expect(pane).toContain("查看全部成分");
    expect(pane).toContain("setContextUsageOpen(false)");
  });

  it("页面根节点、空态与两段展示都在组件里", () => {
    expect(center).toContain('data-pane="context-center"');
    expect(center).toContain("session.inspect");
    expect(center).toContain("先打开一个话题");
    expect(center).toContain("读不到会话成分");
    expect(center).toContain("下一回合将注入");
    expect(center).toContain("本会话未注入");
  });

  it("样式与主题契约：pane 在文档里、关键类有样式", () => {
    expect(styles).toContain(".context-center {");
    expect(styles).toContain(".context-center-nav-item.active");
    expect(styles).toContain(".work-area.context-center-open");
    expect(themeGuide).toContain("`context-center`");
    for (const control of ["context-center-open", "context-center-open-nav", "context-center-close", "context-center-refresh", "context-center-prompt-view", "context-center-tool-filter"]) {
      expect(themeGuide).toContain(`\`${control}\``);
    }
  });
});
