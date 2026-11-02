import { describe, expect, it } from "vitest";
import { EDITOR_LARGE_DOC_CHARS, editorContentSnapshotDelayMs, editorObserverThrottleMs } from "./markdown-editor-policy";

/**
 * 编辑器节流分档（2026-11-02）。小文档必须与改动前逐值一致（120ms / 立即），
 * 大文档才切到 500ms / 400ms——这两条是「编辑大文件不再每键整篇序列化 + 整树重渲」的
 * 唯一开关，改回去会直接回到卡顿。
 */
describe("markdown 编辑器节流策略", () => {
  it("小文档保持旧行为：120ms 节流、立即回写", () => {
    expect(editorObserverThrottleMs(0)).toBe(120);
    expect(editorObserverThrottleMs(10_000)).toBe(120);
    expect(editorContentSnapshotDelayMs(10_000)).toBe(0);
  });

  it("大文档切到 500ms / 400ms", () => {
    expect(editorObserverThrottleMs(EDITOR_LARGE_DOC_CHARS + 1)).toBe(500);
    expect(editorContentSnapshotDelayMs(EDITOR_LARGE_DOC_CHARS + 1)).toBe(400);
  });

  it("阈值处是严格大于（等于阈值仍走小文档档）", () => {
    expect(editorObserverThrottleMs(EDITOR_LARGE_DOC_CHARS)).toBe(120);
    expect(editorContentSnapshotDelayMs(EDITOR_LARGE_DOC_CHARS)).toBe(0);
  });

  it("返回整数毫秒且随长度单调不降", () => {
    const lengths = [0, 1_000, EDITOR_LARGE_DOC_CHARS, EDITOR_LARGE_DOC_CHARS + 1, 5_000_000];
    const throttles = lengths.map(editorObserverThrottleMs);
    const delays = lengths.map(editorContentSnapshotDelayMs);
    for (const value of [...throttles, ...delays]) expect(Number.isInteger(value)).toBe(true);
    for (let index = 1; index < throttles.length; index += 1) {
      expect(throttles[index]!).toBeGreaterThanOrEqual(throttles[index - 1]!);
      expect(delays[index]!).toBeGreaterThanOrEqual(delays[index - 1]!);
    }
  });
});
