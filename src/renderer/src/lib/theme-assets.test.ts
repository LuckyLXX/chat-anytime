import { describe, expect, it } from "vitest";
import { createThemeAssetUrls, resolveThemeAssets } from "./theme-assets";

describe("theme assets", () => {
  it("replaces relative wallpaper paths with runtime URLs without embedding image data", () => {
    const css = ":root { --chat-bg-image: url(\"wallpaper-light.png\"); }";
    const result = resolveThemeAssets(css, { "wallpaper-light.png": "blob:http://localhost/theme-light" });

    expect(result).toContain("url(\"blob:http://localhost/theme-light\")");
    expect(result).not.toContain("wallpaper-light.png");
  });

  it("keeps external URLs untouched", () => {
    const css = ":root { --chat-bg-image: url(https://example.com/wallpaper.png); }";
    expect(resolveThemeAssets(css, { "https://example.com/wallpaper.png": "blob:ignored" })).toBe(css);
  });

  it("converts persisted image data into revocable object URLs", () => {
    const assetUrlSet = createThemeAssetUrls({ "wallpaper-dark.png": "data:image/png;base64,AA==" });

    expect(assetUrlSet.urls["wallpaper-dark.png"]).toMatch(/^blob:/u);
    expect(resolveThemeAssets("url(wallpaper-dark.png)", assetUrlSet.urls)).not.toContain("base64");
    assetUrlSet.revoke();
  });
});
