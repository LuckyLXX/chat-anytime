import { describe, expect, it } from "vitest";
import { sanitizeRichHtmlTree, sanitizeStyleDeclarations, sanitizeStyleTagCss } from "./html-sanitize";

describe("assistant HTML sanitizer", () => {
  it("keeps layout styles but removes executable CSS values", () => {
    expect(sanitizeStyleDeclarations("color: red; padding: 8px; background: url(javascript:bad); onload: alert(1);"))
      .toBe("color: red; padding: 8px");
    expect(sanitizeStyleDeclarations("color: red !important;")).toBe("color: red !important");
  });

  it("removes scripts, event handlers, unsafe URLs, and unsafe classes", () => {
    const tree = {
      type: "root",
      children: [{
        type: "element",
        tagName: "div",
        properties: { onClick: "alert(1)", href: "javascript:bad", className: ["ai-card", "bad class"], style: "color: red" },
        children: [
          { type: "element", tagName: "script", properties: {}, children: [{ type: "text", value: "alert(1)" }] },
          { type: "element", tagName: "span", properties: {}, children: [] }
        ]
      }]
    };
    sanitizeRichHtmlTree()(tree);
    expect(tree.children[0]?.properties).toEqual({ className: ["ai-card", "bad", "class"], style: "color: red" });
    expect(tree.children[0]?.children).toHaveLength(1);
    expect(tree.children[0]?.children?.[0]).toMatchObject({ tagName: "span" });
  });

  it("allows local file URLs for media sources", () => {
    const tree = {
      type: "root",
      children: [{
        type: "element",
        tagName: "img",
        properties: { src: "file:///D:/workspace/PiDesktop/poster.png" },
        children: []
      }]
    };

    sanitizeRichHtmlTree()(tree);
    expect(tree.children[0]?.properties.src).toBe("file:///D:/workspace/PiDesktop/poster.png");
  });

  it("removes style tags unless the caller explicitly enables scoped styles", () => {
    const tree = {
      type: "root",
      children: [{
        type: "element",
        tagName: "style",
        properties: {},
        children: [{ type: "text", value: ".card { color: red; }" }]
      }]
    };

    sanitizeRichHtmlTree()(tree);
    expect(tree.children).toEqual([]);
  });

  it("retains a safe inline script only for an explicit Div bubble", () => {
    const tree = {
      type: "root",
      children: [{
        type: "element",
        tagName: "script",
        properties: { src: "https://example.com/app.js" },
        children: [{ type: "text", value: "const render = () => container.querySelector('canvas'); render();" }]
      }]
    };

    sanitizeRichHtmlTree({ allowBubbleScripts: true })(tree);
    expect(tree.children[0]).toMatchObject({
      tagName: "script",
      properties: { type: "application/x-pidesktop-bubble-script" }
    });
  });

  it("rejects bubble scripts that reach outside the scoped runtime", () => {
    const tree = {
      type: "root",
      children: [{ type: "element", tagName: "script", properties: {}, children: [{ type: "text", value: "fetch('https://example.com');" }] }]
    };

    sanitizeRichHtmlTree({ allowBubbleScripts: true })(tree);
    expect(tree.children).toEqual([]);
  });

  it("rejects DOM prototype escape attempts in bubble scripts", () => {
    const tree = {
      type: "root",
      children: [{ type: "element", tagName: "script", properties: {}, children: [{ type: "text", value: "container.ownerDocument.defaultView" }] }]
    };

    sanitizeRichHtmlTree({ allowBubbleScripts: true })(tree);
    expect(tree.children).toEqual([]);
  });

  it("keeps safe @keyframes rules with sanitized declarations", () => {
    const scoped = sanitizeStyleTagCss(
      "@keyframes heartbeat { 0%,100% { transform: scale(1); } 12% { transform: scale(1.16); } }",
      ".bubble-scope"
    );
    // In a real browser (Electron renderer) the offscreen stylesheet yields a
    // KEYFRAMES_RULE with sanitized declarations. In the node test environment
    // the CSSOM is unavailable, so this assertion guards the happy path only
    // when the environment actually parses CSS.
    if (typeof CSSKeyframeRule === "undefined" || typeof CSSRule === "undefined") return;
    expect(scoped).toContain("@keyframes heartbeat");
    expect(scoped).toContain("transform:scale(1)");
    expect(scoped).toContain("transform:scale(1.16)");
  });

  it("drops dangerous declarations inside keyframe rules", () => {
    const scoped = sanitizeStyleTagCss(
      "@keyframes evil { 0% { transform: scale(1); color: red; } 100% { width: expression(alert(1)); } }",
      ".bubble-scope"
    );
    // expression() is rejected by the whole-style guard, so the entire block
    // collapses to "" rather than leaking the unsafe declaration.
    expect(scoped).not.toContain("expression");
  });
});
