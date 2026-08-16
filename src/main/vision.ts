import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { VisionSettings } from "../shared/protocol.js";

/**
 * Self-built vision fallback: when the active conversation model is text-only,
 * images attached to a prompt are recognized by one of the already-configured
 * provider models (selected in settings, must support image input), called
 * through the shared ModelRuntime. The descriptions are injected into the
 * prompt text instead of the raw image parts.
 */

/** Minimal slice of ModelRuntime needed for one-shot vision calls (easy to stub in tests). */
export interface VisionModelCaller {
  completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
}

export interface VisionModelResolver {
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
}

export interface VisionImage {
  data: string;
  mimeType: string;
}

const DEFAULT_VISION_SYSTEM_PROMPT = [
  "你是图片识别助手。当前对话模型不支持图片输入，由你代为识别用户发送的图片。",
  "请用中文客观、完整地描述图片内容，便于另一个文本模型理解并回答用户问题，包括：",
  "1. 图片中的文字内容（逐字转写，保留排版结构）；",
  "2. 主要物体、人物及其动作和相对位置；",
  "3. 图表/截图的类型、坐标轴、数据要点；",
  "4. 整体布局、配色和风格等对理解问题有帮助的信息。",
  "不要回答或解决用户的问题，只描述你看到的内容。"
].join("\n");

/** Resolve the configured vision model from the registered provider catalog. */
export function resolveVisionModel(vision: VisionSettings | undefined, resolver: VisionModelResolver): Model<Api> | undefined {
  if (!vision?.enabled) return undefined;
  const provider = vision.provider.trim();
  const modelId = vision.model.trim();
  if (!provider || !modelId) return undefined;
  const model = resolver.getModel(provider, modelId);
  if (!model || !model.input.includes("image")) return undefined;
  return model;
}

export function buildVisionSystemPrompt(custom?: string): string {
  return custom?.trim() || DEFAULT_VISION_SYSTEM_PROMPT;
}

function assistantText(message: AssistantMessage): string {
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
}

/** Sentinel rejected by the timeout guard below; mapped to a readable error. */
const VISION_TIMEOUT_MESSAGE = "vision-recognition-timeout";

async function recognizeImage(caller: VisionModelCaller, model: Model<Api>, customPrompt: string | undefined, index: number, total: number, question: string, image: VisionImage, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  let rejectTimeout: ((error: Error) => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  // Abort cooperatively (providers that honor the signal) and race as a hard
  // guard so a stalled provider call can never block the fallback forever.
  const timer = setTimeout(() => {
    controller.abort();
    rejectTimeout?.(new Error(VISION_TIMEOUT_MESSAGE));
  }, timeoutMs);
  const contextLines = total > 1 ? [`这是用户发送的第 ${index} 张图片（共 ${total} 张）。`] : [];
  if (question.trim()) contextLines.push(`用户的请求原文（仅供理解识别侧重点，不要回答它）：\n${question.trim()}`);
  try {
    const result = await Promise.race([
      caller.completeSimple(model, {
        systemPrompt: buildVisionSystemPrompt(customPrompt),
        messages: [{
          role: "user",
          content: [
            { type: "text", text: [...contextLines, "请识别这张图片。"].join("\n\n") },
            { type: "image", data: image.data, mimeType: image.mimeType }
          ],
          timestamp: Date.now()
        }]
      }, { signal: controller.signal }),
      timeoutPromise
    ]);
    const text = assistantText(result);
    if (!text) throw new Error("视觉模型没有返回有效的识别结果");
    return text;
  } catch (error) {
    if (error instanceof Error && (error.message === VISION_TIMEOUT_MESSAGE || error.name === "AbortError")) throw new Error(`图片 ${index} 识别超时`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Recognize every image in parallel; results keep the input order. */
export async function recognizeImages(caller: VisionModelCaller, model: Model<Api>, options: { prompt?: string; question: string; images: VisionImage[] }, timeoutMs = 120_000): Promise<string[]> {
  return Promise.all(options.images.map((image, index) => recognizeImage(caller, model, options.prompt, index + 1, options.images.length, options.question, image, timeoutMs)));
}

/** Format recognition results as the delimited block appended to the prompt text. */
export function formatVisionBlock(results: string[], modelName: string): string {
  const parts = results.map((result, index) => `【图片 ${index + 1}】\n${result.trim()}`);
  return `\n\n---\n[图片识别结果] 当前对话模型不支持图片输入，以下内容改由视觉模型 ${modelName} 识别提供：\n${parts.join("\n\n")}\n---`;
}
