import { useLayoutEffect, useState, type RefObject } from "react";

/** Measure the viewport's usable CSS pixels, excluding its scrollbars. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    function measure(): void {
      const { clientWidth: width, clientHeight: height } = element!;
      if (width > 0 && height > 0) {
        setSize((current) => current.width === width && current.height === height ? current : { width, height });
      }
    }
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
