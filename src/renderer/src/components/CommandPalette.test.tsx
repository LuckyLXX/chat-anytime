// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSearchHit } from "../../../shared/protocol";
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

function hit(overrides: Partial<SessionSearchHit> = {}): SessionSearchHit {
  return {
    sessionId: "s1",
    path: "C:/sessions/s1.jsonl",
    title: "部署事故复盘",
    workspace: "C:/work",
    agentId: "default",
    modifiedAt: Date.now(),
    timestamp: 1_000,
    role: "user",
    snippet: "上线部署失败了，回滚了一版",
    score: 12,
    ...overrides
  };
}

type PaletteProps = Partial<Parameters<typeof CommandPalette>[0]>;

async function render(actions: PaletteAction[], props: PaletteProps = {}): Promise<void> {
  await act(async () => {
    root.render(<CommandPalette open actions={actions} onClose={vi.fn()} {...props} />);
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
    await render(actions, { onClose });

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
    await render(makeActions(), { onClose });
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = container.querySelector(".command-palette-backdrop") as HTMLElement;
    act(() => { backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("runs a clicked action and shows the empty state when there are no actions", async () => {
    const actions = makeActions();
    const onClose = vi.fn();
    await render(actions, { onClose });

    const item = [...container.querySelectorAll<HTMLButtonElement>(".command-palette-item")]
      .find((button) => (button.textContent ?? "").includes("深色"));
    act(() => { item?.click(); });
    expect((actions[3]!.run as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    await render([]);
    expect(container.textContent).toContain("没有匹配的动作");
  });

  // —— 两段式会话检索（2026-10-27 用户报：输入历史对话内容只得到「没有匹配的动作」） ——
  it("turns a non-matching query into a session-search entry instead of an empty list", async () => {
    const onClose = vi.fn();
    const onSearchQueryChange = vi.fn();
    await render(makeActions(), { onClose, onSearchQueryChange });

    type("历史绘画内容");

    expect(container.textContent).toContain("会话检索");
    expect(container.textContent).toContain("搜索会话内容：历史绘画内容");
    expect(container.textContent).not.toContain("没有匹配的动作");
    // 命令模式下不打扰 App 的检索（只有进入检索模式才推查询）。
    expect(onSearchQueryChange).toHaveBeenLastCalledWith("");
  });

  it("enters session-search mode on Enter without closing, keeping the typed query", async () => {
    const onClose = vi.fn();
    const onSearchQueryChange = vi.fn();
    await render(makeActions(), {
      onClose,
      onSearchQueryChange,
      // App 已经为这句查询跑完一轮检索（无命中）。
      sessionSearch: { query: "历史绘画内容", hits: [], loading: false, scanned: 8 }
    });

    type("历史绘画内容");
    press("Enter");

    expect(onClose).not.toHaveBeenCalled();
    expect(input().value).toBe("历史绘画内容");
    expect(input().placeholder).toContain("搜索会话内容");
    expect(container.textContent).toContain("会话检索");
    expect(container.textContent).toContain("扫描 8 个会话");
    expect(container.textContent).toContain("没有匹配的消息");
    expect(onSearchQueryChange).toHaveBeenLastCalledWith("历史绘画内容");
  });

  it("renders hits with highlight and opens one with Enter", async () => {
    const onOpenHit = vi.fn();
    const onClose = vi.fn();
    await render(makeActions(), {
      onOpenHit,
      onClose,
      agents: [{ id: "default", name: "默认助手" }],
      sessionSearch: { query: "部署", hits: [hit()], loading: false, scanned: 4 }
    });

    type("部署");
    press("Enter");

    expect(container.textContent).toContain("部署事故复盘");
    expect(container.textContent).toContain("默认助手");
    expect(container.textContent).toContain("你");
    expect(container.textContent).toContain("扫描 4 个会话");
    expect(container.querySelectorAll("mark")).toHaveLength(1);

    press("Enter");
    expect(onOpenHit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1", timestamp: 1_000, role: "user" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns to the command list on Escape inside session-search mode", async () => {
    const onClose = vi.fn();
    const onSearchQueryChange = vi.fn();
    await render(makeActions(), { onClose, onSearchQueryChange });

    type("部署");
    press("Enter");
    expect(input().placeholder).toContain("搜索会话内容");

    press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(input().value).toBe("");
    expect(input().placeholder).toContain("输入动作名");
    expect(container.textContent).toContain("新建话题");
    expect(onSearchQueryChange).toHaveBeenLastCalledWith("");

    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("asks for at least two characters and surfaces the loading state", async () => {
    await render(makeActions(), { sessionSearch: { query: "", hits: [], loading: false } });

    type("部");
    press("Enter");
    expect(container.textContent).toContain("输入至少 2 个字");
    expect(container.textContent).not.toContain("没有匹配的消息");

    await render(makeActions(), { sessionSearch: { query: "部署", hits: [], loading: true } });
    type("部署");
    press("Enter");
    expect(container.textContent).toContain("搜索中…");
    // 加载中不能同时报「没有匹配的消息」。
    expect(container.textContent).not.toContain("没有匹配的消息");
  });

  it("enters session-search mode from the static search action", async () => {
    const onClose = vi.fn();
    await render([{ id: "session.search", title: "搜索会话内容", group: "会话", enterSearch: true }], { onClose });

    press("Enter");
    expect(onClose).not.toHaveBeenCalled();
    expect(input().placeholder).toContain("搜索会话内容");
    // 没有输入时提示的是「至少 2 个字」，而不是空结果。
    expect(container.textContent).toContain("输入至少 2 个字");
  });

  it("pushes an empty query when the palette closes", async () => {
    const onSearchQueryChange = vi.fn();
    await render(makeActions(), { onSearchQueryChange });

    type("部署");
    press("Enter");
    expect(onSearchQueryChange).toHaveBeenLastCalledWith("部署");

    await act(async () => {
      root.render(<CommandPalette open={false} actions={makeActions()} onClose={vi.fn()} onSearchQueryChange={onSearchQueryChange} />);
    });
    expect(onSearchQueryChange).toHaveBeenLastCalledWith("");
  });
});
