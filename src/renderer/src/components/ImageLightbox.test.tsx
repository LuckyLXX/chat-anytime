// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "./ImageLightbox";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  delete document.documentElement.dataset.uiMotion;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(image: { src: string; alt?: string } | undefined, onClose: () => void = () => undefined): void {
  act(() => { root.render(<ImageLightbox image={image} onClose={onClose} />); });
}

describe("ImageLightbox", () => {
  it("portals the overlay to document.body instead of the message container", () => {
    render({ src: "pidesktop-file://preview/x/y.png", alt: "fox" });
    // 气泡带 content-visibility:auto（隐含 paint containment），内联渲染会让
    // position:fixed 的遮罩以气泡为包含块、被气泡宽度裁切——必须挂在 body 下。
    expect(container.querySelector(".modal-backdrop")).toBeNull();
    const overlay = document.body.querySelector(".modal-backdrop.image-lightbox");
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector("img")?.getAttribute("src")).toBe("pidesktop-file://preview/x/y.png");
    expect(overlay?.querySelector("img")?.getAttribute("alt")).toBe("fox");
  });

  it("closes on Escape and on backdrop mousedown", () => {
    const onClose = vi.fn();
    render({ src: "a.png" }, onClose);
    act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => { document.body.querySelector<HTMLElement>(".modal-backdrop")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps the overlay mounted through the 160ms exit window", () => {
    vi.useFakeTimers();
    render({ src: "a.png" });
    render(undefined);
    expect(document.body.querySelector(".modal-backdrop")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(160); });
    expect(document.body.querySelector(".modal-backdrop")).toBeNull();
  });
});
