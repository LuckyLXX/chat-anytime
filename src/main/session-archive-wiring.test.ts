import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 会话软归档的接线契约（2026-09-28）。
 *
 * 为什么需要源码断言：`session-scope.ts` 自己的用例只能证明「集合运算正确」，
 * 证明不了「命令真的接上了、列表真的按它投影、批量删除真的没逐条刷新列表」。
 * 这套接线的每一处缺失都是静默失效——归档点了没反应（命令没人接）、
 * 归档的会话自己回来（映射/回填漏字段）、或批量删除排出 N 轮磁盘扫描。
 * 这里把五处接线钉死（同 session-index-wiring.test.ts 的纪律）。
 */
describe("session archive wiring contract", () => {
  const runtimeSource = readFileSync(join(__dirname, "pi-runtime.ts"), "utf8");
  const mainSource = readFileSync(join(__dirname, "index.ts"), "utf8");
  const settingsSource = readFileSync(join(__dirname, "settings.ts"), "utf8");
  const protocolSource = readFileSync(join(__dirname, "..", "shared", "protocol.ts"), "utf8");
  const storeSource = readFileSync(join(__dirname, "..", "renderer", "src", "store.ts"), "utf8");
  const appSource = readFileSync(join(__dirname, "..", "renderer", "src", "App.tsx"), "utf8");

  describe("协议声明", () => {
    it("SessionSummary 带 archived 字段、settings 带 archivedSessionPaths 集合", () => {
      expect(protocolSource).toContain("archived?: boolean;");
      expect(protocolSource).toContain("archivedSessionPaths?: string[];");
    });

    it("声明 session.archive（批量入参）与 session.deleteMany 两条命令", () => {
      expect(protocolSource).toContain('{ type: "session.archive"; paths: string[]; archived: boolean }');
      expect(protocolSource).toContain('{ type: "session.deleteMany"; paths: string[] }');
    });
  });

  describe("utility 进程（pi-runtime.ts）", () => {
    it("列表投影按 archivedSessionPaths 计算 archived（与置顶同一处）", () => {
      expect(runtimeSource).toContain("const archivedPaths = settings?.archivedSessionPaths ?? [];");
      expect(runtimeSource).toContain("archived: isSessionArchived(archivedPaths, item.path) || undefined,");
    });

    it("session.archive 更新内存镜像后刷新列表", () => {
      const archiveCase = runtimeSource.slice(runtimeSource.indexOf('case "session.archive": {'), runtimeSource.indexOf('case "session.delete": {'));
      expect(archiveCase).toContain("setArchivedSessionPaths(settings.archivedSessionPaths, accepted, command.archived)");
      expect(archiveCase).toContain("await refreshSessions();");
      expect(archiveCase).toContain("emitState();");
    });

    it("删除的落地体被 session.delete 与 session.deleteMany 共用", () => {
      // 定义 1 次 + 两条命令各调用 1 次 = 3 次（把删除体复制一份出来就少一次）
      expect(runtimeSource.match(/deleteSessionByPath\(/gu)?.length).toBe(3);
      const single = runtimeSource.slice(runtimeSource.indexOf('case "session.delete": {'), runtimeSource.indexOf('case "session.deleteMany": {'));
      expect(single).toContain("await finishSessionDeletion(wasActive);");
    });

    it("批量删除只做一次列表刷新（逐条 refreshSessions 会排出 N 轮磁盘扫描）", () => {
      const many = runtimeSource.slice(runtimeSource.indexOf('case "session.deleteMany": {'), runtimeSource.indexOf('case "workspace.remove": {'));
      expect(many).toContain("deleteSessionByPath(deleteTarget)");
      expect(many).toContain("await finishSessionDeletion(anyActiveDeleted);");
      expect(many).not.toContain("refreshSessions()");
      expect(many).not.toContain("emitState()");
    });
  });

  describe("主进程落盘（index.ts / settings.ts）", () => {
    it("session.archive 写归档集合，删除命令顺手清死路径", () => {
      expect(mainSource).toContain('case "session.archive": settings.archivedSessionPaths = setArchivedSessionPaths(settings.archivedSessionPaths, command.paths, command.archived); break;');
      expect(mainSource).toContain('case "session.delete": settings.archivedSessionPaths = pruneSessionPaths(settings.archivedSessionPaths, [command.path]); break;');
      expect(mainSource).toContain('case "session.deleteMany": settings.archivedSessionPaths = pruneSessionPaths(settings.archivedSessionPaths, command.paths); break;');
    });

    it("migrateSettings 把归档集合读回内存（漏读会被 persistSettings 整体抹掉）", () => {
      expect(settingsSource).toContain("const archivedSessionPaths = normalizeArchivedSessionPaths(source.archivedSessionPaths);");
      expect(settingsSource).toContain("...(archivedSessionPaths ? { archivedSessionPaths } : {})");
    });
  });

  describe("渲染端（store.ts / App.tsx）", () => {
    it("sessions 的身份保留比较覆盖 archived（否则流式期间每帧重建列表引用）", () => {
      expect(storeSource).toContain("item.archived === other.archived");
    });

    it("两个契约属性（视图取值 + 多选布尔）与批量删除命令都接上了", () => {
      expect(appSource).toContain('["data-ui-session-multiselect", sessionMultiSelect]');
      expect(appSource).toContain('["data-ui-sidebar-view", sidebarView === "topics" && sessionView === "archived" ? "archived" : sidebarView],');
      expect(appSource).toContain('type: "session.deleteMany", paths: pending.paths');
    });

    it("打开归档会话时先取消归档（「我要用回它了」）", () => {
      expect(appSource).toContain('await window.piDesktop.send({ type: "session.archive", paths: [path], archived: false });');
    });

    it("会话行右键菜单在两种视图下分别提供归档 / 取消归档", () => {
      expect(appSource).toContain('{ label: "归档", onClick: () => void setSessionsArchived([item.path], true) }');
      expect(appSource).toContain('{ label: "取消归档", onClick: () => void setSessionsArchived([item.path], false) }');
    });
  });
});
