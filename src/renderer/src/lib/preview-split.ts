export const PREVIEW_SPLIT_MIN = 24;
export const PREVIEW_SPLIT_MAX = 76;

export function clampPreviewSplit(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(PREVIEW_SPLIT_MAX, Math.max(PREVIEW_SPLIT_MIN, value));
}

export function previewSplitFromKey(key: string, current: number): number | undefined {
  if (key === "Home") return PREVIEW_SPLIT_MIN;
  if (key === "End") return PREVIEW_SPLIT_MAX;
  if (key === "ArrowLeft" || key === "ArrowUp") return clampPreviewSplit(current - 2);
  if (key === "ArrowRight" || key === "ArrowDown") return clampPreviewSplit(current + 2);
  return undefined;
}
