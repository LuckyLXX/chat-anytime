// 从选定的生图稿生成应用图标资产：
//   build/icon-master.png  2048 母版（透明圆角）
//   build/icon.png         512 通用 PNG
//   build/icon.ico         多尺寸 ICO（256/128/64/48/32/24/16，PNG 压缩条目）
// 用法：npx electron scripts/generate-icon-assets.mjs <源PNG路径>
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
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, S, S).data;

  // 以左上角 (5,5) 采样背景色，扫描主体包围盒
  const bi = (5 * S + 5) * 4;
  const br = data[bi], bg = data[bi + 1], bb = data[bi + 2];
  let minX = S, minY = S, maxX = 0, maxY = 0;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      if (data[i + 3] > 10 && Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) > 60) {
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
  m.drawImage(img, sx, sy, side, side, 0, 0, S, S);

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
  return { master: master.toDataURL("image/png"), sizes, bbox: { minX, minY, maxX, maxY, side } };
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
