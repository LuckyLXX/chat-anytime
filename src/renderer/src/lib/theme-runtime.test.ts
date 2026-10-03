// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { customCssHasWallpaper, readUiThemeContext } from "./theme-runtime";

/**
 * 上报给模型的界面主题快照（2026-10-03）。
 *
 * 这份快照是「模型看到的界面」唯一来源：明暗要按 appearance.theme + 系统
 * prefers-color-scheme 解析（与 App 外壳写 data-theme-effective 的口径一致），壁纸要
 * 与 data-theme-wallpaper 同判据，色板必须读**计算样式**（自定义主题能改任意 token，
 * 读声明值会失真），读不到的键不入表（不编造）。
 */

const TOKEN_VALUES: Record<string, string> = {
  "--surface": "#172033",
  "--surface-raised": "#1e293b",
  "--text": "#eef2ff",
  "--text-muted": "#a6b1c5",
  "--border": "#334155",
  "--accent": "#4f46e5",
  "--accent-soft": "#25254b"
};

function stubTheme(tokens: Record<string, string>, systemDark: boolean): void {
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    getPropertyValue: (name: string) => tokens[name] ?? ""
  } as unknown as CSSStyleDeclaration);
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: systemDark,
    addEventListener: () => {},
    removeEventListener: () => {}
  } as unknown as MediaQueryList);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readUiThemeContext", () => {
  it("读计算样式得到色板，并按系统深浅与壁纸解析出模式", () => {
    stubTheme(TOKEN_VALUES, true);
    expect(readUiThemeContext({ theme: "system", customCss: ':root { --chat-bg-image: url("wall.webp"); }' })).toEqual({
      mode: "dark",
      wallpaper: true,
      palette: {
        surface: "#172033",
        surfaceRaised: "#1e293b",
        text: "#eef2ff",
        textMuted: "#a6b1c5",
        border: "#334155",
        accent: "#4f46e5",
        accentSoft: "#25254b"
      }
    });
  });

  it("显式 light/dark 覆盖系统偏好", () => {
    stubTheme(TOKEN_VALUES, true);
    expect(readUiThemeContext({ theme: "light", customCss: "" }).mode).toBe("light");
    expect(readUiThemeContext({ theme: "light", customCss: "" }).wallpaper).toBe(false);
    stubTheme(TOKEN_VALUES, false);
    expect(readUiThemeContext({ theme: "dark", customCss: "" }).mode).toBe("dark");
    // system + 系统是浅色 → 浅色
    expect(readUiThemeContext({ theme: "system", customCss: "" }).mode).toBe("light");
  });

  it("读不到的 token 不入表（不编造），无壁纸声明时不报壁纸", () => {
    stubTheme({ "--text": "#111111" }, false);
    expect(readUiThemeContext({ theme: "light", customCss: ":root { --surface: #fff; }" })).toEqual({
      mode: "light",
      wallpaper: false,
      palette: { text: "#111111" }
    });
    // --chat-bg-image: none 不算壁纸（与 customCssHasWallpaper 同口径）
    expect(customCssHasWallpaper(":root { --chat-bg-image: none; }")).toBe(false);
  });
});
