// 单图降采样（图片请求体积治理的第一层）。
//
// 复用 Pi 已导出的 resizeImage（内部走 photon wasm + worker 线程，不阻塞主
// 线程），把超过 IMAGE_PER_IMAGE_BYTES 的图压到 ≤1.5MB / ≤1600px。实测：
// 2.28MB PNG → 850ms 产出 386KB，且**两次调用输出字节完全一致**（sha256 相同），
// 因此压缩结果可以安全缓存、也能进入稳定前缀；未超限的小图走光子内部短路
// （3.9KB 图 77ms，wasResized:false）。
//
// LRU 按「原图 base64 的 sha256」缓存压缩结果：同一张图在会话生命周期内只压
// 一次（截图/生成图经常被模型在后续轮次反复 read）。容量按条目与总字节双限，
// 先到者为准，避免缓存本身变成内存泄漏。

import { createHash } from "node:crypto";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  IMAGE_DOWNSAMPLE_MIN_BYTES,
  IMAGE_MAX_DIMENSION,
  IMAGE_PER_IMAGE_BYTES,
  type DownsampleResult
} from "./request-image-budget.js";

/** 缓存条目上限（张）。 */
export const DOWNSAMPLE_CACHE_MAX_ENTRIES = 64;
/** 缓存总字节上限（压缩后 base64 文本量）。 */
export const DOWNSAMPLE_CACHE_MAX_BYTES = 32 * 1024 * 1024;

interface CacheEntry {
  result: DownsampleResult;
}

/**
 * 单图压缩器：LRU 缓存 + Pi resizeImage。构造时注入参数便于单测替身；
 * 生产路径用 {@link createImageDownsampler} 的默认值。
 */
export function createImageDownsampler(options: {
  /** 压缩实现；缺省用 Pi 的 resizeImage（测试注入假件）。 */
  resize?: (image: ImageContent) => Promise<DownsampleResult | undefined>;
  maxEntries?: number;
  maxBytes?: number;
} = {}): (image: ImageContent) => Promise<DownsampleResult | undefined> {
  const maxEntries = options.maxEntries ?? DOWNSAMPLE_CACHE_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DOWNSAMPLE_CACHE_MAX_BYTES;
  const resize = options.resize ?? defaultResize;
  // Map 的插入序即 LRU 序：命中时删除再插入，超限时删除最早插入的。
  const cache = new Map<string, CacheEntry>();
  let cachedBytes = 0;

  return async (image: ImageContent): Promise<DownsampleResult | undefined> => {
    const key = createHash("sha256").update(image.data).digest("hex");
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.result;
    }
    const result = await resize(image);
    if (!result) return undefined;
    cache.set(key, { result });
    cachedBytes += result.data.length;
    while (cache.size > maxEntries || (cachedBytes > maxBytes && cache.size > 1)) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      const evicted = cache.get(oldest.value);
      cache.delete(oldest.value);
      if (evicted) cachedBytes -= evicted.result.data.length;
    }
    return result;
  };
}

/** 缺省压缩实现：只对超限图片调 Pi resizeImage，未超限原样返回。 */
async function defaultResize(image: ImageContent): Promise<DownsampleResult | undefined> {
  if (image.data.length <= IMAGE_DOWNSAMPLE_MIN_BYTES) return { data: image.data, mimeType: image.mimeType };
  try {
    const result = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, {
      maxWidth: IMAGE_MAX_DIMENSION,
      maxHeight: IMAGE_MAX_DIMENSION,
      maxBytes: IMAGE_PER_IMAGE_BYTES
    });
    if (!result) return undefined;
    // 压缩反而变大（极小图 + 编码开销）时保留原图，绝不让请求体长胖。
    if (result.data.length >= image.data.length) return { data: image.data, mimeType: image.mimeType };
    return { data: result.data, mimeType: result.mimeType };
  } catch {
    return undefined;
  }
}
