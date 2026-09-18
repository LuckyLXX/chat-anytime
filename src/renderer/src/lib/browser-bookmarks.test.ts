// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { addBrowserBookmark, bookmarkGlyph, bookmarkHost, removeBrowserBookmark, storedBrowserBookmarks } from "./browser-bookmarks";

describe("browser bookmarks store", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips add / list / remove", () => {
    const first = addBrowserBookmark("https://example.com/a", "一个站点");
    const second = addBrowserBookmark("https://other.test/b", "另一个站点");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const list = storedBrowserBookmarks();
    expect(list.map((item) => item.url)).toEqual(["https://other.test/b", "https://example.com/a"]);
    expect(list[0]?.title).toBe("另一个站点");
    expect(list[0]?.addedAt).toBeGreaterThan(0);
    removeBrowserBookmark(first!.id);
    expect(storedBrowserBookmarks().map((item) => item.url)).toEqual(["https://other.test/b"]);
  });

  it("deduplicates by exact URL: refresh title and move to front instead of adding", () => {
    const first = addBrowserBookmark("https://example.com/a", "旧标题");
    addBrowserBookmark("https://other.test/b", "另一个站点");
    const again = addBrowserBookmark("https://example.com/a", "新标题");
    const list = storedBrowserBookmarks();
    expect(list).toHaveLength(2);
    expect(list.map((item) => item.url)).toEqual(["https://example.com/a", "https://other.test/b"]);
    expect(list[0]?.title).toBe("新标题");
    // 同 URL 重新收藏不换 id（原条目身份保留）。
    expect(list[0]?.id).toBe(first!.id);
    expect(again?.id).toBe(first!.id);
  });

  it("falls back to the host as title when none is provided", () => {
    addBrowserBookmark("https://example.com/a");
    expect(storedBrowserBookmarks()[0]?.title).toBe("example.com");
    const kept = addBrowserBookmark("https://example.com/a");
    expect(kept?.title).toBe("example.com");
  });

  it("rejects empty or whitespace URLs without writing", () => {
    expect(addBrowserBookmark("")).toBeUndefined();
    expect(addBrowserBookmark("   ")).toBeUndefined();
    expect(storedBrowserBookmarks()).toEqual([]);
  });

  it("accepts a URL that needs trimming", () => {
    const bookmark = addBrowserBookmark("  https://example.com/x  ", " 标题 ");
    expect(bookmark?.url).toBe("https://example.com/x");
    expect(bookmark?.title).toBe("标题");
  });

  it("survives corrupt stored data: invalid JSON and non-array shapes read as empty", () => {
    window.localStorage.setItem("pidesktop.browser-bookmarks", "{not json");
    expect(storedBrowserBookmarks()).toEqual([]);
    window.localStorage.setItem("pidesktop.browser-bookmarks", JSON.stringify({ url: "https://example.com" }));
    expect(storedBrowserBookmarks()).toEqual([]);
    // 非数组写入后，下一次 add 不回抛也不丢新书签。
    const bookmark = addBrowserBookmark("https://example.com/a");
    expect(bookmark).toBeDefined();
    expect(storedBrowserBookmarks()).toHaveLength(1);
  });

  it("skips malformed entries but keeps the valid ones", () => {
    window.localStorage.setItem("pidesktop.browser-bookmarks", JSON.stringify([
      { url: "https://ok.test/", title: "OK", id: "ok-1", addedAt: 1 },
      { title: "没有 URL" },
      null,
      42,
      { url: "https://recovered.test/" }
    ]));
    const list = storedBrowserBookmarks();
    expect(list.map((item) => item.url)).toEqual(["https://ok.test/", "https://recovered.test/"]);
    // 缺 id / addedAt / title 的条目现场补齐，不产生 undefined 字段。
    expect(list[1]?.id).toBeTruthy();
    expect(list[1]?.title).toBe("recovered.test");
    expect(list[1]?.addedAt).toBe(0);
  });

  it("degrades silently when storage is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("storage disabled"); }
    });
    try {
      expect(storedBrowserBookmarks()).toEqual([]);
      expect(() => addBrowserBookmark("https://example.com/a")).not.toThrow();
      expect(() => removeBrowserBookmark("whatever")).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });

  it("derives the glyph deterministically from the host and spreads hues over 0-360", () => {
    const once = bookmarkGlyph("https://example.com/a");
    const twice = bookmarkGlyph("https://example.com/another-page");
    expect(once).toEqual(twice);
    expect(once.letter).toBe("E");
    expect(once.hue).toBeGreaterThanOrEqual(0);
    expect(once.hue).toBeLessThan(360);
    const hues = new Set(["example.com", "other.test", "localhost", "github.com", "news.ycombinator.com"].map((host) => bookmarkGlyph(`https://${host}/`).hue));
    expect(hues.size).toBeGreaterThan(1);
    for (const hue of hues) {
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("handles hosts that are bare (unparseable) URLs without throwing", () => {
    expect(bookmarkHost("not a url")).toBe("");
    const glyph = bookmarkGlyph("not a url");
    expect(glyph.letter).toBe("N");
  });
});
