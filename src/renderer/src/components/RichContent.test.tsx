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
        children={'<assistant_html><div><img src="file:///D:/Utools%E6%8F%92%E4%BB%B6/PiDesktop/poster.png" alt="poster" /></div></assistant_html>'}
      />
    );

    expect(markup).toContain('src="file:///D:/Utools%E6%8F%92%E4%BB%B6/PiDesktop/poster.png"');
    expect(markup).toContain('alt="poster"');
  });
});
