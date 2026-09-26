import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 会话索引的接线契约（2026-09-26）。
 *
 * 为什么需要源码断言：`session-summary-cache.ts` 自己的用例只能证明「模块正确」，
 * 证明不了「pi-runtime 真的用了它」——把 `cache:` 参数或落盘调度删掉，模块用例
 * 全绿而冷启动照样重解析 264 MB（实测 1806 ms）。这里把四处接线钉死。
 */
describe("session index wiring contract", () => {
  const source = readFileSync(join(__dirname, "pi-runtime.ts"), "utf8");

  it("刷新会话列表时传入磁盘索引加载来的缓存", () => {
    expect(source).toContain("cache: sessionSummaryCacheFor()");
  });

  it("扫描之后调度索引落盘", () => {
    expect(source).toContain("scheduleSessionIndexSave();");
  });

  it("缓存首次使用时从索引文件装载（而不是从空 Map 开始）", () => {
    expect(source).toContain("loadSessionIndex(sessionIndexPath())");
  });

  it("落盘走原子写（复用 settings-store 的 writeJsonAtomic）", () => {
    expect(source).toContain("saveSessionIndex(sessionIndexPath(), sessionSummaryCache)");
    const cacheSource = readFileSync(join(__dirname, "session-summary-cache.ts"), "utf8");
    expect(cacheSource).toContain("writeJsonAtomic(filePath, payload)");
  });
});
