import { describe, expect, it } from "vitest";
import { isSeedDocumentUrl, isSeedPhase } from "./browser-preview-seed.js";

describe("seeded blank document suppression", () => {
  it("recognizes the blank/empty URLs a fresh tab can report", () => {
    expect(isSeedDocumentUrl("")).toBe(true);
    expect(isSeedDocumentUrl("about:blank")).toBe(true);
  });

  it("does not treat a real page as the seed document", () => {
    expect(isSeedDocumentUrl("http://127.0.0.1:6060/")).toBe(false);
    // about:blank 之外的 about: 页也不是预置文档（页面自己导航过去的，事件要进状态）。
    expect(isSeedDocumentUrl("about:srcdoc")).toBe(false);
  });

  it("suppresses document events only while no real navigation happened", () => {
    // 刚建标签：seeded=true 且还没有文档 → 事件不进状态（否则面板会显示初始空白）。
    expect(isSeedPhase(true, "")).toBe(true);
    expect(isSeedPhase(true, "about:blank")).toBe(true);
  });

  it("stops suppressing once a real navigation happens", () => {
    // navigateTab 会把 seeded 置 false：此后即使 URL 还没更新，事件也必须进状态，
    // 否则真实导航的 URL/标题/加载态全被吞掉。
    expect(isSeedPhase(false, "")).toBe(false);
    expect(isSeedPhase(false, "about:blank")).toBe(false);
    expect(isSeedPhase(true, "http://127.0.0.1:6060/")).toBe(false);
    expect(isSeedPhase(undefined, "about:blank")).toBe(false);
  });
});
