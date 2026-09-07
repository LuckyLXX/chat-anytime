/**
 * 预览面板设备视口（浏览器预览 + HTML 工件预览共用）：设备宽度预设与
 * 适应窗口/原始尺寸的纯布局计算。浏览器侧把设备框矩形作为 native
 * WebContentsView 的 bounds、超宽时以 zoom factor 等比缩小；HTML 侧用
 * CSS transform 缩放 iframe。两侧共享同一套预设与换算，保证观感一致。
 */

export type PreviewDeviceId = "responsive" | "desktop" | "tablet" | "phone";

export interface PreviewDevicePreset {
  id: PreviewDeviceId;
  label: string;
  /** 设备 CSS 宽度；responsive 不限宽（填满容器）。 */
  width: number;
}

export const PREVIEW_DEVICE_PRESETS: readonly PreviewDevicePreset[] = [
  { id: "responsive", label: "自适应", width: 0 },
  { id: "desktop", label: "桌面", width: 1440 },
  { id: "tablet", label: "平板", width: 768 },
  { id: "phone", label: "手机", width: 390 }
];

export function previewDevicePreset(id: PreviewDeviceId): PreviewDevicePreset {
  return PREVIEW_DEVICE_PRESETS.find((preset) => preset.id === id) ?? { id: "responsive", label: "自适应", width: 0 };
}

export interface DeviceFrameLayout {
  /** 设备框可视宽度（已含缩放）。 */
  frameWidth: number;
  /** 设备框可视高度（= 容器高；设备内页面自身滚动）。 */
  frameHeight: number;
  /** 框内内容的 CSS 像素宽（缩放前）。 */
  contentWidth: number;
  /** 框内内容的 CSS 像素高（缩放前；scale<1 时大于可视高）。 */
  contentHeight: number;
  /** 缩放系数（1 = 原始尺寸）。 */
  scale: number;
  /** 相对容器左缘的居中偏移（溢出时为 0，由容器滚动）。 */
  offsetX: number;
  /** 设备宽度是否完整可见（false = 超出容器被裁剪/需滚动）。 */
  fitsWidth: boolean;
}

/**
 * 计算设备框在容器内的布局。
 * - responsive：填满容器；fit 时若实测内容更宽（多画板导出页等），视口放宽到
 *   内容宽并整体缩小到完整可见。
 * - 设备预设 + fit（适应窗口）：视口宽 = max(预设宽, 实测内容宽)，超宽部分
 *   按容器/视口比缩小到完整可见；窄于容器不放大（scale 封顶 1），框居中。
 * - 非 fit（原始尺寸 1:1）：scale=1，忽略实测宽度（诚实展示溢出：浏览器
 *   clampWidth 封顶容器宽，HTML iframe 交给容器滚动）。
 * contentWidth 是沙箱内上报/主进程量测的页面 scrollWidth（可选；0/缺省视为未知）。
 */
export function layoutDeviceFrame(
  container: { width: number; height: number },
  presetId: PreviewDeviceId,
  options: { fit: boolean; clampWidth: boolean; contentWidth?: number }
): DeviceFrameLayout {
  const width = Math.max(0, Math.round(container.width));
  const height = Math.max(0, Math.round(container.height));
  const preset = previewDevicePreset(presetId);
  if (width <= 0 || height <= 0) {
    return { frameWidth: width, frameHeight: height, contentWidth: width, contentHeight: height, scale: 1, offsetX: 0, fitsWidth: true };
  }
  const measured = options.contentWidth && options.contentWidth > 0 ? Math.ceil(options.contentWidth) : 0;
  if (options.fit) {
    const baseWidth = preset.id === "responsive" ? width : preset.width;
    const viewportWidth = Math.max(baseWidth, measured);
    const scale = Math.min(1, width / viewportWidth);
    if (scale < 1) {
      return { frameWidth: width, frameHeight: height, contentWidth: viewportWidth, contentHeight: height / scale, scale, offsetX: 0, fitsWidth: true };
    }
    if (preset.id === "responsive") {
      return { frameWidth: width, frameHeight: height, contentWidth: width, contentHeight: height, scale: 1, offsetX: 0, fitsWidth: true };
    }
    const frameWidth = options.clampWidth ? Math.min(preset.width, width) : preset.width;
    return {
      frameWidth,
      frameHeight: height,
      contentWidth: frameWidth,
      contentHeight: height,
      scale: 1,
      offsetX: Math.max(0, Math.round((width - frameWidth) / 2)),
      fitsWidth: preset.width <= width
    };
  }
  if (preset.id === "responsive") {
    return { frameWidth: width, frameHeight: height, contentWidth: width, contentHeight: height, scale: 1, offsetX: 0, fitsWidth: true };
  }
  const frameWidth = options.clampWidth ? Math.min(preset.width, width) : preset.width;
  return {
    frameWidth,
    frameHeight: height,
    contentWidth: frameWidth,
    contentHeight: height,
    scale: 1,
    offsetX: Math.max(0, Math.round((width - frameWidth) / 2)),
    fitsWidth: preset.width <= width
  };
}

const DEVICE_STORAGE_KEY = "pidesktop.preview-device";
const FIT_STORAGE_KEY = "pidesktop.preview-fit";

function isPreviewDeviceId(value: string | null): value is PreviewDeviceId {
  return value === "responsive" || value === "desktop" || value === "tablet" || value === "phone";
}

/** 上次选择的设备视口（浏览器/HTML 预览共用一份偏好）。 */
export function storedPreviewDevice(): PreviewDeviceId {
  try {
    const value = window.localStorage.getItem(DEVICE_STORAGE_KEY);
    return isPreviewDeviceId(value) ? value : "responsive";
  } catch {
    return "responsive";
  }
}

export function storePreviewDevice(id: PreviewDeviceId): void {
  try { window.localStorage.setItem(DEVICE_STORAGE_KEY, id); } catch { /* storage may be unavailable */ }
}

/** 适应窗口开关（缺省开：超宽页面默认缩放到完整可见）。 */
export function storedPreviewFit(): boolean {
  try {
    return window.localStorage.getItem(FIT_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

export function storePreviewFit(fit: boolean): void {
  try { window.localStorage.setItem(FIT_STORAGE_KEY, fit ? "1" : "0"); } catch { /* storage may be unavailable */ }
}
