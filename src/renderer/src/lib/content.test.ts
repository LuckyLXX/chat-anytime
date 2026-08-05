import { describe, expect, it } from "vitest";
import { extractArtifacts, formatDuration } from "./content";

describe("rich content helpers", () => {
  it("extracts HTML and SVG artifacts without treating ordinary code as an artifact", () => {
    const artifacts = extractArtifacts(
      "```html\n<h1>Hello</h1>\n```\n```ts\nconst x = 1\n```\n```svg\n<svg></svg>\n```",
      "message-1"
    );
    expect(artifacts).toEqual([
      { id: "message-1-artifact-0", title: "HTML 预览", language: "html", content: "<h1>Hello</h1>\n" },
      { id: "message-1-artifact-1", title: "SVG 预览", language: "svg", content: "<svg></svg>\n" }
    ]);
  });

  it("formats short and long tool durations", () => {
    expect(formatDuration(1000, 1450)).toBe("450ms");
    expect(formatDuration(1000, 3250)).toBe("2.3s");
  });
});
