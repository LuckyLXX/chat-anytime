import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyPngToClipboard } from "./share-image";

describe("assistant share image clipboard", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
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
