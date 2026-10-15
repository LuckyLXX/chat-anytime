/**
 * 时间线的粘底属于用户意图，不能从一次 scroll 的底部间距反推：流式尾部节流、
 * 图片解码与 content-visibility 测高都会在父组件滚动之后改变布局并触发 scroll。
 * 保留现有消息级滚动；这里只补异步布局，并识别用户主动离开底部的操作。
 */
export function followTimelineBottom(timeline: HTMLElement, following: { current: boolean }, focused: boolean): () => void {
  let frame: number | undefined;
  let lastTop = timeline.scrollTop;
  const schedule = (): void => {
    if (!following.current || frame !== undefined) return;
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      if (!following.current) return;
      const height = timeline.scrollHeight;
      if (height - timeline.clientHeight - timeline.scrollTop > 1) {
        timeline.scrollTo({ top: height, behavior: "auto" });
      }
    });
  };
  const pause = (): void => {
    following.current = false;
    lastTop = timeline.scrollTop;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
  };
  const onScroll = (): void => {
    const top = timeline.scrollTop;
    const height = timeline.scrollHeight;
    const viewport = timeline.clientHeight;
    const gap = height - viewport - top;
    // scroll 也可能来自浏览器滚动锚定，甚至在 scrollHeight 不变时向上修正。
    // 解除跟随只看下面的真实输入；主动上翻后必须向下回到底部才重新启用。
    if (gap <= 64 && top > lastTop) following.current = true;
    lastTop = top;
    schedule();
  };
  const canScrollNested = (target: EventTarget | null, direction: number): boolean => {
    let node = target instanceof Element ? target : null;
    while (node && node !== timeline) {
      if (node instanceof HTMLElement) {
        const style = getComputedStyle(node);
        if (/auto|scroll/u.test(style.overflowY) && (direction < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight)) return true;
        // contain/none 的内部滚动区到边缘也不把手势传给时间线。
        if (/auto|scroll/u.test(style.overflowY) && /contain|none/u.test(style.overscrollBehaviorY || style.overscrollBehavior)) return true;
      }
      node = node.parentElement;
    }
    return false;
  };
  const onWheel = (event: WheelEvent): void => {
    if (!event.defaultPrevented && !event.ctrlKey && event.deltaY < 0 && timeline.scrollTop > 0 && !canScrollNested(event.target, -1)) pause();
  };
  const onPointerDown = (event: PointerEvent): void => {
    // 原生滚动条没有 wheel；只认时间线边缘的按下，点击消息或展开工具不暂停。
    if (event.target !== timeline || event.button !== 0) return;
    const rect = timeline.getBoundingClientRect();
    const gutter = Math.max(12, timeline.offsetWidth - timeline.clientWidth);
    if (event.clientX >= rect.right - gutter && timeline.scrollTop > 0) pause();
  };
  let touchY: number | undefined;
  const onTouchStart = (event: TouchEvent): void => { touchY = event.touches[0]?.clientY; };
  const onTouchMove = (event: TouchEvent): void => {
    const next = event.touches[0]?.clientY;
    if (next !== undefined && touchY !== undefined && next > touchY && timeline.scrollTop > 0 && !canScrollNested(event.target, -1)) pause();
    touchY = next;
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!timeline.contains(target) && !(focused && (target === document.body || target === document.documentElement))) return;
    if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    const upwards = event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" || (event.key === " " && event.shiftKey);
    if (upwards && timeline.scrollTop > 0 && !canScrollNested(target, -1)) pause();
  };

  // 单个观察器覆盖滚动视口与直属内容：不增加包装层（保持主题/窗口化契约），
  // 不扫描消息后代；新增/实体化条目只增量注册。多次测高合并到一帧，空闲不轮询。
  const resize = new ResizeObserver(schedule);
  resize.observe(timeline);
  for (const child of timeline.children) resize.observe(child);
  const mutations = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.removedNodes) if (node instanceof Element) resize.unobserve(node);
      for (const node of record.addedNodes) if (node instanceof Element) resize.observe(node);
    }
    schedule();
  });
  mutations.observe(timeline, { childList: true });
  timeline.addEventListener("scroll", onScroll, { passive: true });
  timeline.addEventListener("wheel", onWheel, { passive: true });
  timeline.addEventListener("pointerdown", onPointerDown, { passive: true });
  timeline.addEventListener("touchstart", onTouchStart, { passive: true });
  timeline.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("keydown", onKeyDown);
  return () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    resize.disconnect();
    mutations.disconnect();
    timeline.removeEventListener("scroll", onScroll);
    timeline.removeEventListener("wheel", onWheel);
    timeline.removeEventListener("pointerdown", onPointerDown);
    timeline.removeEventListener("touchstart", onTouchStart);
    timeline.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("keydown", onKeyDown);
  };
}
