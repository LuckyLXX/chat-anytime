import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { workspaceFilePreviewUrl } from "../../../shared/protocol";
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

  it("carries the sanitized script source on data-script-source for the bubble runtime", () => {
    // Regression: the sanitizer never wrote dataScriptSource onto the script
    // node, so DynamicHtmlBubble's dataset.scriptSource read came back empty
    // and bubble scripts never executed despite passing the deny-regex gate.
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-script-src"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><script>container.querySelector("canvas");</script></div></assistant_html>'}
      />
    );
    expect(markup).toContain('data-script-source="container.querySelector(&quot;canvas&quot;);"');
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

  it("maps workspace-relative image paths onto the preview protocol", () => {
    const workspace = "D:\\默认工作区";
    const bubble = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-relative-image"
        workspace={workspace}
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><img src="outputs/fox.png" alt="fox" /></div></assistant_html>'}
      />
    );
    expect(bubble).toContain(`src="${workspaceFilePreviewUrl(workspace, "outputs/fox.png")}"`);

    const markdown = renderToStaticMarkup(
      <RichContent artifactPrefix="message-relative-markdown" workspace={workspace} onOpenArtifact={() => undefined}>
        {"![fox](outputs/fox.png)"}
      </RichContent>
    );
    expect(markdown).toContain(`src="${workspaceFilePreviewUrl(workspace, "outputs/fox.png")}"`);
  });

  it("leaves relative image paths untouched without a workspace context", () => {
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-relative-no-workspace"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><img src="outputs/fox.png" alt="fox" /></div></assistant_html>'}
      />
    );
    expect(markup).toContain('src="outputs/fox.png"');
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

  it("keeps element ids unprefixed so CSS #id selectors and url(#id) references resolve", () => {
    // Regression: hast-util-sanitize's default clobber protection rewrites
    // id="badge" to id="user-content-badge", which silently broke every CSS
    // #id selector and SVG url(#id) reference inside bubbles.
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-id-keep"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><span id="badge">ok</span></div></assistant_html>'}
      />
    );
    expect(markup).toContain('id="badge"');
    expect(markup).not.toContain("user-content-");
  });

  it("renders data-send buttons, canvas and structural tags as real elements", () => {
    // Regression: none of these tags were in the sanitize schema's tagNames,
    // so the tags were stripped and only their text content survived —
    // data-send quick replies rendered as plain text and Canvas animations
    // vanished entirely.
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-structure"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div><header class="card-head">标题</header><canvas id="stage" width="120" height="60"></canvas><button data-send="继续">下一步</button><figure><figcaption>说明</figcaption></figure></div></assistant_html>'}
      />
    );
    expect(markup).toContain('<header class="card-head"');
    expect(markup).toContain('<canvas id="stage" width="120" height="60"');
    expect(markup).toContain('class="html-action-button"');
    expect(markup).toContain('data-send="继续"');
    expect(markup).toContain("<figure>");
    expect(markup).toContain("<figcaption>");
  });

  it("preserves SVG filter, mask and clip-path definitions with url() references", () => {
    const markup = renderToStaticMarkup(
      <RichContent
        artifactPrefix="message-svg-fx"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><svg viewBox="0 0 100 100"><defs><filter id="blurFx"><feGaussianBlur stdDeviation="3"></feGaussianBlur></filter><clipPath id="clipRound"><circle cx="50" cy="50" r="40"></circle></clipPath></defs><rect x="10" y="10" width="80" height="80" filter="url(#blurFx)" clip-path="url(#clipRound)"></rect></svg></assistant_html>'}
      />
    );
    expect(markup).toContain("<filter");
    expect(markup).toContain("feGaussianBlur");
    expect(markup).toContain('stdDeviation="3"');
    expect(markup).toContain("<clipPath");
    expect(markup).toContain('filter="url(#blurFx)"');
    expect(markup).toContain('clip-path="url(#clipRound)"');
  });

  it("compresses blank lines while streaming an unclosed bubble", () => {
    // dsh-raw-html v6.38 lesson: a blank line inside the card ends the
    // CommonMark HTML block, so indented follow-up lines would be parsed as
    // a code block (structure tearing / visible source). Compression keeps
    // the whole partial card inside a single HTML block.
    const markup = renderToStaticMarkup(
      <RichContent
        streaming
        artifactPrefix="message-stream-blank"
        onOpenArtifact={() => undefined}
        children={'<assistant_html><div>\n\n    <span class="s1">alpha</span>\n    <span class="s2">beta</span>\n</div>'}
      />
    );
    expect(markup).not.toContain("<pre>");
    expect(markup).not.toContain("<code>");
    expect(markup).toContain('<span class="s1"');
    expect(markup).toContain("beta");
  });
});
