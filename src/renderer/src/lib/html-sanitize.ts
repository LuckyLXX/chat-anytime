const blockedTags = new Set(["base", "embed", "iframe", "link", "meta", "object", "script"]);
const urlProperties = new Set(["action", "formAction", "href", "poster", "src", "xLinkHref"]);
const blockedBubbleScriptPattern = /(?:\beval\s*\(|\bnew\s+function\b|\bfetch\s*\(|\bxmlhttprequest\b|\bwebsocket\b|\beventsource\b|\bnavigator\b|\blocation\b|\bhistory\b|\blocalstorage\b|\bsessionstorage\b|\bindexeddb\b|\bcaches\b|document\s*\.\s*write|window\s*\.\s*open|\bglobalthis\b|\bself\b|\btop\b|\bparent\b|\bownerDocument\b|\bdefaultView\b|\bconstructor\b|\bprototype\b|__proto__|\bimport\s*\(|\brequire\s*\(|\bprocess\b)/iu;

export function sanitizeStyleDeclarations(styleText: string): string {
  const safeRules: string[] = [];
  for (const part of String(styleText || "").split(";")) {
    const separator = part.indexOf(":");
    if (separator < 1) continue;
    const property = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    if (!/^(?:--[a-z][\w-]*|[a-z][\w-]*)$/u.test(property) || /^on/iu.test(property) || !value || value.length > 500) continue;
    if (/expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|@import|url\s*\(/iu.test(`${property}: ${value}`)) continue;
    safeRules.push(`${property}: ${value}`);
  }
  return safeRules.slice(0, 50).join("; ");
}

function isSafeUrl(value: string, property: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.startsWith("javascript:") || normalized.startsWith("vbscript:") || normalized.startsWith("data:text/html")) return false;
  if (property === "href" || property === "formAction" || property === "action") {
    return /^(?:https?:|mailto:|tel:|#|\/|\.\.?\/)/iu.test(normalized);
  }
  return /^(?:https?:|file:\/\/|data:image\/(?:png|gif|jpe?g|webp);|\/|\.\.?\/)/iu.test(normalized);
}

function sanitizeClassValue(value: unknown): string[] {
  const names = Array.isArray(value) ? value : String(value || "").split(/\s+/u);
  return names
    .flatMap((name) => String(name).split(/\s+/u))
    .map((name) => name.trim())
    .filter((name) => /^[a-zA-Z0-9_:/.[\]%-]{1,96}$/u.test(name))
    .slice(0, 64);
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: unknown;
  properties?: Record<string, unknown>;
  children?: Array<HastNode | null | undefined>;
}

export interface RichHtmlSanitizeOptions {
  allowStyleTags?: boolean;
  allowBubbleScripts?: boolean;
  scopeSelector?: string;
}

function sanitizeBubbleScript(scriptText: string): string {
  const source = String(scriptText || "").trim();
  if (!source || source.length > 16_000 || blockedBubbleScriptPattern.test(source)) return "";
  return source;
}

function sanitizeNode(node: HastNode): void {
  if (node.type !== "element") {
    return;
  }
  const properties = node.properties ?? {};
  for (const key of Object.keys(properties)) {
    const value = properties[key];
    if (/^on/iu.test(key) || key.toLowerCase() === "srcset") {
      delete properties[key];
      continue;
    }
    if (key === "style") {
      const safeStyle = sanitizeStyleDeclarations(String(value || ""));
      if (safeStyle) properties[key] = safeStyle;
      else delete properties[key];
      continue;
    }
    if (key === "className") {
      const safeClasses = sanitizeClassValue(value);
      if (safeClasses.length) properties[key] = safeClasses;
      else delete properties[key];
      continue;
    }
    if (urlProperties.has(key) && !isSafeUrl(String(value || ""), key)) delete properties[key];
  }
  node.properties = properties;
}

function textContent(nodes: Array<HastNode | null | undefined> | undefined): string {
  return (nodes ?? []).map((node) => !node ? "" : node.type === "text" ? String(node.value ?? "") : textContent(node.children)).join("");
}

function splitCssSelectors(selectorText: string): string[] {
  const selectors: string[] = [];
  let current = "";
  let bracketDepth = 0;
  let parenthesisDepth = 0;

  for (const character of selectorText) {
    if (character === "[") bracketDepth += 1;
    if (character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (character === "(") parenthesisDepth += 1;
    if (character === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    if (character === "," && bracketDepth === 0 && parenthesisDepth === 0) {
      if (current.trim()) selectors.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (current.trim()) selectors.push(current.trim());
  return selectors;
}

function scopeCssSelector(selector: string, scopeSelector: string): string {
  const raw = selector.trim();
  if (!raw || !scopeSelector) return "";
  const replacedRoots = raw
    .replace(/:root\b/giu, scopeSelector)
    .replace(/(^|[\s>+~])(?:html|body)(?=[\s.#:[>+~]|$)/giu, `$1${scopeSelector}`);
  return replacedRoots.includes(scopeSelector) ? replacedRoots : `${scopeSelector} ${replacedRoots}`;
}

function serializeScopedCssRule(rule: CSSRule, scopeSelector: string): string {
  const styleRuleType = typeof CSSRule === "undefined" ? 1 : CSSRule.STYLE_RULE;
  const mediaRuleType = typeof CSSRule === "undefined" ? 4 : CSSRule.MEDIA_RULE;
  const supportsRuleType = typeof CSSRule === "undefined" ? 12 : CSSRule.SUPPORTS_RULE;
  if (rule.type === styleRuleType) {
    const styleRule = rule as CSSStyleRule;
    const selector = splitCssSelectors(styleRule.selectorText)
      .map((item) => scopeCssSelector(item, scopeSelector))
      .filter(Boolean)
      .join(", ");
    const declarations = sanitizeStyleDeclarations(styleRule.style.cssText);
    return selector && declarations ? `${selector} { ${declarations} }` : "";
  }
  if (rule.type === mediaRuleType || rule.type === supportsRuleType) {
    const groupRule = rule as CSSGroupingRule;
    const conditionText = (rule as CSSMediaRule | CSSSupportsRule).conditionText;
    const nested = Array.from(groupRule.cssRules)
      .map((child) => serializeScopedCssRule(child, scopeSelector))
      .filter(Boolean)
      .join("\n");
    if (!nested) return "";
    const name = rule.type === mediaRuleType ? "media" : "supports";
    return `@${name} ${conditionText} {\n${nested}\n}`;
  }
  return "";
}

/** Sanitize and scope assistant-authored CSS without allowing it to reach the app shell. */
export function sanitizeStyleTagCss(styleText: string, scopeSelector: string): string {
  const raw = String(styleText || "").trim();
  const scope = scopeSelector.trim();
  if (!raw || !scope || typeof document === "undefined") return "";
  const sourceWithoutImports = raw.replace(/@import\s+[^;{}]+;?/giu, "");
  if (/expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|url\s*\(/iu.test(sourceWithoutImports)) return "";

  const openCount = (sourceWithoutImports.match(/\{/gu) ?? []).length;
  const closeCount = (sourceWithoutImports.match(/\}/gu) ?? []).length;
  const source = openCount > closeCount ? `${sourceWithoutImports}${"\n}".repeat(openCount - closeCount)}` : sourceWithoutImports;
  try {
    const cssDocument = document.implementation.createHTMLDocument("");
    const style = cssDocument.createElement("style");
    style.textContent = source;
    cssDocument.head.append(style);
    return Array.from(style.sheet?.cssRules ?? [])
      .map((rule) => serializeScopedCssRule(rule, scope))
      .filter(Boolean)
      .join("\n");
  } catch {
    return "";
  }
}

/** Rehype plugin: sanitize raw assistant HTML before the schema sanitizer runs. */
export function sanitizeRichHtmlTree(options: RichHtmlSanitizeOptions = {}): (tree: unknown) => void {
  const allowStyleTags = options.allowStyleTags === true;
  const allowBubbleScripts = options.allowBubbleScripts === true;
  const scopeSelector = options.scopeSelector?.trim() ?? "";
  return (tree: unknown) => {
    const root = tree as HastNode;
    const visit = (node: HastNode | null | undefined): boolean => {
      if (!node || typeof node !== "object") return false;
      const tagName = String(node.tagName || "").toLowerCase();
      if (node.type === "element" && tagName === "style") {
        const safeCss = allowStyleTags ? sanitizeStyleTagCss(textContent(node.children), scopeSelector) : "";
        if (!safeCss) return false;
        node.children = [{ type: "text", value: safeCss }];
        return true;
      }
      if (node.type === "element" && tagName === "script") {
        const safeScript = allowBubbleScripts ? sanitizeBubbleScript(textContent(node.children)) : "";
        if (!safeScript) return false;
        node.properties = { type: "application/x-pidesktop-bubble-script" };
        node.children = [{ type: "text", value: safeScript }];
        return true;
      }
      sanitizeNode(node);
      if (!node.children) return true;
      node.children = node.children.filter((child) => {
        if (!child) return false;
        const childTagName = String(child.tagName || "").toLowerCase();
        if (child.type === "element" && blockedTags.has(childTagName) && childTagName !== "script") return false;
        return visit(child);
      });
      return true;
    };
    visit(root);
  };
}
