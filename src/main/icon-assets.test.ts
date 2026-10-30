import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * 应用图标资产的「白边」回归网（2026-10-30，GitHub issue #1「桌面图标四周未透明」）。
 *
 * 根因不是图标设计，而是生成链路：`scripts/generate-icon-assets.mjs` 的源稿是
 * 「白底 RGB、无 alpha」的生图稿，旧实现裁切后直接套圆角遮罩，遮罩角部仍残留
 * 源图白底 —— 成品 512 图上沿透明边界有 169 个不透明近白像素、16/24 帧四角是
 * 半透明白，深色壁纸上一眼就是白边白角。修复在脚本里加了 `stripWhiteBackdrop`
 * （外部白底连通区 → 透明 + 过渡带反算 alpha），本文件直接解码**入库产物**校验
 * 像素，而不是断言脚本文本，这样无论谁重跑脚本、换源稿，白边都会立刻转红。
 *
 * 为什么只读 `build/icon.png` / `build/icon.ico` / `src/main/assets/icon.ico`：
 * 这三个是入库产物（`build/icon-master.png` 与 `icon-drafts/` 在 .gitignore 里，
 * 干净 clone 下不存在，断言它会误红）。源脚本另有一条接线断言兜住「改回原图裁切」。
 */

const repoRoot = join(__dirname, "../..");

interface RgbaImage {
  width: number;
  height: number;
  /** 逐像素 RGBA，长度 = width * height * 4 */
  data: Uint8Array;
}

/** 最小 PNG 解码：8bit、非隔行、colorType 6(RGBA) / 2(RGB) —— 正好覆盖 Chromium 产物 */
function decodePng(buffer: Buffer): RgbaImage {
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(body));
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`不支持的 PNG 变体: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor]!;
    cursor += 1;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      let value = raw[cursor + x]!;
      if (filter === 1) {
        value += left;
      } else if (filter === 2) {
        value += up;
      } else if (filter === 3) {
        value += (left + up) >> 1;
      } else if (filter === 4) {
        const estimate = left + up - upLeft;
        const distanceLeft = Math.abs(estimate - left);
        const distanceUp = Math.abs(estimate - up);
        const distanceUpLeft = Math.abs(estimate - upLeft);
        value += distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft ? left : distanceUp <= distanceUpLeft ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`未知 PNG 行过滤类型: ${filter}`);
      }
      line[x] = value & 0xff;
    }
    cursor += stride;
    for (let x = 0; x < width; x++) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      data[target] = line[source]!;
      data[target + 1] = line[source + 1]!;
      data[target + 2] = line[source + 2]!;
      data[target + 3] = channels === 4 ? line[source + 3]! : 255;
    }
    previous = line;
  }
  return { width, height, data };
}

/** ICO 目录解析：本仓库的 ICO 每个条目都是 PNG 压缩帧（Vista+ 标准） */
function readIcoFrames(buffer: Buffer): { size: number; png: Buffer }[] {
  const count = buffer.readUInt16LE(4);
  const frames: { size: number; png: Buffer }[] = [];
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16;
    const size = buffer[entry] === 0 ? 256 : buffer[entry]!;
    const length = buffer.readUInt32LE(entry + 8);
    const start = buffer.readUInt32LE(entry + 12);
    frames.push({ size, png: buffer.subarray(start, start + length) });
  }
  return frames;
}

function pixel(image: RgbaImage, x: number, y: number): [number, number, number, number] {
  const index = (y * image.width + x) * 4;
  return [image.data[index]!, image.data[index + 1]!, image.data[index + 2]!, image.data[index + 3]!];
}

function cornerAlphas(image: RgbaImage): number[] {
  const { width: w, height: h } = image;
  return [pixel(image, 0, 0)[3], pixel(image, w - 1, 0)[3], pixel(image, 0, h - 1)[3], pixel(image, w - 1, h - 1)[3]];
}

/**
 * 贴着透明区的不透明近白像素数 —— 这就是「白边 / 白角」的像素级定义。
 * 阈值 200/230 是照着旧产物定的：旧 512 图上有 169 个（对角线上 24–36px 全是白），
 * 16/24 帧四角是 (255,250,250,54) 这类半透明白。
 */
function whiteEdgePixels(image: RgbaImage): number {
  const { width: w, height: h } = image;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(image, x, y);
      if (a < 200 || r < 230 || g < 230 || b < 230) continue;
      let touchesTransparency = false;
      for (let dy = -1; dy <= 1 && !touchesTransparency; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (pixel(image, nx, ny)[3] === 0) {
            touchesTransparency = true;
            break;
          }
        }
      }
      if (touchesTransparency) count++;
    }
  }
  return count;
}

/** 半透明像素里混进白色（没反算 alpha 的典型症状：边缘是一圈白雾） */
function whiteTranslucentPixels(image: RgbaImage): number {
  let count = 0;
  const pixels = image.width * image.height;
  for (let index = 0; index < pixels; index++) {
    const offset = index * 4;
    const alpha = image.data[offset + 3]!;
    if (alpha === 0 || alpha === 255) continue;
    if (image.data[offset]! > 230 && image.data[offset + 1]! > 230 && image.data[offset + 2]! > 230) count++;
  }
  return count;
}

const iconPng = decodePng(readFileSync(join(repoRoot, "build/icon.png")));
const iconIco = readFileSync(join(repoRoot, "build/icon.ico"));
const runtimeIco = readFileSync(join(repoRoot, "src/main/assets/icon.ico"));
const icoFrames = readIcoFrames(iconIco).map((frame) => ({ size: frame.size, image: decodePng(frame.png) }));

describe("应用图标资产：PNG 无白边", () => {
  it("512×512 四角全透明（旧版四角是白色的近白像素）", () => {
    expect([iconPng.width, iconPng.height]).toEqual([512, 512]);
    expect(cornerAlphas(iconPng)).toEqual([0, 0, 0, 0]);
  });

  it("沿透明边界不存在不透明近白像素（白边 / 白角的像素级判据）", () => {
    expect(whiteEdgePixels(iconPng)).toBe(0);
  });

  it("半透明边缘是主体色而非白色（过渡带按与背景色的混合比例反算过 alpha）", () => {
    expect(whiteTranslucentPixels(iconPng)).toBe(0);
  });

  it("图标主体完好：中心不透明、面积占满、内部白色 CA 字标仍在", () => {
    const [r, g, b, a] = pixel(iconPng, 256, 256);
    expect(a).toBe(255);
    // 中心是蓝绿渐变过渡带上的蓝青色，必须明显偏蓝/偏绿而不是白
    expect(b).toBeGreaterThan(180);
    expect(r).toBeLessThan(60);

    let opaque = 0;
    let opaqueWhite = 0;
    const total = iconPng.width * iconPng.height;
    for (let index = 0; index < total; index++) {
      const offset = index * 4;
      if (iconPng.data[offset + 3]! !== 255) continue;
      opaque++;
      if (iconPng.data[offset]! > 240 && iconPng.data[offset + 1]! > 240 && iconPng.data[offset + 2]! > 240) opaqueWhite++;
    }
    // 圆角矩形约占画布 92%，留足余量防止「遮罩把图标切掉一半」
    expect(opaque / total).toBeGreaterThan(0.6);
    // CA 字标是白色（实测约 2.6 万像素）：这条同时防住「去白底把内部白色也一起去掉」的过度处理
    expect(opaqueWhite).toBeGreaterThan(5000);
  });
});

describe("应用图标资产：ICO 各尺寸帧无白边", () => {
  it("帧齐全：256/128/64/48/32/24/16，且窗口用 icon 与打包用 icon 内容一致", () => {
    expect(icoFrames.map((frame) => frame.size)).toEqual([256, 128, 64, 48, 32, 24, 16]);
    expect(runtimeIco.equals(iconIco)).toBe(true);
  });

  it("每帧四角全透明且无贴边近白像素（旧版 16/24 帧四角是半透明白）", () => {
    for (const frame of icoFrames) {
      expect([frame.image.width, frame.image.height]).toEqual([frame.size, frame.size]);
      expect({ size: frame.size, corners: cornerAlphas(frame.image) }).toEqual({ size: frame.size, corners: [0, 0, 0, 0] });
      expect({ size: frame.size, whiteEdge: whiteEdgePixels(frame.image) }).toEqual({ size: frame.size, whiteEdge: 0 });
      expect({ size: frame.size, whiteTranslucent: whiteTranslucentPixels(frame.image) }).toEqual({ size: frame.size, whiteTranslucent: 0 });
    }
  });
});

describe("生成脚本接线：裁切必须来自去底后的画布", () => {
  const script = readFileSync(join(repoRoot, "scripts/generate-icon-assets.mjs"), "utf8").replace(/\r\n/gu, "\n");

  it("外部白底连通扩散 + 过渡带反算 alpha 的步骤仍在", () => {
    for (const marker of ["const backdrop = new Uint8Array(S * S)", "const isBackdrop = (i) =>", "featherPixels++", "putImageData(new ImageData(data, S, S), 0, 0)"]) {
      expect(script).toContain(marker);
    }
  });

  it("圆角遮罩从去底后的 canvas(c) 取像素，而不是原图 img", () => {
    expect(script).toContain("m.drawImage(c, sx, sy, side, side, 0, 0, S, S)");
    expect(script).not.toContain("m.drawImage(img, sx, sy, side, side, 0, 0, S, S)");
  });
});
