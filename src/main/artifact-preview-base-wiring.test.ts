import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 工作区 html 文件预览的 `<base href>` 接线契约。
 *
 * 为什么放在 main 侧：渲染端 tsconfig 没有 node 类型（不能 import node:fs），而
 * `lib/content.ts` 自己的用例只能证明「给了 baseHref 就会注入」——把
 * `ArtifactPreview` 里解析目录、传给 `buildArtifactPreviewSource` 的那两行删掉，
 * 纯逻辑用例仍然全绿，而侧边栏打开的页面照样整页破图（相对图片/CSS/JS 全部按
 * 应用自己的 `file:///…/renderer/index.html` 解析 → 404，页面自己弹「图片读不到」）。
 */
describe("workspace html preview base-href wiring contract", () => {
  const preview = readFileSync(join(__dirname, "../renderer/src/components/ArtifactPreview.tsx"), "utf8");

  it("把文件所在目录经主进程静态服务解析成 base URL", () => {
    expect(preview).toContain("window.piDesktop.galleryFileUrl(galleryAbsolutePath(assetRoot, assetFile.relativePath), assetRoot)");
    expect(preview).toContain("previewBaseHrefFromFileUrl(fileUrl)");
  });

  it("base 真的传给了 srcDoc 构建器", () => {
    expect(preview).toContain("srcDoc={buildArtifactPreviewSource(artifact, assetBase ? { baseHref: assetBase } : undefined)}");
  });

  it("等目录地址就绪再挂 iframe（否则整页资源白跑一趟）", () => {
    expect(preview).toContain("assetBasePending");
    expect(preview).toMatch(/assetBasePending \? \(\s*<div className="preview-empty-state">/u);
  });

  it("沙箱口径不变：仍然不给 allow-same-origin", () => {
    expect(preview).toContain("sandbox={artifactSandbox(artifact)}");
    // 只允许沙箱字符串出现在 artifactSandbox() 内部，iframe 上的 sandbox 属性不得直写策略。
    expect(preview).not.toContain('sandbox="allow-scripts allow-same-origin"');
    expect(preview).not.toMatch(/sandbox=\{[^}]*(allow-same-origin|allow-scripts)/u);
  });
});
