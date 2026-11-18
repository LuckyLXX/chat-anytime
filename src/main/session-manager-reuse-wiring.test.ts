import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 第一批（2026-11-18 P0 冷开优化）的接线契约。
 *
 * 这一批的收益 100% 来自「少解析一次」——纯函数单测挡不住「缓存模块支持了，
 * 但 pi-runtime 没接上」的静默回退。这里按函数切源码钉住关键事实：
 * 1. `session.open` 把已读到的 header 交给复用入口（不重复有界读）；
 * 2. 自动化冷恢复不再为拿 cwd 整文件 open 一次（未命中至多 1 次解析）；
 * 3. 删除会话不把它的历史顺手塞进缓存，并显式 forget；
 * 4. release 准入带真实 activatedAt，扫描准入走剩余额度；
 * 5. 冷开解析结果同时种进摘要缓存（否则紧随的列表刷新会再解析一次）。
 */
describe("session manager reuse wiring (batch 1)", () => {
  const runtime = readFileSync(join(__dirname, "pi-runtime.ts"), "utf8").replace(/\r\n/gu, "\n");

  function sliceFrom(marker: string, endMarker: string): string {
    const start = runtime.indexOf(marker);
    expect(start, `找不到锚点：${marker}`).toBeGreaterThan(-1);
    const end = runtime.indexOf(endMarker, start);
    expect(end, `找不到结束锚点：${endMarker}`).toBeGreaterThan(start);
    return runtime.slice(start, end);
  }

  it("acquireSessionManagerForReopen hands the already-read header through", () => {
    const branch = sliceFrom('case "session.open": {', 'case "session.rename": {');
    // 两处冷路径（activate:false 与前台）都带 header：有界首行读只做一次，
    // 而且种子摘要要用同一份 header 的原始 cwd / timestamp。
    expect(branch.match(/acquireSessionManagerForReopen\(target, recordRoot, recordWorkspace, owner\.agentId, header\)/gu)).toHaveLength(2);
  });

  it("acquires the manager through the cache and seeds the summary with that same parse", () => {
    const fn = sliceFrom("function acquireSessionManagerForReopen(", "function releaseUnusedSessionManager(");
    expect(fn).toContain("recentSessionManagers.take(target, agentId, recordWorkspace, info)");
    // 冷路径只 open 一次，并在返回前把这次解析种进摘要缓存。
    expect(fn.match(/SessionManager\.open\(target, recordRoot, recordWorkspace\)/gu)).toHaveLength(2);
    expect(fn.match(/rememberSessionSummaryFromManager\(/gu)).toHaveLength(2);
    // 缓存未命中/文件消失都要及时释放陈旧引用。
    expect(fn).toContain("recentSessionManagers.forget(target)");
  });

  it("automation restore reads only the header for id/cwd (no probe-style full open)", () => {
    const fn = sliceFrom("async function openAutomationSessionRecord(", "async function runSessionBoundAutomationTask(");
    expect(fn).toContain("readSessionHeaderId(target) !== sessionId");
    expect(fn).toContain("const header = readSessionHeaderLine(target)");
    expect(fn).toContain("resolve(header.cwd)");
    expect(fn).not.toContain("SessionManager.open(target)");
    expect(fn).toContain("acquireSessionManagerForReopen(target, recordRoot, recordWorkspace, runAgent.id, header)");
    // 身份与工作区校验保留（对应过真实故障）。
    expect(fn).toContain("关联会话路径与工作区不匹配");
  });

  it("deleting a session neither caches its history nor leaves a stale entry", () => {
    const fn = sliceFrom("async function deleteSessionByPath(", "async function finishSessionDeletion(");
    expect(fn).toContain("disposeRecord(live, { cacheForReopen: false })");
    expect(fn).toContain("recentSessionManagers.forget(deleteTarget)");
  });

  it("release admission uses the record's real activatedAt and is marked release", () => {
    const fn = sliceFrom("function rememberSessionManagerForReopen(", "function rememberScannedSessionManager(");
    expect(fn).toContain('origin: "release"');
    expect(fn).toContain("usedAt: record.activatedAt");
  });

  it("scan admission proves identity and signature stability before caching", () => {
    const fn = sliceFrom("function rememberScannedSessionManager(", "function rememberSessionSummaryFromManager(");
    // 解析后现场复验签名（解析期间被追加的文件不入缓存）。
    expect(fn).toContain("info.mtimeMs !== input.mtimeMs || info.size !== input.size");
    // header 与 manager 必须是同一会话。
    expect(fn).toContain("input.header.id !== input.manager.getSessionId()");
    // 已有 live 记录的路径不重复压一份历史。
    expect(fn).toContain("record.session.sessionManager.getSessionFile()");
    // 归属不明（缺 cwd）不入缓存。
    expect(fn).toContain("const headerCwd = input.header.cwd.trim()");
    expect(fn).toContain('origin: "scan"');
  });

  it("refreshSessions passes the scan handoff into the catalog", () => {
    const start = runtime.indexOf("async function performSessionsRefresh(");
    expect(start).toBeGreaterThan(-1);
    const fn = runtime.slice(start, runtime.indexOf("\n}\n", start));
    expect(fn).toContain("onManagerParsed: rememberScannedSessionManager");
  });
});
