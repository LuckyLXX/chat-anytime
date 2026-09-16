import { describe, expect, it, vi } from "vitest";
import {
  NAVIGATE_BUDGET_MS,
  describeNavigateOutcome,
  isAbortedNavigation,
  resolveNavigateOutcome,
  sameUrl,
  withNavigationBudget
} from "./browser-navigate.js";

describe("sameUrl", () => {
  it("treats trailing-slash variants as the same page", () => {
    expect(sameUrl("http://127.0.0.1:6060/", "http://127.0.0.1:6060")).toBe(true);
    expect(sameUrl("http://127.0.0.1:6060/a/", "http://127.0.0.1:6060/a")).toBe(true);
  });

  it("keeps genuinely different pages apart", () => {
    expect(sameUrl("http://127.0.0.1:6060/a", "http://127.0.0.1:6060/b")).toBe(false);
    expect(sameUrl("http://127.0.0.1:6060/", "http://127.0.0.1:6061/")).toBe(false);
  });

  it("never reports a match for empty values", () => {
    // 空 URL（标签页还没有文档）不能被当成「已到达目标」——否则会把一次真失败洗白。
    expect(sameUrl("", "")).toBe(false);
    expect(sameUrl("", "http://127.0.0.1:6060/")).toBe(false);
  });
});

describe("isAbortedNavigation", () => {
  it("recognizes Chromium's navigation-superseded signals", () => {
    expect(isAbortedNavigation("ERR_ABORTED (-3) loading 'http://127.0.0.1:6060/'")).toBe(true);
    expect(isAbortedNavigation(" (-3) loading 'https://example.com/'")).toBe(true);
    expect(isAbortedNavigation("net::ERR_ABORTED")).toBe(true);
  });

  it("does not swallow real network failures", () => {
    expect(isAbortedNavigation("ERR_NAME_NOT_RESOLVED (-105) loading 'https://nope.invalid/'")).toBe(false);
    expect(isAbortedNavigation("ERR_CONNECTION_REFUSED (-102) loading 'http://127.0.0.1:9/'")).toBe(false);
  });
});

describe("resolveNavigateOutcome", () => {
  const base = { targetUrl: "http://127.0.0.1:6060/", currentUrl: "http://127.0.0.1:6060/", loading: false };

  it("reports done on a clean load", () => {
    expect(resolveNavigateOutcome({ ...base, timedOut: false })).toBe("done");
  });

  it("reports still-loading when the budget ran out (never a failure)", () => {
    // 探针实测：服务器不结束响应时 loadURL 永不 settle 且 isLoading() === true。
    expect(resolveNavigateOutcome({ ...base, timedOut: true, loading: true })).toBe("still-loading");
    const text = describeNavigateOutcome("still-loading", base.targetUrl, "页", 30)!;
    expect(text).toContain("仍未加载完");
    expect(text).toContain("未视为失败");
  });

  it("treats an aborted navigation that DID reach the target as success", () => {
    // 探针实测：同标签上第二次导航会以 -3 拒绝，但标签稳稳落在目标 url 上。
    expect(resolveNavigateOutcome({ ...base, timedOut: false, error: "ERR_ABORTED (-3) loading 'http://127.0.0.1:6060/old'" })).toBe("done");
  });

  it("treats an aborted navigation still loading elsewhere as pending", () => {
    expect(resolveNavigateOutcome({
      ...base,
      timedOut: false,
      error: "ERR_ABORTED (-3) loading 'http://127.0.0.1:6060/old'",
      currentUrl: "http://127.0.0.1:6060/new",
      loading: true
    })).toBe("still-loading");
  });

  it("keeps a real failure a failure even if the url looks right", () => {
    expect(resolveNavigateOutcome({
      ...base,
      timedOut: false,
      error: "ERR_NAME_NOT_RESOLVED (-105) loading 'http://127.0.0.1:6060/'"
    })).toBe("failed");
    expect(describeNavigateOutcome("failed", base.targetUrl, "页", 30)).toBeUndefined();
  });

  it("does not launder an abort that never arrived anywhere", () => {
    expect(resolveNavigateOutcome({
      ...base,
      timedOut: false,
      error: "ERR_ABORTED (-3) loading 'http://127.0.0.1:6060/'",
      currentUrl: "",
      loading: false
    })).toBe("failed");
  });

  it("describes a completed navigation with its url and the wait hint", () => {
    const text = describeNavigateOutcome("done", "http://127.0.0.1:6060/", "页", 30)!;
    expect(text).toContain("已导航到 http://127.0.0.1:6060/（页）");
    expect(text).toContain("browser_wait");
  });

  it("falls back to an unknown-title placeholder rather than dropping the url", () => {
    expect(describeNavigateOutcome("done", "http://127.0.0.1:6060/", "", 30)).toContain("（标题未知）");
    expect(describeNavigateOutcome("done", "http://127.0.0.1:6060/", undefined, 30)).toContain("（标题未知）");
  });
});

describe("withNavigationBudget", () => {
  it("returns normally when the navigation settles in time", async () => {
    const onTimeout = vi.fn();
    await withNavigationBudget(Promise.resolve(), onTimeout, 50);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("flags the timeout instead of hanging, and leaves the navigation running", async () => {
    const onTimeout = vi.fn();
    await withNavigationBudget(new Promise(() => undefined), onTimeout, 25);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("propagates a rejection so the caller can classify it", async () => {
    await expect(withNavigationBudget(Promise.reject(new Error("ERR_ABORTED (-3)")), () => undefined, 50)).rejects.toThrow("ERR_ABORTED");
  });

  it("swallows a late rejection after the budget expired", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
    await withNavigationBudget(pending, () => undefined, 20);
    reject(new Error("late failure"));
    await Promise.resolve();
    // 走到这里没有 unhandled rejection 就是通过（vitest 会把未处理的拒绝报成失败）。
  });

  it("keeps a 30s default budget", () => {
    expect(NAVIGATE_BUDGET_MS).toBe(30_000);
  });
});
