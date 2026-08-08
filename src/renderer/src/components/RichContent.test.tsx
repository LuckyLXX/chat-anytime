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
});
