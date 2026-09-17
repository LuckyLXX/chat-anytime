import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyImageSource,
  decodeDataUrl,
  deriveImageFilename,
  extensionForMime,
  imageRelativePath,
  isSameOrigin,
  MAX_SAVE_IMAGE_BYTES,
  saveImageBytes,
  sniffImageMime
} from "./browser-save-image.js";

describe("image source classification", () => {
  it("recognizes the four supported shapes", () => {
    expect(classifyImageSource("data:image/png;base64,AAAA")).toBe("data");
    expect(classifyImageSource("blob:https://example.com/1234")).toBe("blob");
    expect(classifyImageSource("https://example.com/a.png")).toBe("http");
    expect(classifyImageSource("http://example.com/a.png")).toBe("http");
  });

  it("rejects empty and unsupported shapes", () => {
    expect(classifyImageSource("")).toBeUndefined();
    expect(classifyImageSource("   ")).toBeUndefined();
    expect(classifyImageSource("file:///C:/x.png")).toBeUndefined();
    expect(classifyImageSource("chrome://favicon")).toBeUndefined();
    // 裸路径不是图片来源（页面给的 element.src 已被浏览器解析成绝对 URL）。
    expect(classifyImageSource("/a.png")).toBeUndefined();
  });
});

describe("same-origin check (Referer gate for session.fetch)", () => {
  it("compares protocol + host", () => {
    expect(isSameOrigin("https://example.com/page", "https://example.com/img.png")).toBe(true);
    expect(isSameOrigin("https://example.com/page", "https://cdn.example.com/img.png")).toBe(false);
    expect(isSameOrigin("https://example.com/page", "http://example.com/img.png")).toBe(false);
    expect(isSameOrigin("http://127.0.0.1:18777/page", "http://127.0.0.1:18778/img.png")).toBe(false);
  });

  it("treats unparseable URLs as cross-origin (never attach a blocked Referer)", () => {
    expect(isSameOrigin("", "https://example.com/a.png")).toBe(false);
    expect(isSameOrigin("about:blank", "https://example.com/a.png")).toBe(false);
  });
});

describe("magic-byte sniffing", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const gif = Buffer.from("GIF89a", "latin1");
  const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBP", "latin1")]);
  const bmp = Buffer.from("BM\x36\x00\x00\x00", "latin1");
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypavif", "latin1")]);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "utf8");
  const svgWithBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml version="1.0"?><svg></svg>', "utf8")]);

  it("detects real image formats from bytes, not extensions", () => {
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(gif)).toBe("image/gif");
    expect(sniffImageMime(webp)).toBe("image/webp");
    expect(sniffImageMime(bmp)).toBe("image/bmp");
    expect(sniffImageMime(avif)).toBe("image/avif");
    expect(sniffImageMime(svg)).toBe("image/svg+xml");
    // BOM + XML 声明前置的 SVG 也是 SVG（内联图标常见写法）。
    expect(sniffImageMime(svgWithBom)).toBe("image/svg+xml");
  });

  it("returns undefined for non-images and truncated buffers", () => {
    expect(sniffImageMime(Buffer.from("<html></html>", "utf8"))).toBeUndefined();
    expect(sniffImageMime(Buffer.alloc(0))).toBeUndefined();
    // RIFF 但没有 WEBP 品牌（例如 wav）。
    expect(sniffImageMime(Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0, 0, 0, 0]), Buffer.from("WAVE", "latin1")]))).toBeUndefined();
  });

  it("maps MIME to a safe extension", () => {
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/svg+xml")).toBe("svg");
    expect(extensionForMime(undefined)).toBe("bin");
    expect(extensionForMime("image/unknown")).toBe("bin");
  });
});

describe("filename derivation", () => {
  const now = new Date("2026-09-17T08:09:10.000Z");

  it("uses the URL basename with an extension from the sniffed MIME", () => {
    // URL 说 webp，字节说是 PNG → 落盘 .png（不信任后缀）。
    expect(deriveImageFilename("https://example.com/photo.webp", "image/png", now)).toBe("photo.png");
    expect(deriveImageFilename("https://example.com/a/b/c.jpg?v=2", "image/jpeg", now)).toBe("c.jpg");
  });

  it("sanitizes hostile basenames through the shared download sanitizer", () => {
    expect(deriveImageFilename("https://example.com/../../etc/passwd", "image/png", now)).toBe("passwd.png");
    // 百分号编码解码后再清洗（与 Chromium 的下载命名一致）：`a%20b.png` → `a b.png`。
    expect(deriveImageFilename("https://example.com/a%20b.png", "image/png", now)).toBe("a b.png");
    // 编码过的穿越序列解码后同样被拆掉路径分量。
    expect(deriveImageFilename("https://example.com/%2e%2e%2f%2e%2e%2fetc%2fpasswd", "image/png", now)).toBe("passwd.png");
  });

  it("falls back to a timestamped name for data:/blob: and empty paths", () => {
    // 时间戳用**本地时间**组件（与截图/下载命名同一约定，便于用户按文件名排序）。
    const stamp = `image-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    expect(deriveImageFilename("data:image/png;base64,AAAA", "image/png", now)).toBe(`${stamp}.png`);
    expect(deriveImageFilename("blob:https://example.com/1234", "image/png", now)).toBe(`${stamp}.png`);
    expect(deriveImageFilename("https://example.com/", "image/png", now)).toBe(`${stamp}.png`);
    expect(deriveImageFilename(undefined, undefined, now)).toBe(`${stamp}.bin`);
  });
});

describe("saveImageBytes", () => {
  const workspaces: string[] = [];
  afterEach(async () => {
    for (const workspace of workspaces) await rm(workspace, { recursive: true, force: true });
    workspaces.length = 0;
  });
  const makeWorkspace = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "pidesktop-save-image-"));
    workspaces.push(dir);
    return dir;
  };

  it("writes into .pidesktop/downloads and never overwrites an existing file", async () => {
    const workspace = await makeWorkspace();
    const first = await saveImageBytes(workspace, "photo.png", Buffer.from([1, 2, 3]));
    expect(first.filename).toBe("photo.png");
    expect(existsSync(first.filePath)).toBe(true);
    const second = await saveImageBytes(workspace, "photo.png", Buffer.from([4, 5]));
    expect(second.filename).toBe("photo-1.png");
    const third = await saveImageBytes(workspace, "photo.png", Buffer.from([6]));
    expect(third.filename).toBe("photo-2.png");
    // 原文件必须原封不动（这是「绝不覆盖」的判据）。
    expect([...await readFile(first.filePath)]).toEqual([1, 2, 3]);
  });

  it("reports the workspace-relative path in POSIX form", async () => {
    const workspace = await makeWorkspace();
    const saved = await saveImageBytes(workspace, "chart.png", Buffer.from([1]));
    const relative = imageRelativePath(workspace, saved.filePath);
    expect(relative).toBe(".pidesktop/downloads/chart.png");
    expect(relative).not.toContain("\\");
  });

  it("creates the drop directory on demand", async () => {
    const workspace = await makeWorkspace();
    await saveImageBytes(workspace, "a.png", Buffer.from([1]));
    expect(existsSync(join(workspace, ".pidesktop", "downloads", "a.png"))).toBe(true);
  });
});

describe("decodeDataUrl", () => {
  it("decodes base64 payloads and keeps the declared MIME", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const decoded = decodeDataUrl(`data:image/png;base64,${png.toString("base64")}`);
    expect(decoded?.mime).toBe("image/png");
    expect([...decoded!.bytes]).toEqual([...png]);
  });

  it("decodes percent-encoded (non-base64) payloads — the inline-SVG shape", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    const decoded = decodeDataUrl(`data:image/svg+xml,${encodeURIComponent(svg)}`);
    expect(decoded?.mime).toBe("image/svg+xml");
    expect(decoded!.bytes.toString("utf8")).toBe(svg);
  });

  it("returns undefined for malformed input and empty payloads", () => {
    expect(decodeDataUrl("https://example.com/a.png")).toBeUndefined();
    expect(decodeDataUrl("data:image/png;base64,")).toBeUndefined();
    expect(decodeDataUrl("data:,")).toEqual({ bytes: Buffer.alloc(0), mime: "application/octet-stream" });
  });

  it("keeps the size ceiling high enough for real photos but finite", () => {
    // 20MB：与 browser_upload 同口径（单张图上限），不是无限。
    expect(MAX_SAVE_IMAGE_BYTES).toBe(20 * 1024 * 1024);
  });
});
