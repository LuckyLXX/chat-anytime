/// <reference lib="dom" />

/** 输入框取得焦点后，用 CSS Custom Highlight 继续显示原 Range；不改动页面内容或真实选区。 */
export function keepPreviewSelectionHighlighted(doc: Document, range: Range, themed: boolean): () => void {
  const view = doc.defaultView;
  const registry = view?.CSS?.highlights as unknown as Map<string, Highlight> | undefined;
  if (!view || !registry || typeof view.Highlight !== "function" || typeof view.CSSStyleSheet !== "function" || !("adoptedStyleSheets" in doc)) return () => {};
  const name = `pidesktop-preview-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  let sheet: CSSStyleSheet | undefined;
  let highlight: Highlight | undefined;
  try {
    sheet = new view.CSSStyleSheet();
    sheet.replaceSync(themed
      ? `::highlight(${name}) { background-color: var(--selection-bg, #c7d2fe); color: var(--selection-text, #1e1b4b); }`
      : `::highlight(${name}) { background-color: rgba(65, 135, 255, 0.42); }`);
    highlight = new view.Highlight(range);
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    registry.set(name, highlight);
  } catch {
    if (sheet) {
      try { doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((item) => item !== sheet); } catch { /* 页面可能已卸载 */ }
    }
    return () => {};
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (registry.get(name) === highlight) registry.delete(name); } catch { /* 页面可能已卸载 */ }
    try { doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((item) => item !== sheet); } catch { /* 页面可能已卸载 */ }
  };
}
