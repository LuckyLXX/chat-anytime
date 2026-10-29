import { describe, expect, it } from "vitest";
import { artifactSandbox, buildArtifactPreviewSource, extractArtifacts, extractMentionTokens, injectBaseHref, isDynamicArtifact, formatDuration, previewBaseHrefFromFileUrl } from "./content";

describe("rich content helpers", () => {
  it("extracts HTML and SVG artifacts without treating ordinary code as an artifact", () => {
    const artifacts = extractArtifacts(
      "```html\n<h1>Hello</h1>\n```\n```ts\nconst x = 1\n```\n```svg\n<svg></svg>\n```",
      "message-1"
    );
    expect(artifacts).toEqual([
      { id: "message-1-artifact-0", title: "HTML 预览", language: "html", content: "<h1>Hello</h1>\n" },
      { id: "message-1-artifact-1", title: "SVG 预览", language: "svg", content: "<svg></svg>\n" }
    ]);
  });

  it("formats short and long tool durations", () => {
    expect(formatDuration(1000, 1450)).toBe("450ms");
    expect(formatDuration(1000, 3250)).toBe("2.3s");
    expect(formatDuration(1000, 61_500)).toBe("1.0m");
    expect(formatDuration(1000, 345_000)).toBe("5.7m");
    expect(formatDuration(1000, 59_999)).toBe("59.0s");
  });

  it("extracts @file mentions into badges and cleans the body text", () => {
    expect(extractMentionTokens("本条是测试消息 @docs/迭代记录.md")).toEqual({ mentions: ["docs/迭代记录.md"], body: "本条是测试消息" });
    expect(extractMentionTokens("看下 @src/app.ts 和 @docs/架构.md 再改")).toEqual({ mentions: ["src/app.ts", "docs/架构.md"], body: "看下 和 再改" });
    expect(extractMentionTokens("只有引用 @README.md")).toEqual({ mentions: ["README.md"], body: "只有引用" });
  });

  it("keeps plain text intact when mentions look like annotations or emails", () => {
    // 邮箱中缀 @ 不在行首/空白后；@Component 无点斜杠不构成路径；@GetMapping("/x") 括号截断 token 后同样无点斜杠
    expect(extractMentionTokens("联系 someone@example.com 反馈")).toEqual({ mentions: [], body: "联系 someone@example.com 反馈" });
    expect(extractMentionTokens("@Component\n@GetMapping(\"/users\")")).toEqual({ mentions: [], body: "@Component\n@GetMapping(\"/users\")" });
  });

  it("detects dynamic HTML and keeps it in a scripts-only sandbox", () => {
    const artifact = { language: "html", content: "<canvas id=\"stage\"></canvas><script>requestAnimationFrame(() => {});</script>" };
    expect(isDynamicArtifact(artifact)).toBe(true);
    expect(artifactSandbox(artifact)).toBe("allow-scripts");
    expect(buildArtifactPreviewSource(artifact)).toContain("pidesktop-preview-pause");
    expect(buildArtifactPreviewSource(artifact)).toContain("window.requestAnimationFrame");
  });

  it("keeps static HTML fragments inert and does not inject the dynamic runtime", () => {
    const artifact = { language: "html", content: "<div class=\"card\">静态内容</div>" };
    expect(isDynamicArtifact(artifact)).toBe(false);
    expect(artifactSandbox(artifact)).toBe("allow-same-origin");
    expect(buildArtifactPreviewSource(artifact)).not.toContain("pidesktop-preview-pause");
  });

  it("injects the content-size reporter into every html preview (svg excluded)", () => {
    const html = buildArtifactPreviewSource({ language: "html", content: "<!doctype html><html><head></head><body><main>双端</main></body></html>" });
    expect(html).toContain("pidesktop-preview-size");
    // 注入不得破坏原文档结构
    expect(html).toContain("<!doctype html><html><head>");
    const svg = buildArtifactPreviewSource({ language: "svg", content: "<svg xmlns='http://www.w3.org/2000/svg'/>" });
    expect(svg).not.toContain("pidesktop-preview-size");
  });

  it("marks dynamic fenced artifacts during extraction", () => {
    expect(extractArtifacts("```html\n<div><canvas></canvas></div>\n```", "message-2")).toMatchObject([
      { id: "message-2-artifact-0", language: "html", dynamic: true }
    ]);
  });

  // 侧边栏打开工作区里的 html 时，srcDoc 沙箱 iframe 没有目录上下文：不注入 <base> 的话
  // 页面里的相对图片/CSS/JS 全部按应用自己的 file:///…/renderer/index.html 解析（404）。
  describe("<base href> 注入（工作区文件预览的相对资源）", () => {
    const base = "http://127.0.0.1:41234/w/abcdef0123456789/2/";
    const page = '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><img src="风格提示词/A-G_代码样片/A1_字雨.jpg"></body></html>';

    it("把目录地址放在 head 最前面，先于任何相对引用", () => {
      const out = buildArtifactPreviewSource({ language: "html", content: page }, { baseHref: base });
      expect(out).toContain(`<head>\n<base href="${base}">`);
      expect(out.indexOf("<base")).toBeLessThan(out.indexOf("style.css"));
      // 尺寸上报与沙箱口径不变（页面依旧拿不到 allow-same-origin）。
      expect(out).toContain("pidesktop-preview-size");
      expect(artifactSandbox({ language: "html", content: page })).toBe("allow-scripts");
    });

    it("片段预览（我们自己包的文档）也注入", () => {
      const out = buildArtifactPreviewSource({ language: "html", content: "<img src=\"a.jpg\">" }, { baseHref: base });
      expect(out).toContain(`<base href="${base}">`);
      expect(out.indexOf("<base")).toBeLessThan(out.indexOf("a.jpg"));
    });

    it("没有 head 的完整文档会补一个 head", () => {
      const out = injectBaseHref("<html><body>x</body></html>", base);
      expect(out).toBe(`<html>\n<head><base href="${base}"></head><body>x</body></html>`);
    });

    it("页面自带绝对 base（CDN）时尊重它，不插自己的", () => {
      const source = '<!doctype html><html><head><base href="https://cdn.example.com/app/"></head><body></body></html>';
      expect(injectBaseHref(source, base)).toBe(source);
    });

    it("页面自带相对 base 时按我们的目录地址解成绝对地址", () => {
      const out = injectBaseHref('<html><head><base href="assets/"></head><body></body></html>', base);
      expect(out).toContain(`<base href="${base}assets/">`);
      expect(out).not.toContain('href="assets/"');
    });

    it("没有 href 的 base 保留其他属性（target 等不能被吃掉）", () => {
      expect(injectBaseHref('<html><head><base target="_blank"></head><body></body></html>', base)).toBe(
        `<html><head><base href="${base}" target="_blank"></head><body></body></html>`
      );
      expect(injectBaseHref('<html><head><base href="sub/" target="_blank"></head><body></body></html>', base)).toContain(`href="${base}sub/" target="_blank"`);
    });

    it("站点根 base（/assets/）落到静态服务的挂载根（否则被 token 校验拒掉）", () => {
      const out = injectBaseHref('<html><head><base href="/assets/"></head><body></body></html>', base);
      expect(out).toContain(`<base href="http://127.0.0.1:41234/w/abcdef0123456789/2/assets/">`);
    });

    it("属性值里的 $& / $' 不会被当成字符串替换串", () => {
      const out = injectBaseHref('<html><head><base href="a$&b/"></head><body></body></html>', base);
      expect(out).toContain(`<base href="${base}a$&amp;b/">`);
      expect(out.match(/<base\b/gu)).toHaveLength(1);
    });

    it("协议相对的绝对 base（//cdn）原样保留", () => {
      const source = '<html><head><base href="//cdn.example.com/app/"></head><body></body></html>';
      expect(injectBaseHref(source, base)).toBe(source);
    });

    it("不传 baseHref 时不注入（聊天里的代码块 artifact 没有磁盘目录）", () => {
      expect(buildArtifactPreviewSource({ language: "html", content: page })).not.toContain("<base");
    });

    it("属性值会被转义", () => {
      expect(injectBaseHref("<html><head></head></html>", 'http://h/d?a=1&b="2"')).toContain('<base href="http://h/d?a=1&amp;b=&quot;2&quot;">');
    });
  });

  describe("previewBaseHrefFromFileUrl", () => {
    it("静态服务文件地址 → 所在目录", () => {
      expect(previewBaseHrefFromFileUrl("http://127.0.0.1:41234/w/abcdef0123456789/2/%E9%A3%8E%E6%A0%BC%E6%8C%91%E9%80%89.html")).toBe("http://127.0.0.1:41234/w/abcdef0123456789/2/");
      expect(previewBaseHrefFromFileUrl("http://127.0.0.1:41234/w/abcdef0123456789/2/sub/page.html")).toBe("http://127.0.0.1:41234/w/abcdef0123456789/2/sub/");
    });

    it("拿不到目录时返回 undefined（非法/空地址）", () => {
      expect(previewBaseHrefFromFileUrl("")).toBeUndefined();
      expect(previewBaseHrefFromFileUrl("about:blank")).toBeUndefined();
      expect(previewBaseHrefFromFileUrl("/page.html")).toBeUndefined();
    });
  });
});
