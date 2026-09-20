import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_GALLERY_APPS, type GalleryApp } from "../shared/gallery.js";
import {
  galleryPathFor,
  galleryThumbsDirFor,
  isSafeThumbName,
  loadGallery,
  persistGallery,
  pruneGalleryThumbs,
  readGalleryThumb,
  removeGalleryThumb,
  writeGallery,
  writeGalleryThumb
} from "./gallery-store.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pidesktop-gallery-"));
}

function app(patch: Partial<GalleryApp> = {}): GalleryApp {
  return {
    id: "g1",
    title: "示例作品",
    kind: "file",
    workspace: "D:/ws",
    entry: "designs/exports/demo.html",
    createdAt: 1000,
    updatedAt: 1000,
    ...patch
  };
}

describe("gallery-store 路径", () => {
  it("清单在 <agentDir>/pidesktop-gallery/gallery.json，缩略图在其 thumbs/", () => {
    expect(galleryPathFor("C:/agent").replaceAll("\\", "/")).toBe("C:/agent/pidesktop-gallery/gallery.json");
    expect(galleryThumbsDirFor("C:/agent").replaceAll("\\", "/")).toBe("C:/agent/pidesktop-gallery/thumbs");
  });
});

describe("loadGallery / writeGallery", () => {
  it("往返：写后读回同一份清单", () => {
    const dir = tempDir();
    const file = galleryPathFor(dir);
    writeGallery(file, [app()]);
    expect(loadGallery(file)).toEqual([app()]);
    // 自动建目录（首次发布时 pidesktop-gallery/ 还不存在）
    expect(readFileSync(file, "utf8")).toContain("示例作品");
  });

  it("缺文件 / 坏 JSON / 缺 apps 字段一律回空表（不抛）", () => {
    const dir = tempDir();
    expect(loadGallery(galleryPathFor(dir))).toEqual([]);
    const file = galleryPathFor(dir);
    writeGallery(file, []);
    writeFileSync(file, "{ not json", "utf8");
    expect(loadGallery(file)).toEqual([]);
    writeFileSync(file, '{"other":1}', "utf8");
    expect(loadGallery(file)).toEqual([]);
  });

  it("逐条丢弃坏条目，好条目照常读回", () => {
    const dir = tempDir();
    const file = galleryPathFor(dir);
    writeGallery(file, []); // 先建目录
    writeFileSync(file, JSON.stringify({ apps: [app(), { title: "坏条目" }, null, app({ id: "g2", entry: "b.html", updatedAt: 9 })] }), "utf8");
    expect(loadGallery(file).map((item) => item.id).sort()).toEqual(["g1", "g2"]);
  });
});

describe("persistGallery（超限淘汰 + 缩略图跟随）", () => {
  it("超上限淘汰最旧，并删掉其缩略图文件", () => {
    const dir = tempDir();
    const file = galleryPathFor(dir);
    const thumbs = galleryThumbsDirFor(dir);
    const apps: GalleryApp[] = [];
    for (let index = 0; index < MAX_GALLERY_APPS + 2; index += 1) {
      apps.push(app({ id: `g${index}`, entry: `${index}.html`, updatedAt: 1000 + index, thumb: `gallery-${index}.png` }));
    }
    writeGalleryThumb(thumbs, "gallery-0.png", Buffer.from("png"));
    writeGalleryThumb(thumbs, "gallery-1.png", Buffer.from("png"));
    const kept = persistGallery(file, apps, thumbs);
    expect(kept).toHaveLength(MAX_GALLERY_APPS);
    expect(kept.some((item) => item.id === "g0")).toBe(false);
    expect(readGalleryThumb(thumbs, "gallery-0.png")).toBeUndefined();
    expect(readGalleryThumb(thumbs, "gallery-1.png")).toBeUndefined();
  });

  it("未超限时不删任何缩略图", () => {
    const dir = tempDir();
    const file = galleryPathFor(dir);
    const thumbs = galleryThumbsDirFor(dir);
    writeGalleryThumb(thumbs, "gallery-keep.png", Buffer.from("png"));
    persistGallery(file, [app({ thumb: "gallery-keep.png" })], thumbs);
    expect(readGalleryThumb(thumbs, "gallery-keep.png")).toBeDefined();
  });
});

describe("缩略图读写与越界防护", () => {
  it("读写往返；缺文件返回 undefined（卡片降级，不是错误）", () => {
    const dir = tempDir();
    const thumbs = galleryThumbsDirFor(dir);
    writeGalleryThumb(thumbs, "gallery-1.png", Buffer.from("abc"));
    expect(readGalleryThumb(thumbs, "gallery-1.png")?.toString()).toBe("abc");
    expect(readGalleryThumb(thumbs, "missing.png")).toBeUndefined();
  });

  it("拒绝带路径分隔符 / `..` 的文件名（条目 json 可手改，防目录穿越）", () => {
    const thumbs = galleryThumbsDirFor(tempDir());
    for (const name of ["../secret.png", "a/b.png", "a\\b.png", "..", ".", ""]) {
      expect(isSafeThumbName(name)).toBe(false);
      expect(readGalleryThumb(thumbs, name)).toBeUndefined();
    }
    expect(isSafeThumbName("gallery-1.png")).toBe(true);
  });

  it("删除是幂等的（文件本来就不在也不报错）", () => {
    const thumbs = galleryThumbsDirFor(tempDir());
    expect(() => removeGalleryThumb(thumbs, "gallery-none.png")).not.toThrow();
    expect(() => removeGalleryThumb(thumbs, undefined)).not.toThrow();
  });
});

describe("pruneGalleryThumbs（孤儿缩略图清理）", () => {
  it("删掉清单里已不存在的 gallery-*.png，保留在册的与非本模块命名的文件", () => {
    const dir = tempDir();
    const thumbs = galleryThumbsDirFor(dir);
    writeGalleryThumb(thumbs, "gallery-a.png", Buffer.from("a"));
    writeGalleryThumb(thumbs, "gallery-orphan.png", Buffer.from("o"));
    writeGalleryThumb(thumbs, "design-20260920.png", Buffer.from("d"));
    const removed = pruneGalleryThumbs(thumbs, [app({ thumb: "gallery-a.png" })]);
    expect(removed).toBe(1);
    expect(readGalleryThumb(thumbs, "gallery-a.png")).toBeDefined();
    expect(readGalleryThumb(thumbs, "gallery-orphan.png")).toBeUndefined();
    // 其它前缀（design-/browser-）属截图模块的地盘，不越权清理
    expect(readGalleryThumb(thumbs, "design-20260920.png")).toBeDefined();
  });

  it("目录不存在时返回 0 而不是抛", () => {
    expect(pruneGalleryThumbs(join(tempDir(), "nope"), [])).toBe(0);
  });
});
