// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaletteAction } from "../lib/command-palette";
import { CommandPalette } from "./CommandPalette";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function makeActions(): PaletteAction[] {
  return [
    { id: "new", title: "新建话题", group: "会话", run: vi.fn() },
    { id: "model", title: "切换模型：Claude", group: "模型", keywords: "model claude", run: vi.fn() },
    { id: "readonly", title: "访问模式：只读", group: "权限", disabled: true, run: vi.fn() },
    { id: "dark", title: "主题：深色", group: "主题", run: vi.fn() }
  ];
}

async function render(actions: PaletteAction[], onClose = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(<CommandPalette open actions={actions} onClose={onClose} />);
  });
}

function input(): HTMLInputElement {
  return container.querySelector(".command-palette-input-row input") as HTMLInputElement;
}

function type(value: string): void {
  const field = input();
  // 受控 input：绕过 React 的 value tracker，走原生 setter 再发 input 事件。
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(key: string): void {
  act(() => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("CommandPalette", () => {
  it("renders grouped actions and hints", async () => {
    const actions = makeActions();
    actions[1]!.hint = "claude-opus";
    await render(actions);

    expect(container.querySelector(".command-palette")?.getAttribute("role")).toBe("dialog");
    expect(container.textContent).toContain("新建话题");
    expect(container.textContent).toContain("切换模型：Claude");
    expect(container.textContent).toContain("会话");
    expect(container.textContent).toContain("模型");
    expect(container.textContent).toContain("claude-opus");
  });

  it("filters by title, keyword and width-insensitive query", async () => {
    await render(makeActions());
    type("模型");
    expect(container.textContent).toContain("切换模型：Claude");
    expect(container.textContent).not.toContain("新建话题");

    type("ＣＬＡＵＤＥ");
    expect(container.textContent).toContain("切换模型：Claude");
  });

  it("runs the first action with Enter and closes the palette", async () => {
    const actions = makeActions();
    const onClose = vi.fn();
    await render(actions, onClose);

    press("Enter");
    expect((actions[0]!.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves with arrow keys and skips disabled actions", async () => {
    const actions = makeActions();
    await render(actions);

    // 0 → 1（模型）→ 跳过错禁的 2 → 3（深色）
    press("ArrowDown");
    press("ArrowDown");
    press("Enter");
    expect((actions[3]!.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect((actions[1]!.run as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("does not run a disabled action", async () => {
    const actions = makeActions();
    await render(actions);
    type("只读");
    press("Enter");
    expect((actions[2]!.run as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("closes on Escape and on backdrop click", async () => {
    const onClose = vi.fn();
    await render(makeActions(), onClose);
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = container.querySelector(".command-palette-backdrop") as HTMLElement;
    act(() => { backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("runs a clicked action and shows the empty state", async () => {
    const actions = makeActions();
    const onClose = vi.fn();
    await render(actions, onClose);

    const item = [...container.querySelectorAll<HTMLButtonElement>(".command-palette-item")]
      .find((button) => (button.textContent ?? "").includes("深色"));
    act(() => { item?.click(); });
    expect((actions[3]!.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    type("不存在的动作");
    expect(container.textContent).toContain("没有匹配的动作");
  });
});
