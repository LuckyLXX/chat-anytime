import { describe, expect, it } from "vitest";
// 渲染端 tsconfig 不带 node 类型（types 只有 vite/client），所以用 Vite 的 `?raw`
// 读源码，而不是 node:fs——这样断言的就是真正参与构建的那份文件。
import appRaw from "./App.tsx?raw";
import conversationPaneRaw from "./ConversationPane.tsx?raw";
import workflowCenterRaw from "./WorkflowCenter.tsx?raw";
import galleryDevelopRaw from "./lib/gallery-develop.ts?raw";

/**
 * 工作流渲染端接线的契约保护（源码断言型测试，2026-11-19）。
 *
 * 为什么是源码断言而不是渲染：App.tsx 要整套 store 假件 + bootstrap + 侧栏/预览/
 * 分屏子树才能挂载，而这里要钉的恰恰是「散落在 App 里的一根线」——静默失效类风险：
 * 漏接线时什么都不报错，就是按钮点了没反应、dirty 草稿被切走、原生预览盖住中心页。
 * 同先例：`src/main/panel-wiring.test.ts`、`gallery-develop-wiring.test.ts`。
 *
 * 已经能用真行为覆盖的部分不在这里重复：
 *  - 运行摘要的过期/水合/身份 → `store.test.ts`
 *  - 运行条按 owner 过滤与详情/定位回调 → `ConversationPane.composer-status-stack.test.tsx`
 *  - 切工作区的保存/放弃/取消 → `WorkflowCenter.test.tsx`
 */

// 行尾在本地工作区（LF）与 CI 检出（CRLF）之间不一致：读入即归一化，跨行断言才不会假红。
const normalize = (source: string): string => source.replace(/\r\n/gu, "\n");

const app = normalize(appRaw);
const conversationPane = normalize(conversationPaneRaw);
const workflowCenter = normalize(workflowCenterRaw);

describe("App：工作流中心的挂载与互斥", () => {
  it("中心页渲染在 work-area 内，包 ExitWrap 并登记 presence（原生预览要让位）", () => {
    expect(app).toContain('import { WorkflowCenter, type WorkflowLeaveGuard } from "./WorkflowCenter";');
    expect(app).toContain("const workflowCenterPresence = useExitPresence(workflowCenterOpen, 180);");
    expect(app).toContain("{workflowCenterPresence.rendered && (");
    expect(app).toContain("<WorkflowCenter");
    // work-area 上的类名是主题/布局契约（面板浮层据此收起）。
    expect(app).toContain("${workflowCenterPresence.rendered ? \" workflow-center-open\" : \"\"}");
    // 中心页自身是全幅 DOM 覆盖层，必须登记到弹层计数（WorkflowCenter 内部 useOverlayLayer(true)）。
    expect(workflowCenter).toContain("useOverlayLayer(true);");
  });

  it("打开中心页关闭预览与其它中心；反向入口也会关掉中心页", () => {
    // 打开：预览、设置、自动化面板/中心、记忆、上下文一起收起。
    const open = app.slice(app.indexOf("function openWorkflowCenter("), app.indexOf("function closeWorkflowCenter("));
    for (const line of ["setPreviewOpened(false);", "setPreviewAddMenuOpen(false);", "setSettingsOpen(false);", "setAutomationPanelOpen(false);", "setAutomationCenterOpen(false);", "setMemoryCenterOpen(false);", "setContextCenterOpen(false);"]) {
      expect(open).toContain(line);
    }
    // 反向：其它中心页与预览入口都要关掉工作流中心（互斥不能单向）。
    for (const fn of ["function openAutomationPanel(", "function openAutomationCenter(", "function openMemoryCenter(", "function openContextCenter("]) {
      const body = app.slice(app.indexOf(fn), app.indexOf("\n  }", app.indexOf(fn)));
      expect(body).toContain("setWorkflowCenterOpen(false);");
    }
    const previewOpen = app.slice(app.indexOf("const openPreviewTarget = useCallback("), app.indexOf("const updatePreviewTarget"));
    expect(previewOpen).toContain("setWorkflowCenterOpen(false);");
  });

  it("运行摘要按 owner 过滤后传给中心页（不把整库运行塞进去）", () => {
    expect(app).toContain("const workflowRunsSnapshot = useDesktopStore((state) => state.workflowRuns);");
    expect(app).toContain("workflowRunsForOwner(workflowRunsSnapshot?.runs, workflowCenterOwnerId)");
    expect(app).toContain("runs={workflowCenterRuns}");
    // 从运行条「详情」进来时落在运行历史页（initialRunId → 冻结快照）。
    expect(app).toContain("initialRunId: workflowCenterRunId");
  });

  it("切工作区不直接换中心的 workspace：先发切换请求，dirty 守卫回执后才落地", () => {
    const effect = app.slice(app.indexOf("// 工作区被切走且中心页开着"), app.indexOf("async function createWorkflowOwnerSession("));
    expect(effect).toContain("setWorkflowCenterSwitch({ workspace: activeWorkspace, requestId: workflowCenterSwitchSeqRef.current })");
    // 关键的反向证据：切换 effect 里**不能**直接 setWorkflowCenterWorkspace。
    expect(effect).not.toContain("setWorkflowCenterWorkspace(");
    expect(app).toContain("workspaceSwitch: workflowCenterSwitch");
    expect(app).toContain("onWorkspaceSwitch={(next) => { setWorkflowCenterWorkspace(next); setWorkflowCenterSwitch(undefined); }}");
  });
});

describe("App：离开中心的单一 dirty 守卫", () => {
  // 源码里的换行（不用 "\n" 字面量：本文件经 ?raw 读入的源码就是带换行的字符串）。
  const NL = String.fromCharCode(10);

  /** 取出以 `from` 开头、到 `closing` 为止的源码片段（找不到就红，避免断言空跑）。 */
  function block(from: string, closing: string): string {
    const start = app.indexOf(from);
    expect(start, `找不到 ${from}`).toBeGreaterThanOrEqual(0);
    const end = app.indexOf(closing, start);
    expect(end, `${from} 找不到收尾 ${JSON.stringify(closing)}`).toBeGreaterThan(start);
    return app.slice(start, end);
  }

  it("只有一个通道：requestLeaveWorkflowCenter 先问组件注册的守卫", () => {
    expect(app).toContain("const workflowCenterLeaveGuardRef = useRef<WorkflowLeaveGuard | undefined>(undefined);");
    expect(app).toContain("const registerWorkflowCenterLeaveGuard = useCallback((guard: WorkflowLeaveGuard | undefined): void => {");
    const request = block("const requestLeaveWorkflowCenter = useCallback(", `${NL}  }, []);`);
    // 中心页没开 / 守卫没注册时直接放行，否则把动作交给守卫（由它决定什么时候执行）。
    expect(request).toContain("if (!workflowCenterOpenRef.current) { action(); return; }");
    expect(request).toContain("if (!guard) { action(); return; }");
    expect(request).toContain("guard(action);");
    // 绝不用 window.confirm：那里只有「是/否」两选，没有保存/放弃/取消。
    expect(app).not.toContain("window.confirm(");
    // 组件侧注册与注销。
    expect(app).toContain("onRegisterLeaveGuard={registerWorkflowCenterLeaveGuard}");
  });

  it("每条会关掉中心页的路径都过守卫（四个中心 + 预览 + 设置 + 侧栏开关）", () => {
    for (const fn of ["function openAutomationPanel(", "function openAutomationCenter(", "function openMemoryCenter(", "function openContextCenter("]) {
      const body = block(fn, `${NL}  }${NL}`);
      expect(body, `${fn} 没有走 requestLeaveWorkflowCenter`).toContain("requestLeaveWorkflowCenter(() => {");
      expect(body).toContain("setWorkflowCenterOpen(false);");
    }
    const previewOpen = block("const openPreviewTarget = useCallback(", `${NL}  }, [requestLeaveWorkflowCenter]);`);
    expect(previewOpen).toContain("requestLeaveWorkflowCenter(() => {");
    expect(previewOpen).toContain("setWorkflowCenterOpen(false);");
    const reveal = block("function revealPreviewTab(", `${NL}  }${NL}`);
    expect(reveal).toContain("requestLeaveWorkflowCenter(() => {");
    expect(reveal).toContain("setWorkflowCenterOpen(false);");
    // 设置四个入口统一走 openSettings（侧栏按钮 / Ctrl+, / 命令面板 / openSettingsOn）。
    const openSettings = block("function openSettings(", `${NL}  }${NL}`);
    expect(openSettings).toContain("requestLeaveWorkflowCenter(() => {");
    expect(openSettings).toContain("setSettingsOpen(true);");
    expect(app).toContain('data-control="settings" onClick={() => openSettings()}');
    expect(app).toContain("else shortcutActionsRef.current.openSettings();");
    expect(app).toContain("openSettings: () => openSettings()");
    expect(app).toContain("run: () => openSettings()");
    expect(app).toContain("function openSettingsOn(tab: SettingsTab): void { openSettings(tab); }");
  });

  it("setWorkflowCenterOpen(false) 只出现在守卫的动作里，或就是守卫本身（closeWorkflowCenter）", () => {
    // 允许出现 setWorkflowCenterOpen(false) 的函数：守卫的动作闭包，以及「关页」这一个动作本身。
    const allowed = new Set([
      "openAutomationPanel", "openAutomationCenter", "openMemoryCenter", "openContextCenter",
      "openPreviewTarget", "revealPreviewTab",
      "closeWorkflowCenter"
    ]);
    let current = "";
    for (const line of app.split(NL)) {
      const fn = /^\s*(?:async )?function (\w+)\(/u.exec(line) ?? /^\s*const (\w+) = useCallback\(/u.exec(line);
      if (fn) current = fn[1]!;
      if (line.includes("setWorkflowCenterOpen(false)")) {
        expect(allowed.has(current), `setWorkflowCenterOpen(false) 出现在 ${current} 里，未经守卫`).toBe(true);
      }
    }
  });
});

describe("App：入口（侧栏 / 折叠栏 / 命令面板）", () => {
  it("侧栏与折叠栏都有 workflow-center-open 入口，并带激活态", () => {
    const matches = app.match(/data-control="workflow-center-open"/gu) ?? [];
    expect(matches).toHaveLength(2);
    expect(app).toContain("workflowCenterOpen ? \" active\" : \"\"");
    expect(app).toContain("workflowCenterOpen ? requestLeaveWorkflowCenter(closeWorkflowCenter) : openWorkflowCenter()");
  });

  it("命令面板有「打开工作流中心」动作", () => {
    expect(app).toContain('id: "view.workflow"');
    expect(app).toContain("run: () => openWorkflowCenter()");
    expect(app).toContain("Workflow,");
  });
});

describe("App：页面运行的 owner 解析", () => {
  it("没有 owner 时用带 requestId 的 session.new 等待回执，工作区固定在中心页", () => {
    const create = app.slice(app.indexOf("async function createWorkflowOwnerSession("), app.indexOf("/**\n   * 运行条「待确认」定位"));
    // 固定工作区：中心页的冻结工作区优先，缺省退回当前工作区；绝不跟随激活会话飘。
    expect(create).toContain("const workspace = workflowCenterWorkspace ?? activeWorkspace ?? \"\";");
    expect(create).toContain("workspace,");
    // 等真实回执（session.new-result），拿到的 id 写回 owner。
    expect(create).toContain("requestGallerySession({");
    expect(create).toContain("setWorkflowCenterOwnerId(sessionId);");
    // 绝不伪造 session-pending 身份（只允许出现在注释里，不能是字符串字面量）。
    expect(app).not.toContain('"session-pending');
    expect(app).not.toContain("session-pending-");
    expect(normalize(galleryDevelopRaw)).toContain("session.new-result");
  });

  it("待确认定位把 owner 会话切到前台（复用既有 PermissionDialog，不另造授权弹窗）", () => {
    const locate = app.slice(app.indexOf("function locateWorkflowOwner("), app.indexOf("// 运行条的两个入口"));
    expect(locate).toContain("sessionSummaries.find((item) => item.id === run.ownerSessionId)");
    expect(locate).toContain("focusPane(run.ownerSessionId)");
    expect(locate).toContain("void openSession(summary.path, summary.workspace, summary.id, summary.agentId);");
  });
});

describe("ConversationPane：运行条接线", () => {
  it("三处 ConversationPane 都接上详情/定位两个入口（单窗口 / 分屏格 / 设计模式侧栏）", () => {
    const matches = app.match(/onOpenWorkflowRun=\{openWorkflowRun\}/gu) ?? [];
    expect(matches).toHaveLength(3);
    expect((app.match(/onLocateWorkflowOwner=\{locateWorkflowOwnerEntry\}/gu) ?? [])).toHaveLength(3);
    // 回调身份恒定（ConversationPane 是 memo 组件）。
    expect(app).toContain("const openWorkflowRun = useCallback(");
    expect(app).toContain("const locateWorkflowOwnerEntry = useCallback(");
  });

  it("运行条按本格 owner 过滤后挂在 composer 的状态条堆栈里", () => {
    expect(conversationPane).toContain("workflowRunsForOwner(workflowRunsSnapshot?.runs, data.sessionId)");
    expect(conversationPane).toContain("<WorkflowRunStrip");
    expect(conversationPane).toContain("onDetails={(runId) => onOpenWorkflowRun?.(runId, sessionId)}");
    expect(conversationPane).toContain("onLocateOwner={(run) => onLocateWorkflowOwner?.(run)}");
    // 运行条必须在 status-stack 容器内部（与计划/团队同一条自适应容器）。
    const stack = conversationPane.slice(conversationPane.indexOf('data-composer-zone="status-stack"'), conversationPane.indexOf('data-composer-zone="queue"'));
    expect(stack).toContain("<WorkflowRunStrip");
    expect(stack).toContain('data-composer-zone="plan"');
    expect(stack).toContain("<TeamStrip");
  });
});
