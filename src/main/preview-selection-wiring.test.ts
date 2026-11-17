import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("预览选区跨进程接线", () => {
  it("网页 preload、主进程、主 preload 与 demo 镜像使用同一事件链", () => {
    const browserPreload = read("src/preload/browser-pick.ts");
    const controller = read("src/main/browser-preview.ts");
    const main = read("src/main/index.ts");
    const preload = read("src/preload/index.ts");
    const demo = read("src/renderer/src/demo-api.ts");
    const protocol = read("src/shared/protocol.ts");
    expect(browserPreload).toContain('win.addEventListener("contextmenu"');
    expect(browserPreload).toContain('"browser-preview:selection-result"');
    expect(controller).toContain('channel === "browser-preview:selection-result"');
    expect(controller).toContain("parseBrowserTextSelection(payload");
    expect(controller).toContain("this.onTextSelection?.({ tabId, ...selection })");
    expect(main).toContain('webContents.send("browser-preview:selection", selection)');
    expect(preload).toContain('ipcRenderer.on("browser-preview:selection", handler)');
    expect(preload).toContain('ipcRenderer.removeListener("browser-preview:selection", handler)');
    expect(protocol).toContain("onBrowserTextSelected(listener:");
    expect(demo).toContain("onBrowserTextSelected(_listener:");
  });

  it("选区经当前标签过滤和统一弹窗进入焦点聊天输入框，并登记原生视图让位", () => {
    const browser = read("src/renderer/src/components/BrowserPreview.tsx");
    const preview = read("src/renderer/src/components/ArtifactPreview.tsx");
    const app = read("src/renderer/src/App.tsx");
    expect(browser).toContain("if (selection.tabId === tabId) onTextSelection?.(selection)");
    expect(preview).toContain("onContextMenu={handleSelectionContextMenu}");
    expect(preview).toContain("readPreviewDomSelection(event.currentTarget, event.target, window.getSelection())");
    expect(preview).toContain("onTextSelection={(selection) => onSelectionRequest?.(");
    expect(app).toContain("useOverlayLayer(selectionPresence.rendered)");
    expect(app).toContain("const targetId = focusedPaneId ?? activeSessionId");
    expect(app).toContain("composer.insertText(message)");
    expect(app).toContain("请先创建或打开一个会话，再发送选中内容");
    expect(app).toContain("onSelectionRequest={setPreviewSelection}");
  });
});
