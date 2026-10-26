// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { COMPOSER_TEXTAREA_MAX_HEIGHT, COMPOSER_TEXTAREA_MIN_HEIGHT, isComposerTextareaAtBottom, planComposerTextareaSize, resizeComposerTextarea } from "./composer-input";

describe("composer 输入框自适应高度", () => {
  it("单行时保持 32px 基线且不滚动", () => {
    expect(planComposerTextareaSize({ contentHeight: 23, scrollTop: 0, atBottom: true })).toEqual({
      height: COMPOSER_TEXTAREA_MIN_HEIGHT,
      overflowY: "hidden",
      scrollTop: 0
    });
  });

  it("未到上限时按内容增高", () => {
    expect(planComposerTextareaSize({ contentHeight: 180, scrollTop: 0, atBottom: true })).toEqual({
      height: 180,
      overflowY: "hidden",
      scrollTop: 0
    });
  });

  it("到上限后停止增高并改为内部滚动", () => {
    expect(planComposerTextareaSize({ contentHeight: 420, scrollTop: 240, atBottom: true })).toEqual({
      height: COMPOSER_TEXTAREA_MAX_HEIGHT,
      overflowY: "auto",
      scrollTop: 420
    });
  });

  it("贴底编辑保持贴底；在中间编辑保持原滚动位置", () => {
    expect(planComposerTextareaSize({ contentHeight: 420, scrollTop: 160, atBottom: false }).scrollTop).toBe(160);
    expect(planComposerTextareaSize({ contentHeight: 420, scrollTop: 0, atBottom: true }).scrollTop).toBe(420);
  });

  it("CSS 上限（主题覆盖）通过参数生效", () => {
    expect(planComposerTextareaSize({ contentHeight: 300, scrollTop: 0, atBottom: false }, 200)).toEqual({
      height: 200,
      overflowY: "auto",
      scrollTop: 0
    });
  });

  it("距底部 4px 内仍视为贴底（scrollHeight/clientHeight 的整数与小数误差）", () => {
    expect(isComposerTextareaAtBottom(316, 240, 73)).toBe(true);
    expect(isComposerTextareaAtBottom(316, 240, 60)).toBe(false);
  });
});

describe("resizeComposerTextarea", () => {
  it("先把高度重置为 auto 再量内容，避免删除内容后缩不回去", () => {
    const textarea = document.createElement("textarea");
    let scrollHeight = 500;
    let measuredAtHeight = "";
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get() {
        measuredAtHeight = textarea.style.height;
        return scrollHeight;
      }
    });
    Object.defineProperty(textarea, "clientHeight", { configurable: true, value: 240 });

    resizeComposerTextarea(textarea, 240);
    expect(measuredAtHeight).toBe("auto");
    expect(textarea.style.height).toBe("240px");
    expect(textarea.style.overflowY).toBe("auto");

    scrollHeight = 60; // 内容删到两行 → 应缩回内容高度
    resizeComposerTextarea(textarea, 240);
    expect(textarea.style.height).toBe("60px");
    expect(textarea.style.overflowY).toBe("hidden");
    expect(textarea.scrollTop).toBe(0);
  });
});
