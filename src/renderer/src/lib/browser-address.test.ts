// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { saveBrowserAddress, storedBrowserAddress } from "./browser-address";

describe("browser address bar persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("never fabricates a default address for a tab that never navigated", () => {
    // 事故根因之一：旧实现缺省返回 "http://localhost:3000"，空标签页的地址栏
    // 会显示一个没人访问过的网址，看起来像「导航地址和页面地址对不上」。
    expect(storedBrowserAddress("pi-browser-fresh")).toBe("");
    expect(storedBrowserAddress("pi-browser-fresh")).not.toContain("localhost:3000");
  });

  it("round-trips the address a tab really navigated to", () => {
    saveBrowserAddress("pi-browser-1", "http://127.0.0.1:6060/");
    expect(storedBrowserAddress("pi-browser-1")).toBe("http://127.0.0.1:6060/");
  });

  it("keeps tabs independent", () => {
    saveBrowserAddress("pi-browser-1", "http://127.0.0.1:6060/");
    expect(storedBrowserAddress("pi-browser-2")).toBe("");
  });

  it("degrades to an empty address when storage is unavailable", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("storage disabled"); }
    });
    try {
      expect(storedBrowserAddress("pi-browser-1")).toBe("");
      // 写入失败也不能抛（演示模式 / 隐私模式下同样要走通）。
      expect(() => saveBrowserAddress("pi-browser-1", "http://x/")).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });
});
