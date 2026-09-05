import { describe, expect, it } from "vitest";
import {
  buildLocateScript,
  buildScrollScript,
  buildSnapshotScript,
  buildTypeScript,
  elementSignature,
  formatSnapshotLine,
  isSideEffectRejection,
  urlPatternMatcher,
  withOpTimeout
} from "./browser-automation.js";

describe("browser automation url patterns", () => {
  it("treats patterns without glob characters as substring matches", () => {
    const matcher = urlPatternMatcher("dashboard");
    expect(matcher("https://example.com/app/dashboard")).toBe(true);
    expect(matcher("https://example.com/home")).toBe(false);
  });

  it("keeps * within one path segment and lets ** cross segments", () => {
    const single = urlPatternMatcher("https://example.com/*/page");
    expect(single("https://example.com/a/page")).toBe(true);
    expect(single("https://example.com/a/b/page")).toBe(false);

    const multi = urlPatternMatcher("https://example.com/**/page");
    expect(multi("https://example.com/a/page")).toBe(true);
    expect(multi("https://example.com/a/b/page")).toBe(true);
  });

  it("supports ? as a single-character wildcard", () => {
    const matcher = urlPatternMatcher("https://example.com/page?");
    expect(matcher("https://example.com/page1")).toBe(true);
    expect(matcher("https://example.com/page12")).toBe(false);
  });
});

describe("browser automation snapshot formatting", () => {
  const element = {
    tag: "button",
    role: null,
    type: "submit",
    id: "login",
    cls: "primary large",
    name: "登录",
    text: "登录",
    value: null,
    x: 12,
    y: 34
  };

  it("renders a readable ref line", () => {
    expect(formatSnapshotLine(element, 2)).toBe('@e3 <button type="submit"#login.primary.large> "登录"');
  });

  it("drops the type attribute for non-input elements", () => {
    expect(formatSnapshotLine({ ...element, tag: "a", type: null, id: null, cls: null, name: null }, 0))
      .toBe('@e1 <a> "登录"');
  });

  it("falls back to name then value for the label", () => {
    const named = { ...element, text: null, name: "搜索", value: null };
    expect(formatSnapshotLine(named, 0)).toContain('"搜索"');
    const valued = { ...element, text: null, name: null, value: "hello" };
    expect(formatSnapshotLine(valued, 0)).toContain('"hello"');
  });

  it("derives a stable identity signature from every observed attribute", () => {
    const signature = elementSignature(element);
    expect(signature).toContain("button");
    expect(signature).toContain("login");
    expect(elementSignature(element)).toBe(signature);
    expect(elementSignature({ ...element, text: "退出" })).not.toBe(signature);
  });
});

describe("browser automation page scripts", () => {
  it("caps the snapshot element list and carries page text", () => {
    const script = buildSnapshotScript(200, 3000);
    expect(script).toContain("collectInteractiveElements");
    expect(script).toContain("collectPageText");
    expect(script).toContain("truncated");
  });

  it("pierces open shadow roots and same-origin iframes", () => {
    const snapshot = buildSnapshotScript(200, 3000);
    expect(snapshot).toContain("el.shadowRoot");
    expect(snapshot).toContain("contentDocument");
    expect(snapshot).toContain("cross-origin");
    const locate = buildLocateScript(0);
    expect(locate).toContain("frameElement");
    expect(locate).toContain("viewportPosition");
    expect(locate).toContain("hitTest");
  });

  it("locates an element, scrolls it into view, and returns a signature", () => {
    const script = buildLocateScript(3);
    expect(script).toContain("scrollIntoView");
    expect(script).toContain("elementFromPoint");
    expect(script).toContain("signature");
  });

  it("clears inputs via the native setter in fill mode only", () => {
    const fill = buildTypeScript(0, "fill");
    expect(fill).toContain("getOwnPropertyDescriptor");
    expect(fill).toContain("dispatchEvent");
    const append = buildTypeScript(0, "append");
    expect(append).not.toContain("getOwnPropertyDescriptor");
  });

  it("scrolls by delta without a ref and scrolls an element into view with one", () => {
    const page = buildScrollScript("down", 500);
    expect(page).toContain("scrollBy(0, 500)");
    const up = buildScrollScript("up", 500);
    expect(up).toContain("scrollBy(0, -500)");
    const element = buildScrollScript("down", 500, 2);
    expect(element).toContain("scrollIntoView");
  });
});

describe("read-mode side-effect rejection classifier", () => {
  it("recognizes V8 debug-evaluate rejections across message shapes", () => {
    expect(isSideEffectRejection("EvalError: Possible side-effect in debug-evaluate")).toBe(true);
    expect(isSideEffectRejection("EvalError: Possible side effect in debugger evaluate")).toBe(true);
  });

  it("leaves ordinary script errors alone", () => {
    expect(isSideEffectRejection("TypeError: Cannot read properties of null (reading 'x')")).toBe(false);
    expect(isSideEffectRejection("SyntaxError: Unexpected token")).toBe(false);
  });
});

describe("withOpTimeout", () => {
  it("passes through the operation result when it settles in time", async () => {
    const result = await withOpTimeout(Promise.resolve("ok"), 1000);
    expect(result).toBe("ok");
  });

  it("rejects with a retryable error and swallows the zombie outcome", async () => {
    let release: (value: string) => void = () => undefined;
    const slow = new Promise<string>((resolve) => {
      release = resolve;
    });
    await expect(withOpTimeout(slow, 20)).rejects.toThrow(/超时（0 秒无响应）/);
    release("late");
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});
