import type { ThemePresetId } from "../../../shared/protocol";

export interface ThemePresetDefinition {
  id: ThemePresetId;
  name: string;
  description: string;
  swatches: readonly [string, string, string];
  css: string;
}

export const THEME_PRESETS: readonly ThemePresetDefinition[] = [
  {
    id: "default",
    name: "标准",
    description: "中性工作台",
    swatches: ["#f8fafc", "#e2e8f0", "#6366f1"],
    css: ""
  },
  {
    id: "indigo",
    name: "靛蓝",
    description: "深色编辑台",
    swatches: ["#111827", "#273449", "#818cf8"],
    css: `
:root[data-theme-preset="indigo"] {
  --surface: #111827;
  --surface-muted: #0b1220;
  --surface-raised: #1b2638;
  --border: #334155;
  --border-strong: #475569;
  --text: #eef2ff;
  --text-muted: #a6b1c5;
  --accent: #818cf8;
  --accent-hover: #a5b4fc;
  --accent-soft: #25254b;
  --danger: #fb7185;
  --warning: #fbbf24;
  --blue: #93c5fd;
  --code-surface: #0b1220;
  --code-text: #e5e7eb;
}
`
  },
  {
    id: "forest",
    name: "松林",
    description: "低饱和绿色",
    swatches: ["#f2f7f3", "#d8e8dc", "#16794b"],
    css: `
:root[data-theme-preset="forest"] {
  --surface: #f7fbf8;
  --surface-muted: #eef6f0;
  --surface-raised: #ffffff;
  --border: #c9ddce;
  --border-strong: #9fbea8;
  --text: #17251b;
  --text-muted: #5f7665;
  --accent: #16794b;
  --accent-hover: #0f623b;
  --accent-soft: #e1f0e5;
  --danger: #b83b43;
  --warning: #9a641d;
  --blue: #2a668f;
  --code-surface: #17231b;
  --code-text: #e8f2e9;
}
`
  },
  {
    id: "rose",
    name: "赤陶",
    description: "暖色高对比",
    swatches: ["#fffaf8", "#f1d9d1", "#b4534b"],
    css: `
:root[data-theme-preset="rose"] {
  --surface: #fffaf8;
  --surface-muted: #f9f0ed;
  --surface-raised: #ffffff;
  --border: #ead3cc;
  --border-strong: #d5aaa0;
  --text: #332321;
  --text-muted: #826966;
  --accent: #b4534b;
  --accent-hover: #963f3a;
  --accent-soft: #f7e5e0;
  --danger: #b42318;
  --warning: #9a5b1a;
  --blue: #31658a;
  --code-surface: #292021;
  --code-text: #fff7f4;
}
`
  }
] as const;

export function themePresetCss(id: ThemePresetId): string {
  return THEME_PRESETS.find((preset) => preset.id === id)?.css ?? "";
}
