const blockedTags = new Set(["base", "embed", "iframe", "link", "meta", "object", "script"]);
const urlProperties = new Set(["action", "formAction", "href", "poster", "src", "xLinkHref"]);
const blockedBubbleScriptPattern = /(?:\beval\s*\(|\bnew\s+function\b|\bfetch\s*\(|\bxmlhttprequest\b|\bwebsocket\b|\beventsource\b|\bnavigator\b|\blocation\b|\bhistory\b|\blocalstorage\b|\bsessionstorage\b|\bindexeddb\b|\bcaches\b|document\s*\.\s*write|window\s*\.\s*open|\bglobalthis\b|\bself\b|\btop\b|\bparent\b|\bownerDocument\b|\bdefaultView\b|\bconstructor\b|\bprototype\b|__proto__|\bimport\s*\(|\brequire\s*\(|\bprocess\b)/iu;

// dsh-raw-html 教训：复杂卡片（渐变文字、滤镜、图表）依赖厂商前缀属性与
// url(#id) SVG 引用，声明级白名单一刀切会把它们静默丢掉导致"样式坏了"。
// 上限只防 DoS，按现代卡片体量放宽。
const styleDeclarationLimit = 128;
const styleValueLimit = 2000;
// CSS url() 白名单：与 richUrlTransform 的 src 策略同构（https/file/相对、
// data: 图片与字体），另放行 url(#id)——SVG 渐变/滤镜/clipPath 引用的刚需。
// data:image/svg+xml 亦允许：CSS 图像上下文的 SVG 运行在 secure static mode，
// 脚本与外部资源被浏览器禁用。javascript:/data:text/html 等仍被拒绝。
const cssUrlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'][^)]*))?\s*\)/giu;
const safeCssUrlPattern = /^(?:https?:|file:\/\/|data:image\/(?:png|gif|jpe?g|webp|avif|svg\+xml);|data:(?:font\/|application\/(?:x-)?font-|vnd\.ms-fontobject)|\/|\.{1,2}\/)/iu;

function isSafeCssUrl(value: string): boolean {
  const raw = value.trim();
  if (!raw) return false;
  if (raw.startsWith("#")) return true;
  return safeCssUrlPattern.test(raw);
}

/** 校验一条声明里所有 url() 引用；出现任何不安全 url 返回空串丢弃整条声明。 */
function sanitizeStyleUrls(value: string): string {
  let unsafe = false;
  cssUrlPattern.lastIndex = 0;
  value.replace(cssUrlPattern, (match: string, doubleQuoted?: string, singleQuoted?: string, bare?: string): string => {
    if (!isSafeCssUrl(String(doubleQuoted ?? singleQuoted ?? bare ?? ""))) unsafe = true;
    return match;
  });
  return unsafe ? "" : value;
}

/** 引号/括号感知的声明切分：url(data:image/png;base64,..) 与 content:"a;b" 不被 `;` 撕开。 */
function splitStyleDeclarations(styleText: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (const character of String(styleText || "")) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    if (character === ";" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

export function sanitizeStyleDeclarations(styleText: string): string {
  const safeRules: string[] = [];
  for (const part of splitStyleDeclarations(styleText)) {
    const separator = part.indexOf(":");
    if (separator < 1) continue;
    const property = part.slice(0, separator).trim().toLowerCase();
    const value = part.slice(separator + 1).trim();
    // 属性名允许厂商前缀（-webkit-text-fill-color 等）与自定义属性（--x）。
    if (!/^(?:--[a-z][\w-]*|-?[a-z][\w-]*)$/u.test(property) || /^on/iu.test(property) || !value || value.length > styleValueLimit) continue;
    if (/expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding|@import/iu.test(`${property}: ${value}`)) continue;
    const urlSafe = sanitizeStyleUrls(value);
    if (!urlSafe) continue;
    safeRules.push(`${property}: ${urlSafe}`);
  }
  return safeRules.slice(0, styleDeclarationLimit).join("; ");
}

function isSafeUrl(value: string, property: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.startsWith("javascript:") || normalized.startsWith("vbscript:") || normalized.startsWith("data:text/html")) return false;
  if (property === "href" || property === "formAction" || property === "action") {
    return /^(?:https?:|mailto:|tel:|#|\/|\.\.?\/)/iu.test(normalized);
  }
  if (/^(?:https?:|file:\/\/|data:image\/(?:png|gif|jpe?g|webp);|\/|\.\.?\/)/iu.test(normalized)) return true;
  // 工作区相对路径（outputs/fox.png、./fox.png）不含任何 scheme：渲染端会把
  // 它映射成 pidesktop-file:// 协议 URL（resolveWorkspaceAssetUrl），这里必须
  // 放行，否则气泡里的相对图片路径在 sanitize 阶段就被静默删掉 src。
  return !normalized.includes(":") && !normalized.startsWith("//");
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

/** 嵌套子规则选择器：显式 `&` 替换为 :is(<scoped 父选择器>)，隐式嵌套保持原样（相对父级）。 */
function scopeNestedSelector(selector: string, scopedParent: string): string {
  return splitCssSelectors(selector)
    .map((item) => {
      const raw = item.trim();
      if (!raw) return "";
      return raw.includes("&") ? raw.replaceAll("&", `:is(${scopedParent})`) : raw;
    })
    .filter(Boolean)
    .join(", ");
}

interface CssRuleLike {
  cssText: string;
  selectorText?: string;
  keyText?: string;
  style?: { cssText?: string };
  cssRules?: ArrayLike<CssRuleLike>;
  conditionText?: string;
  name?: string;
}

/**
 * 规则序列化用特征检测而不是 CSSRule 数值常量：@container 等新规则的常量
 * 在不同环境可用性不一，而 selectorText/keyText/conditionText/name 属性
 * （或 cssText 的 at-头）在各代 Chromium 都稳定。
 */
function serializeScopedCssRule(rule: CssRuleLike, scopeSelector: string, scopedParent = ""): string {
  const text = rule.cssText || "";
  const brace = text.indexOf("{");
  const head = (brace < 0 ? text : text.slice(0, brace)).trim();

  if (head.startsWith("@font-face")) {
    const declarations = sanitizeStyleDeclarations(rule.style?.cssText ?? "");
    return declarations ? `@font-face { ${declarations} }` : "";
  }
  if (head.startsWith("@keyframes") && rule.cssRules && typeof rule.name === "string") {
    const nested = Array.from(rule.cssRules)
      .map((child) => {
        const key = String(child.keyText ?? "").trim();
        if (!key) return "";
        const declarations = sanitizeStyleDeclarations(child.style?.cssText ?? "");
        return declarations ? `${key} { ${declarations} }` : "";
      })
      .filter(Boolean)
      .join("\n");
    if (!nested) return "";
    return `@keyframes ${rule.name} {\n${nested}\n}`;
  }
  // 分组规则（@media / @supports / @container）：条件保留，子规则递归作用域化。
  if ((rule.conditionText !== undefined || head.startsWith("@container")) && rule.cssRules) {
    const condition = head.startsWith("@container") ? head.replace(/^@container\s*/iu, "").trim() : String(rule.conditionText ?? "").trim();
    const keyword = head.startsWith("@container") ? "container" : head.startsWith("@supports") ? "supports" : "media";
    if (!condition) return "";
    const nested = Array.from(rule.cssRules)
      .map((child) => serializeScopedCssRule(child, scopeSelector, scopedParent))
      .filter(Boolean)
      .join("\n");
    if (!nested) return "";
    return `@${keyword} ${condition} {\n${nested}\n}`;
  }
  if (typeof rule.selectorText === "string" && rule.style) {
    const selectorList = splitCssSelectors(rule.selectorText)
      .map((item) => (scopedParent ? scopeNestedSelector(item, scopedParent) : scopeCssSelector(item, scopeSelector)))
      .filter(Boolean)
      .join(", ");
    const declarations = sanitizeStyleDeclarations(rule.style.cssText ?? "");
    // CSS 嵌套：style rule 的 cssRules 非空时输出嵌套块，保持浏览器嵌套语义。
    const nested = rule.cssRules && rule.cssRules.length > 0
      ? Array.from(rule.cssRules)
          .map((child) => serializeScopedCssRule(child, scopeSelector, selectorList || scopedParent))
          .filter(Boolean)
          .join("\n")
      : "";
    if (!selectorList || (!declarations && !nested)) return "";
    return nested ? `${selectorList} { ${declarations ? `${declarations}; ` : ""}\n${nested}\n}` : (declarations ? `${selectorList} { ${declarations} }` : "");
  }
  return "";
}

/** Sanitize and scope assistant-authored CSS without allowing it to reach the app shell. */
export function sanitizeStyleTagCss(styleText: string, scopeSelector: string): string {
  const raw = String(styleText || "").trim();
  const scope = scopeSelector.trim();
  if (!raw || !scope || typeof document === "undefined") return "";
  const sourceWithoutImports = raw.replace(/@import\s+[^;{}]+;?/giu, "");
  if (/expression\s*\(|javascript\s*:|behavior\s*:|-moz-binding/iu.test(sourceWithoutImports)) return "";

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
        // 源码放 dataScriptSource（hast camelCase；toJsxRuntime 序列化为
        // data-script-source 供 DynamicHtmlBubble 的 dataset.scriptSource 读取），
        // children 保留源码文本仅作 DOM 内可见内容——inert type 保证不执行。
        node.properties = { type: "application/x-pidesktop-bubble-script", dataScriptSource: safeScript };
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
