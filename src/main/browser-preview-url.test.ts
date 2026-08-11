import { describe, expect, it } from "vitest";
import { normalizeBrowserUrl } from "./browser-preview-url.js";

describe("browser preview URLs", () => {
  it("adds useful default protocols for local and public addresses", () => {
    expect(normalizeBrowserUrl("localhost:3000/docs")).toBe("http://localhost:3000/docs");
    expect(normalizeBrowserUrl("example.com/path")).toBe("https://example.com/path");
  });

  it("keeps explicit HTTP URLs and rejects unsafe protocols", () => {
    expect(normalizeBrowserUrl("http://127.0.0.1:5173")).toBe("http://127.0.0.1:5173/");
    expect(() => normalizeBrowserUrl("javascript:alert(1)")).toThrow("HTTP");
    expect(() => normalizeBrowserUrl("file:///C:/secret.txt")).toThrow("HTTP");
    expect(() => normalizeBrowserUrl(" ")).toThrow("请输入");
  });
});
