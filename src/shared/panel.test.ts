import { describe, expect, it } from "vitest";
import { PANEL_STATE_ENDPOINT, isPanelEntryFile, isPanelStatePath, panelDevHint, parsePanelRequest, summarizeTodos } from "./panel.js";

describe("parsePanelRequest", () => {
  it("accepts whitelisted actions", () => {
    expect(parsePanelRequest({ action: "show-main" })).toEqual({ action: "show-main" });
    expect(parsePanelRequest({ action: "  show-main  " })).toEqual({ action: "show-main" });
    // 窗口级动作：无边框形态（桌宠/抽屉）的页面靠它们关窗、切两态、调大小
    expect(parsePanelRequest({ action: "close" })).toEqual({ action: "close" });
    expect(parsePanelRequest({ action: "toggle" })).toEqual({ action: "toggle" });
    expect(parsePanelRequest({ action: "grow" })).toEqual({ action: "grow" });
    expect(parsePanelRequest({ action: "shrink" })).toEqual({ action: "shrink" });
    expect(parsePanelRequest({ action: "reset-size" })).toEqual({ action: "reset-size" });
  });

  it("resize 必须带合法的正数尺寸（缺参数就当非法，不退到某个缺省尺寸）", () => {
    expect(parsePanelRequest({ action: "resize", width: 360.4, height: 320.6 })).toEqual({ action: "resize", width: 360, height: 321 });
    expect(parsePanelRequest({ action: "resize" })).toBeUndefined();
    expect(parsePanelRequest({ action: "resize", width: 360 })).toBeUndefined();
    expect(parsePanelRequest({ action: "resize", width: 0, height: 320 })).toBeUndefined();
    expect(parsePanelRequest({ action: "resize", width: -100, height: 320 })).toBeUndefined();
    expect(parsePanelRequest({ action: "resize", width: Number.NaN, height: 320 })).toBeUndefined();
    expect(parsePanelRequest({ action: "resize", width: "360", height: "320" })).toBeUndefined();
  });

  it("rejects anything outside the whitelist", () => {
    expect(parsePanelRequest({ action: "abort" })).toBeUndefined();
    expect(parsePanelRequest({ action: "show-main " + "x".repeat(10) })).toBeUndefined();
    expect(parsePanelRequest({ action: "SHOW-MAIN" })).toBeUndefined();
    expect(parsePanelRequest({ action: 7 })).toBeUndefined();
    expect(parsePanelRequest({})).toBeUndefined();
  });

  it("rejects non-object bodies (数组/字符串/null 都不算动作)", () => {
    expect(parsePanelRequest(undefined)).toBeUndefined();
    expect(parsePanelRequest(null)).toBeUndefined();
    expect(parsePanelRequest("show-main")).toBeUndefined();
    expect(parsePanelRequest(["show-main"])).toBeUndefined();
  });
});

describe("isPanelStatePath", () => {
  it("matches the endpoint at any depth (面板页可以用相对路径取数)", () => {
    expect(isPanelStatePath(`/${PANEL_STATE_ENDPOINT}`)).toBe(true);
    expect(isPanelStatePath(`/${PANEL_STATE_ENDPOINT}`.replace(/^\//u, ""))).toBe(true);
    expect(isPanelStatePath(`/panels/status/${PANEL_STATE_ENDPOINT}`)).toBe(true);
    expect(isPanelStatePath(`/a/b/c/${PANEL_STATE_ENDPOINT}`)).toBe(true);
  });

  it("does not hijack lookalike files", () => {
    expect(isPanelStatePath(`/${PANEL_STATE_ENDPOINT}.bak`)).toBe(false);
    expect(isPanelStatePath(`/x${PANEL_STATE_ENDPOINT}`)).toBe(false);
    expect(isPanelStatePath("/index.html")).toBe(false);
    expect(isPanelStatePath("/")).toBe(false);
  });
});

describe("summarizeTodos", () => {
  it("counts by status", () => {
    expect(
      summarizeTodos([
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
        { content: "c", status: "pending" },
        { content: "d", status: "completed" }
      ])
    ).toEqual({ total: 4, completed: 2, inProgress: 1 });
  });

  it("returns a zeroed summary for an empty list", () => {
    expect(summarizeTodos([])).toEqual({ total: 0, completed: 0, inProgress: 0 });
  });
});

describe("isPanelEntryFile", () => {
  it("accepts web pages only", () => {
    expect(isPanelEntryFile("panels/status/index.html")).toBe(true);
    expect(isPanelEntryFile("D:\\ws\\panel.HTM")).toBe(true);
    expect(isPanelEntryFile("panel.svg")).toBe(true);
  });

  it("rejects everything else (面板是网页，不是任意文件)", () => {
    expect(isPanelEntryFile("panels/status")).toBe(false);
    expect(isPanelEntryFile("panel.md")).toBe(false);
    expect(isPanelEntryFile("panel.js")).toBe(false);
    expect(isPanelEntryFile("panel.html.bak")).toBe(false);
  });
});

describe("panelDevHint", () => {
  it("names the endpoint so 继续开发 的模型不用猜", () => {
    expect(panelDevHint()).toContain(PANEL_STATE_ENDPOINT);
    expect(panelDevHint()).toContain("show-main");
  });

  it("写清窗口级动作与桌宠/抽屉的页面契约（否则新形态作品只能靠猜）", () => {
    const hint = panelDevHint();
    expect(hint).toContain('"action\":\"close\"');
    expect(hint).toContain('"action\":\"toggle\"');
    expect(hint).toContain('"action\":\"grow\"');
    expect(hint).toContain("resize");
    expect(hint).toContain("-webkit-app-region: drag");
    expect(hint).toContain("no-drag");
    expect(hint).toContain('"pet"');
    expect(hint).toContain('"drawer"');
    expect(hint).toContain("left/right/top/bottom");
    expect(hint).toContain("不要自己搭本地代理");
  });
});
