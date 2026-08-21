// Manual element-pick preload for the built-in browser preview
// (WebContentsView). It runs inside every preview tab's renderer with
// contextIsolation and sandbox on — no Node API beyond the minimal
// ipcRenderer bridge. The app renderer toggles pick mode via the
// "browser-preview:pick-mode" channel; while active, real user hovers are
// highlighted and the next real click opens a compact in-page input card AT
// THE CLICK POSITION (closed shadow DOM, isolated from page CSS/JS). Typing
// a note and pressing Enter /「发送」reports {url, element, note} back to the
// main process as "browser-preview:pick-result"; Esc / × cancels silently.
//
// AI-driven clicks arrive as CDP Input.dispatch* events, which in Electron are
// isTrusted === true and indistinguishable from real input in the page; the
// main process therefore drops pick-results while a tab's `automating` banner
// is set. The isTrusted check here only filters page-script synthetic events
// (element.click() / new MouseEvent + dispatchEvent), which are untrusted.
//
// Coverage notes: listeners register on window capture at preload time (the
// earliest possible listener), so page-side capture handlers can never
// swallow a pick first. Event targets come from composedPath(), which
// pierces Shadow DOM (retargeting would otherwise expose only the host), and
// the same listeners are recursively installed into same-origin iframes
// (cross-origin frames cannot be instrumented from DOM script).

/// <reference lib="dom" />
import { ipcRenderer } from "electron";

const PICK_MODE_CHANNEL = "browser-preview:pick-mode";
const PICK_RESULT_CHANNEL = "browser-preview:pick-result";
const MAX_TEXT_CHARS = 4000;
const MAX_PATH_CHARS = 600;
const OUTLINE = "2px solid #f59e0b";

interface PickElement {
  tag: string;
  path?: string;
  role?: string;
  type?: string;
  name?: string;
  text?: string;
  href?: string;
  src?: string;
}

let pickActive = false;
let hoverElement: (HTMLElement | SVGElement) | null = null;
/** Documents (top-level + same-origin iframes) that already carry the listeners. */
const installedDocs = new WeakSet<Document>();
/** Live MutationObservers tracking iframe insertion per document. */
const pickObservers: MutationObserver[] = [];
/** The in-page confirm card ({url, element} captured, awaiting the note). */
let pickCard: { host: HTMLDivElement; input: HTMLInputElement; dispose: () => void } | null = null;

/**
 * Real event target: the first element of the composed path. `event.target`
 * is retargeted to the shadow host across shadow boundaries, while
 * `composedPath()[0]` is the actual inner element (e.g. the 发布 button
 * inside a web component). Duck-typed so it stays testable without a DOM.
 */
export function firstElementTarget(path: readonly EventTarget[]): Element | undefined {
  for (const node of path) {
    if (node && typeof node === "object" && "tagName" in node && "getAttribute" in node) return node as Element;
  }
  return undefined;
}

/**
 * CSS selector path from the document root (or the nearest id anchor, which
 * is unique) down to the element, e.g. `#main > ul > li:nth-of-type(2) > a`.
 * Pierces open shadow roots via getRootNode().host; stops at the document
 * boundary (an iframe's path does not include its outer page). Duck-typed
 * for the same testability reason as firstElementTarget.
 */
export function elementPath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && parts.length < 15) {
    const tag = String(node.tagName).toLowerCase();
    const rawId = (node as HTMLElement).id;
    const id = typeof rawId === "string" && /^[\w-]+$/u.test(rawId) ? rawId : "";
    if (id) {
      parts.unshift(`${tag}#${id}`);
      break;
    }
    let part = tag;
    const parent: Element | null = node.parentElement;
    if (parent && typeof parent.children === "object" && parent.children !== null) {
      const current: Element = node;
      const sameTag = Array.prototype.filter.call(parent.children, (child: Element) => child.tagName === current.tagName) as Element[];
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (parent) {
      node = parent;
      continue;
    }
    // 穿透 shadow root：parentElement 到 shadow 边界为 null，宿主在外层文档。
    const root: Node | null = typeof node.getRootNode === "function" ? node.getRootNode() : null;
    node = root && typeof root === "object" && "host" in root && root.host instanceof Object ? (root.host as Element) : null;
  }
  return parts.join(" > ").slice(0, MAX_PATH_CHARS);
}

function describeElement(el: Element): PickElement {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") ?? undefined;
  const type = el.getAttribute("type") ?? undefined;
  const name = (el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? el.getAttribute("alt") ?? el.getAttribute("title") ?? "").trim().slice(0, 200) || undefined;
  const raw = typeof (el as HTMLInputElement).value === "string" && (el as HTMLInputElement).value
    ? (el as HTMLInputElement).value
    : (el.textContent ?? "");
  const text = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS) || undefined;
  const anchor = el.tagName === "A" ? el : el.closest("a");
  const href = anchor instanceof HTMLAnchorElement && anchor.href ? anchor.href : undefined;
  const image = el.tagName === "IMG" ? el as HTMLImageElement : el.querySelector("img");
  const src = image instanceof HTMLImageElement && image.src ? image.src : undefined;
  const path = elementPath(el) || undefined;
  return { tag, path, role, type, name, text, href, src };
}

function clearHover(): void {
  if (hoverElement) {
    hoverElement.style.outline = hoverElement.getAttribute("data-pi-pick-outline") ?? "";
    hoverElement.removeAttribute("data-pi-pick-outline");
    hoverElement = null;
  }
}

function highlight(target: Element): void {
  if (target === hoverElement) return;
  clearHover();
  const styled = target as HTMLElement & SVGElement;
  styled.setAttribute("data-pi-pick-outline", styled.style.outline);
  styled.style.outline = OUTLINE;
  styled.style.outlineOffset = "1px";
  hoverElement = styled;
}

function removePickCard(): void {
  if (!pickCard) return;
  pickCard.dispose();
  pickCard.host.remove();
  pickCard = null;
}

function styleElement(el: HTMLElement, css: Partial<CSSStyleDeclaration>): void {
  Object.assign(el.style, css);
}

function describeCardTitle(el: PickElement): string {
  const attrs = [
    el.role ? ` role="${el.role}"` : "",
    el.type ? ` type="${el.type}"` : "",
    el.name ? ` name=${JSON.stringify(el.name)}` : ""
  ].join("");
  const label = el.text ? ` ${JSON.stringify(el.text.slice(0, 60))}` : "";
  return `<${el.tag}${attrs}>${label}`;
}

/**
 * 就地确认卡：跟随点击坐标出现在页面内（同源 iframe 内的元素则出现在该
 * iframe 里），closed shadow DOM 把样式与节点都和页面隔离；发送/取消后才
 * 产生 pick-result。约 320×84px，紧凑单行描述 + 输入行。
 */
function showPickCard(doc: Document, x: number, y: number, message: { url: string; element: PickElement }): void {
  removePickCard();
  const win = doc.defaultView ?? window;

  const host = doc.createElement("div") as HTMLDivElement;
  host.setAttribute("data-pi-pick-card", "1");
  styleElement(host, { position: "fixed", left: "0px", top: "0px", zIndex: "2147483647" });
  const root = host.attachShadow({ mode: "closed" });

  const card = doc.createElement("div");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "已选中的页面元素");
  styleElement(card, {
    display: "grid", gap: "6px", width: "318px", padding: "8px", boxSizing: "border-box",
    background: "#1d2330", color: "#f3f5f9", borderRadius: "8px",
    border: "1px solid rgba(255, 255, 255, .16)",
    boxShadow: "0 8px 28px rgba(0, 0, 0, .4)",
    font: '12px/1.4 system-ui, "Microsoft YaHei", sans-serif'
  });

  const head = doc.createElement("div");
  styleElement(head, { display: "flex", alignItems: "center", gap: "6px", minWidth: "0" });
  const dot = doc.createElement("span");
  styleElement(dot, { flexShrink: "0", width: "8px", height: "8px", borderRadius: "50%", background: "#f59e0b" });
  const desc = doc.createElement("strong");
  styleElement(desc, {
    flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    fontWeight: "600", fontSize: "11px", fontFamily: "Consolas, monospace"
  });
  desc.textContent = describeCardTitle(message.element);
  desc.title = `${message.element.path ? `${message.element.path}\n` : ""}${message.url}`;
  const close = doc.createElement("button");
  close.type = "button";
  close.textContent = "×";
  close.setAttribute("aria-label", "取消选择");
  styleElement(close, {
    flexShrink: "0", border: "0", background: "transparent", color: "#9aa4b2",
    cursor: "pointer", fontSize: "14px", lineHeight: "1", padding: "2px 4px", borderRadius: "4px"
  });
  close.addEventListener("click", removePickCard);
  head.append(dot, desc, close);

  const row = doc.createElement("div");
  styleElement(row, { display: "flex", gap: "6px" });
  const input = doc.createElement("input");
  input.placeholder = "输入内容，回车发送（可留空）";
  input.setAttribute("aria-label", "元素附带内容");
  styleElement(input, {
    flex: "1", minWidth: "0", height: "28px", padding: "0 8px", boxSizing: "border-box",
    borderRadius: "5px", border: "1px solid rgba(255, 255, 255, .2)",
    background: "rgba(255, 255, 255, .08)", color: "#fff", outline: "0", fontSize: "12px"
  });
  input.addEventListener("focus", () => styleElement(input, { borderColor: "#f59e0b" }));
  input.addEventListener("blur", () => styleElement(input, { borderColor: "rgba(255, 255, 255, .2)" }));
  const send = doc.createElement("button");
  send.type = "button";
  send.textContent = "发送";
  styleElement(send, {
    flexShrink: "0", height: "28px", padding: "0 11px", borderRadius: "5px", border: "0",
    background: "#f59e0b", color: "#1d2330", cursor: "pointer", fontSize: "12px", fontWeight: "600"
  });

  const submit = (): void => {
    const note = input.value.trim().slice(0, 2000);
    ipcRenderer.send(PICK_RESULT_CHANNEL, { url: message.url, element: message.element, note });
    removePickCard();
  };
  send.addEventListener("click", submit);
  // 中文输入法确认候选词的 Enter 不触发提交。
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  row.append(input, send);

  card.append(head, row);
  root.append(card);
  (doc.body ?? doc.documentElement).appendChild(host);

  // 跟随点击位置，视口边缘钳制；卡片高约 84px，点击过近底部时改为上方弹出。
  const cardWidth = 320;
  const cardHeight = 84;
  const left = Math.max(8, Math.min(x, win.innerWidth - cardWidth - 8));
  const top = y + 14 + cardHeight > win.innerHeight ? Math.max(8, y - cardHeight - 10) : y + 14;
  styleElement(host, { left: `${left}px`, top: `${top}px` });

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") removePickCard();
  };
  win.addEventListener("keydown", onKey, true);
  pickCard = {
    host,
    input,
    dispose: () => win.removeEventListener("keydown", onKey, true)
  };
  input.focus();
}

function handleHover(event: Event): void {
  if (!pickActive) return;
  const target = firstElementTarget(event.composedPath());
  if (!target) return;
  highlight(target);
}

function handleClick(event: Event): void {
  if (!pickActive) return;
  // 页面脚本合成的假事件（element.click / dispatchEvent）不可信，忽略；
  // CDP 合成输入是 trusted 的，由主进程的 automating 抑制兜底。
  if (!event.isTrusted) return;
  event.preventDefault();
  event.stopPropagation();
  const el = firstElementTarget(event.composedPath());
  pickActive = false;
  clearHover();
  if (!el) return;
  const doc = (el as Node).ownerDocument ?? document;
  const mouse = event as MouseEvent;
  // 元素所在的文档即卡片宿主；同源 iframe 里点击就在该 iframe 内弹出，
  // URL 用该文档自己的地址（doc.URL）而非顶层页面。
  showPickCard(doc, mouse.clientX, mouse.clientY, { url: doc.URL || location.href, element: describeElement(el) });
}

/** Attach listeners to a same-origin iframe document (each navigation = new Document). */
function attachIframe(frame: HTMLIFrameElement): void {
  if (frame.dataset.piPickAttached) return;
  frame.dataset.piPickAttached = "1";
  const attach = (): void => {
    let inner: Document | null = null;
    try {
      inner = frame.contentDocument;
    } catch {
      return; // cross-origin frame: cannot be instrumented from DOM script
    }
    if (!inner) return;
    if (inner.readyState === "loading") {
      inner.addEventListener("DOMContentLoaded", () => attach(), { once: true });
      return;
    }
    installPickDocument(inner);
  };
  frame.addEventListener("load", () => attach(), { once: true });
  attach();
}

/** Install hover/click capture into one document (top-level or same-origin iframe) and track its iframes. */
function installPickDocument(doc: Document): void {
  if (installedDocs.has(doc)) return;
  installedDocs.add(doc);
  // window capture at install time beats every page-side capture handler, so
  // a page can never swallow a pick click first. Each document has its own
  // window; only one capture layer is registered per document.
  const win = doc.defaultView ?? window;
  win.addEventListener("mouseover", handleHover, true);
  win.addEventListener("click", handleClick, true);
  for (const frame of Array.from(doc.querySelectorAll("iframe"))) attachIframe(frame);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node instanceof HTMLIFrameElement) attachIframe(node);
        else if (node instanceof HTMLElement) for (const frame of Array.from(node.querySelectorAll("iframe"))) attachIframe(frame);
      }
    }
  });
  observer.observe(doc, { childList: true, subtree: true });
  pickObservers.push(observer);
}

ipcRenderer.on(PICK_MODE_CHANNEL, (_event, enabled: unknown) => {
  pickActive = enabled === true;
  clearHover();
  removePickCard();
});

// Install immediately at preload time — the document object already exists,
// the observer picks up everything inserted afterwards.
installPickDocument(document);
