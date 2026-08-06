import type { ThemeColorKey, ThemeOverrideMode, ThemeOverrides, ThemePresetId } from "../../../shared/protocol";

export interface ThemePresetDefinition {
  id: ThemePresetId;
  name: string;
  description: string;
  swatches: readonly [string, string, string];
  css: string;
}

type ThemeVars = Record<string, string>;

const chatAnytimeVariableAliases: readonly [RegExp, string][] = [
  [/--bg-primary(?![-\w])/gu, "--surface"],
  [/--bg-secondary(?![-\w])/gu, "--surface-muted"],
  [/--bg-tertiary(?![-\w])/gu, "--surface-raised"],
  [/--bg-card(?![-\w])/gu, "--surface-raised"],
  [/--bg-hover(?![-\w])/gu, "--surface-button-hover"],
  [/--text-primary(?![-\w])/gu, "--text"],
  [/--text-secondary(?![-\w])/gu, "--text-muted"],
  [/--border-color(?![-\w])/gu, "--border"],
  [/--border-light(?![-\w])/gu, "--border-strong"],
  [/--accent-primary(?![-\w])/gu, "--accent"],
  [/--accent-secondary(?![-\w])/gu, "--accent-hover"],
  [/--accent-success(?![-\w])/gu, "--success"],
  [/--accent-danger(?![-\w])/gu, "--danger"]
];

const lightBase: ThemeVars = {
  "--chat-bg-image": "none",
  "--chat-bg-opacity": "0",
  "--chat-bg-size": "cover",
  "--chat-bg-repeat": "no-repeat",
  "--chat-bg-position": "center",
  "--surface": "#ffffff",
  "--surface-muted": "#f8fafc",
  "--surface-raised": "#f1f5f9",
  "--surface-conversation": "var(--surface)",
  "--surface-sidebar": "var(--surface-muted)",
  "--surface-sidebar-tabs": "var(--surface-raised)",
  "--surface-sidebar-hover": "var(--surface-raised)",
  "--surface-sidebar-active": "var(--accent-soft)",
  "--surface-sidebar-badge": "var(--surface-raised)",
  "--surface-input": "var(--surface)",
  "--surface-footer": "var(--surface-muted)",
  "--surface-detail": "var(--surface-muted)",
  "--surface-button-hover": "var(--surface-raised)",
  "--preview-surface": "var(--surface)",
  "--border": "#e2e8f0",
  "--border-strong": "#cbd5e1",
  "--border-message": "var(--border)",
  "--border-assistant": "var(--border)",
  "--blockquote-border": "var(--border-strong)",
  "--text": "#1e293b",
  "--text-muted": "#64748b",
  "--text-sidebar-active": "var(--text)",
  "--text-on-accent": "#ffffff",
  "--on-accent": "var(--text-on-accent)",
  "--text-on-user-bubble": "#ffffff",
  "--avatar-user-text": "#ffffff",
  "--avatar-assistant-text": "#ffffff",
  "--avatar-user": "var(--user-bubble)",
  "--avatar-assistant": "var(--text)",
  "--link": "var(--blue)",
  "--accent": "#4f46e5",
  "--accent-hover": "#4338ca",
  "--accent-soft": "#eef2ff",
  "--accent-text": "var(--accent-hover)",
  "--accent-border": "var(--accent-hover)",
  "--focus-ring": "rgb(99 102 241 / 32%)",
  "--selection-bg": "#c7d2fe",
  "--selection-text": "#1e1b4b",
  "--success": "#059669",
  "--success-soft": "#d1fae5",
  "--success-border": "#34d399",
  "--completed-border": "#34d399",
  "--danger": "#dc2626",
  "--danger-soft": "#fee2e2",
  "--danger-border": "#fca5a5",
  "--danger-text": "#b42318",
  "--warning": "#d97706",
  "--warning-soft": "#fef3c7",
  "--blue": "#2563eb",
  "--user-bubble": "#2563eb",
  "--user-bubble-border": "#1d4ed8",
  "--ai-bubble": "var(--surface)",
  "--tool-bubble-bg": "var(--accent-soft)",
  "--tool-bubble-border": "var(--border)",
  "--code-surface": "#0b1220",
  "--code-text": "#e5e7eb",
  "--inline-code-surface": "var(--accent-soft)",
  "--inline-code-text": "var(--accent-hover)",
  "--syntax-keyword": "#c026d3",
  "--syntax-string": "#047857",
  "--syntax-number": "#b45309",
  "--syntax-comment": "#64748b",
  "--syntax-title": "#2563eb",
  "--syntax-meta": "#fb7185",
  "--blockquote-surface": "var(--accent-soft)",
  "--diff-add-text": "#166534",
  "--diff-remove-text": "#b42318",
  "--diff-hunk-text": "#1d4ed8",
  "--diff-meta-text": "#4338ca",
  "--user-action-border": "rgb(255 255 255 / 42%)",
  "--user-action-surface": "rgb(255 255 255 / 16%)",
  "--panel-bg": "rgb(255 255 255 / 92%)",
  "--shadow-sm": "0 1px 2px rgb(15 23 42 / 6%)",
  "--shadow-md": "0 5px 18px rgb(15 23 42 / 8%)",
  "--shadow-lg": "0 22px 70px rgb(15 23 42 / 18%)",
  "--scrollbar-track": "var(--surface-muted)",
  "--scrollbar-thumb": "rgb(99 102 241 / 38%)",
  "--scrollbar-thumb-hover": "rgb(99 102 241 / 60%)",
  "--overlay": "rgb(15 23 42 / 42%)"
};

const darkBase: ThemeVars = {
  "--chat-bg-image": "none",
  "--chat-bg-opacity": "0",
  "--chat-bg-size": "cover",
  "--chat-bg-repeat": "no-repeat",
  "--chat-bg-position": "center",
  "--surface": "#172033",
  "--surface-muted": "#0b1220",
  "--surface-raised": "#1e293b",
  "--surface-conversation": "var(--surface)",
  "--surface-sidebar": "var(--surface-muted)",
  "--surface-sidebar-tabs": "var(--surface-raised)",
  "--surface-sidebar-hover": "var(--surface-raised)",
  "--surface-sidebar-active": "var(--accent-soft)",
  "--surface-sidebar-badge": "var(--surface-raised)",
  "--surface-input": "var(--surface)",
  "--surface-footer": "var(--surface-muted)",
  "--surface-detail": "var(--surface-muted)",
  "--surface-button-hover": "var(--surface-raised)",
  "--preview-surface": "var(--surface)",
  "--border": "#334155",
  "--border-strong": "#475569",
  "--border-message": "var(--border)",
  "--border-assistant": "var(--border)",
  "--blockquote-border": "var(--border-strong)",
  "--text": "#eef2ff",
  "--text-muted": "#a6b1c5",
  "--text-sidebar-active": "var(--text)",
  "--text-on-accent": "#ffffff",
  "--on-accent": "var(--text-on-accent)",
  "--text-on-user-bubble": "#ffffff",
  "--avatar-user-text": "#ffffff",
  "--avatar-assistant-text": "var(--surface)",
  "--avatar-user": "var(--user-bubble)",
  "--avatar-assistant": "var(--text)",
  "--link": "var(--blue)",
  "--accent": "#4f46e5",
  "--accent-hover": "#5b5bd6",
  "--accent-soft": "#25254b",
  "--accent-text": "#c4b5fd",
  "--accent-border": "var(--accent-hover)",
  "--focus-ring": "rgb(129 140 248 / 38%)",
  "--selection-bg": "#3730a3",
  "--selection-text": "#ffffff",
  "--success": "#34d399",
  "--success-soft": "#123c32",
  "--success-border": "#34d399",
  "--completed-border": "#34d399",
  "--danger": "#fb7185",
  "--danger-soft": "#4a1d2b",
  "--danger-border": "#fb7185",
  "--danger-text": "#fda4af",
  "--warning": "#fbbf24",
  "--warning-soft": "#4a3510",
  "--blue": "#93c5fd",
  "--user-bubble": "#2563eb",
  "--user-bubble-border": "#60a5fa",
  "--ai-bubble": "var(--surface)",
  "--tool-bubble-bg": "var(--accent-soft)",
  "--tool-bubble-border": "var(--border)",
  "--code-surface": "#0b1220",
  "--code-text": "#e5e7eb",
  "--inline-code-surface": "var(--accent-soft)",
  "--inline-code-text": "#c4b5fd",
  "--syntax-keyword": "#c4b5fd",
  "--syntax-string": "#86efac",
  "--syntax-number": "#fbbf24",
  "--syntax-comment": "#94a3b8",
  "--syntax-title": "#93c5fd",
  "--syntax-meta": "#fb7185",
  "--blockquote-surface": "var(--accent-soft)",
  "--diff-add-text": "#86efac",
  "--diff-remove-text": "#fda4af",
  "--diff-hunk-text": "#93c5fd",
  "--diff-meta-text": "#c4b5fd",
  "--user-action-border": "rgb(255 255 255 / 42%)",
  "--user-action-surface": "rgb(255 255 255 / 16%)",
  "--panel-bg": "rgb(23 32 51 / 94%)",
  "--shadow-sm": "0 1px 2px rgb(0 0 0 / 20%)",
  "--shadow-md": "0 8px 24px rgb(0 0 0 / 24%)",
  "--shadow-lg": "0 22px 70px rgb(0 0 0 / 45%)",
  "--scrollbar-track": "var(--surface-muted)",
  "--scrollbar-thumb": "rgb(129 140 248 / 42%)",
  "--scrollbar-thumb-hover": "rgb(129 140 248 / 68%)",
  "--overlay": "rgb(0 0 0 / 58%)"
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
      "--surface": "#0c1929", "--surface-muted": "#132f4c", "--surface-raised": "#1a3f5e", "--border": "#1e3a5f", "--border-strong": "#2a4d72", "--accent": "#0ea5e9", "--accent-hover": "#38bdf8", "--accent-soft": "#163b58", "--blue": "#7dd3fc", "--user-bubble": "#0369a1", "--text-on-accent": "#082f49", "--on-accent": "#082f49", "--panel-bg": "rgb(19 47 76 / 94%)"
    }, {
      "--surface": "#f0f7ff", "--surface-muted": "#e0efff", "--surface-raised": "#dbeafe", "--border": "#bfdbfe", "--border-strong": "#93c5fd", "--accent": "#0284c7", "--accent-hover": "#0369a1", "--accent-soft": "#dbeafe", "--blue": "#0369a1", "--user-bubble": "#0369a1", "--text-on-accent": "#ffffff", "--on-accent": "#ffffff", "--panel-bg": "rgb(224 239 255 / 92%)"
    })
  },
  {
    id: "emerald", name: "翡翠", description: "清晰的绿色工作台", swatches: ["#0a1f1a", "#143d30", "#10b981"],
    css: presetCss("emerald", {
      "--surface": "#0a1f1a", "--surface-muted": "#0f2e24", "--surface-raised": "#143d30", "--border": "#1a3d30", "--border-strong": "#265a48", "--accent": "#10b981", "--accent-hover": "#34d399", "--accent-soft": "#123d30", "--blue": "#7dd3fc", "--user-bubble": "#047857", "--text-on-accent": "#052e16", "--on-accent": "#052e16", "--panel-bg": "rgb(15 46 36 / 94%)"
    }, {
      "--surface": "#f0fdf4", "--surface-muted": "#dcfce7", "--surface-raised": "#bbf7d0", "--border": "#86efac", "--border-strong": "#4ade80", "--accent": "#059669", "--accent-hover": "#047857", "--accent-soft": "#dcfce7", "--blue": "#1769aa", "--user-bubble": "#047857", "--text-on-accent": "#022c22", "--on-accent": "#022c22", "--panel-bg": "rgb(220 252 231 / 92%)"
    })
  },
  {
    id: "indigo", name: "靛蓝", description: "深色编辑台", swatches: ["#111827", "#273449", "#818cf8"],
    css: presetCss("indigo", {
      "--surface": "#111827", "--surface-muted": "#0b1220", "--surface-raised": "#1b2638", "--border": "#334155", "--border-strong": "#475569", "--accent": "#818cf8", "--accent-hover": "#a5b4fc", "--accent-soft": "#25254b", "--user-bubble": "#4f46e5", "--text-on-accent": "#1e1b4b", "--on-accent": "#1e1b4b"
    }, {
      "--surface": "#f5f7ff", "--surface-muted": "#eef2ff", "--surface-raised": "#e0e7ff", "--border": "#c7d2fe", "--border-strong": "#a5b4fc", "--accent": "#4f46e5", "--accent-hover": "#4338ca", "--accent-soft": "#e0e7ff", "--user-bubble": "#4f46e5", "--text-on-accent": "#ffffff", "--on-accent": "#ffffff"
    })
  },
  {
    id: "forest", name: "松林", description: "低饱和绿色", swatches: ["#f2f7f3", "#d8e8dc", "#16794b"],
    css: presetCss("forest", {
      "--surface": "#17251b", "--surface-muted": "#102017", "--surface-raised": "#213326", "--border": "#34513d", "--border-strong": "#4d7057", "--accent": "#55b77a", "--accent-hover": "#7bd39a", "--accent-soft": "#21452e", "--blue": "#93c5fd", "--user-bubble": "#16794b", "--text-on-accent": "#052e16", "--on-accent": "#052e16", "--panel-bg": "rgb(23 37 27 / 94%)"
    }, {
      "--surface": "#f7fbf8", "--surface-muted": "#eef6f0", "--surface-raised": "#ffffff", "--border": "#c9ddce", "--border-strong": "#9fbea8", "--accent": "#16794b", "--accent-hover": "#0f623b", "--accent-soft": "#e1f0e5", "--blue": "#2a668f", "--user-bubble": "#16794b", "--text-on-accent": "#ffffff", "--on-accent": "#ffffff", "--panel-bg": "rgb(247 251 248 / 92%)"
    })
  },
  {
    id: "rose", name: "赤陶", description: "暖色高对比", swatches: ["#fffaf8", "#f1d9d1", "#b4534b"],
    css: presetCss("rose", {
      "--surface": "#2b1d1e", "--surface-muted": "#1c1315", "--surface-raised": "#3b2828", "--border": "#61413e", "--border-strong": "#855852", "--accent": "#f08b7d", "--accent-hover": "#ffb0a3", "--accent-soft": "#522c2d", "--blue": "#93c5fd", "--user-bubble": "#b4534b", "--text-on-accent": "#451a03", "--on-accent": "#451a03", "--panel-bg": "rgb(43 29 30 / 94%)"
    }, {
      "--surface": "#fffaf8", "--surface-muted": "#f9f0ed", "--surface-raised": "#ffffff", "--border": "#ead3cc", "--border-strong": "#d5aaa0", "--accent": "#b4534b", "--accent-hover": "#963f3a", "--accent-soft": "#f7e5e0", "--danger": "#b42318", "--blue": "#31658a", "--user-bubble": "#b4534b", "--text-on-accent": "#ffffff", "--on-accent": "#ffffff", "--panel-bg": "rgb(255 250 248 / 92%)"
    })
  },
  {
    id: "amber", name: "琥珀", description: "温暖的高亮工作台", swatches: ["#1a150a", "#3d3220", "#f59e0b"],
    css: presetCss("amber", {
      "--surface": "#211b0e", "--surface-muted": "#171208", "--surface-raised": "#3d3220", "--border": "#5f4b2a", "--border-strong": "#806538", "--accent": "#f59e0b", "--accent-hover": "#fbbf24", "--accent-soft": "#4b3717", "--blue": "#93c5fd", "--user-bubble": "#b45309", "--text-on-accent": "#422006", "--on-accent": "#422006", "--panel-bg": "rgb(61 50 32 / 94%)"
    }, {
      "--surface": "#fffbeb", "--surface-muted": "#fef3c7", "--surface-raised": "#fde68a", "--border": "#fcd34d", "--border-strong": "#fbbf24", "--accent": "#d97706", "--accent-hover": "#b45309", "--accent-soft": "#fef3c7", "--blue": "#1d4ed8", "--user-bubble": "#b45309", "--text-on-accent": "#422006", "--on-accent": "#422006", "--panel-bg": "rgb(254 243 199 / 92%)"
    })
  },
  {
    id: "violet", name: "紫罗兰", description: "沉浸式紫色工作台", swatches: ["#13091f", "#2a1850", "#8b5cf6"],
    css: presetCss("violet", {
      "--surface": "#1b1028", "--surface-muted": "#100719", "--surface-raised": "#2a1850", "--border": "#46316e", "--border-strong": "#62469a", "--accent": "#a78bfa", "--accent-hover": "#c4b5fd", "--accent-soft": "#392269", "--blue": "#93c5fd", "--user-bubble": "#7c3aed", "--text-on-accent": "#1e1b4b", "--on-accent": "#1e1b4b", "--panel-bg": "rgb(42 24 80 / 94%)"
    }, {
      "--surface": "#f5f3ff", "--surface-muted": "#ede9fe", "--surface-raised": "#ddd6fe", "--border": "#c4b5fd", "--border-strong": "#a78bfa", "--accent": "#7c3aed", "--accent-hover": "#6d28d9", "--accent-soft": "#ede9fe", "--blue": "#2563eb", "--user-bubble": "#7c3aed", "--text-on-accent": "#ffffff", "--on-accent": "#ffffff", "--panel-bg": "rgb(237 233 254 / 92%)"
    })
  },
  {
    id: "carbon", name: "碳灰", description: "克制的中性深色", swatches: ["#18181b", "#3f3f46", "#3b82f6"],
    css: presetCss("carbon", {
      "--surface": "#18181b", "--surface-muted": "#101012", "--surface-raised": "#27272a", "--border": "#3f3f46", "--border-strong": "#52525b", "--accent": "#60a5fa", "--accent-hover": "#93c5fd", "--accent-soft": "#1e3a5f", "--blue": "#93c5fd", "--user-bubble": "#2563eb", "--text-on-accent": "#172033", "--on-accent": "#172033", "--panel-bg": "rgb(39 39 42 / 94%)"
    }, {
      "--surface": "#fafafa", "--surface-muted": "#f4f4f5", "--surface-raised": "#e4e4e7", "--border": "#d4d4d8", "--border-strong": "#a1a1aa", "--accent": "#2563eb", "--accent-hover": "#1d4ed8", "--accent-soft": "#dbeafe", "--blue": "#1d4ed8", "--user-bubble": "#2563eb", "--text-on-accent": "#ffffff", "--on-accent": "#ffffff", "--panel-bg": "rgb(250 250 250 / 92%)"
    })
  }
];

export const THEME_PRESETS: readonly ThemePresetDefinition[] = presetDefinitions;

export function themePresetCss(id: ThemePresetId): string {
  return THEME_PRESETS.find((preset) => preset.id === id)?.css ?? "";
}

const themeColorVariables: Record<ThemeColorKey, string> = {
  accent: "--accent",
  accentHover: "--accent-hover",
  userBubble: "--user-bubble",
  aiBubble: "--ai-bubble"
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function resolveThemeVariable(value: string, vars: ThemeVars, seen = new Set<string>()): string {
  const match = /^var\((--[\w-]+)\)$/u.exec(value.trim());
  const variable = match?.[1];
  if (!variable || seen.has(variable)) return value.trim();
  const next = vars[variable];
  if (!next) return value.trim();
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return resolveThemeVariable(next, vars, nextSeen);
}

function presetModeVars(id: ThemePresetId, mode: ThemeOverrideMode): ThemeVars {
  const vars = { ...(mode === "dark" ? darkBase : lightBase) };
  const css = themePresetCss(id);
  if (!css) return vars;
  const selector = mode === "dark"
    ? `:root[data-theme-preset="${id}"][data-theme="dark"]`
    : `:root[data-theme-preset="${id}"]`;
  const block = new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`, "u").exec(css)?.[1] ?? "";
  for (const declaration of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
    const variable = declaration[1];
    const value = declaration[2];
    if (variable && value) vars[variable] = value.trim();
  }
  return vars;
}

/** Return the resolved default value for one of the four ChatAnyTime color controls. */
export function themePresetColor(id: ThemePresetId, mode: ThemeOverrideMode, key: ThemeColorKey): string {
  const vars = presetModeVars(id, mode);
  return resolveThemeVariable(vars[themeColorVariables[key]] ?? "#000000", vars);
}

/** Build independent light/dark override rules for the main document or a preview scope. */
export function themeOverrideCss(overrides: ThemeOverrides, scopeSelector = ":root"): string {
  return (["light", "dark"] as const).flatMap((mode) => {
    const declarationsForMode = Object.entries(overrides[mode] ?? {})
      .map(([key, value]) => [themeColorVariables[key as ThemeColorKey], value] as const)
      .filter(([variable, value]) => Boolean(variable) && /^#[\da-f]{6}$/iu.test(value ?? ""));
    if (declarationsForMode.length === 0) return [];
    return `${scopeSelector}[data-theme-effective="${mode}"] {\n${declarationsForMode.map(([variable, value]) => `  ${variable}: ${value};`).join("\n")}\n}`;
  }).join("\n");
}

function baseThemeCssForScope(scopeSelector: string): string {
  return `
${scopeSelector}[data-theme-effective="light"] {
${declarations(lightBase)}
}

${scopeSelector}[data-theme-effective="dark"] {
${declarations(darkBase)}
}
`;
}

/**
 * Build the same light/dark preset variables for a nested preview scope. The
 * main window uses :root selectors, while a preview must not mutate them.
 */
export function themePreviewCss(id: ThemePresetId, scopeSelector = ".theme-preview-scope"): string {
  return `${baseThemeCssForScope(scopeSelector)}\n${themePresetCss(id).replaceAll(":root", scopeSelector)}`;
}

function normalizeChatAnyTimeVariables(css: string): string {
  return chatAnytimeVariableAliases.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), css);
}

function scopeModeSelectors(css: string, rootSelector: string): string {
  const commonRootSelector = `${rootSelector}[data-theme-effective]`;
  return css
    .replace(/html\.has-wallpaper:not\(\.theme-light\)/gu, `${rootSelector}[data-theme-wallpaper="true"][data-theme-effective="dark"]`)
    .replace(/html\.has-wallpaper\.theme-light/gu, `${rootSelector}[data-theme-wallpaper="true"][data-theme-effective="light"]`)
    .replace(/html\.has-wallpaper/gu, `${rootSelector}[data-theme-wallpaper="true"]`)
    .replace(/html\.theme-light/gu, `${rootSelector}[data-theme-effective="light"]`)
    .replace(/html\.theme-dark/gu, `${rootSelector}[data-theme-effective="dark"]`)
    .replace(/html:not\(\.theme-light\)/gu, `${rootSelector}[data-theme-effective="dark"]`)
    .replace(/:root(?=\[(?!data-theme-custom\b))/gu, rootSelector)
    .replace(/:root(?!\[data-theme-custom\])/gu, commonRootSelector)
    .replace(/(?<![\w-])\.message-bubble(?![\w-])/gu, `${rootSelector} .message-bubble`);
}

/**
 * Give user-authored root rules one extra attribute of specificity so they can
 * override preset variables while keeping ordinary component selectors in the
 * same cascade as the app stylesheet.
 */
export function scopeCustomThemeCss(css: string, rootSelector = ":root[data-theme-custom]"): string {
  return scopeModeSelectors(normalizeChatAnyTimeVariables(String(css || "")), rootSelector);
}

/**
 * Adapt the selector names used by ChatAnyTime theme templates to a nested
 * preview pane. Variable declarations remain user-authored CSS; only the
 * document-level mode selectors need to be redirected.
 */
export function scopeCustomThemeCssForPreview(css: string, scopeSelector = ".theme-preview-scope[data-theme-custom]"): string {
  return scopeModeSelectors(normalizeChatAnyTimeVariables(String(css || "")), scopeSelector);
}
