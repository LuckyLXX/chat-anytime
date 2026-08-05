import { describe, expect, it } from "vitest";
import { artifactSandbox, buildArtifactPreviewSource, extractArtifacts, isDynamicArtifact, formatDuration } from "./content";

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

  it("detects dynamic HTML and keeps it in a scripts-only sandbox", () => {
    const artifact = { language: "html", content: "<canvas id=\"stage\"></canvas><script>requestAnimationFrame(() => {});</script>" };
    expect(isDynamicArtifact(artifact)).toBe(true);
    expect(artifactSandbox(artifact)).toBe("allow-scripts");
    expect(buildArtifactPreviewSource(artifact)).toContain("pidesktop-preview-pause");
    expect(buildArtifactPreviewSource(artifact)).toContain("window.requestAnimationFrame");
  });

  it("keeps static HTML fragments inert and does not inject the dynamic runtime", () => {
    const artifact = { language: "html", content: "<div class=\"card\">静态内容</div>" };
    expect(isDynamicArtifact(artifact)).toBe(false);
    expect(artifactSandbox(artifact)).toBe("allow-same-origin");
    expect(buildArtifactPreviewSource(artifact)).not.toContain("pidesktop-preview-pause");
  });

  it("marks dynamic fenced artifacts during extraction", () => {
    expect(extractArtifacts("```html\n<div><canvas></canvas></div>\n```", "message-2")).toMatchObject([
      { id: "message-2-artifact-0", language: "html", dynamic: true }
    ]);
  });
});
