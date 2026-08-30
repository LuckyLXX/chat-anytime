// Vision capability cluster: the recognize_images customTool, the
// model-directed hint appended to image-bearing prompts of text-only
// conversation models, and the request-layer image strip that keeps raw image
// parts away from those models. Attached images stay in the session transcript
// (the renderer shows them in the user's bubble and the JSONL persists them);
// the model calls the tool on its own initiative to recognize them, and may
// pass `files` to read image files directly (e.g. its own screenshots) so
// UI-automation loops (screenshot → look → act) work without a multimodal
// model, or a `prompt` with per-call recognition guidance that overrides the
// settings-level custom prompt (blank/absent falls back to it, then the
// built-in default). Pure over injected dependencies so it is testable
// without Pi or Electron. The tool schema is byte-stable: no dynamic state
// (image counts, prompts) ever enters the definition — such state flows only
// through tool arguments at the conversation tail.

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Context, ImageContent, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { formatVisionBlock, recognizeImages } from "./vision.js";

/** Max image size for model-supplied image files (matches prompt attachments). */
export const MAX_VISION_FILE_BYTES = 20 * 1024 * 1024;
/** Per-call cap for model-supplied image file paths (matches prompt attachments). */
export const MAX_VISION_FILES = 5;

/** Supported image MIME types keyed by lowercase extension without the dot. */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp"
};

/** Map a file path to its image MIME type; undefined when unsupported. */
export function imageMimeForPath(path: string): string | undefined {
  const ext = path.toLowerCase().split(".").pop();
  return ext ? IMAGE_MIME_BY_EXTENSION[ext] : undefined;
}

const VISION_HINT_PATTERN = /\n\n【附带 \d+ 张图片，请调用 recognize_images 工具识别后再回答。】$/u;

/**
 * The hint appended to a prompt whose images the conversation model cannot
 * see. It rides the conversation tail (never the system prompt) so the
 * provider prefix cache stays untouched, and is stripped again for display
 * and regenerate matching via {@link stripVisionHint}.
 */
export function visionHintText(count: number): string {
  return `\n\n【附带 ${count} 张图片，请调用 recognize_images 工具识别后再回答。】`;
}

/** Remove the trailing vision hint from a stored user text (display/matching). */
export function stripVisionHint(text: string): string {
  return text.replace(VISION_HINT_PATTERN, "");
}

/** Placeholder left where an image part was stripped from a text-only request. */
const STRIPPED_IMAGE_PLACEHOLDER = "（此处为图片附件，当前模型不支持图片输入，可调用 recognize_images 工具识别）";

function isImageContent(part: unknown): part is ImageContent {
  if (!part || typeof part !== "object") return false;
  const candidate = part as { type?: unknown; data?: unknown; mimeType?: unknown };
  return candidate.type === "image" && typeof candidate.data === "string" && typeof candidate.mimeType === "string";
}

/**
 * Remove every image part from user and toolResult messages of an LLM request
 * context — the transport half of the vision invariant (the tool is the other
 * half). Images from a `read` on a screenshot become a placeholder pointing at
 * recognize_images, so text-only screenshot loops stay coherent. Contexts
 * without image parts are returned unchanged.
 */
export function stripContextImages(context: Context): Context {
  let changed = false;
  const messages = context.messages.map((message) => {
    if (message.role !== "user" && message.role !== "toolResult") return message;
    if (!Array.isArray(message.content)) return message;
    let hasImage = false;
    const content = message.content.filter((part) => {
      if (part.type === "image") { hasImage = true; return false; }
      return true;
    });
    if (!hasImage) return message;
    changed = true;
    if (content.length === 0) content.push({ type: "text", text: STRIPPED_IMAGE_PLACEHOLDER });
    return { ...message, content };
  });
  return changed ? { ...context, messages } : context;
}

/** Structural slice of Pi's AgentMessage needed to find current-turn images. */
export interface VisionTranscriptMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  stopReason?: string;
}

function hasToolCallPart(message: VisionTranscriptMessage): boolean {
  return Array.isArray(message.content)
    && message.content.some((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall");
}

/**
 * True for assistant messages that are intermediate steps of the run in
 * flight. Pi appends the tool-calling assistant message to the transcript
 * BEFORE executing the call, so while recognize_images runs the transcript
 * always ends with one — the turn boundary is the last assistant message
 * that ended a previous run, not merely the last assistant message. A
 * "length"-stopped message with salvaged tool calls is also a mid-run step
 * (the loop fails the truncated calls and keeps going); without tool calls
 * it ended the run.
 */
function isMidRunAssistant(message: VisionTranscriptMessage): boolean {
  return message.stopReason === "toolUse" || (message.stopReason === "length" && hasToolCallPart(message));
}

/** Images the user attached in the current turn, plus their latest text. */
export interface PendingTurnImages {
  images: ImageContent[];
  /** Most recent user text of the turn (hint already stripped) — recognition context only. */
  question: string;
}

/**
 * Collect images from user messages of the current run (everything after the
 * last assistant message that concluded a previous run; tool-calling steps of
 * the run in flight do not end it). Stateless — the tool re-reads the live
 * transcript on every call, so there is no inbox to stage, consume, or leak
 * across turns.
 */
export function currentTurnUserImages(messages: readonly VisionTranscriptMessage[]): PendingTurnImages | undefined {
  const images: ImageContent[] = [];
  let question = "";
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      if (!isMidRunAssistant(message)) break;
      continue;
    }
    if (message.role !== "user") continue;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isImageContent(part)) images.unshift(part);
      }
    }
    if (!question && Array.isArray(message.content)) {
      const text = message.content
        .filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text")
        .map((part) => (part as { text?: unknown }).text)
        .filter((text): text is string => typeof text === "string")
        .join("");
      question = stripVisionHint(text);
    }
  }
  return images.length ? { images, question } : undefined;
}

export interface VisionToolDeps {
  /** Throws a user-facing error when no vision model/runtime is available. */
  resolve: () => { runtime: ModelRuntime; model: Model<Api>; prompt: string | undefined };
  /** Images attached by the user in the current turn; undefined when none are pending. */
  pendingUserImages: () => PendingTurnImages | undefined;
  /** Read an image file inside the workspace (validates path, size, mime). */
  readImageFile: (path: string) => Promise<ImageContent>;
  errorText: (error: unknown) => string;
}

const NO_PENDING_TEXT = "当前没有待识别的图片（用户附图与文件参数均为空）。请忽略本次调用。";

/** Build the recognize_images customTool (one per session record). */
export function buildVisionTools(deps: VisionToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: "recognize_images",
      label: "识别图片",
      description: [
        "识别用户发送的图片或指定图片文件，返回逐图描述，供你基于图片内容继续回答或操作。",
        "用法一：用户在某条消息中附带了图片，但当前对话模型不支持图片输入——先调用本工具识别全部附带图片，再回答。",
        "用法二：自行查看工作区内的图片文件（例如你用 bash 生成的截图）——传入 files 参数（相对工作区的路径列表，最多 5 个），识别结果按调用顺序标注文件名。",
        "prompt 参数可选：本次识别的指导提示词，由你按当前需要编写——说明重点识别什么、按什么格式描述（如「逐字转写报错对话框中的全部文字」「读出图表各数据点的数值并按序列出」）；不传则默认全面描述（文字转写、物体/人物/布局、图表要点）。",
        "一次调用可同时识别附带图片与文件图片；识别不成功时根据错误信息修正（路径、格式）后重试。"
      ].join(""),
      promptSnippet: "recognize_images: 识别用户附图或工作区图片文件",
      parameters: Type.Object({
        files: Type.Optional(Type.Array(Type.String({ description: "可选，工作区内的图片文件路径（相对路径，如 screenshot.png），最多 5 个" }), { maxItems: MAX_VISION_FILES })),
        prompt: Type.Optional(Type.String({ description: "可选，本次识别的指导提示词：告诉视觉模型重点识别什么、按什么格式描述；不传则默认全面描述" }))
      }),
      execute: async (_id, params) => {
        const files = (Array.isArray(params?.files) ? params.files.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter((f) => f.length > 0) : []).slice(0, MAX_VISION_FILES);
        // The calling model's per-call guidance wins over the settings-level
        // custom prompt; blank/absent falls back to it, then the built-in
        // default (buildVisionSystemPrompt).
        const guidance = typeof params?.prompt === "string" && params.prompt.trim() ? params.prompt.trim() : undefined;
        const pending = deps.pendingUserImages();
        const pendingImages = pending?.images ?? [];
        if (files.length === 0 && pendingImages.length === 0) {
          return { content: [{ type: "text" as const, text: NO_PENDING_TEXT }], details: { consumed: 0 } };
        }
        const { runtime, model, prompt } = deps.resolve();
        const fileImages: ImageContent[] = [];
        for (const file of files) {
          try {
            fileImages.push(await deps.readImageFile(file));
          } catch (error) {
            throw new Error(`读取图片文件失败：${file}（${deps.errorText(error)}）`);
          }
        }
        try {
          const labels = [...pendingImages.map(() => undefined), ...files];
          const images = [...pendingImages, ...fileImages];
          const results = await recognizeImages(runtime, model, { prompt: guidance ?? prompt, question: pending?.question ?? "", images });
          return { content: [{ type: "text" as const, text: formatVisionBlock(results, model.name || model.id, labels) }], details: { consumed: images.length } };
        } catch (error) {
          throw new Error(`图片识别失败：${deps.errorText(error)}`);
        }
      }
    })
  ];
}
