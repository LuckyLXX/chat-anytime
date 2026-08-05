const blockedTags = new Set(["base", "embed", "iframe", "link", "meta", "object", "script", "style"]);
const urlProperties = new Set(["action", "formAction", "href", "poster", "src", "xLinkHref"]);

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
  return /^(?:https?:|data:image\/(?:png|gif|jpe?g|webp);|\/|\.\.?\/)/iu.test(normalized);
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
  properties?: Record<string, unknown>;
  children?: HastNode[];
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

/** Rehype plugin: sanitize raw assistant HTML before the schema sanitizer runs. */
export function sanitizeRichHtmlTree(): (tree: unknown) => void {
  return (tree: unknown) => {
    const root = tree as HastNode;
    const visit = (node: HastNode): void => {
      sanitizeNode(node);
      if (!node.children) return;
      node.children = node.children.filter((child) => {
        if (child.type === "element" && blockedTags.has(String(child.tagName || "").toLowerCase())) return false;
        visit(child);
        return true;
      });
    };
    visit(root);
  };
}
