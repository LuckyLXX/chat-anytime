import { useId } from "react";

/**
 * ChatAnyTime 品牌字标：蓝绿渐变圆角方块 + 白色几何 CA 笔画。
 * 与应用图标（build/icon-master.png，生成稿 icon-drafts/draft-1）同风格，
 * 颜色自包含，不随主题变化。
 */
export function BrandMark({ size = 20, radius = 14.4, title = "ChatAnyTime" }: { size?: number; radius?: number; title?: string }) {
  const gradientId = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2F80F7" />
          <stop offset="1" stopColor="#2BD48F" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="64" height="64" rx={radius} fill={`url(#${gradientId})`} />
      <g fill="none" stroke="#ffffff" strokeWidth="46" strokeLinecap="round" strokeLinejoin="round" transform="scale(0.125)">
        <path d="M234.5 178.2 A95 95 0 1 0 234.5 333.8" />
        <path d="M285 354 L355 158 L425 354" />
        <path d="M302 298 L408 298" />
      </g>
    </svg>
  );
}
