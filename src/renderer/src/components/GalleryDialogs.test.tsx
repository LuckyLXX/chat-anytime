// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GalleryDraft, GalleryKind } from "../../../shared/gallery";
import { GalleryPublishDialog } from "./GalleryDialogs";

/**
 * 「登记新作品」对话框的行为测试（2026-11-16 整改）。
 *
 * 为什么需要真交互而不是静态字符串断言：面板本地服务的 command / url 从「两个可选
 * 输入框」改成了**成对**关系——只填一项时是配置错误（平台靠 command 起进程、靠 url
 * 探活，缺一个就无法判断服务起没起来）。旧实现里这种半套配置会静默失效：用户以为
 * 服务被托管了，实际命令根本没执行。这类「看起来成功、实际没生效」的缺陷只有模拟
 * 输入 + 提交才能钉住，静态 markup 里没有错误态可看。
 */

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

function renderDialog(initial: { kind?: GalleryKind; path?: string; title?: string } = {}): ReturnType<typeof vi.fn> {
  const onSubmit = vi.fn();
  act(() => root.render(
    <GalleryPublishDialog
      initial={{ kind: initial.kind ?? "panel", path: initial.path ?? "panels/status", title: initial.title ?? "状态面板" }}
      workspace="D:/ws"
      onSubmit={onSubmit}
      onClose={() => {}}
    />
  ));
  return onSubmit;
}

/** 受控 input：绕过 React 的 value tracker，走原生 setter 再发 input 事件。 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 按 label 前缀找字段（label 文案里带字段名，前缀足够唯一）。 */
function field(prefix: string): HTMLInputElement | undefined {
  for (const label of container.querySelectorAll("label")) {
    if (!label.textContent?.startsWith(prefix)) continue;
    const input = label.querySelector("input");
    if (input) return input as HTMLInputElement;
  }
  return undefined;
}

function selectKind(kind: GalleryKind): void {
  const select = container.querySelector("select") as HTMLSelectElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(select, kind);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function submitButton(): HTMLButtonElement {
  return container.querySelector('button[type="submit"]') as HTMLButtonElement;
}

/**
 * 直接派发 submit 事件（不点按钮）：按钮 disabled 时浏览器不派发 click，
 * 于是「按钮禁用了但回车/脚本仍能提交」这类洞只有这条路能测出来。
 */
function submitForm(): void {
  const form = container.querySelector("form") as HTMLFormElement;
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

function alertText(): string | undefined {
  return container.querySelector('[role="alert"]')?.textContent ?? undefined;
}

describe("面板本地服务：command / url 成对校验", () => {
  it("只填启动命令：可见错误 + 禁用发布 + 提交被挡住", () => {
    const onSubmit = renderDialog();
    typeInto(field("① 启动命令")!, "node bridge.mjs");
    expect(alertText()).toContain("必须成对");
    expect(alertText()).toContain("给了 command 也要给 url");
    expect(submitButton().disabled).toBe(true);
    // 即便绕过按钮（回车 / 脚本提交），也必须在 submit() 里再挡一次
    submitForm();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("只填探活地址：同样报错并挡住提交", () => {
    const onSubmit = renderDialog();
    typeInto(field("② 探活地址")!, "http://127.0.0.1:8791/api/health");
    expect(alertText()).toContain("必须成对");
    expect(alertText()).toContain("给了 url 也要给 command");
    expect(submitButton().disabled).toBe(true);
    submitForm();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("两项都填：错误消失，提示先探活（可达=外部服务不接管），草稿带上成对的 command + url", () => {
    const onSubmit = renderDialog();
    typeInto(field("① 启动命令")!, "node bridge.mjs");
    typeInto(field("② 探活地址")!, "http://127.0.0.1:8791/api/health");
    expect(alertText()).toBeUndefined();
    expect(submitButton().disabled).toBe(false);
    // 「已配置」≠「平台一定在托管」：运行时先探活，可达就复用外部服务
    const hint = container.textContent ?? "";
    expect(hint).toContain("先探活");
    expect(hint).toContain("外部服务，平台不启动");
    expect(hint).toContain("关闭面板时只停止平台自己启动的这个服务");
    submitForm();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      title: "状态面板",
      kind: "panel",
      path: "panels/status",
      command: "node bridge.mjs",
      url: "http://127.0.0.1:8791/api/health"
    });
  });

  it("两项都留空：不报错，面板直连（草稿里没有 command / url）", () => {
    const onSubmit = renderDialog();
    expect(alertText()).toBeUndefined();
    submitForm();
    const draft = onSubmit.mock.calls[0]![0] as GalleryDraft;
    expect(draft.command).toBeUndefined();
    expect(draft.url).toBeUndefined();
  });

  it("探活地址的字段名自带语义（不是面板页面地址）", () => {
    renderDialog();
    expect(field("② 探活地址（不是面板页面地址）")).toBeDefined();
  });
});

describe("path / entry 术语", () => {
  it("file / panel 提供可选的 entry 字段，并随草稿提交（path 是目录时用）", () => {
    const onSubmit = renderDialog({ kind: "panel", path: "panels/status" });
    expect(field("入口网页（path）")?.value).toBe("panels/status");
    typeInto(field("入口（entry，可选）")!, "index.html");
    submitForm();
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ path: "panels/status", entry: "index.html" });
  });

  it("server 没有 entry 字段（path 必须是项目目录），切换类型后也不带出去", () => {
    const onSubmit = renderDialog({ kind: "file", path: "outputs/demo" });
    typeInto(field("入口（entry，可选）")!, "index.html");
    selectKind("server");
    expect(field("入口（entry，可选）")).toBeUndefined();
    expect(field("项目目录（path）")?.value).toBe("outputs/demo");
    submitForm();
    const draft = onSubmit.mock.calls[0]![0] as GalleryDraft;
    expect(draft.kind).toBe("server");
    expect(draft.entry).toBeUndefined();
  });
});
