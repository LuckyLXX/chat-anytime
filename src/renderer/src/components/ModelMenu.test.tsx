// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ModelOption, ProviderOption } from "../../../shared/protocol";
import { ModelMenu } from "./ModelMenu";

/**
 * 模型快捷切换的两段式菜单（2026-11-04）：一级只列供应商，点开才展开该供应商的
 * 模型。契约要点：模型不在一级出现（否则又退回平铺长列表）、二级带搜索与返回、
 * Esc 逐级退、当前模型所在供应商与模型都带 active。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const providers: ProviderOption[] = [
  { id: "anthropic", name: "Anthropic", configured: true },
  { id: "openrouter", name: "OpenRouter", configured: true }
];

function model(provider: string, id: string, name = id): ModelOption {
  return { provider, id, name, configured: true, input: ["text"], imageInput: false };
}

const models: ModelOption[] = [
  model("anthropic", "claude-sonnet", "Claude Sonnet"),
  model("anthropic", "claude-opus", "Claude Opus"),
  ...Array.from({ length: 10 }, (_, index) => model("openrouter", `or-model-${index}`, `OR Model ${index}`))
];

const SELECTED = "anthropic/claude-sonnet";
let container: HTMLDivElement;
let onSelect: Mock<(value: string) => void>;
let onClose: Mock<() => void>;

function render(): void {
  act(() => {
    createRoot(container).render(<ModelMenu models={models} providers={providers} value={SELECTED} onSelect={onSelect} onClose={onClose} />);
  });
}

const providerRows = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>(".model-menu-provider")];
const modelRows = (): HTMLButtonElement[] => [...container.querySelectorAll<HTMLButtonElement>(".model-menu-model")];
const rowFor = (provider: string): HTMLButtonElement => providerRows().find((row) => row.dataset.provider === provider)!;
const panel = (): HTMLElement | null => container.querySelector<HTMLElement>(".model-menu-panel");

function openProvider(provider: string): void {
  act(() => { rowFor(provider).click(); });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  onSelect = vi.fn<(value: string) => void>();
  onClose = vi.fn<() => void>();
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

describe("ModelMenu 两段式", () => {
  it("一级只列供应商：任何模型都要点开供应商之后才出现", () => {
    render();
    expect(providerRows().map((row) => row.dataset.provider)).toEqual(["anthropic", "openrouter"]);
    expect(modelRows()).toHaveLength(0);
    expect(panel()).toBeNull();
    // 一级行带副标题：当前供应商显示当前模型名，其余显示模型数
    expect(rowFor("anthropic").textContent).toContain("Claude Sonnet");
    expect(rowFor("openrouter").textContent).toContain("10 个模型");
  });

  it("当前模型所在供应商与模型都带 active（旧实现的「勾选当前项」不丢）", () => {
    render();
    expect(rowFor("anthropic").classList.contains("active")).toBe(true);
    expect(rowFor("openrouter").classList.contains("active")).toBe(false);
    openProvider("anthropic");
    const checked = modelRows().filter((row) => row.getAttribute("aria-checked") === "true");
    expect(checked).toHaveLength(1);
    expect(checked[0]!.textContent).toContain("Claude Sonnet");
  });

  it("点开供应商只列它自己的模型，点击模型回传 provider/id", () => {
    render();
    openProvider("openrouter");
    expect(panel()?.getAttribute("aria-label")).toBe("OpenRouter 的模型");
    expect(modelRows()).toHaveLength(10);
    expect(modelRows().every((row) => row.textContent?.startsWith("OR Model"))).toBe(true);
    act(() => { modelRows().find((row) => row.textContent?.includes("OR Model 3"))!.click(); });
    expect(onSelect).toHaveBeenCalledWith("openrouter/or-model-3");
  });

  it("模型多的供应商（≥8）带搜索框并能按 ID 过滤；少的没有搜索框", () => {
    render();
    openProvider("anthropic");
    expect(container.querySelector(".model-menu-search")).toBeNull();
    openProvider("openrouter");
    const input = container.querySelector<HTMLInputElement>(".model-menu-search input");
    expect(input).toBeTruthy();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "model-7");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(modelRows()).toHaveLength(1);
    expect(modelRows()[0]!.textContent).toContain("OR Model 7");
    // 搜不到时给明确空态，而不是空白面板
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "zzz");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(modelRows()).toHaveLength(0);
    expect(container.querySelector(".model-menu-empty")?.textContent).toContain("zzz");
  });

  it("二级打开后鼠标横移到另一个供应商直接切换（级联惯例）", () => {
    render();
    openProvider("anthropic");
    act(() => { rowFor("openrouter").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(panel()?.getAttribute("aria-label")).toBe("OpenRouter 的模型");
    expect(modelRows()).toHaveLength(10);
  });

  it("没打开二级时鼠标横移不展开（首次必须点击/键盘，避免划过去就弹）", () => {
    render();
    act(() => { rowFor("openrouter").dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
    expect(panel()).toBeNull();
  });

  it("Esc 逐级退：先收二级（不关菜单），二级收掉后再 Esc 才关闭整个菜单", () => {
    render();
    openProvider("openrouter");
    act(() => { panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(panel()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    act(() => { container.querySelector<HTMLElement>(".model-select-menu")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("返回按钮同样只退一级，并把焦点交回原供应商行", () => {
    render();
    openProvider("openrouter");
    const back = container.querySelector<HTMLButtonElement>(".model-menu-back")!;
    act(() => { back.click(); });
    expect(panel()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(rowFor("openrouter"));
  });

  it("键盘路径：↑/↓ 在供应商间移动，→ 展开并让二级接管焦点", () => {
    render();
    const popover = container.querySelector<HTMLElement>(".model-select-menu")!;
    expect(document.activeElement).toBe(rowFor("anthropic"));
    act(() => { popover.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(rowFor("openrouter"));
    act(() => { popover.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
    expect(panel()).toBeTruthy();
    // 有搜索框时焦点落在搜索框，↑/↓ 再从那里进入模型列表
    expect(document.activeElement).toBe(container.querySelector(".model-menu-search input"));
    act(() => { popover.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })); });
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(rowFor("openrouter"));
  });

  it("空目录给引导文案（而不是一个空弹层）", () => {
    act(() => { createRoot(container).render(<ModelMenu models={[]} providers={providers} value="" onSelect={onSelect} onClose={onClose} />); });
    expect(container.querySelector(".model-menu-empty")?.textContent).toContain("设置 → 模型服务");
    expect(providerRows()).toHaveLength(0);
  });
});
