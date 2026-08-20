import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildVisionTools, imageMimeForPath, type VisionInbox } from "./runtime-vision.js";

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
    inbox: () => VisionInbox | undefined;
    clearInbox: () => void;
    readImageFile: (path: string) => Promise<ImageContent>;
    errorText: (error: unknown) => string;
  };
  setInbox: (inbox: VisionInbox | undefined) => void;
  completeSimple: ReturnType<typeof vi.fn>;
  readImageFile: ReturnType<typeof vi.fn>;
}

function harness(overrides: { readImageFile?: (path: string) => Promise<ImageContent>; model?: Model<Api>; prompt?: string } = {}): Harness {
  let inbox: VisionInbox | undefined;
  const { completeSimple, runtime } = runnerStub("识别结果内容");
  const readImageFile = vi.fn(overrides.readImageFile ?? (async (path: string) => image(`data-of-${path}`)));
  return {
    deps: {
      resolve: () => ({ runtime, model: overrides.model ?? model(), prompt: overrides.prompt }),
      inbox: () => inbox,
      clearInbox: () => { inbox = undefined; },
      readImageFile,
      errorText: (e) => (e instanceof Error ? e.message : String(e))
    },
    setInbox: (value) => { inbox = value; },
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
  });

  it("rejects unsupported extensions and dotless paths", () => {
    expect(imageMimeForPath("notes.txt")).toBeUndefined();
    expect(imageMimeForPath("noext")).toBeUndefined();
  });
});

describe("buildVisionTools", () => {
  it("registers a single recognize_images tool with a byte-stable schema", () => {
    const h = harness();
    const tool = toolOf(h);
    expect(tool.name).toBe("recognize_images");
    expect(tool.label).toBe("识别图片");
    // Schema must never carry dynamic state: only the optional files array.
    expect(tool.parameters).toEqual({ type: "object", properties: { files: expect.objectContaining({ type: "array" }) } });
  });

  it("returns a no-op hint when neither inbox nor files are present", async () => {
    const h = harness();
    const result = await runTool(toolOf(h), "call-1", {});
    expect(resultText(result)).toContain("当前没有待识别的图片");
    expect(h.completeSimple).not.toHaveBeenCalled();
  });

  it("recognizes staged user images and clears the inbox", async () => {
    const h = harness();
    h.setInbox({ images: [image("aaa"), image("bbb")], question: "这张图讲什么？" });
    const result = await runTool(toolOf(h), "call-1", {});
    const text = resultText(result);
    expect(text).toContain("【图片 1】");
    expect(text).toContain("【图片 2】");
    expect(text).toContain("GLM-4V Flash");
    expect(h.completeSimple).toHaveBeenCalledTimes(2);
    // Staged images go to the vision model, question travels as context.
    const firstContent = JSON.stringify(h.completeSimple.mock.calls[0]);
    expect(firstContent).toContain("aaa");
    expect(firstContent).toContain("这张图讲什么？");
    // Tool consumption clears the inbox for the next turn.
    expect(h.deps.inbox()).toBeUndefined();
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

  it("recognizes staged images and file images in one call, labels only the files", async () => {
    const h = harness();
    h.setInbox({ images: [image("aaa")], question: "看这张图" });
    const result = await runTool(toolOf(h), "call-1", { files: ["shot.png"] });
    const text = resultText(result);
    expect(text).toContain("【图片 1】\n");
    expect(text).toContain("【图片 2 · shot.png】");
    // Inbox was consumed even when mixed with file images.
    expect(h.deps.inbox()).toBeUndefined();
  });

  it("propagates file read failures with the offending path", async () => {
    const h = harness({ readImageFile: async (path) => { throw new Error(`ENOENT: ${path}`); } });
    await expect(runTool(toolOf(h), "call-1", { files: ["missing.png"] })).rejects.toThrow("读取图片文件失败：missing.png");
    expect(h.completeSimple).not.toHaveBeenCalled();
  });

  it("propagates recognition failures", async () => {
    const h = harness();
    h.setInbox({ images: [image("aaa")], question: "" });
    h.completeSimple.mockRejectedValue(new Error("上游 HTTP 500"));
    await expect(runTool(toolOf(h), "call-1", {})).rejects.toThrow("图片识别失败：上游 HTTP 500");
  });

  it("propagates the unconfigured-vision error from resolve", async () => {
    const h = harness();
    const deps = { ...h.deps, resolve: () => { throw new Error("当前模型不支持图片输入，请先切换多模态模型"); } };
    const tools = buildVisionTools(deps);
    h.setInbox({ images: [image("aaa")], question: "" });
    await expect(runTool(tools[0], "call-1", {})).rejects.toThrow("当前模型不支持图片输入");
  });

  it("caps the number of file paths per call", async () => {
    const h = harness();
    const files = Array.from({ length: 10 }, (_, i) => `${i}.png`);
    await runTool(toolOf(h), "call-1", { files });
    expect(h.readImageFile).toHaveBeenCalledTimes(5);
  });
});