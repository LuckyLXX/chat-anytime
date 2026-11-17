export interface SelectionRect { left: number; top: number; right: number; bottom: number }

/** 把选区附近的控件限制在可见区域内；上方空间不足时优先放下方。 */
export function positionSelectionPopover(anchor: SelectionRect, bounds: SelectionRect, width: number, height: number): { left: number; top: number } {
  const gap = 8;
  const minLeft = bounds.left + gap;
  const maxLeft = Math.max(minLeft, bounds.right - width - gap);
  const minTop = bounds.top + gap;
  const maxTop = Math.max(minTop, bounds.bottom - height - gap);
  const above = anchor.top - height - gap;
  const below = anchor.bottom + gap;
  return {
    left: Math.max(minLeft, Math.min(anchor.left, maxLeft)),
    top: Math.max(minTop, Math.min(above >= minTop ? above : below, maxTop))
  };
}
