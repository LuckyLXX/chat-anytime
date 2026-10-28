import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 作品封面接线契约（源码断言型，2026-10-28）。
 *
 * 为什么用源码断言：封面链路横跨 shared（优先级纯函数）、utility（发布 + 存量补齐）、
 * main（离屏截图 RPC）与渲染端（发布对话框），而 `pi-runtime.ts` 是 utility 入口、
 * 单测里无法 import（顶层 `process.parentPort` 缺失即抛）。这里钉的是**静默失效**类风险：
 *  1. 封面优先级不能乱（显式 cover 被自动截图盖掉 = 用户指定的图永远不生效）；
 *  2. server 必须先探活再截（否则会为一张封面等满加载超时）；
 *  3. 拿不到画面必须落到程序化占位（否则又回到「卡片只有类型图标」）；
 *  4. design-snapshot 已经写盘，发布侧不能再按另一个文件名写一遍（旧实现每次发布
 *     在 thumbs 里留一个孤儿 PNG）；
 *  5. 存量作品要补齐，且补封面不能改 updatedAt（否则旧作品集体跳到作品墙最前面）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/gu, "\n");
const runtime = read(join(here, "pi-runtime.ts"));
const snapshot = read(join(here, "design-snapshot.ts"));
const tool = read(join(here, "runtime-gallery.ts"));
const dialogs = read(join(here, "../renderer/src/components/GalleryDialogs.tsx"));

/** 取一个顶层函数的函数体（签名后的 `{` 到同层闭合 `}`）。 */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `找不到 ${signature}（改名了？此测试要同步更新）`).toBeGreaterThan(-1);
  const bodyStart = source.indexOf("{", start + signature.length - 1);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error(`${signature} 的函数体没闭合`);
}

describe("封面优先级与截图扩展", () => {
  const coverBody = bodyOf(runtime, "async function generateGalleryCover(");

  it("显式 cover → 自动截图目标 → 程序化占位（顺序即语义）", () => {
    const explicitAt = coverBody.indexOf("const explicit = cover?.trim();");
    const targetAt = coverBody.indexOf("const target = gallerySnapshotTarget(app);");
    const placeholderAt = coverBody.indexOf("galleryPlaceholderCoverHtml(app)");
    expect(explicitAt).toBeGreaterThan(-1);
    expect(targetAt).toBeGreaterThan(explicitAt);
    expect(placeholderAt).toBeGreaterThan(targetAt);
  });

  it("显式封面只接受工作区内图片（越界直接失败，不回退到自动图）", () => {
    expect(coverBody).toContain("if (!pathIsWithin(root, absolute)) return { failure: \"封面图片必须位于作品工作区内\" };");
    expect(coverBody).toContain("coverExtensionAllowed(absolute)");
    expect(coverBody).toContain("await coverFileAllowed(absolute)");
  });

  it("server 先单次探活再截服务页（不可达不截，避免等加载超时）", () => {
    const probeAt = coverBody.indexOf("await probeService(address)");
    const serviceShotAt = coverBody.indexOf("url: target.url }, \"service\"");
    expect(probeAt).toBeGreaterThan(-1);
    expect(serviceShotAt).toBeGreaterThan(probeAt);
  });

  it("占位封面用 data: URL 走离屏截图（不落临时文件）", () => {
    expect(coverBody).toContain("`data:text/html;charset=utf-8,${encodeURIComponent(galleryPlaceholderCoverHtml(app))}`");
  });

  it("design-snapshot 三输入：url / htmlPath / imagePath", () => {
    expect(snapshot).toContain("export function resolveDesignSnapshotInput(");
    expect(snapshot).toContain('if (input.kind === "image") return this.captureImage(request, input.path);');
    expect(snapshot).toContain("return this.capturePage(request, input.url);");
    expect(snapshot).toContain("void contents.loadURL(targetUrl)");
  });
});

describe("封面的落盘与存量补齐", () => {
  it("缩略图文件名取回执路径的 basename（不再二次写盘）", () => {
    expect(runtime).toContain("return { thumb: basename(shot.savedPath), source };");
    // 反面：发布会重新生成一个 galleryThumbName() 并写同一份字节（孤儿文件）
    expect(runtime).not.toContain("writeGalleryThumb(");
  });

  it("启动时后台补齐缺封面的旧作品，且走 map 而不是 upsert（不刷新 updatedAt）", () => {
    expect(runtime).toContain("setTimeout(() => { void backfillGalleryCovers(); }, 4_000);");
    expect(runtime).toContain("const missing = galleryApps.filter((app) => !app.thumb);");
    expect(runtime).toContain("galleryApps = galleryApps.map((item) => item.id === app.id ? { ...item, thumb: cover.thumb!, coverSource: cover.source } : item);");
  });

  it("发布回执带封面结果（工具与人工 toast 共用）", () => {
    expect(runtime).toContain("const cover = await generateGalleryCover(upserted.app, draft.cover, root);");
    expect(runtime).toContain("galleryCoverNote(cover.source)");
    expect(runtime).toContain("if (!coverSource || coverSource === \"generated\")");
  });
});

describe("工具与对话框", () => {
  it("gallery_publish 暴露 cover 参数并透传", () => {
    expect(tool).toContain("cover: Type.Optional(Type.String({ description: \"封面图片的工作区相对路径");
    expect(tool).toContain("if (cover) draft.cover = cover;");
    expect(tool).toContain("每个作品都要有封面");
  });

  it("人工对话框有封面输入与预览；提交时写入 draft.cover", () => {
    expect(dialogs).toContain("封面图片（可选）");
    expect(dialogs).toContain("if (cover.trim()) draft.cover = cover.trim();");
    expect(dialogs).toContain("window.piDesktop.readWorkspaceFile(relativePath, workspace)");
  });
});
