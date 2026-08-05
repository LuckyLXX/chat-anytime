import type { ThemePresetId } from "../../../shared/protocol";

export interface ThemePresetDefinition {
  id: ThemePresetId;
  name: string;
  description: string;
  swatches: readonly [string, string, string];
  css: string;
}

type ThemeVars = Record<string, string>;

const lightBase: ThemeVars = {
  "--surface": "#ffffff",
  "--surface-muted": "#f8fafc",
  "--surface-raised": "#f1f5f9",
  "--border": "#e2e8f0",
  "--border-strong": "#cbd5e1",
  "--text": "#1e293b",
  "--text-muted": "#64748b",
  "--accent": "#6366f1",
  "--accent-hover": "#4f46e5",
  "--accent-soft": "#eef2ff",
  "--danger": "#dc2626",
  "--warning": "#d97706",
  "--blue": "#2563eb",
  "--code-surface": "#0b1220",
  "--code-text": "#e5e7eb",
  "--syntax-keyword": "#c026d3",
  "--syntax-string": "#047857",
  "--syntax-number": "#b45309",
  "--syntax-comment": "#64748b",
  "--syntax-title": "#2563eb",
  "--syntax-meta": "#b42318",
  "--panel-bg": "rgb(255 255 255 / 92%)",
  "--shadow-sm": "0 1px 2px rgb(15 23 42 / 6%)",
  "--shadow-md": "0 5px 18px rgb(15 23 42 / 8%)"
};

const darkBase: ThemeVars = {
  "--surface": "#172033",
  "--surface-muted": "#0b1220",
  "--surface-raised": "#1e293b",
  "--border": "#334155",
  "--border-strong": "#475569",
  "--text": "#eef2ff",
  "--text-muted": "#a6b1c5",
  "--accent": "#818cf8",
  "--accent-hover": "#a5b4fc",
  "--accent-soft": "#25254b",
  "--danger": "#fb7185",
  "--warning": "#fbbf24",
  "--blue": "#93c5fd",
  "--code-surface": "#0b1220",
  "--code-text": "#e5e7eb",
  "--syntax-keyword": "#c4b5fd",
  "--syntax-string": "#86efac",
  "--syntax-number": "#fbbf24",
  "--syntax-comment": "#94a3b8",
  "--syntax-title": "#93c5fd",
  "--syntax-meta": "#fb7185",
  "--panel-bg": "rgb(23 32 51 / 94%)",
  "--shadow-sm": "0 1px 2px rgb(0 0 0 / 20%)",
  "--shadow-md": "0 8px 24px rgb(0 0 0 / 24%)"
};

function declarations(vars: ThemeVars): string {
  return Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`).join("\n");
}

function presetCss(id: Exclude<ThemePresetId, "default">, darkOverrides: ThemeVars, lightOverrides: ThemeVars): string {
  const selector = `:root[data-theme-preset="${id}"]`;
  return `
${selector} {
${declarations({ ...lightBase, ...lightOverrides })}
}

${selector}[data-theme="dark"] {
${declarations({ ...darkBase, ...darkOverrides })}
}

@media (prefers-color-scheme: dark) {
  ${selector}[data-theme="system"] {
${declarations({ ...darkBase, ...darkOverrides })}
  }
}
`;
}

const presetDefinitions: ThemePresetDefinition[] = [
  { id: "default", name: "标准", description: "中性工作台", swatches: ["#f8fafc", "#e2e8f0", "#6366f1"], css: "" },
  {
    id: "ocean", name: "海洋", description: "冷静的蓝色工作台", swatches: ["#0c1929", "#1a3f5e", "#0ea5e9"],
    css: presetCss("ocean", {
      "--surface": "#0c1929", "--surface-muted": "#132f4c", "--surface-raised": "#1a3f5e", "--border": "#1e3a5f", "--border-strong": "#2a4d72", "--accent": "#0ea5e9", "--accent-hover": "#38bdf8", "--accent-soft": "#163b58", "--blue": "#7dd3fc", "--panel-bg": "rgb(19 47 76 / 94%)"
    }, {
      "--surface": "#f0f7ff", "--surface-muted": "#e0efff", "--surface-raised": "#dbeafe", "--border": "#bfdbfe", "--border-strong": "#93c5fd", "--accent": "#0284c7", "--accent-hover": "#0369a1", "--accent-soft": "#dbeafe", "--blue": "#0369a1", "--panel-bg": "rgb(224 239 255 / 92%)"
    })
  },
  {
    id: "emerald", name: "翡翠", description: "清晰的绿色工作台", swatches: ["#0a1f1a", "#143d30", "#10b981"],
    css: presetCss("emerald", {
      "--surface": "#0a1f1a", "--surface-muted": "#0f2e24", "--surface-raised": "#143d30", "--border": "#1a3d30", "--border-strong": "#265a48", "--accent": "#10b981", "--accent-hover": "#34d399", "--accent-soft": "#123d30", "--blue": "#7dd3fc", "--panel-bg": "rgb(15 46 36 / 94%)"
    }, {
      "--surface": "#f0fdf4", "--surface-muted": "#dcfce7", "--surface-raised": "#bbf7d0", "--border": "#86efac", "--border-strong": "#4ade80", "--accent": "#059669", "--accent-hover": "#047857", "--accent-soft": "#dcfce7", "--blue": "#1769aa", "--panel-bg": "rgb(220 252 231 / 92%)"
    })
  },
  {
    id: "indigo", name: "靛蓝", description: "深色编辑台", swatches: ["#111827", "#273449", "#818cf8"],
    css: presetCss("indigo", {
      "--surface": "#111827", "--surface-muted": "#0b1220", "--surface-raised": "#1b2638", "--border": "#334155", "--border-strong": "#475569", "--accent": "#818cf8", "--accent-hover": "#a5b4fc", "--accent-soft": "#25254b"
    }, {
      "--surface": "#f5f7ff", "--surface-muted": "#eef2ff", "--surface-raised": "#e0e7ff", "--border": "#c7d2fe", "--border-strong": "#a5b4fc", "--accent": "#4f46e5", "--accent-hover": "#4338ca", "--accent-soft": "#e0e7ff"
    })
  },
  {
    id: "forest", name: "松林", description: "低饱和绿色", swatches: ["#f2f7f3", "#d8e8dc", "#16794b"],
    css: presetCss("forest", {
      "--surface": "#17251b", "--surface-muted": "#102017", "--surface-raised": "#213326", "--border": "#34513d", "--border-strong": "#4d7057", "--accent": "#55b77a", "--accent-hover": "#7bd39a", "--accent-soft": "#21452e", "--blue": "#93c5fd", "--panel-bg": "rgb(23 37 27 / 94%)"
    }, {
      "--surface": "#f7fbf8", "--surface-muted": "#eef6f0", "--surface-raised": "#ffffff", "--border": "#c9ddce", "--border-strong": "#9fbea8", "--accent": "#16794b", "--accent-hover": "#0f623b", "--accent-soft": "#e1f0e5", "--blue": "#2a668f", "--panel-bg": "rgb(247 251 248 / 92%)"
    })
  },
  {
    id: "rose", name: "赤陶", description: "暖色高对比", swatches: ["#fffaf8", "#f1d9d1", "#b4534b"],
    css: presetCss("rose", {
      "--surface": "#2b1d1e", "--surface-muted": "#1c1315", "--surface-raised": "#3b2828", "--border": "#61413e", "--border-strong": "#855852", "--accent": "#f08b7d", "--accent-hover": "#ffb0a3", "--accent-soft": "#522c2d", "--blue": "#93c5fd", "--panel-bg": "rgb(43 29 30 / 94%)"
    }, {
      "--surface": "#fffaf8", "--surface-muted": "#f9f0ed", "--surface-raised": "#ffffff", "--border": "#ead3cc", "--border-strong": "#d5aaa0", "--accent": "#b4534b", "--accent-hover": "#963f3a", "--accent-soft": "#f7e5e0", "--danger": "#b42318", "--blue": "#31658a", "--panel-bg": "rgb(255 250 248 / 92%)"
    })
  },
  {
    id: "amber", name: "琥珀", description: "温暖的高亮工作台", swatches: ["#1a150a", "#3d3220", "#f59e0b"],
    css: presetCss("amber", {
      "--surface": "#211b0e", "--surface-muted": "#171208", "--surface-raised": "#3d3220", "--border": "#5f4b2a", "--border-strong": "#806538", "--accent": "#f59e0b", "--accent-hover": "#fbbf24", "--accent-soft": "#4b3717", "--blue": "#93c5fd", "--panel-bg": "rgb(61 50 32 / 94%)"
    }, {
      "--surface": "#fffbeb", "--surface-muted": "#fef3c7", "--surface-raised": "#fde68a", "--border": "#fcd34d", "--border-strong": "#fbbf24", "--accent": "#d97706", "--accent-hover": "#b45309", "--accent-soft": "#fef3c7", "--blue": "#1d4ed8", "--panel-bg": "rgb(254 243 199 / 92%)"
    })
  },
  {
    id: "violet", name: "紫罗兰", description: "沉浸式紫色工作台", swatches: ["#13091f", "#2a1850", "#8b5cf6"],
    css: presetCss("violet", {
      "--surface": "#1b1028", "--surface-muted": "#100719", "--surface-raised": "#2a1850", "--border": "#46316e", "--border-strong": "#62469a", "--accent": "#a78bfa", "--accent-hover": "#c4b5fd", "--accent-soft": "#392269", "--blue": "#93c5fd", "--panel-bg": "rgb(42 24 80 / 94%)"
    }, {
      "--surface": "#f5f3ff", "--surface-muted": "#ede9fe", "--surface-raised": "#ddd6fe", "--border": "#c4b5fd", "--border-strong": "#a78bfa", "--accent": "#7c3aed", "--accent-hover": "#6d28d9", "--accent-soft": "#ede9fe", "--blue": "#2563eb", "--panel-bg": "rgb(237 233 254 / 92%)"
    })
  },
  {
    id: "carbon", name: "碳灰", description: "克制的中性深色", swatches: ["#18181b", "#3f3f46", "#3b82f6"],
    css: presetCss("carbon", {
      "--surface": "#18181b", "--surface-muted": "#101012", "--surface-raised": "#27272a", "--border": "#3f3f46", "--border-strong": "#52525b", "--accent": "#60a5fa", "--accent-hover": "#93c5fd", "--accent-soft": "#1e3a5f", "--blue": "#93c5fd", "--panel-bg": "rgb(39 39 42 / 94%)"
    }, {
      "--surface": "#fafafa", "--surface-muted": "#f4f4f5", "--surface-raised": "#e4e4e7", "--border": "#d4d4d8", "--border-strong": "#a1a1aa", "--accent": "#2563eb", "--accent-hover": "#1d4ed8", "--accent-soft": "#dbeafe", "--blue": "#1d4ed8", "--panel-bg": "rgb(250 250 250 / 92%)"
    })
  }
];

export const THEME_PRESETS: readonly ThemePresetDefinition[] = presetDefinitions;

export function themePresetCss(id: ThemePresetId): string {
  return THEME_PRESETS.find((preset) => preset.id === id)?.css ?? "";
}
