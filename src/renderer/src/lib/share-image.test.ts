// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyPngToClipboard, resolveShareTarget, shareElementAsImage } from "./share-image";

const capture = vi.fn();
vi.mock("html2canvas-pro", () => ({ default: (...args: unknown[]) => capture(...args) as Promise<HTMLCanvasElement> }));

function stubClipboard(): { written: Blob[] } {
  const written: Blob[] = [];
  vi.stubGlobal("ClipboardItem", class TestClipboardItem {
    constructor(readonly items: Record<string, Blob>) {}
  });
  vi.stubGlobal("navigator", {
    clipboard: {
      write: (items: Array<{ items?: Record<string, Blob> }>) => {
        for (const item of items) {
          const blob = item.items?.["image/png"];
          if (blob) written.push(blob);
        }
        return Promise.resolve();
      }
    }
  });
  return { written };
}

/** 捕获 html2canvas 收到的离屏外壳，供断言「截了什么」。 */
function captureSurface(): HTMLElement {
  const surface = capture.mock.calls.at(-1)?.[0] as HTMLElement | undefined;
  if (!surface) throw new Error("html2canvas 未被调用");
  return surface;
}

describe("assistant share image clipboard", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    capture.mockReset();
    capture.mockImplementation(() => Promise.resolve({ toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["png"], { type: "image/png" })) }));
  });

  it("writes a PNG blob as an image clipboard item", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const blob = new Blob(["png"], { type: "image/png" });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", class TestClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    });

    await copyPngToClipboard(blob);

    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0]?.[0]?.[0] as { items?: Record<string, Blob> } | undefined;
    expect(item?.items?.["image/png"]).toBe(blob);
  });

  it("reports unsupported image clipboard environments", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("ClipboardItem", undefined);

    await expect(copyPngToClipboard(new Blob(["png"], { type: "image/png" }))).rejects.toThrow("当前环境不支持图片剪贴板");
  });
});

describe("assistant share framing", () => {
  /** 复刻消息结构：气泡正文（含 md 说明 + Div 气泡）、交付产物面板、操作按钮。 */
  function mountReply(options: { withBubble: boolean }): HTMLElement {
    document.body.innerHTML = `
      <article class="message message-assistant">
        <div class="message-body message-bubble" style="padding: 12px 15px; border-radius: 10px; border: 1px solid rgb(1, 2, 3); background-color: rgb(9, 9, 9); line-height: 1.65">
          <div class="assistant-share-content">
            <div class="rich-content">
              <p class="assistant-note">说明：先拉取数据，再整理成卡片。</p>
              ${options.withBubble ? '<div class="html-bubble scope-x" style="line-height: 23px"><div class="report-card"><h1>AI 每日新闻日报</h1></div></div>' : ""}
            </div>
          </div>
          <div class="message-actions"><button type="button">分享</button></div>
        </div>
      </article>`;
    const target = document.querySelector<HTMLElement>(".assistant-share-content");
    if (!target) throw new Error("fixture 缺失");
    return target;
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
    capture.mockReset();
    capture.mockImplementation(() => Promise.resolve({ toBlob: (callback: (blob: Blob) => void) => callback(new Blob(["png"], { type: "image/png" })) }));
  });

  it("targets the Div bubble when one is rendered", () => {
    const root = mountReply({ withBubble: true });
    expect(resolveShareTarget(root)).toBe(root.querySelector(".html-bubble"));
  });

  it("falls back to the whole reply content without a bubble", () => {
    const root = mountReply({ withBubble: false });
    expect(resolveShareTarget(root)).toBe(root);
  });

  it("shares only the card, without the markdown around it, when a bubble exists", async () => {
    stubClipboard();
    await shareElementAsImage(mountReply({ withBubble: true }));

    const surface = captureSurface();
    expect(surface.querySelector(".html-bubble")).not.toBeNull();
    expect(surface.textContent).toContain("AI 每日新闻日报");
    // 关键回归：气泡外的 md 说明不进图。
    expect(surface.textContent).not.toContain("先拉取数据");
    expect(surface.querySelector(".assistant-note")).toBeNull();
    // 紧贴卡片：外壳自身不带聊天气泡的底色/内距/边框。
    expect(surface.style.backgroundColor).toBe("");
    expect(surface.style.padding).toBe("");
    expect(surface.style.borderWidth).toBe("");
  });

  // 卡片分支的克隆必须活在 message-body + rich-content 里：这两个类的后代规则
  // （标题字号/段落边距/表格字号/无单位行高）决定了卡片在屏幕上的实际尺寸。
  // 真机探针实测：脱离该上下文时表格比屏幕高 10px、卡片高 23px。
  it("captures the card inside the same class context as the screen", async () => {
    stubClipboard();
    await shareElementAsImage(mountReply({ withBubble: true }));

    const surface = captureSurface();
    const context = surface.firstElementChild as HTMLElement;
    expect(context.className).toBe("message-body rich-content");
    // 克隆体保留卡片自己的 padding（3px 6px 是屏幕观感的一部分）。
    const clone = context.querySelector<HTMLElement>(".html-bubble");
    expect(clone?.style.padding).toBe("");
    // 行高不能拷成固定像素：卡内 12px 表格文字在屏幕上按 1.65 重算，
    // 被写死的 23.1px 会把表格行撜高（40px vs 37px）。
    expect(context.style.lineHeight).toBe("");
    expect(surface.style.lineHeight).toBe("");
  });

  it("keeps the whole reply (markdown included) when there is no bubble", async () => {
    stubClipboard();
    await shareElementAsImage(mountReply({ withBubble: false }));

    const surface = captureSurface();
    expect(surface.textContent).toContain("先拉取数据");
    expect(surface.querySelector(".assistant-note")).not.toBeNull();
    // 整块回复分支：外壳复刻聊天气泡的外框与内距。
    expect(surface.style.backgroundColor).toBe("rgb(9, 9, 9)");
    expect(surface.style.padding).not.toBe("");
  });
});
