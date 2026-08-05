import { describe, expect, it } from "vitest";
import { sanitizeRichHtmlTree, sanitizeStyleDeclarations } from "./html-sanitize";

describe("assistant HTML sanitizer", () => {
  it("keeps layout styles but removes executable CSS values", () => {
    expect(sanitizeStyleDeclarations("color: red; padding: 8px; background: url(javascript:bad); onload: alert(1);"))
      .toBe("color: red; padding: 8px");
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
});
