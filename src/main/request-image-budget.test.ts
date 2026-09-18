import { describe, expect, it, vi } from "vitest";
import type { Context, ImageContent, Message } from "@earendil-works/pi-ai";
import {
  applyImageBudget,
  base64Bytes,
  estimateContextTextBytes,
  estimateUtf8Bytes,
  imageBudgetForContext,
  imagePixelSize,
  GATEWAY_BODY_LIMIT_BYTES,
  IMAGE_DOWNSAMPLE_MIN_BYTES,
  IMAGE_MIN_BUDGET_BYTES,
  IMAGE_TOTAL_BUDGET_BYTES,
  placeholderText,
  resolveImagePath,
  type DownsampleResult
} from "./request-image-budget.js";

/** 造一张「base64 长度 = bytes」的假图（内容可辨以生成不同哈希）。 */
function fakeImage(bytes: number, seed = "a", mimeType = "image/png"): ImageContent {
  const payload = seed.repeat(Math.ceil(bytes / seed.length)).slice(0, bytes);
  return { type: "image", data: payload, mimeType };
}

function userMessage(images: ImageContent[], text = "看一下"): Message {
  return { role: "user", content: [{ type: "text", text }, ...images], timestamp: 1 };
}

function toolResultMessage(toolCallId: string, images: ImageContent[], savedPath?: string): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "browser_screenshot",
    content: [{ type: "text", text: "已截取" }, ...images],
    ...(savedPath ? { details: { savedPath } } : {}),
    isError: false,
    timestamp: 1
  };
}

function assistantWithToolCall(id: string, path: string): Message {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 1
  } as unknown as Message;
}

function context(messages: Message[]): Context {
  return { messages };
}

/** 默认假压缩器：把图压到原有 1/10，方便断言「发生压缩」而不依赖真实 photon。 */
type DownsampleFn = (image: ImageContent) => Promise<DownsampleResult | undefined>;

function fakeDownsample(): ReturnType<typeof vi.fn<DownsampleFn>> {
  return vi.fn<DownsampleFn>(async (image) => ({
    data: image.data.slice(0, Math.max(1, Math.floor(image.data.length / 10))),
    mimeType: image.mimeType
  }));
}

interface BudgetHarness {
  downsample: ReturnType<typeof fakeDownsample>;
  warn: (message: string) => void;
  warnings: string[];
}

function deps(downsample: ReturnType<typeof fakeDownsample> = fakeDownsample()): BudgetHarness {
  const warnings: string[] = [];
  return { downsample, warn: (message: string) => { warnings.push(message); }, warnings };
}

describe("applyImageBudget · 热路径", () => {
  it("无图片时返回同一 context 引用，不调用压缩", async () => {
    const d = deps();
    const source = context([userMessage([], "纯文本")]);
    const { context: result, stats } = await applyImageBudget(source, d);
    expect(result).toBe(source);
    expect(d.downsample).not.toHaveBeenCalled();
    expect(stats.imagesTotal).toBe(0);
  });

  it("未超预算时返回同一引用且图片原样", async () => {
    const d = deps();
    const image = fakeImage(1000);
    const source = context([userMessage([image])]);
    const { context: result, stats } = await applyImageBudget(source, d);
    expect(result).toBe(source);
    expect(d.downsample).not.toHaveBeenCalled();
    expect(stats.bytesBefore).toBe(stats.bytesAfter);
    expect(stats.imagesDownsampled).toBe(0);
    expect(stats.imagesOmitted).toBe(0);
  });
});

describe("applyImageBudget · 单图超限", () => {
  it("超预算时大图触发压缩，压缩结果进入结果且统计正确", async () => {
    const d = deps();
    // 5 张 1.5MB 图 = 7.5MB > 6MB 预算；假压缩器压到 1/10 → 全部保留。
    const images = Array.from({ length: 5 }, (_, index) => fakeImage(IMAGE_DOWNSAMPLE_MIN_BYTES + 1000, `big${String(index)}`));
    const source = context([userMessage(images)]);
    const { context: result, stats } = await applyImageBudget(source, d);
    expect(d.downsample).toHaveBeenCalledTimes(5);
    expect(stats.imagesDownsampled).toBe(5);
    expect(stats.imagesOmitted).toBe(0);
    const content = (result.messages[0] as { content: Array<{ type: string; data?: string }> }).content;
    const imageParts = content.filter((part) => part.type === "image");
    expect(imageParts).toHaveLength(5);
    for (const part of imageParts) expect(part.data!.length).toBeLessThan(IMAGE_DOWNSAMPLE_MIN_BYTES);
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
  });

  it("小图不触发压缩", async () => {
    const d = deps();
    const source = context([userMessage([fakeImage(100_000)])]);
    await applyImageBudget(source, d);
    expect(d.downsample).not.toHaveBeenCalled();
  });
});

describe("applyImageBudget · 总量超预算", () => {
  it("保留最新、省略最旧，且占位符是文本块", async () => {
    const d = deps();
    // 8 张 1MB 图 = 8MB > 6MB。压缩器压到 1/10（0.1MB/张），于是本可全保留；
    // 用「不压缩」的假件以验证纯预算路径：压不动的大图才会被省略。
    const noop = vi.fn(async (image: ImageContent) => ({ data: image.data, mimeType: image.mimeType }));
    const images = Array.from({ length: 8 }, (_, index) => fakeImage(1024 * 1024, `s${String(index)}`));
    const source = context([userMessage(images)]);
    const { context: result, stats } = await applyImageBudget(source, { ...d, downsample: noop });
    // 预算 6MB、每张 1MB → 保留最新 6 张，省略最旧 2 张。
    expect(stats.imagesOmitted).toBe(2);
    expect(stats.imagesTotal).toBe(8);
    const content = (result.messages[0] as { content: Array<{ type: string; text?: string; data?: string }> }).content;
    const imageParts = content.filter((part) => part.type === "image");
    const textParts = content.filter((part) => part.type === "text");
    expect(imageParts).toHaveLength(6);
    // 被省略的是最旧的两张：它们变成文本块（含占位符标记）。
    const placeholders = textParts.filter((part) => part.text?.includes("图片已省略"));
    expect(placeholders).toHaveLength(2);
    // 最新的图仍然留在原位（数组尾部两张是 image，头部两张是占位符）。
    expect(content[1]!.type).toBe("text");
    expect(content[1]!.text).toContain("图片已省略");
    expect(content[2]!.type).toBe("text");
    expect(content[content.length - 1]!.type).toBe("image");
  });

  it("同一条消息里部分压缩保留、部分省略（双 Map 同时命中）", async () => {
    // 造一张压得动的大图、一张压不动的超大图（省略）、一张小图（原样保留）。
    const downsample = vi.fn(async (image: ImageContent): Promise<DownsampleResult | undefined> => {
      if (image.data.startsWith("cannot")) return undefined; // 模拟压制失败
      return { data: image.data.slice(0, 100), mimeType: image.mimeType };
    });
    const compressible = fakeImage(2 * 1024 * 1024, "a"); // 压得动
    const uncompressible = fakeImage(7 * 1024 * 1024, "cannot"); // 压不动（7MB > 6MB 预算）
    const small = fakeImage(1000, "c"); // 小图
    const source = context([userMessage([uncompressible, compressible, small])]);
    const { context: result, stats } = await applyImageBudget(source, deps(downsample));
    expect(stats.imagesOmitted).toBe(1);
    expect(stats.imagesDownsampled).toBe(1); // 2MB 的那张
    const content = (result.messages[0] as { content: Array<{ type: string; data?: string; text?: string }> }).content;
    // 最旧的 unmcompressible 被省略；压缩后的保留；小图原样。
    expect(content[1]!.type).toBe("text");
    expect(content[1]!.text).toContain("图片已省略");
    expect(content[2]!.type).toBe("image");
    expect(content[2]!.data!.length).toBe(100);
    expect(content[3]!.type).toBe("image");
    expect(content[3]!.data).toBe(small.data);
  });

  it("省略的图片不越过未受影响消息生成新对象（零拷贝）", async () => {
    const noop = vi.fn(async (image: ImageContent) => ({ data: image.data, mimeType: image.mimeType }));
    const old = toolResultMessage("c1", [fakeImage(4 * 1024 * 1024, "old")]);
    const textOnly = userMessage([], "中间消息");
    const fresh = toolResultMessage("c2", [fakeImage(4 * 1024 * 1024, "new")]);
    const source = context([old, textOnly, fresh]);
    const { context: result } = await applyImageBudget(source, deps(noop));
    // 中间纯文本消息保持原引用。
    expect(result.messages[1]).toBe(textOnly);
    // 合计 8MB > 6MB → 最旧的整条消息替换为占位符；最新的保留。
    expect((result.messages[2] as { content: Array<{ type: string }> }).content.some((part) => part.type === "image")).toBe(true);
  });
});

describe("applyImageBudget · 占位符稳定性", () => {
  it("同一张图两次裁剪产生逐字节相同的占位符", async () => {
    const noop = () => Promise.resolve(undefined);
    const image = fakeImage(4 * 1024 * 1024, "stable");
    const build = (): Context => context([
      toolResultMessage("c1", [image], ".pidesktop/screenshots/x.png"),
      toolResultMessage("c2", [fakeImage(4 * 1024 * 1024, "newer")], ".pidesktop/screenshots/y.png")
    ]);
    const first = await applyImageBudget(build(), deps(vi.fn(noop)));
    const second = await applyImageBudget(build(), deps(vi.fn(noop)));
    const textOf = (ctx: Context): string => ((ctx.messages[0] as { content: Array<{ type: string; text?: string }> }).content.find((part) => part.type === "text" && part.text?.includes("图片已省略"))?.text) ?? "";
    expect(textOf(first.context)).toBe(textOf(second.context));
    expect(textOf(first.context)).not.toBe("");
  });

  it("占位符不携带省略张数（跨图状态会让缓存整段失效）", () => {
    const image = fakeImage(1000, "z");
    const text = placeholderText(image, { path: "a.png" });
    expect(text).not.toMatch(/省略 \d+ 张/);
    expect(placeholderText(image, { path: "a.png" })).toBe(text);
  });

  it("不同图片的占位符不同（短哈希兜底）", () => {
    const a = placeholderText(fakeImage(1000, "aaa"), {});
    const b = placeholderText(fakeImage(1000, "bbb"), {});
    expect(a).not.toBe(b);
    expect(a).toContain("内容标识");
  });
});

describe("resolveImagePath", () => {
  it("优先 details.savedPath", () => {
    const message = toolResultMessage("c1", [], ".pidesktop/screenshots/a.png");
    expect(resolveImagePath(context([message]), message)).toBe(".pidesktop/screenshots/a.png");
  });

  it("回退到配对 toolCall 的 path", () => {
    const assistant = assistantWithToolCall("call-1", "outputs/fox.png");
    const message = toolResultMessage("call-1", []);
    expect(resolveImagePath(context([assistant, message]), message)).toBe("outputs/fox.png");
  });

  it("都没有时返回 undefined（用短哈希兜底）", () => {
    const message = userMessage([fakeImage(10)]);
    expect(resolveImagePath(context([message]), message)).toBeUndefined();
  });
});

describe("applyImageBudget · fail-open", () => {
  it("压缩器抛错时按原样返回 context，并记一条警告", async () => {
    const d = deps();
    d.downsample.mockRejectedValue(new Error("photon 炸了"));
    // 总量必须超预算才会进入压缩路径（热路径本就不调压缩器）。
    const images = Array.from({ length: 5 }, (_, index) => fakeImage(IMAGE_DOWNSAMPLE_MIN_BYTES + 1000, `fail${String(index)}`));
    const source = context([userMessage(images)]);
    const { context: result, stats } = await applyImageBudget(source, d);
    expect(result).toBe(source);
    expect(stats.bytesAfter).toBe(stats.bytesBefore);
    expect(d.warnings.some((message) => message.includes("按原样发送"))).toBe(true);
  });

  it("压缩返回 undefined 时该图保留原样，其余图照常处理", async () => {
    const d = deps();
    d.downsample.mockResolvedValue(undefined);
    // 最新一张 5MB（压缩失败）无条件保留；更旧的 3MB 因超预算被省略。
    const older = fakeImage(3 * 1024 * 1024, "older");
    const newest = fakeImage(5 * 1024 * 1024, "newest");
    const source = context([userMessage([older, newest])]);
    const { context: result, stats } = await applyImageBudget(source, d);
    expect(stats.imagesDownsampled).toBe(0);
    const content = (result.messages[0] as { content: Array<{ type: string; data?: string; text?: string }> }).content;
    const imageParts = content.filter((part) => part.type === "image");
    expect(imageParts).toHaveLength(1);
    expect(imageParts[0]!.data).toBe(newest.data);
    expect(stats.imagesOmitted).toBe(1);
  });
});

describe("imagePixelSize", () => {
  function pngHeader(width: number, height: number): string {
    const buffer = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer.toString("base64");
  }

  function jpegHeader(width: number, height: number): string {
    const buffer = Buffer.alloc(20);
    buffer.writeUInt16BE(0xffd8, 0); // SOI
    buffer.writeUInt16BE(0xffc0, 2); // SOF0
    buffer.writeUInt16BE(17, 4); // segment length
    buffer[6] = 8; // precision
    buffer.writeUInt16BE(height, 7);
    buffer.writeUInt16BE(width, 9);
    return buffer.toString("base64");
  }

  it("解析 PNG IHDR", () => {
    expect(imagePixelSize(pngHeader(1586, 992), "image/png")).toEqual({ width: 1586, height: 992 });
  });

  it("解析 JPEG SOF0", () => {
    expect(imagePixelSize(jpegHeader(640, 480), "image/jpeg")).toEqual({ width: 640, height: 480 });
  });

  it("非法数据返回 undefined 而不抛错", () => {
    expect(imagePixelSize("not-base64!!!", "image/png")).toBeUndefined();
    expect(imagePixelSize("", "image/jpeg")).toBeUndefined();
    expect(imagePixelSize("QUJD", "image/png")).toBeUndefined();
  });
});

describe("base64Bytes", () => {
  it("按 base64 文本长度计（请求体的膨胀源）", () => {
    expect(base64Bytes("abcd")).toBe(4);
    expect(base64Bytes("")).toBe(0);
  });
});

describe("预算阈值", () => {
  it("总量预算小于网关 8MB 上限，留出文本余量", () => {
    expect(IMAGE_TOTAL_BUDGET_BYTES).toBeLessThan(GATEWAY_BODY_LIMIT_BYTES);
    expect(IMAGE_TOTAL_BUDGET_BYTES).toBeGreaterThan(4 * 1024 * 1024);
  });

  it("压缩触发阈值与单图目标一致（压了也不会更小）", () => {
    expect(IMAGE_DOWNSAMPLE_MIN_BYTES).toBe(1.5 * 1024 * 1024);
  });
});

describe("estimateUtf8Bytes", () => {
  it("ASCII 按 1 字节、CJK 按 3 字节、emoji 按 4 字节", () => {
    expect(estimateUtf8Bytes("abc")).toBe(3);
    expect(estimateUtf8Bytes("中文")).toBe(6);
    expect(estimateUtf8Bytes("😀")).toBe(4);
    expect(estimateUtf8Bytes("")).toBe(0);
  });
});

describe("imageBudgetForContext（自适应预算）", () => {
  it("文本小时用满额预算", () => {
    const source = context([userMessage([], "短文本")]);
    expect(imageBudgetForContext(source)).toBe(IMAGE_TOTAL_BUDGET_BYTES);
  });

  it("文本大时预算收紧（实测会话 C 的 2MB 文本场景）", () => {
    // 2MB 中文文本≈6MB 字节；可用空间 = 8MB − 6MB − 0.5MB = 1.5MB。
    const bigText = "啊".repeat(Math.floor(2 * 1024 * 1024 / 3));
    const source = context([userMessage([], bigText)]);
    const budget = imageBudgetForContext(source);
    expect(budget).toBeLessThan(IMAGE_TOTAL_BUDGET_BYTES);
    expect(budget).toBeGreaterThanOrEqual(IMAGE_MIN_BUDGET_BYTES);
  });

  it("文本梅峰也不会把预算压到下限以下（最新图总能保留）", () => {
    const hugeText = "a".repeat(10 * 1024 * 1024);
    expect(imageBudgetForContext(context([userMessage([], hugeText)]))).toBe(IMAGE_MIN_BUDGET_BYTES);
  });

  it("文本预算估算不包含图片（图片另算，否则会扣两遍）", () => {
    const image = fakeImage(1000);
    const withImage = estimateContextTextBytes(context([userMessage([image], "hi")]));
    const withoutImage = estimateContextTextBytes(context([userMessage([], "hi")]));
    expect(withImage).toBe(withoutImage);
  });

  it("裁剪后的总账（文本 + 图片）应低于网关上限", async () => {
    // 1.5MB 中文文本 + 8 张 1MB 图；预算应自动收紧，使合计不超 8MB。
    const bigText = "啊".repeat(500_000);
    const noop = vi.fn(async (image: ImageContent) => ({ data: image.data, mimeType: image.mimeType }));
    const images = Array.from({ length: 8 }, (_, index) => fakeImage(1024 * 1024, `t${String(index)}`));
    const source = context([userMessage(images, bigText)]);
    const { context: result } = await applyImageBudget(source, deps(noop));
    // 总字节（保守取 JSON 长度）必须在网关上限内。
    expect(JSON.stringify(result).length).toBeLessThan(GATEWAY_BODY_LIMIT_BYTES);
  });
});
