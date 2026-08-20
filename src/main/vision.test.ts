import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { VisionSettings } from "../shared/protocol.js";
import {
  buildVisionSystemPrompt,
  formatVisionBlock,
  recognizeImages,
  resolveVisionModel,
  type VisionModelCaller
} from "./vision.js";

function multimodalModel(input: ("text" | "image")[] = ["text", "image"]): Model<Api> {
  return { id: "glm-4v-flash", name: "GLM-4V Flash", provider: "proxy", input } as unknown as Model<Api>;
}

function assistantResponse(content: AssistantMessage["content"]): AssistantMessage {
  return { role: "assistant", api: "openai-completions", content } as unknown as AssistantMessage;
}

function callerReturning(contentByCall: AssistantMessage["content"][]): VisionModelCaller & { calls: { model: Model<Api>; context: Context }[] } {
  const calls: { model: Model<Api>; context: Context }[] = [];
  let index = 0;
  return {
    calls,
    async completeSimple(model, context) {
      calls.push({ model, context });
      return assistantResponse(contentByCall[Math.min(index++, contentByCall.length - 1)]!);
    }
  };
}

describe("vision model resolution", () => {
  const model = multimodalModel();
  const vision: VisionSettings = { enabled: true, provider: "proxy", model: "glm-4v-flash" };

  it("requires enabled settings, a provider, a model id and image capability", () => {
    const resolver = { getModel: vi.fn(() => model) };
    expect(resolveVisionModel(undefined, resolver)).toBeUndefined();
    expect(resolveVisionModel({ ...vision, enabled: false }, resolver)).toBeUndefined();
    expect(resolveVisionModel({ ...vision, provider: " " }, resolver)).toBeUndefined();
    expect(resolveVisionModel({ ...vision, model: " " }, resolver)).toBeUndefined();
    expect(resolveVisionModel(vision, { getModel: () => undefined })).toBeUndefined();
    expect(resolveVisionModel(vision, { getModel: vi.fn(() => multimodalModel(["text"])) })).toBeUndefined();
    expect(resolveVisionModel(vision, resolver)).toBe(model);
    expect(resolver.getModel).toHaveBeenCalledWith("proxy", "glm-4v-flash");
  });

  it("prefers the custom recognition prompt but falls back to the built-in one", () => {
    expect(buildVisionSystemPrompt("  只描述文字  ")).toBe("只描述文字");
    expect(buildVisionSystemPrompt("   ")).toContain("图片识别助手");
    expect(buildVisionSystemPrompt(undefined)).toBe(buildVisionSystemPrompt(""));
  });
});

describe("recognizeImages", () => {
  it("sends one vision request per image through the shared model runtime", async () => {
    const caller = callerReturning([[{ type: "text", text: " 一张架构图 " }]]);
    const model = multimodalModel();
    const results = await recognizeImages(caller, model, { question: "这是什么图表？", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] });

    expect(results).toEqual(["一张架构图"]);
    expect(caller.calls).toHaveLength(1);
    expect(caller.calls[0]?.model).toBe(model);
    const context = caller.calls[0]!.context;
    expect(context.systemPrompt).toContain("图片识别助手");
    const userMessage = context.messages[0] as { role: string; content: { type: string; text?: string; data?: string; mimeType?: string }[] };
    expect(userMessage.role).toBe("user");
    expect(JSON.stringify(userMessage.content)).toContain("这是什么图表？");
    expect(userMessage.content).toContainEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  });

  it("recognizes multiple images in parallel, keeps order and labels each request", async () => {
    const caller = callerReturning([
      [{ type: "thinking", thinking: "先看图" }, { type: "text", text: "第一张的描述" }],
      [{ type: "text", text: "第二张的描述" }]
    ]);
    const results = await recognizeImages(caller, multimodalModel(), {
      question: "",
      images: [{ data: "aaa", mimeType: "image/png" }, { data: "bbb", mimeType: "image/jpeg" }]
    });

    expect(results).toEqual(["第一张的描述", "第二张的描述"]);
    const first = caller.calls[0]!.context.messages[0] as { content: { type: string; text?: string }[] };
    const second = caller.calls[1]!.context.messages[0] as { content: { type: string; text?: string }[] };
    expect(String(first.content.find((part) => part.type === "text")?.text)).toContain("第 1 张");
    expect(String(second.content.find((part) => part.type === "text")?.text)).toContain("第 2 张");
  });

  it("forwards the custom recognition prompt as the system prompt", async () => {
    const caller = callerReturning([[{ type: "text", text: "ok" }]]);
    await recognizeImages(caller, multimodalModel(), { prompt: "只转写文字", question: "", images: [{ data: "aaa", mimeType: "image/png" }] });
    expect(caller.calls[0]?.context.systemPrompt).toBe("只转写文字");
  });

  it("propagates upstream failures", async () => {
    const caller: VisionModelCaller = {
      async completeSimple() {
        throw new Error("上游返回 HTTP 401");
      }
    };
    await expect(recognizeImages(caller, multimodalModel(), { question: "", images: [{ data: "aaa", mimeType: "image/png" }] })).rejects.toThrow("HTTP 401");
  });

  it("rejects empty recognition output", async () => {
    const caller = callerReturning([[{ type: "text", text: "   " }]]);
    await expect(recognizeImages(caller, multimodalModel(), { question: "", images: [{ data: "aaa", mimeType: "image/png" }] })).rejects.toThrow("没有返回有效的识别结果");
  });

  it("times out stalled recognition requests", async () => {
    const caller: VisionModelCaller = { completeSimple: () => new Promise(() => {}) };
    await expect(recognizeImages(caller, multimodalModel(), { question: "", images: [{ data: "aaa", mimeType: "image/png" }] }, 10)).rejects.toThrow("识别超时");
  });
});

describe("vision prompt block", () => {
  it("labels every image and names the vision model", () => {
    const block = formatVisionBlock(["第一张的描述", "第二张的描述"], "GLM-4V Flash");
    expect(block).toContain("【图片 1】\n第一张的描述");
    expect(block).toContain("【图片 2】\n第二张的描述");
    expect(block).toContain("GLM-4V Flash");
    expect(block.startsWith("\n\n---\n")).toBe(true);
  });

  it("annotates model-supplied file names and drops the old fallback wording", () => {
    const block = formatVisionBlock(["截图内容"], "GLM-4V Flash", ["shot.png"]);
    expect(block).toContain("【图片 1 · shot.png】\n截图内容");
    expect(block).not.toContain("当前对话模型不支持图片输入");
  });
});
