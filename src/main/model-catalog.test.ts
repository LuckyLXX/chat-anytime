import { describe, expect, it } from "vitest";
import { isDesktopConfiguredProvider } from "./model-catalog.js";

describe("desktop model catalog visibility", () => {
  it("hides providers configured only by inherited environment variables", () => {
    expect(isDesktopConfiguredProvider({ configured: true, source: "environment" })).toBe(false);
  });

  it("keeps explicit runtime, stored, and provider configuration visible", () => {
    expect(isDesktopConfiguredProvider({ configured: true, source: "runtime" })).toBe(true);
    expect(isDesktopConfiguredProvider({ configured: true, source: "stored" })).toBe(true);
    expect(isDesktopConfiguredProvider({ configured: true, source: "models_json_key" })).toBe(true);
  });

  it("hides providers without usable authentication", () => {
    expect(isDesktopConfiguredProvider(undefined)).toBe(false);
    expect(isDesktopConfiguredProvider({ configured: false })).toBe(false);
  });
});
