import type { AppearanceBlurMode } from "../../../shared/protocol.js";

/**
 * 图形能力档位（2026-11-11，用户报「内网 8C16G 2.6GHz 虚拟机打开设置页特别卡、滚动也卡」）。
 *
 * 实测结论（生产构建、窗口 1424×881、`--disable-gpu` 模拟虚拟机软件渲染）：
 *
 * | 场景 | 设置页滚动 | 首次打开设置页 |
 * | --- | --- | --- |
 * | 默认外观（无壁纸） | 75fps | 427ms（2× CPU 节流） |
 * | 带壁纸主题 | **11~13fps** | 642ms（2× CPU 节流） |
 * | 带壁纸主题 + 关闭 backdrop-filter | **38~57fps** | 460ms |
 * | 带壁纸主题 + 有硬件 GPU | 63fps | — |
 *
 * LoAF 采样里 `styleAndLayout` 只占 13ms / 9402ms ⇒ 成本全在合成与光栅（不是 React、
 * 不是布局）。逐项 A/B 也把其它嫌疑排除了：去掉 `background-attachment: fixed` 无变化、
 * 隐藏壁纸图层无变化、只禁主题 `filter` 无变化——**`backdrop-filter` 是唯一主因**
 * （弹窗自身 blur 占一半，弹窗背后 sidebar/topbar/composer 的 blur 占另一半）。
 *
 * 因此降级策略是「无硬件加速时不启用毛玻璃」，判据取 WebGL 的 unmasked renderer
 * 字符串：虚拟机/远程桌面下 Chromium 会落在 WARP（Microsoft Basic Render Driver）
 * 或 SwiftShader/llvmpipe 上，这三类都能稳定匹配。
 *
 * 为什么不读 `app.getGPUFeatureStatus()`：实测在窗口显示前后/无窗口时它都可能返回
 * `disabled_software`（本机有 AMD 独显也是如此），不可作为判据。
 */

/** 软件渲染的 renderer 字样（大小写不敏感，覆盖 WARP / SwiftShader / Mesa 软管）。 */
const SOFTWARE_RENDERER_PATTERN = /swiftshader|basic render driver|llvmpipe|softpipe|software\s*(?:rasterizer|rendering)|microsoft basic|mesa offscreen|gallium\s*\(?\s*softpipe/i;

/**
 * 判断 WebGL renderer 字符串是否为软件渲染。
 *
 * 空值/未知一律返回 false（**不降级**）：宁可让罕见环境保留毛玻璃，也不要因为
 * 读不到 renderer 就无差别摘掉视觉——用户仍可用 `appearance.blur = "off"` 手动关。
 */
export function isSoftwareRenderer(renderer: string | null | undefined): boolean {
  if (typeof renderer !== "string" || !renderer.trim()) return false;
  return SOFTWARE_RENDERER_PATTERN.test(renderer);
}

/**
 * 读 WebGL 的 unmasked renderer 字符串（诊断 + 检测共用）。
 * 任何异常/不可用都返回 undefined（调用方按「未检测到」处理）。
 */
export function readWebglRenderer(doc: Document = document): string | undefined {
  try {
    const canvas = doc.createElement("canvas");
    const context = canvas.getContext("webgl") as WebGLRenderingContext | null;
    if (!context) return undefined;
    const extension = context.getExtension("WEBGL_debug_renderer_info");
    const value = extension
      ? context.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : context.getParameter(context.RENDERER);
    // 立即释放上下文：检测只做一次，没有理由让一个 GPU 上下文长驻。
    context.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 三态 → 是否启用毛玻璃。`auto` 由检测结果决定，`on`/`off` 是用户强制。
 * 缺省（undefined）等价 `auto`。
 */
export function resolveBlurEnabled(mode: AppearanceBlurMode | undefined, softwareRendering: boolean): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return !softwareRendering;
}
