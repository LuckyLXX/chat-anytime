import type { ContextUsage } from "../../../shared/protocol";

/**
 * 上下文占用展示的纯函数集合。
 * 阈值语义与 pi CLI footer 一致：>70% 警告色，>90% 危险色。
 */

/** 12,300 → "12.3K"；1,250,000 → "1.3M"；800 → "800"。 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(Math.round(tokens / 100) / 10)}K`;
  return `${(Math.round(tokens / 100_000) / 10)}M`;
}

export type ContextUsageTone = "normal" | "warn" | "danger";

export function contextUsageTone(usage: ContextUsage): ContextUsageTone {
  const percent = usage.percent;
  if (percent == null) return "normal";
  if (percent > 90) return "danger";
  if (percent > 70) return "warn";
  return "normal";
}

/** chip 主文案：`62%`；压缩后 tokens 未知时显示 `—`。 */
export function contextUsagePercentLabel(usage: ContextUsage): string {
  if (usage.percent == null) return "—";
  // 与 pi CLI 一致保留一位小数；整数百分比不带小数尾巴。
  const rounded = Math.round(usage.percent * 10) / 10;
  return `${rounded}%`;
}

/** 缓存命中段：`93%`；无 usage 数据时返回空串（不渲染该段）。 */
export function contextUsageCacheLabel(usage: ContextUsage): string {
  if (usage.cacheHitRate == null) return "";
  return `${Math.round(usage.cacheHitRate)}%`;
}

/** 悬浮提示：`80.1K / 128K tokens（估算）· 缓存命中 93.2%`。 */
export function contextUsageTooltip(usage: ContextUsage): string {
  const lines: string[] = [];
  if (usage.tokens == null || usage.percent == null) {
    lines.push(`上下文窗口 ${formatTokenCount(usage.contextWindow)} tokens；压缩后暂无法估算，下一条回复后更新`);
  } else {
    lines.push(`上下文约 ${formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)} tokens（估算）`);
  }
  if (usage.cacheHitRate != null) {
    lines.push(`会话累计缓存命中 ${(Math.round(usage.cacheHitRate * 10) / 10)}%（越接近 100% 越省钱）`);
  }
  return lines.join("\n");
}
