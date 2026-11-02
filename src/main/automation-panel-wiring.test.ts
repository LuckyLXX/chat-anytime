import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 自动化面板 P0 的接线契约（2026-11-02）。
 *
 * 纯渲染测试只能证明面板自己发命令；这里钉住「入口真的打开面板而不是设置页」、
 * 「后台会话真的写入 origin」、「停止命令真的接到中止路径」以及主题五处镜像，
 * 防止后续重构把功能悄悄退回旧行为。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

describe("automation panel wiring contract", () => {
  const app = read("../renderer/src/App.tsx");
  const panel = read("../renderer/src/AutomationPanel.tsx");
  const runtime = read("pi-runtime.ts");
  const catalog = read("session-catalog.ts");
  const protocol = read("../shared/protocol.ts");
  const styles = read("../renderer/src/styles.css");

  it("sidebar entry opens the right-side panel and keeps the session bucket toggle", () => {
    expect(app).toContain("import { AutomationPanel");
    expect(app).toContain("automation-panel-open");
    expect(app).toContain('data-control="automation-open"');
    expect(app).toContain("openAutomationPanel()");
    expect(app).toContain('data-control="automation-sessions-toggle"');
    expect(app).toContain("showAutomationSessions");
    expect(styles).toContain(".automation-panel {");
    expect(styles).toContain(".work-area.automation-panel-open");
  });

  it("panel exposes task/runs controls and the stop action", () => {
    expect(panel).toContain('data-pane="automation-panel"');
    expect(panel).toContain('data-control="automation-run"');
    expect(panel).toContain('data-control="automation-toggle"');
    expect(panel).toContain('data-control="automation-stop"');
    expect(panel).toContain('data-control="automation-panel-close"');
    expect(panel).toContain('data-control="automation-panel-manage"');
    expect(panel).toContain("<AutomationRuns");
    expect(panel).toContain("compact");
  });

  it("background runs write the persistent origin marker into the Pi session", () => {
    expect(protocol).toContain("origin?: SessionOrigin");
    expect(runtime).toContain("appendCustomEntry(AUTOMATION_SESSION_ORIGIN_CUSTOM_TYPE");
    expect(runtime).toContain('sessionOrigin: { kind: "automation", taskId: task.id, taskName: task.name }');
    expect(runtime).toContain("origin: record.origin");
    expect(catalog).toContain("item.origin ? { origin: item.origin }");
  });

  it("stop command routes to the existing session.abort path", () => {
    expect(protocol).toContain('type: "automation.stop"');
    expect(runtime).toContain("const automationRunSessions = new Map<string, string>();");
    expect(runtime).toContain('case "automation.stop":');
    expect(runtime).toContain('await handleCommand({ type: "session.abort", sessionId: runSessionId });');
  });

  it("topic list and search hide automation sessions by default", () => {
    expect(app).toContain("sessionsForView(sessionSummaries, sessionView, sessionViewOptions)");
    expect(app).toContain("showAutomation: showAutomationSessions");
    expect(runtime).toContain("isAutomationSessionSummary(session)");
    expect(catalog).toContain("includeAutomation");
  });

  it("keeps the five theme mirrors in sync", () => {
    const mirrors = [
      "../../AGENTS.md",
      "../../docs/theme-guide.md",
      "../../resources/skills/pidesktop-theme-creator/SKILL.md",
      "../../resources/skills/pidesktop-theme-creator/references/variables.md",
      "../../resources/skills/pidesktop-theme-creator/scripts/check_theme.py"
    ];
    for (const mirror of mirrors) expect(read(mirror)).toContain("automation-panel");
  });
});
