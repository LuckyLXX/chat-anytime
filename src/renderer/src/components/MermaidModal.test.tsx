// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Mermaid 本体 ~2.5MB 且是动态 import；测试只关心「放大弹窗挂在哪里」，
// 所以直接替掉整个模块（MermaidBlock 走的是 import("mermaid").default）。
vi.mock("mermaid", () => ({
  default: {
    initialize: () => undefined,
    render: async () => ({ svg: '<svg data-fake="diagram"></svg>' })
  }
}));

import { RichContent } from "./RichContent";

/**
 * Mermaid 放大弹窗必须 portal 到 document.body。
 *
 * 背景：预览内容块现在带 `content-visibility: auto`（长文档只渲染可视区），该属性
 * 隐含 paint containment——内联渲染的 `position: fixed` 后代（.modal-backdrop）会以
 * 内容块为包含块、被裁在块宽度内。2026-09-09 的 ImageLightbox 就是栽在这条上，
 * 这里对 Mermaid 放大弹窗做同一约束的回归测试。
 */
describe("Mermaid 放大弹窗", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("portals the expanded diagram out of the content subtree", async () => {
    await act(async () => {
      root.render(
        <RichContent artifactPrefix="message-mermaid" onOpenArtifact={() => undefined}>
          {"```mermaid\nflowchart LR\n A --> B\n```"}
        </RichContent>
      );
    });
    // 等 mermaid 的动态 import + 渲染 settle 进 state
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const expand = container.querySelector<HTMLButtonElement>(".mermaid-actions button[aria-label='放大图表']");
    expect(expand).not.toBeNull();
    expect(container.querySelector(".modal-backdrop")).toBeNull();

    await act(async () => { expand!.click(); });

    // 弹窗必须挂在 body 下、不能留在气泡/预览内容子树里（cv 会把 fixed 困住）。
    expect(container.querySelector(".modal-backdrop")).toBeNull();
    const overlay = document.body.querySelector(".modal-backdrop");
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector(".diagram-modal")).not.toBeNull();
    // 内容块带 content-visibility:auto 时，约束的就是「不在它的子树内」。
    expect(overlay?.closest(".rich-content")).toBeNull();
  });
});
