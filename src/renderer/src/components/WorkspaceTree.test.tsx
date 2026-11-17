// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceDirectoryEntry } from "../../../shared/protocol";
import { WorkspaceTree } from "./WorkspaceTree";

/**
 * 文件树右键「新建文件 / 新建文件夹」的三条落点（2026-11-17，用户报「右键新建文件夹
 * 好像没生效」）。
 *
 * 根因不是 IPC 也不是写入——主进程的创建函数有单测、真实路径也验过。真正的问题在
 * 「看不见结果」与「落点错了」：
 * ① 在**折叠目录行**上新建：目录写进去了，但那一行不展开、新条目也不定位，
 *    屏幕上零变化，看起来就是没生效（用户报的就是这个）；
 * ② 在**文件行**上新建：旧实现把文件路径当目录用（`README.md/新目录`），主进程只能
 *    抛 `ENOTDIR: not a directory` / `EEXIST`，弹窗里出现一条 Node 原始报错。
 *
 * 本文件钉住：新建后目标目录要展开、新行要高亮并可见；文件行的新建落在同级目录；
 * 根目录仍然即时刷新。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE = "D:/ws";

let tree: Map<string, WorkspaceDirectoryEntry[]>;
let container: HTMLDivElement;
let root: Root;
let created: { files: string[]; dirs: string[] };

function entry(name: string, kind: WorkspaceDirectoryEntry["kind"], relativePath = name): WorkspaceDirectoryEntry {
  return { name, relativePath, kind };
}

const list = vi.fn(async (_workspace: string, relativePath?: string) => {
  const key = relativePath ?? "";
  return { relativePath: key, entries: tree.get(key) ?? [] };
});

/** 内存工作区：创建 = 写进父目录列表 + 记录调用参数。 */
const createWorkspaceDirectory = vi.fn(async (_workspace: string, relativePath: string) => {
  created.dirs.push(relativePath);
  const parent = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
  tree.set(relativePath, []);
  tree.set(parent, [...(tree.get(parent) ?? []), entry(relativePath.split("/").at(-1)!, "directory", relativePath)]);
  return { relativePath };
});

const createWorkspaceFile = vi.fn(async (_workspace: string, relativePath: string) => {
  created.files.push(relativePath);
  const parent = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
  tree.set(parent, [...(tree.get(parent) ?? []), entry(relativePath.split("/").at(-1)!, "file", relativePath)]);
  return { relativePath };
});

beforeEach(() => {
  tree = new Map([
    ["", [entry("src", "directory"), entry("README.md", "file")]],
    ["src", [entry("runtime.ts", "file", "src/runtime.ts")]]
  ]);
  created = { files: [], dirs: [] };
  list.mockClear();
  createWorkspaceDirectory.mockClear();
  createWorkspaceFile.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("window", {
    ...globalThis.window,
    piDesktop: {
      listWorkspaceDirectory: list,
      createWorkspaceDirectory,
      createWorkspaceFile,
      renameWorkspaceEntry: vi.fn(),
      deleteWorkspaceEntry: vi.fn(),
      revealInExplorer: vi.fn()
    },
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    addEventListener: globalThis.addEventListener.bind(globalThis),
    removeEventListener: globalThis.removeEventListener.bind(globalThis),
    innerWidth: 1200,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<WorkspaceTree workspace={WORKSPACE} onOpenFile={() => {}} onAddToChat={() => {}} onError={(message) => console.error("onError", message)} />);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function rows(): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(".workspace-tree-row")];
}

function rowByText(text: string): HTMLButtonElement {
  const found = rows().find((row) => row.textContent === text);
  if (!found) throw new Error(`row not found: ${text} / ${rows().map((row) => row.textContent).join("|")}`);
  return found;
}

async function openRootMenu(): Promise<void> {
  const nav = container.querySelector(".workspace-tree")!;
  await act(async () => {
    nav.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  });
}

async function openMenuOn(text: string): Promise<void> {
  const row = rowByText(text);
  await act(async () => {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }));
  });
}

function menuItem(label: string): HTMLButtonElement {
  const items = [...document.querySelectorAll<HTMLButtonElement>(".context-menu-item")];
  const found = items.find((item) => item.textContent === label);
  if (!found) throw new Error(`menu item not found: ${label} / ${items.map((item) => item.textContent).join("|")}`);
  return found;
}

async function submitPrompt(value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(".extension-ui-dialog input");
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input!, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = document.querySelector<HTMLButtonElement>(".extension-ui-dialog button[type=submit]")!;
  await act(async () => {
    submit.click();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("WorkspaceTree 右键新建", () => {
  it("根目录：创建后立刻出现在树里并带定位高亮", async () => {
    await mount();
    await openRootMenu();
    await act(async () => { menuItem("新建文件夹").click(); });
    await submitPrompt("新目录");

    expect(created.dirs).toEqual(["新目录"]);
    const row = rowByText("新目录");
    expect(row.className).toContain("just-created");
    // 根目录没有可展开的父行，但列表必须已经重载（读回磁盘）。
    expect(list.mock.calls.some(([, relativePath]) => relativePath === undefined)).toBe(true);
  });

  it("折叠目录行：创建后父行自动展开，新子行可见且高亮", async () => {
    await mount();
    expect(rowByText("src").getAttribute("aria-expanded")).toBe("false");
    await openMenuOn("src");
    await act(async () => { menuItem("新建文件夹").click(); });
    await submitPrompt("sub");

    expect(created.dirs).toEqual(["src/sub"]);
    expect(rowByText("src").getAttribute("aria-expanded")).toBe("true");
    expect(rowByText("sub").className).toContain("just-created");
  });

  it("文件行：新建落在同级目录，不再把文件路径当目录用", async () => {
    await mount();
    await openMenuOn("README.md");
    await act(async () => { menuItem("新建文件").click(); });
    await submitPrompt("notes.md");

    expect(created.files).toEqual(["notes.md"]);
    expect(rowByText("notes.md").className).toContain("just-created");
  });

  it("文件行菜单仍然提供新建入口（落点算同级，不隐藏功能）", async () => {
    await mount();
    await openMenuOn("README.md");
    const labels = [...document.querySelectorAll(".context-menu-item")].map((item) => item.textContent);
    expect(labels).toContain("新建文件");
    expect(labels).toContain("新建文件夹");
  });
});
