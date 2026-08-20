// Vision capability cluster: the recognize_images customTool plus the
// per-session inbox that stages user-attached images for text-only
// conversation models. The model calls the tool on its own initiative:
// without arguments it recognizes the staged user images; with `files` it
// reads image files directly (e.g. its own screenshots) so UI-automation
// loops (screenshot → look → act) work without a multimodal model. Raw image
// parts never reach the text-only model. Pure over injected dependencies so
// it is testable without Pi or Electron. The tool schema is byte-stable: no
// dynamic state (pending image counts, prompts) ever enters the definition —
// such state flows only through tool arguments at the conversation tail.

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
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
  gif: "image/gif"
};

/** Map a file path to its image MIME type; undefined when unsupported. */
export function imageMimeForPath(path: string): string | undefined {
  const ext = path.toLowerCase().split(".").pop();
  return ext ? IMAGE_MIME_BY_EXTENSION[ext] : undefined;
}

/** Images staged from a user message, awaiting the model's recognize_images call. */
export interface VisionInbox {
  images: ImageContent[];
  /** Original user text (pre-injection), used as recognition context. */
  question: string;
}

export interface VisionToolDeps {
  /** Throws a user-facing error when no vision model/runtime is available. */
  resolve: () => { runtime: ModelRuntime; model: Model<Api>; prompt: string | undefined };
  /** The session's staged inbox; undefined when nothing is pending. */
  inbox: () => VisionInbox | undefined;
  /** Clear the staged inbox after successful recognition. */
  clearInbox: () => void;
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
        "识别用户发送的图片或指定图片文件，返回逐图描述（文字逐字转写、物体/人物/布局、图表与数据要点等），供你基于图片内容继续回答或操作。",
        "用法一：用户在某条消息中附带了图片，但当前对话模型不支持图片输入——先调用本工具（不传参数）识别全部附带图片，再回答。",
        "用法二：自行查看工作区内的图片文件（例如你用 bash 生成的截图）——传入 files 参数（相对工作区的路径列表，最多 5 个），识别结果按调用顺序标注文件名。",
        "一次调用可同时识别附带图片与文件图片；识别不成功时根据错误信息修正（路径、格式）后重试。"
      ].join(""),
      promptSnippet: "recognize_images: 识别用户附图或工作区图片文件",
      parameters: Type.Object({
        files: Type.Optional(Type.Array(Type.String({ description: "可选，工作区内的图片文件路径（相对路径，如 screenshot.png），最多 5 个" }), { maxItems: MAX_VISION_FILES }))
      }),
      execute: async (_id, params) => {
        const files = (Array.isArray(params?.files) ? params.files.filter((f): f is string => typeof f === "string").map((f) => f.trim()).filter((f) => f.length > 0) : []).slice(0, MAX_VISION_FILES);
        const inbox = deps.inbox();
        const inboxImages = inbox?.images ?? [];
        if (files.length === 0 && inboxImages.length === 0) {
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
          const labels = [...inboxImages.map(() => undefined), ...files];
          const images = [...inboxImages, ...fileImages];
          const results = await recognizeImages(runtime, model, { prompt, question: inbox?.question ?? "", images });
          deps.clearInbox();
          return { content: [{ type: "text" as const, text: formatVisionBlock(results, model.name || model.id, labels) }], details: { consumed: images.length } };
        } catch (error) {
          throw new Error(`图片识别失败：${deps.errorText(error)}`);
        }
      }
    })
  ];
}