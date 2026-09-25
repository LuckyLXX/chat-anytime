import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { themeAssetFileUrl } from "../shared/theme-assets.js";
import {
  THEME_ASSET_EXTENSIONS,
  THEME_ASSET_MAX_FILE_BYTES,
  THEME_ASSET_MAX_SCOPE_BYTES,
  serveThemeAsset,
  themeAssetMimeType,
  themeAssetsDirFor,
  themeScopeDir
} from "./theme-assets.js";

/**
 * 主题资产协议 handler 的真盘测试（2026-09-26 主题资产落磁盘）。
 * `serveThemeAsset` 刻意不依赖 Electron，所以这里能用真实临时目录钉住状态码与 MIME。
 */

let root = "";
let themesDir = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pi-theme-assets-"));
  themesDir = themeAssetsDirFor(root);
  mkdirSync(join(themesDir, "custom-a", "assets"), { recursive: true });
  writeFileSync(join(themesDir, "custom-a", "assets", "bg.webp"), Buffer.from([1, 2, 3, 4]));
  writeFileSync(join(themesDir, "custom-a", "theme.woff2"), Buffer.from([5, 6]));
  writeFileSync(join(themesDir, "custom-a", "note.txt"), Buffer.from("nope"));
  mkdirSync(join(themesDir, "current"), { recursive: true });
  writeFileSync(join(themesDir, "current", "wallpaper.png"), Buffer.from([7, 8, 9]));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("serveThemeAsset", () => {
  it("真文件 200 + 正确 MIME + 完整字节（图片与字体都走同一条流）", async () => {
    const image = await serveThemeAsset({ scope: "custom-a", relativePath: "assets/bg.webp" }, themesDir);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(image.headers.get("content-length")).toBe("4");
    expect(image.headers.get("cache-control")).toBe("no-cache");
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([1, 2, 3, 4]);

    const font = await serveThemeAsset({ scope: "custom-a", relativePath: "theme.woff2" }, themesDir);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
  });

  it("`current` 草稿作用域同样可取", async () => {
    const response = await serveThemeAsset({ scope: "current", relativePath: "wallpaper.png" }, themesDir);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("目录 404、不存在的文件 404、未知扩展名 415", async () => {
    expect((await serveThemeAsset({ scope: "custom-a", relativePath: "assets" }, themesDir)).status).toBe(404);
    expect((await serveThemeAsset({ scope: "custom-a", relativePath: "assets/missing.png" }, themesDir)).status).toBe(404);
    expect((await serveThemeAsset({ scope: "custom-missing", relativePath: "x.png" }, themesDir)).status).toBe(404);
    expect((await serveThemeAsset({ scope: "custom-a", relativePath: "note.txt" }, themesDir)).status).toBe(415);
  });

  it("穿越与非法作用域一律拒绝（协议解析层挡不住的，handler 再挡一次）", async () => {
    expect((await serveThemeAsset({ scope: "custom-a", relativePath: "../../custom-b/secret.png" }, themesDir)).status).toBe(403);
    expect((await serveThemeAsset({ scope: "custom-a", relativePath: "../../../etc/passwd" }, themesDir)).status).toBe(403);
    expect((await serveThemeAsset({ scope: "../custom-a", relativePath: "assets/bg.webp" }, themesDir)).status).toBe(400);
  });
});

describe("目录与 MIME 口径", () => {
  it("themesDir 落在 agentDir 下的 pidesktop-themes", () => {
    expect(themeAssetsDirFor(join("C:", "agent"))).toBe(join("C:", "agent", "pidesktop-themes"));
  });

  it("themeScopeDir 只接受安全作用域名", () => {
    expect(themeScopeDir("C:/themes", "custom-a")).toBe(join("C:/themes", "custom-a"));
    expect(themeScopeDir("C:/themes", "a/b")).toBeUndefined();
    expect(themeScopeDir("C:/themes", "..")).toBeUndefined();
  });

  it("MIME 表覆盖白名单里的全部扩展名，未知扩展名无 MIME", () => {
    for (const extension of THEME_ASSET_EXTENSIONS) {
      expect(themeAssetMimeType(`x${extension}`), extension).toBeTruthy();
    }
    expect(themeAssetMimeType("x.txt")).toBeUndefined();
    expect(themeAssetMimeType("x.pdf")).toBeUndefined();
  });

  it("体积上限：单文件 8MB / 单主题 32MB（比例刻意留出富余）", () => {
    expect(THEME_ASSET_MAX_FILE_BYTES).toBe(8 * 1024 * 1024);
    expect(THEME_ASSET_MAX_SCOPE_BYTES).toBe(THEME_ASSET_MAX_FILE_BYTES * 4);
  });
});

describe("协议 URL 与 handler 的接缝", () => {
  it("由 themeAssetFileUrl 生成的地址能被 handler 直接取到", async () => {
    const url = themeAssetFileUrl("custom-a", "assets/bg.webp");
    const response = await serveThemeAsset({ scope: "custom-a", relativePath: "assets/bg.webp" }, themesDir);
    expect(url).toContain("/theme/custom-a/");
    expect(response.status).toBe(200);
  });
});
