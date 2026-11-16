import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 作品「继续开发」跨工作区的接线契约（源码断言型，2026-10-28）。
 *
 * 为什么用源码断言：这条链路横跨 App.tsx（判定 + 新建话题 + 待注入）、preload 与
 * 主进程 IPC，而 App.tsx 渲染要一整套 store/IPC 假件（同 gallery-run-wiring.ts）。
 * 这里钉的都是**静默失效**类风险——不报错、不崩溃，只是用户点了像没点：
 *  1. 判定必须用 workspaceKey（大小写/分隔符不敏感），字符串相等会把 `D:\ws` 与
 *     `d:/ws` 当成两个工作区：明明在作品目录里却新建话题；
 *  2. 工作区失效必须**先预检**再 session.new，否则只会得到笼统的「新建话题失败」，
 *     既不带路径也无法区分是目录没了还是助手归档；
 *  3. 跨工作区必须是「新建干净话题」（2026-10-28 用户选定），不是打开历史会话；
 *  4. 注入必须等新会话的 composer 注册（sessionId 绑定 + 超时丢弃），
 *     不能顺手写当前会话的输入框——那就等于没修这个问题；
 *  5. 「打开所在文件夹」必须走 revealInExplorer(workspace, entry)，入口为根
 *     （kind=server 的 "."）时打开工作区根目录。
 *
 * 读源码一律用 read()：本地工作副本是 LF、CI（Windows runner）检出成 CRLF，
 * 硬编码 `\n` 的跨行断言会在 CI 上假红（见 docs/迭代记录 2026-09-28 条）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/gu, "\n");
const app = read(join(here, "../renderer/src/App.tsx"));
const preload = read(join(here, "../preload/index.ts"));
const main = read(join(here, "index.ts"));
const protocol = read(join(here, "../shared/protocol.ts"));
const wall = read(join(here, "../renderer/src/components/GalleryWall.tsx"));
const runtime = read(join(here, "pi-runtime.ts"));
const development = read(join(here, "../renderer/src/lib/gallery-develop.ts"));

/** 取出 `developGalleryApp` 的 useCallback 体（到依赖数组收尾）。 */
function developBody(): string {
  const start = app.indexOf("const developGalleryApp = useCallback(");
  expect(start, "找不到 developGalleryApp（改名了？此测试要同步更新）").toBeGreaterThan(-1);
  const end = app.indexOf("}, [focusedPaneId, activeSessionId, activeWorkspace, splitTree, settings, activeAgentId]);", start);
  expect(end, "developGalleryApp 的依赖数组变了（先确认改动，再同步这条断言）").toBeGreaterThan(start);
  return app.slice(start, end);
}

describe("作品继续开发的跨工作区接线", () => {
  const body = developBody();

  it("同工作区判定用 workspaceKey（路径身份，大小写/分隔符不敏感）", () => {
    expect(body).toContain("workspaceKey(activeWorkspace!) === workspaceKey(app.workspace)");
    // 反面：直接字符串相等会把 D:\\ws 与 d:/ws 当成两个工作区
    expect(body).not.toContain("activeWorkspace === app.workspace");
  });

  it("同工作区绑定现有会话并等待输入框，跨工作区不复用旧会话", () => {
    expect(body).toContain("let sessionId = sameWorkspace ? targetId : undefined;");
    expect(body).toContain("await insertGalleryDevelopmentText({");
    expect(body).toContain("getComposer: (target) => composerBridge.current.get(target)");
    expect(body).toContain("const needsNewSession = !sessionId;");
  });

  it("工作区失效先预检、再 session.new：报错带完整路径，绝不静默降级", () => {
    const checkAt = body.indexOf("workspaceDirectoryExists(app.workspace)");
    const newAt = body.indexOf("await requestGallerySession({");
    expect(checkAt, "预检调用不见了：失效工作区会被报成笼统的「新建话题失败」").toBeGreaterThan(-1);
    expect(newAt).toBeGreaterThan(checkAt);
    expect(body).toContain("throw new Error(`登记的工作区已失效：${app.workspace}");
    // 预检失败必须在 return 里，不能继续走 session.new
    expect(body).toMatch(/if \(!\(await window\.piDesktop\.workspaceDirectoryExists\(app\.workspace\)\)\) \{[\s\S]*?throw new Error/u);
  });

  it("跨工作区新建干净话题（用户选定），工作区来自作品登记", () => {
    expect(body).toContain("await requestGallerySession({");
    expect(body).toContain("workspace: app.workspace,");
    expect(body).toContain("agentId: pickTopicAgentId(settings, activeAgentId),");
    // 不是 session.open / workspace.open——那会恢复历史会话，不是「干净话题」
    expect(body).not.toContain('type: "session.open"');
    expect(body).not.toContain('type: "workspace.open"');
  });

  it("待注入使用独立操作 id，等到确认的新会话和输入框，超时或取消后清理", () => {
    expect(body).toContain("requestId: id,");
    expect(body).toContain("previous?.controller.abort();");
    expect(body).toContain("pendingGalleryInjectRef.current?.id === id");
    expect(body).toContain("sessionId = await requestGallerySession({");
    expect(body).toContain("await insertGalleryDevelopmentText({");
    expect(body).toContain("snapshot.sessionId === target");
    expect(body).toContain("pendingGalleryInjectRef.current = undefined;");
  });

  it("新话题回执由 utility 在真实创建后发出并按请求标识关联", () => {
    expect(protocol).toContain('type: "session.new-result"; requestId: string; ok: true; sessionId: string');
    expect(protocol).toContain('type: "session.new-result"; requestId: string; ok: false; error: string');
    expect(runtime).toContain('post({ type: "session.new-result", requestId: command.requestId, ok: true, sessionId: newSessionId });');
    expect(runtime).toContain('post({ type: "session.new-result", requestId: event.data.requestId, ok: false, error: errorText(error) });');
    expect(development).toContain('message.type !== "session.new-result" || message.requestId !== options.requestId');
    expect(development).toContain('type: "session.cancel-new", requestId: options.requestId');
    expect(runtime).toContain('if (event.data.type === "session.cancel-new") {');
    expect(runtime).toContain('sessionNewClaims.cancel(event.data.requestId);');
    expect(runtime).toContain('isCancelled: () => claim.cancelled');
    expect(runtime).toContain('sessionNewClaims.finish(requestId, claim);');
  });

  it("「打开所在文件夹」走 revealInExplorer：文件选中、工作区根直接进入", () => {
    expect(app).toContain('await window.piDesktop.revealInExplorer(app.workspace, app.entry === "." ? undefined : app.entry);');
    expect(wall).toContain('data-control="gallery-reveal"');
    expect(wall).toContain("onReveal(app)");
  });

  it("workspaceDirectoryExists 的协议 / preload / ipcMain 三处通道名一致", () => {
    expect(protocol).toContain("workspaceDirectoryExists(path: string): Promise<boolean>;");
    expect(preload).toContain('ipcRenderer.invoke("desktop:workspace-directory-exists", path)');
    expect(main).toContain('ipcMain.handle("desktop:workspace-directory-exists"');
  });
});
