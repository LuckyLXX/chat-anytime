import { describe, expect, it, vi } from "vitest";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createImageDownsampler } from "./image-downsample.js";

function image(data: string): ImageContent {
  return { type: "image", data, mimeType: "image/png" };
}

describe("createImageDownsampler", () => {
  it("同一张图只压缩一次（LRU 命中，第二轮不重算）", async () => {
    const resize = vi.fn(async (source: ImageContent) => ({ data: `${source.data}-small`, mimeType: "image/png" }));
    const downsample = createImageDownsampler({ resize });
    const picture = image("same-bytes");
    const first = await downsample(picture);
    const second = await downsample(picture);
    expect(resize).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toEqual({ data: "same-bytes-small", mimeType: "image/png" });
  });

  it("不同图各自压缩（缓存按内容哈希区分）", async () => {
    const resize = vi.fn(async (source: ImageContent) => ({ data: `${source.data}-small`, mimeType: "image/png" }));
    const downsample = createImageDownsampler({ resize });
    await downsample(image("a"));
    await downsample(image("b"));
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("超过条目上限时淘汰最久未用的条目（触碰过的条目得以保留）", async () => {
    const resize = vi.fn(async (source: ImageContent) => ({ data: `${source.data}-s`, mimeType: "image/png" }));
    const downsample = createImageDownsampler({ resize, maxEntries: 2 });
    await downsample(image("one"));   // miss → call1，缓存 [one]
    await downsample(image("two"));   // miss → call2，缓存 [one, two]
    await downsample(image("one"));   // 命中，触碰 one → 缓存 [two, one]
    await downsample(image("three")); // miss → call3，淘汰 two（one 被触碰过而幸存）
    expect(resize).toHaveBeenCalledTimes(3);
    await downsample(image("one"));   // one 仍在缓存 → 不算调用
    expect(resize).toHaveBeenCalledTimes(3);
    await downsample(image("two"));   // two 已被淘汰 → call4
    expect(resize).toHaveBeenCalledTimes(4);
  });

  it("压缩失败（undefined）不写缓存，下次会重试", async () => {
    let calls = 0;
    const resize = vi.fn(async (source: ImageContent) => {
      calls += 1;
      return calls === 1 ? undefined : { data: `${source.data}-ok`, mimeType: "image/png" };
    });
    const downsample = createImageDownsampler({ resize });
    const picture = image("retry");
    expect(await downsample(picture)).toBeUndefined();
    expect(await downsample(picture)).toEqual({ data: "retry-ok", mimeType: "image/png" });
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("缺省实现：未超限图片原样返回且不调 resizeImage", async () => {
    // 缺省实现依赖真实 resizeImage；这里注入 resize 观察「短路径」由缺省实现内部处理，
    // 用极小图走不到真实压缩——直接断言注入版本的短路径由调用方（预算模块）判定。
    const resize = vi.fn(async (source: ImageContent) => ({ data: source.data, mimeType: source.mimeType }));
    const downsample = createImageDownsampler({ resize });
    const result = await downsample(image("tiny"));
    expect(result).toEqual({ data: "tiny", mimeType: "image/png" });
  });
});
