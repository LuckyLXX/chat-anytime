import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

describe("预览选区就地发送接线", () => {
  it("网页 preload、主进程与渲染端双向传递选区请求和结果", () => {
    const browserPreload = read("src/preload/browser-pick.ts");
    const ui = read("src/preload/browser-selection-ui.ts");
    const controller = read("src/main/browser-preview.ts");
    const main = read("src/main/index.ts");
    const preload = read("src/preload/index.ts");
    const demo = read("src/renderer/src/demo-api.ts");
    const protocol = read("src/shared/protocol.ts");
    expect(browserPreload).toContain("installBrowserSelectionUI(doc");
    expect(browserPreload).toContain('"browser-preview:selection-result"');
    expect(browserPreload).toContain('"browser-preview:selection-reply"');
    expect(ui).toContain('win.addEventListener("pointerup"');
    expect(ui).toContain('host.attachShadow({ mode: "closed" })');
    expect(controller).toContain("parseBrowserTextSelection(payload");
    expect(controller).toContain("this.onTextSelection?.({ tabId, ...selection })");
    expect(controller).toContain('contents.send("browser-preview:selection-automation"');
    expect(main).toContain('webContents.send("browser-preview:selection", selection)');
    expect(preload).toContain('ipcRenderer.on("browser-preview:selection", handler)');
    expect(preload).toContain('ipcRenderer.removeListener("browser-preview:selection", handler)');
    expect(protocol).toContain("onBrowserTextSelected(listener:");
    expect(demo).toContain("onBrowserTextSelected(_listener:");
  });

  it("发送到焦点会话，按 utility 权威忙闲排队并匹配回执", () => {
    const browser = read("src/renderer/src/components/BrowserPreview.tsx");
    const preview = read("src/renderer/src/components/ArtifactPreview.tsx");
    const app = read("src/renderer/src/App.tsx");
    const helper = read("src/renderer/src/lib/preview-selection-send.ts");
    const runtime = read("src/main/pi-runtime.ts");
    const queue = runtime.slice(runtime.indexOf('case "session.queue.add":'), runtime.indexOf('case "session.queue.sendNow":'));
    expect(browser).toContain("if (selection.tabId !== tabId) return");
    expect(browser).toContain('type: "selection-reply", tabId, requestId: selection.requestId');
    expect(preview).toContain("<PreviewSelectionPopover");
    expect(preview).toContain("onSelectionSubmit({ source: selection.url, text: selection.text }, selection.note)");
    expect(app).toContain("const targetId = focusedPaneId ?? activeSessionId");
    expect(app).toContain("sendPreviewSelectionToSession(window.piDesktop, targetId, message)");
    expect(app).not.toContain("useOverlayLayer(selectionPresence.rendered)");
    expect(helper).toContain('type: "session.queue.add", sessionId, text, requestId');
    expect(helper).toContain('message.type !== "session.queue-result"');
    expect(queue).toContain("if (runActive(record))");
    expect(queue).toContain('streamingBehavior: "followUp"');
    expect(queue).toContain('type: "session.prompt"');
    expect(runtime).toContain("dispatchWithQueueReceipt(event.data, handleCommand, post, errorText)");
  });
});
