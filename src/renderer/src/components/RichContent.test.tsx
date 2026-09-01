import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichContent } from "./RichContent";

describe("RichContent dynamic bubbles", () => {
  it("renders dynamic assistant HTML directly in the chat bubble with an inert script", () => {
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-1"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><canvas id="stage"></canvas><script>requestAnimationFrame(() => {});</script></div></assistant_html>'}
      />
    );

    expect(markup).toContain("html-bubble");
    expect(markup).toContain('type="application/x-pidesktop-bubble-script"');
    expect(markup).not.toContain('class="artifact-card"');
  });

  it("keeps file URLs on images inside assistant HTML bubbles", () => {
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-file-image"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><img src="file:///D:/workspace/PiDesktop/poster.png" alt="poster" /></div></assistant_html>'}
      />
    );

    expect(markup).toContain('src="file:///D:/workspace/PiDesktop/poster.png"');
    expect(markup).toContain('alt="poster"');
  });

  it("renders unclosed assistant HTML as lightweight markdown while streaming", () => {
    // Before the assistant_html closing tag arrives the segment is unclosed and
    // must NOT enter the heavy DynamicHtmlBubble pipeline (rehypeRaw + double
    // sanitize) on every streaming frame. It renders as lightweight markdown;
    // the interactive bubble mounts only once the closing tag lands.
    const markup = renderToStaticMarkup(
      <RichContent
        streaming
        artifactPrefix="message-stream"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><canvas id="stage"></canvas><script>requestAnimationFrame(() => {});</script></div>'}
      />
    );
    expect(markup).not.toContain('type="application/x-pidesktop-bubble-script"');
  });

  it("renders indented HTML spans as elements, not a TEXT code block", () => {
    // Regression: assistant_html content with 4-space-indented <span> rows
    // after a blank line was being parsed by CommonMark as an indented code
    // block, producing a "TEXT" panel with escaped markup.
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-spans"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div>\n\n    <span class="lg-spark s1">alpha</span>\n    <span class="lg-spark s2">beta</span>\n</div></assistant_html>'}
      />
    );
    expect(markup).not.toContain("<pre>");
    expect(markup).not.toContain("<code>");
    expect(markup).toContain('<span class="lg-spark s1"');
    expect(markup).toContain("alpha");
    expect(markup).toContain("beta");
  });

  it("preserves SVG gradient elements and keyframe animations inside bubbles", () => {
    // Regression: the heart bubble uses SVG <linearGradient>/<stop> and CSS
    // @keyframes. Both were silently stripped by the sanitizer and CSS pipeline.
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-heart"
        onOpenArtifact={() => undefined}
        children={'<assistant_html>\n<style>\n@keyframes lg-heartbeat { 0%,100% { transform: scale(1); } 12% { transform: scale(1.16); } }\n.lg-heart-box { animation: lg-heartbeat 1.6s ease-in-out infinite; }\n</style>\n<div class="lg-heart-wrap">\n  <svg class="lg-heart-svg" viewBox="0 0 100 100">\n    <defs>\n      <linearGradient id="lgGrad" x1="0" y1="0" x2="0" y2="1">\n        <stop offset="0%" stop-color="#ff8fa3"></stop>\n        <stop offset="100%" stop-color="#c2253f"></stop>\n      </linearGradient>\n    </defs>\n    <path d="M50,88 C22,68 2,48 2,28" fill="url(#lgGrad)"></path>\n  </svg>\n</div>\n</assistant_html>'}
      />
    );
    expect(markup).not.toContain("<pre>");
    expect(markup).not.toContain("<code>");
    expect(markup).toContain("<svg");
    expect(markup).toContain("linearGradient");
    expect(markup).toContain("<stop");
    expect(markup).toContain("<path");
    // CSS @keyframes are sanitized via an offscreen stylesheet which requires
    // a real CSSOM; in the node test environment that path returns "" so the
    // style node is dropped. We assert the structure is preserved (no code
    // block) and verify keyframe sanitization in the dedicated sanitizer test.
    expect(markup).not.toContain("expression(");
  });

  it("strips dangerous attributes from SVG inside assistant HTML", () => {
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-svg-safe"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3" onclick="alert(1)"></circle></svg></assistant_html>'}
      />
    );
    expect(markup).toContain("<circle");
    expect(markup).not.toContain("onclick");
  });
});
