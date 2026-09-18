import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, ImageContent, Model } from "@earendil-works/pi-ai";
import { budgetedStreamSimple, createImageBudgetGate } from "./budgeted-stream.js";
import { IMAGE_DOWNSAMPLE_MIN_BYTES } from "./request-image-budget.js";

function model(): Model<Api> {
  return { id: "vision-model", provider: "test", input: ["text", "image"], api: "openai-completions" } as unknown as Model<Api>;
}

function fakeImage(bytes: number, seed: string): ImageContent {
  return { type: "image", data: seed.repeat(Math.ceil(bytes / seed.length)).slice(0, bytes), mimeType: "image/png" };
}

function contextWith(images: ImageContent[]): Context {
  return { messages: [{ role: "user", content: [{ type: "text", text: "看图" }, ...images], timestamp: 1 }] };
}

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-completions",
    provider: "test",
    model: "vision-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 1
  } as unknown as AssistantMessage;
}

/** 下游 streamSimple 假件：记录收到的 context，返回一个立即结束的流。 */
function downstream(): { stream: ReturnType<typeof vi.fn>; seen: Context[] } {
  const seen: Context[] = [];
  const stream = vi.fn((_model: Model<Api>, context: Context): AssistantMessageEventStream => {
    seen.push(context);
    const result = createAssistantMessageEventStream();
    const message = assistantMessage();
    result.push({ type: "start", partial: message });
    result.push({ type: "text_start", contentIndex: 0, partial: message });
    result.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
    result.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
    result.push({ type: "done", reason: "stop", message });
    result.end(message);
    return result;
  });
  return { stream: stream as unknown as ReturnType<typeof vi.fn>, seen };
}

async function collect(stream: AssistantMessageEventStream): Promise<string[]> {
  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  return events;
}

describe("createImageBudgetGate", () => {
  it("未超预算时返回同一引用且不记日志", async () => {
    const downsample = vi.fn(async (image: ImageContent) => ({ data: image.data, mimeType: image.mimeType }));
    const logs: string[] = [];
    const gate = createImageBudgetGate({ downsample, warn: () => undefined, log: (message) => logs.push(message) });
    const source = contextWith([fakeImage(1000, "small")]);
    const result = await gate(source);
    expect(result).toBe(source);
    expect(logs).toHaveLength(0);
    expect(downsample).not.toHaveBeenCalled();
  });

  it("真实裁剪时记一条含前后体积的日志", async () => {
    // 5 张 2MB 图 = 10MB > 6MB 预算；压缩器压到 1/10 → 全部保留并压缩。
    const downsample = vi.fn(async (image: ImageContent) => ({ data: image.data.slice(0, image.data.length / 10), mimeType: image.mimeType }));
    const logs: string[] = [];
    const gate = createImageBudgetGate({ downsample, warn: () => undefined, log: (message) => logs.push(message) });
    const source = contextWith(Array.from({ length: 5 }, (_, index) => fakeImage(2 * 1024 * 1024, `big${String(index)}`)));
    const result = await gate(source);
    expect(result).not.toBe(source);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("图片预算裁剪");
    expect(logs[0]).toContain("压缩 5 张");
  });

  it("裁剪器抛错时 fail-open（返回原 context + 警告）", async () => {
    const downsample = vi.fn(async (image: ImageContent) => {
      void image;
      throw new Error("photon 不可用");
    });
    const warnings: string[] = [];
    const gate = createImageBudgetGate({ downsample, warn: (message) => warnings.push(message) });
    const source = contextWith(Array.from({ length: 5 }, (_, index) => fakeImage(IMAGE_DOWNSAMPLE_MIN_BYTES + 1000, `x${String(index)}`)));
    const result = await gate(source);
    expect(result).toBe(source);
    expect(warnings.some((message) => message.includes("按原样发送"))).toBe(true);
  });
});

describe("budgetedStreamSimple", () => {
  it("同步返回流，且下游收到的是裁剪后的 context", async () => {
    const { stream, seen } = downstream();
    const downsample = vi.fn(async (image: ImageContent) => ({ data: image.data.slice(0, image.data.length / 10), mimeType: image.mimeType }));
    const gate = createImageBudgetGate({ downsample, warn: () => undefined });
    const wrapped = budgetedStreamSimple(stream as never, gate);
    const source = contextWith(Array.from({ length: 5 }, (_, index) => fakeImage(2 * 1024 * 1024, `c${String(index)}`)));

    // 同步拿到流（没有 await）——Pi 的调用方按此契约消费。
    const result = wrapped(model(), source);
    expect(result).toBeDefined();
    expect(typeof result[Symbol.asyncIterator]).toBe("function");

    await collect(result);
    expect(stream).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(source);
    const content = (seen[0]!.messages[0] as { content: Array<{ type: string; data?: string }> }).content;
    const imagePart = content.find((part) => part.type === "image")!;
    expect(imagePart.data!.length).toBeLessThan(2 * 1024 * 1024);
  });

  it("未超预算时下游收到的就是原 context（引用相同）", async () => {
    const { stream, seen } = downstream();
    const gate = createImageBudgetGate({ downsample: async (image) => ({ data: image.data, mimeType: image.mimeType }), warn: () => undefined });
    const wrapped = budgetedStreamSimple(stream as never, gate);
    const source = contextWith([fakeImage(1000, "t")]);
    await collect(wrapped(model(), source));
    expect(seen[0]).toBe(source);
  });

  it("门自身抛错时以 error 事件结束流（不静默丢请求）", async () => {
    const { stream, seen } = downstream();
    const gate = vi.fn(async () => {
      throw new Error("gate 炸了");
    });
    const wrapped = budgetedStreamSimple(stream as never, gate);
    const source = contextWith([fakeImage(1000, "y")]);
    const events = await collect(wrapped(model(), source));
    // lazyStream 的语义：setup 抛错 → error event 结束流（不是静默吞掉）。
    expect(events).toContain("error");
    expect(seen).toHaveLength(0);
  });
});
