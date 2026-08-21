import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcRenderer: { on: vi.fn(), send: vi.fn() }
}));

type PickModule = typeof import("./browser-pick.js");

describe("browser pick event target (shadow DOM piercing)", () => {
  let mod: PickModule;

  beforeAll(async () => {
    Object.defineProperty(globalThis, "MutationObserver", {
      value: class {
        observe(): void { /* no-op */ }
      }
    });
    Object.defineProperty(globalThis, "document", {
      value: {
        defaultView: { addEventListener: vi.fn() },
        querySelectorAll: () => [],
        addEventListener: vi.fn()
      }
    });
    mod = await import("./browser-pick.js");
  });

  const element = (overrides: Record<string, unknown> = {}) => ({ tagName: "BUTTON", getAttribute: () => null, ...overrides });

  it("returns the first element of the path", () => {
    const target = element();
    expect(mod.firstElementTarget([target] as unknown as EventTarget[])).toBe(target);
  });

  it("pierces shadow DOM: prefers the inner target over the retargeted host", () => {
    const inner = element({ tagName: "BUTTON" });
    const host = element({ tagName: "X-PUBLISH" });
    const path = [inner, { host }, host, { tagName: "HTML" }];
    expect(mod.firstElementTarget(path as unknown as EventTarget[])).toBe(inner);
  });

  it("skips non-element path entries (documents, shadow roots, text nodes)", () => {
    const target = element();
    const path = [{ nodeType: 3 }, { nodeType: 11 }, target, { nodeType: 9 }];
    expect(mod.firstElementTarget(path as unknown as EventTarget[])).toBe(target);
  });

  it("returns undefined when the path carries no element", () => {
    expect(mod.firstElementTarget([{ nodeType: 9 }, { nodeType: 11 }] as unknown as EventTarget[])).toBeUndefined();
    expect(mod.firstElementTarget([] as unknown as EventTarget[])).toBeUndefined();
  });
});

describe("browser pick element path (CSS selector)", () => {
  let mod: PickModule;

  beforeAll(async () => {
    mod = await import("./browser-pick.js");
  });

  const el = (tagName: string, extra: Record<string, unknown> = {}): Element =>
    ({ tagName, ...extra }) as unknown as Element;

  it("uses an id anchor when the element has a safe id", () => {
    expect(mod.elementPath(el("BUTTON", { id: "submit" }))).toBe("button#submit");
  });

  it("ignores ids that are not valid selector identifiers", () => {
    const button = el("BUTTON", { id: "sub mit", parentElement: el("FORM", { parentElement: el("BODY") }) });
    expect(mod.elementPath(button)).toBe("body > form > button");
  });

  it("walks ancestors with nth-of-type only among same-tag siblings", () => {
    const second = el("LI");
    const list = { tagName: "UL", children: [el("LI"), second, el("SPAN")] };
    (second as unknown as Record<string, unknown>).parentElement = list;
    expect(mod.elementPath(second as Element)).toBe("ul > li:nth-of-type(2)");
  });

  it("omits nth-of-type for unique tags", () => {
    const only = el("LI");
    const list = { tagName: "UL", children: [only] };
    (only as unknown as Record<string, unknown>).parentElement = list;
    expect(mod.elementPath(only as Element)).toBe("ul > li");
  });

  it("pierces shadow roots via getRootNode().host", () => {
    const host = el("SECTION", { parentElement: el("BODY") });
    const inner = el("SPAN", { parentElement: null, getRootNode: () => ({ host }) });
    expect(mod.elementPath(inner as Element)).toBe("body > section > span");
  });
});
