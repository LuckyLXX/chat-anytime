// Vision fallback cluster extracted from pi-runtime.ts. For text-only
// conversation models, attached images are recognized by a user-selected
// multimodal model and injected into the prompt text; raw image parts never
// reach the text-only model. This module owns the recognition flow and the
// transient pending-bubble construction; pi-runtime applies state transitions
// (busy/status/pending message + emit) through the single apply() callback.

import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ChatMessage } from "../shared/protocol.js";
import { formatVisionBlock, recognizeImages } from "./vision.js";

export interface VisionFallbackState {
  busy: boolean;
  status: string;
  pendingMessage?: ChatMessage;
}

export interface VisionFallbackDeps {
  /** Throws a user-facing error when no vision model/runtime is available. */
  resolve: () => { runtime: ModelRuntime; model: Model<Api>; prompt: string | undefined };
  /** Apply one state transition: assign busy/status/pending and emit. */
  apply: (state: VisionFallbackState) => void;
  errorText: (error: unknown) => string;
}

export async function runVisionFallback(deps: VisionFallbackDeps, payload: { text: string; images: ImageContent[] }): Promise<void> {
  const { runtime, model, prompt } = deps.resolve();
  const since = Date.now();
  deps.apply({
    busy: true,
    status: "正在识别图片",
    pendingMessage: {
      id: `vision-pending-${since}`,
      uuid: `vision-pending-${since}`,
      role: "user",
      timestamp: since,
      blocks: [
        ...(payload.text.trim() ? [{ type: "text" as const, text: payload.text }] : []),
        ...payload.images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))
      ]
    }
  });
  try {
    const results = await recognizeImages(runtime, model, { prompt, question: payload.text, images: payload.images });
    payload.text += formatVisionBlock(results, model.name || model.id);
    payload.images = [];
  } catch (error) {
    deps.apply({ busy: false, status: "请求失败", pendingMessage: undefined });
    throw new Error(`图片识别失败：${deps.errorText(error)}`);
  }
}
