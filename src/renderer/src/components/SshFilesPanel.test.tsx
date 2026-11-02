// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshEventData, SshRemoteEntry } from "../../../shared/protocol";
import { SshFilesPanel } from "./SshFilesPanel";

/**
 * 结构钩子契约（公开主题 API）+ 两条行为回归。
 *
 * 钩子（`data-pane="ssh-files"` 与 `data-control` 里的 ssh-upload / ssh-download /
 * ssh-transfer-cancel）是**公开主题 API**（见 AGENTS.md / docs/theme-guide.md 与
 * pidesktop-theme-creator 的校验清单），五处镜像文档与这里必须一致。
 *
 * 行为回归：
 * ① 传输完成后刷新**当前目录**——`sftp.list` 的 `path` 缺省值是远端 home，裸调
 *    `list()` 会让用户「在指定目录上传完文件后自动跳回根目录」（用户 2026-11-02 报）。
 * ② 多选下载：ctrl 点选多个文件后一次 `sftp.download` 带多个 remotePaths。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const HOME = "/home/pi";

function entry(name: string, kind: SshRemoteEntry["kind"], size = 0): SshRemoteEntry {
  return { name, kind, size, sizeText: kind === "directory" ? "-" : `${size} B`, mtimeText: "2026-01-01 00:00", mtimeMs: 1 };
}

const tree: Record<string, SshRemoteEntry[]> = {
  [HOME]: [entry("app", "directory"), entry("notes.txt", "file", 1024)],
  [`${HOME}/app`]: [entry("logs", "directory"), entry("server.js", "file", 2048), entry("README.md", "file", 512)]
};

let container: HTMLDivElement;
let root: Root;
let listener: ((event: SshEventData) => void) | undefined;

const ssh = vi.fn(async (command: { type: string; path?: string }) => {
  if (command.type === "sftp.list") {
    const target = command.path ?? HOME;
    return { kind: "sftp-listing", path: target, home: HOME, entries: tree[target] ?? [] };
  }
  return { kind: "void" };
});

beforeEach(() => {
  ssh.mockClear();
  listener = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("window", {
    ...globalThis.window,
    piDesktop: {
      ssh,
      onSshData: (_id: string, fn: typeof listener) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      chooseSshUploadFiles: async () => [] as string[],
      revealInExplorer: async () => undefined
    }
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(workspace: string | undefined = "D:/ws"): Promise<void> {
  await act(async () => root.render(<SshFilesPanel terminalId="t" workspace={workspace} onError={() => {}} />));
}

function row(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>(".ssh-files-row")].find((element) => element.dataset.name === name);
  if (!found) throw new Error(`找不到行：${name}`);
  return found;
}

function click(element: Element, init: MouseEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
}

describe("SshFilesPanel theme hooks", () => {
  it("carries the public theme hooks for the remote file drawer", () => {
    const markup = renderToStaticMarkup(<SshFilesPanel terminalId="ssh-1" workspace="D:/ws" onError={() => {}} />);
    // data-pane 契约
    expect(markup).toContain('data-pane="ssh-files"');
    // 控件钩子契约（首屏必须在，否则主题选择器挂不上）
    for (const control of ["ssh-upload", "ssh-download"]) {
      expect(markup).toContain(`data-control="${control}"`);
    }
    // 类名骨架：面包屑/列头/列表（主题可用 .ssh-files-* / .ssh-transfer-* 命中）
    expect(markup).toContain("ssh-files-toolbar");
    expect(markup).toContain("ssh-files-columns");
    expect(markup).toContain("ssh-files-list");
  });

  it("renders the download action disabled until a file is selected", () => {
    const markup = renderToStaticMarkup(<SshFilesPanel terminalId="ssh-1" workspace="D:/ws" onError={() => {}} />);
    // 未选中文件时下载必须禁用（没有明确目标就不该能点）
    expect(markup).toMatch(/data-control="ssh-download"[^>]*disabled/u);
    // 上传不依赖选中项（首屏目录未就绪时才禁用，那只是为了 remoteDir 不是空串）
    expect(markup).toContain('data-control="ssh-upload"');
  });

  it("renders the drawer without a workspace so the panel itself never crashes", () => {
    const markup = renderToStaticMarkup(<SshFilesPanel terminalId="ssh-1" onError={() => {}} />);
    expect(markup).toContain('data-pane="ssh-files"');
  });
});

describe("SshFilesPanel 行为回归", () => {
  it("传输完成后刷新的是当前目录，不会跳回远端 home", async () => {
    await mount();
    // 首屏在 home，双击进入 app
    act(() => {
      row("app").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await act(async () => {});
    expect(ssh).toHaveBeenLastCalledWith({ type: "sftp.list", terminalId: "t", path: `${HOME}/app` });

    // 上传完成事件（终态）触发刷新 —— 修的正是这里：必须是 /home/pi/app，不是 home
    act(() => {
      listener?.({ type: "transfer", terminalId: "t", transferId: "ui-upload-1", direction: "upload", name: "server.js", state: "done", transferred: 2048, total: 2048 });
    });
    await act(async () => {});
    expect(ssh).toHaveBeenLastCalledWith({ type: "sftp.list", terminalId: "t", path: `${HOME}/app` });
  });

  it("多选后一次下载带上全部选中文件的远端路径（目录不参与）", async () => {
    await mount();
    act(() => {
      row("app").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await act(async () => {});
    click(row("server.js"));
    // ctrl 点第二行 → 两个文件都选中
    click(row("README.md"), { ctrlKey: true });
    // 目录不参与下载
    click(row("logs"), { ctrlKey: true });
    const download = container.querySelector<HTMLButtonElement>('[data-control="ssh-download"]')!;
    expect(download.disabled).toBe(false);
    click(download);
    await act(async () => {});
    expect(ssh).toHaveBeenCalledWith({
      type: "sftp.download",
      terminalId: "t",
      transferId: expect.stringMatching(/^ui-download-/u),
      remotePaths: [`${HOME}/app/server.js`, `${HOME}/app/README.md`],
      workspace: "D:/ws"
    });
  });

  it("Backspace 回上一级，Ctrl+A 全选（键盘可达）", async () => {
    await mount();
    act(() => {
      row("app").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    await act(async () => {});
    const list = container.querySelector<HTMLDivElement>(".ssh-files-list")!;
    act(() => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    });
    expect([...container.querySelectorAll(".ssh-files-row.selected")].length).toBe(3);
    act(() => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    });
    await act(async () => {});
    expect(ssh).toHaveBeenLastCalledWith({ type: "sftp.list", terminalId: "t", path: HOME });
  });
});
