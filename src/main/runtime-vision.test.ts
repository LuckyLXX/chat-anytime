import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Context, ImageContent, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  buildVisionTools,
  currentTurnUserImages,
  imageMimeForPath,
  stripContextImages,
  stripVisionHint,
  visionHintText,
  type PendingTurnImages,
  type VisionTranscriptMessage
} from "./runtime-vision.js";

function model(): Model<Api> {
  return { id: "glm-4v-flash", name: "GLM-4V Flash", provider: "proxy", input: ["text", "image"] } as unknown as Model<Api>;
}

function assistantMessage(text: string): AssistantMessage {
  return { role: "assistant", api: "openai-completions", content: [{ type: "text", text }] } as unknown as AssistantMessage;
}

function image(data: string, mimeType = "image/png"): ImageContent {
  return { type: "image", data, mimeType };
}

/** Stub runner tracking completeSimple calls (recognizeImages only needs this slice). */
function runnerStub(text: string): { runtime: ModelRuntime; completeSimple: ReturnType<typeof vi.fn> } {
  const completeSimple = vi.fn().mockResolvedValue(assistantMessage(text));
  return { runtime: { completeSimple } as unknown as ModelRuntime, completeSimple };
}

interface Harness {
  deps: {
    resolve: () => { runtime: ModelRuntime; model: Model<Api>; prompt: string | undefined };
    pendingUserImages: () => PendingTurnImages | undefined;
    readImageFile: (path: string) => Promise<ImageContent>;
    errorText: (error: unknown) => string;
  };
  setPending: (pending: PendingTurnImages | undefined) => void;
  completeSimple: ReturnType<typeof vi.fn>;
  readImageFile: ReturnType<typeof vi.fn>;
}

function harness(overrides: { readImageFile?: (path: string) => Promise<ImageContent>; model?: Model<Api>; prompt?: string } = {}): Harness {
  let pending: PendingTurnImages | undefined;
  const { completeSimple, runtime } = runnerStub("识别结果内容");
  const readImageFile = vi.fn(overrides.readImageFile ?? (async (path: string) => image(`data-of-${path}`)));
  return {
    deps: {
      resolve: () => ({ runtime, model: overrides.model ?? model(), prompt: overrides.prompt }),
      pendingUserImages: () => pending,
      readImageFile,
      errorText: (e) => (e instanceof Error ? e.message : String(e))
    },
    setPending: (value) => { pending = value; },
    completeSimple,
    readImageFile
  };
}

function toolOf(h: Harness) {
  const tools = buildVisionTools(h.deps);
  return tools[0]!;
}

interface ToolRunResult {
  content: { type: string; text?: string }[];
}

// defineTool 推断的 execute 需要全部 5 个参数；测试里其余参数恒为空。
async function runTool(tool: { execute?: unknown } | undefined, id: string, params: unknown): Promise<ToolRunResult> {
  if (typeof tool?.execute !== "function") throw new Error("tool has no execute");
  const execute = tool.execute as (toolCallId: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: undefined) => Promise<ToolRunResult>;
  return execute(id, params, undefined, undefined, undefined);
}

function resultText(result: ToolRunResult): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

describe("imageMimeForPath", () => {
  it("maps supported extensions to image MIME types", () => {
    expect(imageMimeForPath("shot.png")).toBe("image/png");
    expect(imageMimeForPath("a/b/shot.jpg")).toBe("image/jpeg");
    expect(imageMimeForPath("SHOT.JPEG")).toBe("image/jpeg");
    expect(imageMimeForPath("anim.webp")).toBe("image/webp");
    expect(imageMimeForPath("anim.gif")).toBe("image/gif");
    expect(imageMimeForPath("logo.bmp")).toBe("image/bmp");
  });

  it("rejects unsupported extensions and dotless paths", () => {
    expect(imageMimeForPath("notes.txt")).toBeUndefined();
    expect(imageMimeForPath("noext")).toBeUndefined();
  });
});

describe("vision hint", () => {
  it("round-trips: strip removes exactly what visionHintText appended", () => {
    const text = "这张图讲什么？";
    const stored = text + visionHintText(3);
    expect(stored).toContain("【附带 3 张图片");
    expect(stripVisionHint(stored)).toBe(text);
  });

  it("leaves texts without the hint untouched (including similar wording)", () => {
    expect(stripVisionHint("普通消息")).toBe("普通消息");
    expect(stripVisionHint("【附带 3 张图片，请调用 recognize_images 工具识别后再回答。】开头而不是结尾")).toBe("【附带 3 张图片，请调用 recognize_images 工具识别后再回答。】开头而不是结尾");
  });
});

describe("stripContextImages", () => {
  function context(messages: unknown[]): Context {
    return { systemPrompt: "s", messages } as unknown as Context;
  }

  it("removes image parts from user and toolResult messages, keeps text", () => {
    const source = context([
      { role: "user", content: [{ type: "text", text: "看看" }, { type: "image", data: "aaa", mimeType: "image/png" }] },
      { role: "toolResult", content: [{ type: "image", data: "bbb", mimeType: "image/png" }], toolCallId: "t1" }
    ]);
    const stripped = stripContextImages(source);
    expect(stripped.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "看看" }] });
    // Image-only content degrades to a placeholder pointing at the tool.
    const toolContent = (stripped.messages[1] as { content: { type: string; text?: string }[] }).content;
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0]!.text).toContain("recognize_images");
  });

  it("returns the same context object when no image parts exist", () => {
    const source = context([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
    expect(stripContextImages(source)).toBe(source);
  });
});

describe("currentTurnUserImages", () => {
  function userMessage(content: unknown, timestamp = 1): VisionTranscriptMessage {
    return { role: "user", content, timestamp };
  }

  it("collects images from user messages after the last assistant message, in order", () => {
    const messages: VisionTranscriptMessage[] = [
      userMessage([{ type: "text", text: "旧问题" }, { type: "image", data: "old", mimeType: "image/png" }]),
      { role: "assistant", content: [], timestamp: 2 },
      userMessage([{ type: "text", text: "新问题" }]),
      userMessage([{ type: "image", data: "first", mimeType: "image/png" }]),
      userMessage([{ type: "image", data: "second", mimeType: "image/png" }])
    ];
    const pending = currentTurnUserImages(messages);
    expect(pending?.images.map((part) => part.data)).toEqual(["first", "second"]);
    // Question = most recent user text of the turn.
    expect(pending?.question).toBe("新问题");
  });

  it("strips the vision hint from the question and skips string-only content", () => {
    const messages: VisionTranscriptMessage[] = [
      userMessage("纯文本消息" + visionHintText(1)),
      userMessage([{ type: "image", data: "aaa", mimeType: "image/png" }])
    ];
    const pending = currentTurnUserImages(messages);
    expect(pending?.images).toHaveLength(1);
    expect(pending?.question).toBe("");
  });

  it("returns undefined when the current turn has no attached images", () => {
    expect(currentTurnUserImages([userMessage([{ type: "text", text: "没有图" }])])).toBeUndefined();
    expect(currentTurnUserImages([])).toBeUndefined();
  });

  it("ignores non-user roles without stopping the scan", () => {
    const messages: VisionTranscriptMessage[] = [
      userMessage([{ type: "image", data: "old", mimeType: "image/png" }]),
      { role: "assistant", content: [], timestamp: 2 },
      { role: "toolResult", content: [{ type: "text", text: "tool output" }], timestamp: 3 },
      userMessage([{ type: "text", text: "继续" }, { type: "image", data: "new", mimeType: "image/png" }])
    ];
    const pending = currentTurnUserImages(messages);
    expect(pending?.images.map((part) => part.data)).toEqual(["new"]);
  });

  // Pi appends the tool-calling assistant message to the transcript BEFORE
  // executing the call — while recognize_images runs, the transcript ends
  // with the very assistant message that issued it. These shapes reproduce
  // the live mid-run transcript, not the settled post-turn one.
  function midRunAssistant(stopReason: string, content: unknown[] = [{ type: "toolCall", id: "t1", toolName: "recognize_images", arguments: {} }]): VisionTranscriptMessage {
    return { role: "assistant", content, timestamp: 9, stopReason };
  }

  it("finds images even though the transcript ends with the calling assistant message", () => {
    const messages: VisionTranscriptMessage[] = [
      { role: "assistant", content: [], timestamp: 2, stopReason: "stop" },
      userMessage([{ type: "text", text: "这张图讲什么？" }, { type: "image", data: "aaa", mimeType: "image/png" }]),
      midRunAssistant("toolUse")
    ];
    const pending = currentTurnUserImages(messages);
    expect(pending?.images.map((part) => part.data)).toEqual(["aaa"]);
    expect(pending?.question).toBe("这张图讲什么？");
  });

  it("keeps scanning across earlier tool steps and results of the same run", () => {
    const messages: VisionTranscriptMessage[] = [
      userMessage([{ type: "image", data: "first", mimeType: "image/png" }]),
      midRunAssistant("toolUse"),
      { role: "toolResult", content: [{ type: "text", text: "ok" }], timestamp: 5 },
      userMessage([{ type: "text", text: "顺便看这张" }, { type: "image", data: "second", mimeType: "image/png" }]),
      midRunAssistant("toolUse")
    ];
    const pending = currentTurnUserImages(messages);
    expect(pending?.images.map((part) => part.data)).toEqual(["first", "second"]);
    expect(pending?.question).toBe("顺便看这张");
  });

  it("treats a truncated tool-call retry step (stopReason length with tool calls) as mid-run", () => {
    const messages: VisionTranscriptMessage[] = [
      userMessage([{ type: "image", data: "aaa", mimeType: "image/png" }]),
      midRunAssistant("length"),
      { role: "toolResult", content: [{ type: "text", text: "failed" }], timestamp: 5 },
      midRunAssistant("toolUse")
    ];
    expect(currentTurnUserImages(messages)?.images).toHaveLength(1);
  });

  it("stops at a previous run's final message — stale images are not current-turn", () => {
    const messages: VisionTranscriptMessage[] = [
      userMessage([{ type: "image", data: "old", mimeType: "image/png" }]),
      { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 2, stopReason: "stop" },
      userMessage([{ type: "text", text: "没有新图" }]),
      midRunAssistant("toolUse")
    ];
    expect(currentTurnUserImages(messages)).toBeUndefined();
  });

  it("treats length without tool calls as a run boundary", () => {
    const messages: VisionTranscriptMessage[] = [
      userMessage([{ type: "image", data: "old", mimeType: "image/png" }]),
      { role: "assistant", content: [{ type: "text", text: "trunc" }], timestamp: 2, stopReason: "length" },
      userMessage([{ type: "text", text: "继续" }]),
      midRunAssistant("toolUse")
    ];
    expect(currentTurnUserImages(messages)).toBeUndefined();
  });
});

describe("buildVisionTools", () => {
  it("registers a single recognize_images tool with a byte-stable schema", () => {
    const h = harness();
    const tool = toolOf(h);
    expect(tool.name).toBe("recognize_images");
    expect(tool.label).toBe("识别图片");
    // Schema must never carry dynamic state: only the optional files array
    // and the per-call guidance prompt.
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        files: expect.objectContaining({ type: "array" }),
        prompt: expect.objectContaining({ type: "string" })
      }
    });
  });

  it("returns a no-op hint when neither pending images nor files are present", async () => {
    const h = harness();
    const result = await runTool(toolOf(h), "call-1", {});
    expect(resultText(result)).toContain("当前没有待识别的图片");
    expect(h.completeSimple).not.toHaveBeenCalled();
  });

  it("recognizes current-turn user images", async () => {
    const h = harness();
    h.setPending({ images: [image("aaa"), image("bbb")], question: "这张图讲什么？" });
    const result = await runTool(toolOf(h), "call-1", {});
    const text = resultText(result);
    expect(text).toContain("【图片 1】");
    expect(text).toContain("【图片 2】");
    expect(text).toContain("GLM-4V Flash");
    expect(h.completeSimple).toHaveBeenCalledTimes(2);
    // Turn images go to the vision model, question travels as context.
    const firstContent = JSON.stringify(h.completeSimple.mock.calls[0]);
    expect(firstContent).toContain("aaa");
    expect(firstContent).toContain("这张图讲什么？");
  });

  it("uses the model-supplied prompt as the vision system prompt, trimmed", async () => {
    const h = harness({ prompt: "设置里的全局自定义提示词" });
    h.setPending({ images: [image("aaa")], question: "" });
    await runTool(toolOf(h), "call-1", { prompt: "  逐字转写报错对话框中的全部文字  " });
    const systemPrompt = (h.completeSimple.mock.calls[0] as unknown[])[1] as { systemPrompt: string };
    expect(systemPrompt.systemPrompt).toBe("逐字转写报错对话框中的全部文字");
  });

  it("falls back to the settings prompt when the model passes none or only whitespace", async () => {
    for (const params of [{}, { prompt: "   " }]) {
      const h = harness({ prompt: "设置里的全局自定义提示词" });
      h.setPending({ images: [image("aaa")], question: "" });
      await runTool(toolOf(h), "call-1", params);
      const context = (h.completeSimple.mock.calls[0] as unknown[])[1] as { systemPrompt: string };
      expect(context.systemPrompt).toBe("设置里的全局自定义提示词");
    }
  });

  it("guidance applies to file images too, not only pending turn images", async () => {
    const h = harness();
    await runTool(toolOf(h), "call-1", { files: ["shot.png"], prompt: "描述界面元素及其相对位置" });
    const context = (h.completeSimple.mock.calls[0] as unknown[])[1] as { systemPrompt: string };
    expect(context.systemPrompt).toBe("描述界面元素及其相对位置");
  });

  it("reads model-supplied image files and labels them in the result", async () => {
    const h = harness();
    const result = await runTool(toolOf(h), "call-1", { files: ["shot.png", "diagram.jpg"] });
    const text = resultText(result);
    expect(h.readImageFile).toHaveBeenCalledTimes(2);
    expect(h.readImageFile).toHaveBeenNthCalledWith(1, "shot.png");
    expect(h.readImageFile).toHaveBeenNthCalledWith(2, "diagram.jpg");
    expect(text).toContain("【图片 1 · shot.png】");
    expect(text).toContain("【图片 2 · diagram.jpg】");
  });

  it("recognizes turn images and file images in one call, labels only the files", async () => {
    const h = harness();
    h.setPending({ images: [image("aaa")], question: "看这张图" });
    const result = await runTool(toolOf(h), "call-1", { files: ["shot.png"] });
    const text = resultText(result);
    expect(text).toContain("【图片 1】\n");
    expect(text).toContain("【图片 2 · shot.png】");
  });

  it("propagates file read failures with the offending path", async () => {
    const h = harness({ readImageFile: async (path) => { throw new Error(`ENOENT: ${path}`); } });
    await expect(runTool(toolOf(h), "call-1", { files: ["missing.png"] })).rejects.toThrow("读取图片文件失败：missing.png");
    expect(h.completeSimple).not.toHaveBeenCalled();
  });

  it("propagates recognition failures", async () => {
    const h = harness();
    h.setPending({ images: [image("aaa")], question: "" });
    h.completeSimple.mockRejectedValue(new Error("上游 HTTP 500"));
    await expect(runTool(toolOf(h), "call-1", {})).rejects.toThrow("图片识别失败：上游 HTTP 500");
  });

  it("propagates the unconfigured-vision error from resolve", async () => {
    const h = harness();
    const deps = { ...h.deps, resolve: () => { throw new Error("当前模型不支持图片输入，请先切换多模态模型"); } };
    const tools = buildVisionTools(deps);
    h.setPending({ images: [image("aaa")], question: "" });
    await expect(runTool(tools[0], "call-1", {})).rejects.toThrow("当前模型不支持图片输入");
  });

  it("caps the number of file paths per call", async () => {
    const h = harness();
    const files = Array.from({ length: 10 }, (_, i) => `${i}.png`);
    await runTool(toolOf(h), "call-1", { files });
    expect(h.readImageFile).toHaveBeenCalledTimes(5);
  });
});
