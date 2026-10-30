// 从选定的生图稿生成应用图标资产：
//   build/icon-master.png  2048 母版（透明圆角）
//   build/icon.png         512 通用 PNG
//   build/icon.ico         多尺寸 ICO（256/128/64/48/32/24/16，PNG 压缩条目）
//   src/main/assets/icon.ico  窗口/任务栏图标（与 build/icon.ico 同内容）
// 用法：npx electron scripts/generate-icon-assets.mjs <源PNG路径>
//
// 源稿是「白底 RGB、无 alpha」的生图稿。旧实现裁切后直接套 22.5% 圆角遮罩，
// 遮罩角部仍留着源图白底 → 成品图标外面一圈白色（深色壁纸上一眼白边白角，
// GitHub issue #1 也就是这个现象）。现在多一步 `stripWhiteBackdrop`：从画布
// 四边做连通扩散求「外部白底掩码」，掩码内 alpha 归零，紧邻掩码的过渡像素按
// 与背景色的混合比例反算 alpha（unpremultiply），得到「主体色 → 全透明」的抗
// 锯齿边；主体内部互不连通的白色（CA 字标）不受影响。
import { app, BrowserWindow } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const source = path.resolve(root, process.argv[2] ?? "icon-drafts/draft-1-flat-gradient.png");

/** 在离屏页面里执行：检测图标主体包围盒 → 裁切 → 圆角遮罩 → 逐级降采样 */
async function pageTask(dataUrl) {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const S = 2048;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, S, S);
  const data = ctx.getImageData(0, 0, S, S).data;

  // ── 外部白底 → 透明（见文件头说明） ──────────────────────────────────
  const bgColor = (() => {
    // 四角 8×8 采样的平均值：源稿背景是均匀的近白（实测 (252,250,251)）
    let r = 0, g = 0, b = 0, n = 0;
    for (const [ox, oy] of [[0, 0], [S - 8, 0], [0, S - 8], [S - 8, S - 8]]) {
      for (let y = oy; y < oy + 8; y++) {
        for (let x = ox; x < ox + 8; x++) {
          const i = (y * S + x) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
    }
    return [r / n, g / n, b / n];
  })();
  const BG_TOLERANCE = 26;
  const isBackdrop = (i) =>
    Math.abs(data[i] - bgColor[0]) <= BG_TOLERANCE &&
    Math.abs(data[i + 1] - bgColor[1]) <= BG_TOLERANCE &&
    Math.abs(data[i + 2] - bgColor[2]) <= BG_TOLERANCE;

  // 连通扩散：只有从画布边缘能走到的近背景像素才算「外部背景」
  const backdrop = new Uint8Array(S * S);
  const queue = new Int32Array(S * S);
  let qTail = 0;
  const seed = (idx) => {
    if (backdrop[idx] || !isBackdrop(idx * 4)) return;
    backdrop[idx] = 1;
    queue[qTail++] = idx;
  };
  for (let x = 0; x < S; x++) { seed(x); seed((S - 1) * S + x); }
  for (let y = 0; y < S; y++) { seed(y * S); seed(y * S + S - 1); }
  for (let qHead = 0; qHead < qTail; qHead++) {
    const idx = queue[qHead];
    const x = idx % S;
    const y = (idx - x) / S;
    if (x > 0) seed(idx - 1);
    if (x < S - 1) seed(idx + 1);
    if (y > 0) seed(idx - S);
    if (y < S - 1) seed(idx + S);
  }

  // 掩码内 = 全透明；紧邻掩码的过渡像素按 (bg - p) / (bg - inside) 反算 alpha，
  // 颜色换成内侧主体色，避免半透明处保留白色（否则仍是一圈白雾）
  let strippedPixels = 0;
  let featherPixels = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = y * S + x;
      const i4 = idx * 4;
      if (backdrop[idx]) { data[i4 + 3] = 0; strippedPixels++; continue; }
      const touchesBackdrop =
        (x > 0 && backdrop[idx - 1]) || (x < S - 1 && backdrop[idx + 1]) ||
        (y > 0 && backdrop[idx - S]) || (y < S - 1 && backdrop[idx + S]);
      if (!touchesBackdrop) continue;
      // 向内 2px 邻域里最不白的一个像素视为主体色（圆角处过渡是从背景色到主体色）
      let inside = -1, insideScore = -1;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
          const ni = ny * S + nx;
          if (backdrop[ni]) continue;
          const p = ni * 4;
          const score =
            Math.abs(data[p] - bgColor[0]) + Math.abs(data[p + 1] - bgColor[1]) + Math.abs(data[p + 2] - bgColor[2]);
          if (score > insideScore) { insideScore = score; inside = ni; }
        }
      }
      if (inside < 0) { data[i4 + 3] = 0; strippedPixels++; continue; }
      const b4 = inside * 4;
      let numerator = 0, denominator = 0;
      for (let k = 0; k < 3; k++) {
        const span = bgColor[k] - data[b4 + k];
        // 跨度太小的通道噪声大，跳过（背景本身近似灰白，主体色至少有一个通道跨度大）
        if (Math.abs(span) <= 24) continue;
        numerator += bgColor[k] - data[i4 + k];
        denominator += span;
      }
      const alpha = denominator !== 0 ? Math.max(0, Math.min(1, numerator / denominator)) : 1;
      data[i4] = data[b4];
      data[i4 + 1] = data[b4 + 1];
      data[i4 + 2] = data[b4 + 2];
      data[i4 + 3] = Math.round(alpha * 255);
      featherPixels++;
    }
  }
  // 把去底后的像素写回画布（后面裁切与遮罩都从这份画布取，而不是原图）
  ctx.putImageData(new ImageData(data, S, S), 0, 0);

  // 包围盒改为按 alpha 判定（去底后背景 alpha 已是 0）
  let minX = S, minY = S, maxX = 0, maxY = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (data[(y * S + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const side = Math.max(maxX - minX + 1, maxY - minY + 1);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = Math.round(cx - side / 2), sy = Math.round(cy - side / 2);

  // 圆角遮罩（Windows 11 风格圆角比例 22.5%）
  const radius = Math.round(side * 0.225);
  const master = document.createElement("canvas");
  master.width = S;
  master.height = S;
  const m = master.getContext("2d");
  const r = radius, w = S, h = S;
  m.beginPath();
  m.moveTo(r, 0);
  m.lineTo(w - r, 0);
  m.arcTo(w, 0, w, r, r);
  m.lineTo(w, h - r);
  m.arcTo(w, h, w - r, h, r);
  m.lineTo(r, h);
  m.arcTo(0, h, 0, h - r, r);
  m.lineTo(0, r);
  m.arcTo(0, 0, r, 0, r);
  m.closePath();
  m.clip();
  m.drawImage(c, sx, sy, side, side, 0, 0, S, S);

  // 逐级减半降采样，避免一次缩小的锯齿
  function scaleTo(target) {
    let cur = master;
    let curSize = S;
    while (Math.floor(curSize / 2) >= target) {
      const half = document.createElement("canvas");
      half.width = half.height = Math.floor(curSize / 2);
      const hctx = half.getContext("2d");
      hctx.imageSmoothingEnabled = true;
      hctx.imageSmoothingQuality = "high";
      hctx.drawImage(cur, 0, 0, half.width, half.height);
      cur = half;
      curSize = half.width;
    }
    if (curSize === target) return cur.toDataURL("image/png");
    const out = document.createElement("canvas");
    out.width = out.height = target;
    const octx = out.getContext("2d");
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(cur, 0, 0, target, target);
    return out.toDataURL("image/png");
  }

  const sizes = {};
  for (const t of [512, 256, 128, 64, 48, 32, 24, 16]) sizes[t] = scaleTo(t);
  // 产物自检：在 512 帧上统计「贴着透明区的不透明近白像素」——这就是用户看到的白边
  const out = document.createElement("canvas");
  out.width = out.height = 512;
  const octx = out.getContext("2d", { willReadFrequently: true });
  const png = new Image();
  png.src = sizes[512];
  await png.decode();
  octx.drawImage(png, 0, 0);
  const px = octx.getImageData(0, 0, 512, 512).data;
  let whiteEdge = 0;
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      const i4 = (y * 512 + x) * 4;
      if (px[i4 + 3] < 200 || px[i4] < 230 || px[i4 + 1] < 230 || px[i4 + 2] < 230) continue;
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= 512 || ny >= 512) continue;
          if (px[(ny * 512 + nx) * 4 + 3] === 0) { edge = true; break; }
        }
      }
      if (edge) whiteEdge++;
    }
  }
  return {
    master: master.toDataURL("image/png"),
    sizes,
    bbox: { minX, minY, maxX, maxY, side },
    backdrop: { color: bgColor.map((v) => Math.round(v)), strippedPixels, featherPixels, whiteEdge },
  };
}

function dataUrlToBuffer(u) {
  return Buffer.from(u.slice(u.indexOf(",") + 1), "base64");
}

/** 组装 PNG 压缩条目的 ICO（Vista+ 标准） */
function buildIco(sizes) {
  const chain = [256, 128, 64, 48, 32, 24, 16].map((s) => ({ s, png: dataUrlToBuffer(sizes[s]) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(chain.length, 4);
  let offset = 6 + 16 * chain.length;
  const dirs = chain.map((e) => {
    const b = Buffer.alloc(16);
    b.writeUInt8(e.s === 256 ? 0 : e.s, 0);
    b.writeUInt8(e.s === 256 ? 0 : e.s, 1);
    b.writeUInt16LE(1, 4); // planes
    b.writeUInt16LE(32, 6); // bpp
    b.writeUInt32LE(e.png.length, 8);
    b.writeUInt32LE(offset, 12);
    offset += e.png.length;
    return b;
  });
  return Buffer.concat([header, ...dirs, ...chain.map((e) => e.png)]);
}

app.whenReady().then(async () => {
  try {
    const buf = await readFile(source);
    const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    const win = new BrowserWindow({ show: false, width: 400, height: 300 });
    await win.loadURL("about:blank");
    const result = await win.webContents.executeJavaScript(`(${pageTask.toString()})(${JSON.stringify(dataUrl)})`);
    console.log("[icon] bbox =", JSON.stringify(result.bbox));
    console.log("[icon] backdrop =", JSON.stringify(result.backdrop));
    if (result.backdrop && result.backdrop.whiteEdge > 0) {
      console.error(`[icon] 警告：512 帧仍有 ${result.backdrop.whiteEdge} 个贴边近白像素（白边未清干净）`);
    }
    await mkdir(path.join(root, "build"), { recursive: true });
    await mkdir(path.join(root, "src/main/assets"), { recursive: true });
    await writeFile(path.join(root, "build/icon-master.png"), dataUrlToBuffer(result.master));
    await writeFile(path.join(root, "build/icon.png"), dataUrlToBuffer(result.sizes[512]));
    await writeFile(path.join(root, "build/icon.ico"), buildIco(result.sizes));
    await writeFile(path.join(root, "src/main/assets/icon.ico"), buildIco(result.sizes));
    console.log("[icon] done: build/icon-master.png, build/icon.png, build/icon.ico, src/main/assets/icon.ico");
    app.exit(0);
  } catch (err) {
    console.error("[icon] failed:", err);
    app.exit(1);
  }
});
