import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 第二批（2026-11-18 P0 冷开优化）的接线契约。
 *
 * 协调器自己的行为由 `session-open-coordinator.test.ts` 覆盖；这里钉的是
 * **接线**——登记发生在消息入口而不是执行时、屏障覆盖所有入队命令、过期请求
 * 在阶段边界真的退出、准备阶段不再预写全局 workspace、未提交资源按阶段回收、
 * 分屏入口在 open 之前先发 watch。任何一条回退都会让「请求合并」变成
 * 「请求丢失」或「格子空白」。
 */
describe("session open coordination wiring (batch 2)", () => {
  const runtime = readFileSync(join(__dirname, "pi-runtime.ts"), "utf8").replace(/\r\n/gu, "\n");
  const app = readFileSync(join(__dirname, "..", "renderer", "src", "App.tsx"), "utf8").replace(/\r\n/gu, "\n");

  function sliceFrom(marker: string, endMarker: string): string {
    const start = runtime.indexOf(marker);
    expect(start, `找不到锚点：${marker}`).toBeGreaterThan(-1);
    const end = runtime.indexOf(endMarker, start);
    expect(end, `找不到结束锚点：${endMarker}`).toBeGreaterThan(start);
    return runtime.slice(start, end);
  }

  it("registers the open intent at the message entry, before the serial queue", () => {
    const handler = runtime.slice(runtime.indexOf('parentPort.on("message"'));
    const register = handler.indexOf("registerSessionOpenIntent(event.data)");
    const queue = handler.indexOf("commandQueue = commandQueue");
    expect(register).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(register);
    // 登记之后入队之前，其余命令一律关闭当前批次（屏障）。
    expect(handler).toContain("sessionOpenCoordinator.barrier()");
    // 分屏保护：watch 到达即登记/解除。
    expect(handler).toContain("sessionOpenCoordinator.protectSession(event.data.sessionId)");
    expect(handler).toContain("sessionOpenCoordinator.unprotectSession(event.data.sessionId)");
    // 票根必须在 finally 释放（成功/失败/跳过都走这里）。
    expect(handler).toContain("sessionOpenCoordinator.finish(openTicket.seq)");
    // 被取代的打开不弹错误 toast（新目标接管 opening 提示）。
    expect(handler).toContain("if (openTicket?.isSuperseded()) return;");
  });

  it("keeps RPC results and the stop side-paths out of the barrier logic", () => {
    const handler = runtime.slice(runtime.indexOf('parentPort.on("message"'));
    const abortIndex = handler.indexOf('event.data.type === "session.killExecution"');
    const registerIndex = handler.indexOf("registerSessionOpenIntent(event.data)");
    // 旁路在登记/屏障之前 return：RPC 结果与停止不参与批次推进。
    expect(abortIndex).toBeGreaterThan(-1);
    expect(registerIndex).toBeGreaterThan(abortIndex);
    expect(handler.indexOf('"browser-automation.result"')).toBeLessThan(registerIndex);
  });

  it("skips a superseded open before any disk work and never steals the activation", () => {
    const branch = sliceFrom('case "session.open": {', 'case "session.search": {');
    const ticketIndex = branch.indexOf("sessionOpenTickets.get(command)");
    const liveIndex = branch.indexOf("const fileLive =");
    expect(ticketIndex).toBeGreaterThan(-1);
    expect(liveIndex).toBeGreaterThan(ticketIndex);
    expect(branch).toContain("if (ticket && !sessionOpenCoordinator.begin(ticket.seq)) break;");
    // 两处阶段边界：解析前（opening 之后）与解析后（装配之前），且都只对
    // 有票根的前台打开启用（内部递归恢复保持原调度语义）。
    expect(branch.match(/if \(ticket\) \{\s*await yieldToEventLoop\(\);\s*if \(ticket\.isSuperseded\(\)\)/gu)).toHaveLength(2);
    expect(branch.match(/await yieldToEventLoop\(\)/gu)).toHaveLength(2);
    // 解析后过期：manager 回到缓存或释放，不再装配。
    expect(branch).toContain("releaseUnusedSessionManager(acquisition, target, recordWorkspace, owner.agentId)");
    // 装配中的检查走同一个票根（不只依赖 generation）。
    expect(branch).toContain("isCancelled: () => ticket.isSuperseded()");
    // 装配中途被取代（还没进 SDK）时 manager 回缓存，而不是白扔一次解析。
    expect(branch).toContain('if (stage === "prepared") releaseUnusedSessionManager(acquisition, target, recordWorkspace, owner.agentId)');
    // 被取代留下的 opening 提示由后续目标接管（live 快路径也要接手）。
    expect(branch).toContain("pendingOpeningHintPath !== target.toLowerCase()");
  });

  it("no longer pre-writes the global workspace during preparation", () => {
    const branch = sliceFrom('case "session.open": {', 'case "session.search": {');
    // activate(record) 是唯一提交点：准备阶段写全局镜像会让被取代的打开留下痕迹。
    expect(branch).not.toContain("workspace = recordWorkspace");
    expect(branch).not.toContain("touchRecentWorkspace(");
    expect(branch).toContain("post({ type: \"session.opening\", path: target");
  });

  it("keeps every global mirror untouched until activate() commits the record", () => {
    const fn = sliceFrom("async function createSession(", "function syncBundledToolsToAgentDir(");
    // 取消/失败/被取代都不得改动工作区、助手与 active 会话（它们只在 activate 里改）。
    expect(fn).not.toContain("currentAgent = ");
    expect(fn).not.toContain("activeRuntime = ");
    expect(fn).not.toContain("settings.currentAgentId");
    expect(fn).not.toMatch(/^  workspace = /mu);
  });

  it("checks the checkpoint at every stage boundary and cleans up by stage", () => {
    const fn = sliceFrom("async function createSession(", "function syncBundledToolsToAgentDir(");
    // 阶段边界：资源装配前 / reload 后、SDK 前 / SDK 后 / 扩展绑定后。
    const reload = fn.indexOf("await resourceLoader.reload();");
    const sdk = fn.indexOf("const result = await createAgentSession({");
    const bind = fn.indexOf("await result.session.bindExtensions({");
    expect(reload).toBeGreaterThan(-1);
    expect(sdk).toBeGreaterThan(reload);
    expect(bind).toBeGreaterThan(sdk);
    const checkpoints = [...fn.matchAll(/await abandonCheckpoint\(\)/gu)].map((match) => match.index!);
    expect(checkpoints.length).toBeGreaterThanOrEqual(5);
    expect(checkpoints.filter((index) => index < reload)).toHaveLength(1);
    // reload 之后、SDK 之前两处：装配完成一次 + 工具装配完成后一次。
    expect(checkpoints.filter((index) => index > reload && index < sdk)).toHaveLength(2);
    expect(checkpoints.filter((index) => index > sdk && index < bind)).toHaveLength(1);
    expect(checkpoints.filter((index) => index > bind)).toHaveLength(1);
    // 未提交的 SDK 会话按阶段回收，绝不走 disposeRecord。
    expect(fn.match(/discardUncommitted\(result\.session\)/gu)).toHaveLength(2);
    expect(fn).not.toContain("disposeRecord(result");
    // 回收时把「是否已进 SDK」告诉调用方（prepared 阶段 manager 可安全回缓存）。
    expect(fn).toContain("sdkSessionCreated = true;");
    expect(fn).toContain('options.onAbandoned?.(sdkSessionCreated ? "built" : "prepared")');
  });

  it("yields only for cancellable foreground opens and tears resources down in order", () => {
    const fn = sliceFrom("async function createSession(", "function syncBundledToolsToAgentDir(");
    // 新的让出点只对带 isCancelled 的调用启用：后台/自动化会话调度语义不变。
    expect(fn).toContain("const cancellation = options.isCancelled;");
    expect(fn).toContain("if (!cancellation) return false;");
    // 回收顺序：MCP 注销 → 配置监听 → 团队 → 订阅 →（最后）session.dispose。
    const teardown = fn.slice(fn.indexOf("teardown.push(() => {"), fn.indexOf("teardown.push(() => {\n    clearTimeout(mcpStatusTimer);"));
    expect(teardown.indexOf("unregisterAll")).toBeLessThan(teardown.indexOf("mcpConfigWatcher"));
    expect(teardown.indexOf("mcpConfigWatcher")).toBeLessThan(teardown.indexOf("teamRuntime?.dispose"));
    expect(teardown.indexOf("teamRuntime?.dispose")).toBeLessThan(teardown.indexOf("unsubscribe"));
    const discard = fn.slice(fn.indexOf("const discardUncommitted = "), fn.indexOf("// 首屏列表刷新可能在本函数里启动"));
    expect(discard.indexOf("step()")).toBeLessThan(discard.indexOf("session?.dispose()"));
  });

  it("registers watch before opening a split pane (both entries)", () => {
    const addSplit = app.slice(app.indexOf("function addSplitPane("), app.indexOf("function removeSplitPane("));
    const protect = addSplit.indexOf("protectSplitPane(item.id)");
    const open = addSplit.indexOf('type: "session.open"');
    expect(protect).toBeGreaterThan(-1);
    expect(open).toBeGreaterThan(protect);

    const openSession = app.slice(app.indexOf("async function openSession("), app.indexOf("function openSearchHit("));
    const replaceProtect = openSession.indexOf("protectSplitPane(sessionId)");
    const replaceOpen = openSession.indexOf('type: "session.open"');
    expect(replaceProtect).toBeGreaterThan(-1);
    expect(replaceOpen).toBeGreaterThan(replaceProtect);

    const restore = app.slice(app.indexOf("splitRestoreDoneRef.current = true;"), app.indexOf("}, [ready, splitTree, paneIds, focusedPaneId, sessionSummaries]);"));
    const restoreProtect = restore.indexOf("protectSplitPane(focused)");
    const restoreOpen = restore.indexOf('type: "session.open"');
    expect(restoreProtect).toBeGreaterThan(-1);
    expect(restoreOpen).toBeGreaterThan(restoreProtect);
  });

  it("does not re-send watch for an already registered pane", () => {
    const helper = app.slice(app.indexOf("function protectSplitPane("), app.indexOf("async function openSession("));
    expect(helper).toContain("if (registered.has(sessionId)) return;");
    expect(helper).toContain('type: "session.watch"');
  });
});
