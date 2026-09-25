import { describe, expect, it } from "vitest";
import { PREVIEW_FILE_SCHEME } from "./protocol.js";
import {
  THEME_ASSET_CURRENT_SCOPE,
  THEME_ASSET_SCHEME,
  activeThemeScope,
  parseThemeAssetUrl,
  isThemeAssetUrl,
  resolveThemeAssetUrls,
  themeAssetFileUrl,
  themeAssetReferences,
  themeAssetRelativePath,
  themeAssetScopeName
} from "./theme-assets.js";

describe("主题资产协议 URL", () => {
  it("与预览文件共用同一个特权 scheme（两处常量不许漂移）", () => {
    expect(THEME_ASSET_SCHEME).toBe(PREVIEW_FILE_SCHEME);
  });

  it("往返：非 ASCII / 空格 / 嵌套路径 / 中文主题 id", () => {
    const url = themeAssetFileUrl("custom-测试", "assets/壁纸 dark.webp");
    expect(url).toMatch(/^pidesktop-file:\/\/theme\//u);
    expect(url).not.toContain("%5C");
    expect(parseThemeAssetUrl(url)).toEqual({ scope: "custom-测试", relativePath: "assets/壁纸 dark.webp" });
  });

  it("相对路径在 URL 里是单个段（斜杠被编码，不会被拆成多段）", () => {
    const url = themeAssetFileUrl("current", "a/b/c.png");
    expect(url.split("/").slice(3)).toHaveLength(2);
    expect(parseThemeAssetUrl(url)).toEqual({ scope: "current", relativePath: "a/b/c.png" });
  });

  it("拒绝穿越 / 绝对路径 / 段数不对 / 非法编码 / 非法作用域 / 外来 scheme", () => {
    expect(parseThemeAssetUrl("pidesktop-file://theme/current/..%2F..%2Fetc%2Fpasswd")).toBeUndefined();
    expect(parseThemeAssetUrl(`pidesktop-file://theme/current/${encodeURIComponent("/etc/passwd")}`)).toBeUndefined();
    expect(parseThemeAssetUrl(`pidesktop-file://theme/current/${encodeURIComponent("C:/x.png")}`)).toBeUndefined();
    expect(parseThemeAssetUrl("pidesktop-file://theme/current/a.png/extra")).toBeUndefined();
    expect(parseThemeAssetUrl("pidesktop-file://theme/current")).toBeUndefined();
    expect(parseThemeAssetUrl("pidesktop-file://theme/current/%E0%A4%A")).toBeUndefined();
    expect(parseThemeAssetUrl("pidesktop-file://theme/a%2Fb/x.png")).toBeUndefined();
    expect(parseThemeAssetUrl("https://theme/current/x.png")).toBeUndefined();
    expect(parseThemeAssetUrl("pidesktop-file://preview/C%3A%5Cwork/x.png")).toBeUndefined();
    expect(parseThemeAssetUrl("not a url")).toBeUndefined();
  });
});

describe("isThemeAssetUrl：host 对得上即算（内容合法性与否交给 parse）", () => {
  it("区分 theme URL 与其余地址", () => {
    expect(isThemeAssetUrl("pidesktop-file://theme/current/a.png")).toBe(true);
    expect(isThemeAssetUrl("pidesktop-file://theme/current/..%2F..%2Fx")).toBe(true);
    expect(isThemeAssetUrl("pidesktop-file://preview/C%3A%5Cwork/x.png")).toBe(false);
    expect(isThemeAssetUrl("https://theme/current/a.png")).toBe(false);
    expect(isThemeAssetUrl("not a url")).toBe(false);
  });
});

describe("themeAssetRelativePath：安全判定与归一化", () => {
  it("反斜杠转正斜杠、去掉前导 ./、统一小写", () => {
    expect(themeAssetRelativePath(".\\Assets\\BG.PNG")).toBe("assets/bg.png");
    expect(themeAssetRelativePath("./wallpaper.png")).toBe("wallpaper.png");
  });

  it("拒绝空值、绝对路径、UNC、盘符、协议前缀、数据流、空段与父目录段", () => {
    for (const value of ["", "   ", "/etc/passwd", "\\\\server\\share\\x.png", "C:/x.png", "https://x/y.png", "data:image/png;base64,AA", "a/../b.png", "a//b.png", "./../x.png", "assets/\u0000.png"]) {
      expect(themeAssetRelativePath(value), value).toBeUndefined();
    }
  });
});

describe("themeAssetScopeName", () => {
  it("接受主题 id 与 current，拒绝路径分隔符与 Windows 非法字符", () => {
    expect(themeAssetScopeName("custom-0f3a")).toBe("custom-0f3a");
    expect(themeAssetScopeName(THEME_ASSET_CURRENT_SCOPE)).toBe("current");
    for (const value of ["", ".", "..", "a/b", "a\\b", "a:b", "a*b", "a?b", "a<b", 'a"b']) {
      expect(themeAssetScopeName(value), value).toBeUndefined();
    }
  });
});

describe("themeAssetReferences", () => {
  it("抽取安全相对引用并去重，跳过外链 / data / var / #id", () => {
    const css = [
      "@font-face { src: url(./Fonts/Theme.woff2); }",
      ":root { --chat-bg-image: url(\"Assets/BG dark.webp\"); }",
      ".a { background: url(https://example.com/x.png); }",
      ".b { background: url(data:image/png;base64,AAAA); }",
      ".c { mask: url(#mask); }",
      ".d { src: var(--x); }",
      // 百分号编码不做解码（与旧 collectThemeAssets 一致）：键就是 CSS 里写的字样
      ".e { background: url(assets/bg%20dark.webp); }",
      ".f { background: url(../escape.png); }"
    ].join("\n");
    expect(themeAssetReferences(css)).toEqual(["fonts/theme.woff2", "assets/bg dark.webp", "assets/bg%20dark.webp"]);
  });
});

describe("resolveThemeAssetUrls：安全相对引用改写成协议 URL", () => {
  it("改写为 url(\"pidesktop-file://theme/<scope>/<rel>\")，其余引用原样保留", () => {
    const css = [
      "@font-face { src: url(./Fonts/Theme.woff2) format(\"woff2\"); }",
      ":root { --chat-bg-image: url('assets/bg dark.webp') center / cover no-repeat; }",
      ".a { background: url(https://example.com/x.png); }",
      ".b { background: url(data:image/png;base64,AAAA); }",
      ".c { mask: url(#mask); }",
      ".d { color: var(--accent); }",
      ".e { background: url(../escape.png); }"
    ].join("\n");
    const resolved = resolveThemeAssetUrls(css, "custom-a");
    expect(resolved).toContain(`url("${themeAssetFileUrl("custom-a", "fonts/theme.woff2")}")`);
    expect(resolved).toContain(`url("${themeAssetFileUrl("custom-a", "assets/bg dark.webp")}")`);
    expect(resolved).toContain("url(https://example.com/x.png)");
    expect(resolved).toContain("url(data:image/png;base64,AAAA)");
    expect(resolved).toContain("url(#mask)");
    expect(resolved).toContain("var(--accent)");
    expect(resolved).toContain("url(../escape.png)");
    expect(resolved.match(/pidesktop-file:\/\//gu)).toHaveLength(2);
  });

  it("作用域名非法 / CSS 为空时一个字都不改", () => {
    const css = ":root { --x: url(a.png); }";
    expect(resolveThemeAssetUrls(css, "")).toBe(css);
    expect(resolveThemeAssetUrls(css, "../evil")).toBe(css);
    expect(resolveThemeAssetUrls("", "current")).toBe("");
  });

  it("同一份 CSS 用不同作用域改写（current 草稿 vs 已保存主题）", () => {
    const css = ":root { --chat-bg-image: url(wallpaper.png); }";
    expect(resolveThemeAssetUrls(css, THEME_ASSET_CURRENT_SCOPE)).toContain("/current/");
    expect(resolveThemeAssetUrls(css, "custom-a")).toContain("/custom-a/");
  });
});

describe("activeThemeScope：CSS 等值命中主题则用主题 id，否则 current", () => {
  const themes = [
    { id: "custom-a", name: "A", css: ":root { --accent: red; }" },
    { id: "custom-b", name: "B", css: ":root { --accent: blue; }" }
  ];

  it("命中主题", () => {
    expect(activeThemeScope({ customCss: themes[1]!.css, customThemes: themes })).toBe("custom-b");
  });

  it("未命中（导入中的草稿 / 空 CSS）→ current", () => {
    expect(activeThemeScope({ customCss: ":root { --accent: green; }", customThemes: themes })).toBe(THEME_ASSET_CURRENT_SCOPE);
    expect(activeThemeScope({ customCss: "", customThemes: themes })).toBe(THEME_ASSET_CURRENT_SCOPE);
  });
});
