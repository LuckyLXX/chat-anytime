import { describe, expect, it } from "vitest";
import {
  OVERLAY_MARGIN,
  OVERLAY_SIZE,
  buildOverlayHtml,
  computeOverlayPlacement,
  escapeOverlayText
} from "./computer-overlay.js";

describe("escapeOverlayText", () => {
  it("escapes window-title metacharacters for safe HTML embedding", () => {
    expect(escapeOverlayText('微信 <bob> & "friends"')).toBe("微信 &lt;bob&gt; &amp; &quot;friends&quot;");
    expect(escapeOverlayText("'</script>'")).toBe("&#39;&lt;/script&gt;&#39;");
    expect(escapeOverlayText("普通标题")).toBe("普通标题");
  });

  it("double-escaping is not applied (idempotent characters survive once)", () => {
    expect(escapeOverlayText("&amp;")).toBe("&amp;amp;");
  });
});

describe("computeOverlayPlacement", () => {
  it("places the banner inside the bottom-right of the work area", () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
    const placement = computeOverlayPlacement(workArea);
    expect(placement).toEqual({
      x: 1920 - OVERLAY_SIZE.width - OVERLAY_MARGIN,
      y: 1040 - OVERLAY_SIZE.height - OVERLAY_MARGIN,
      width: OVERLAY_SIZE.width,
      height: OVERLAY_SIZE.height
    });
    expect(placement.x).toBeGreaterThanOrEqual(workArea.x);
    expect(placement.y + placement.height).toBeLessThanOrEqual(workArea.y + workArea.height);
  });

  it("respects non-origin work areas (multi-monitor taskbar offsets)", () => {
    const placement = computeOverlayPlacement({ x: 100, y: 50, width: 1280, height: 700 });
    expect(placement.x).toBe(100 + 1280 - OVERLAY_SIZE.width - OVERLAY_MARGIN);
    expect(placement.y).toBe(50 + 700 - OVERLAY_SIZE.height - OVERLAY_MARGIN);
  });
});

describe("buildOverlayHtml", () => {
  it("produces a self-contained document with the label node and no template text", () => {
    const html = buildOverlayHtml();
    expect(html).toContain(`id="t"`);
    expect(html).toContain(".bar");
    expect(html).not.toContain("undefined");
    // the html is loaded via a data: URL — no remote resources
    expect(html).not.toMatch(/src\s*=|href\s*=/u);
  });
});
