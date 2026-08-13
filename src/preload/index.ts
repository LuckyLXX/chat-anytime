import { contextBridge, ipcRenderer } from "electron";
import type { BrowserPreviewCommand, BrowserPreviewState, DesktopApi, RuntimeCommand, RuntimeMessage } from "../shared/protocol.js";

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
  chooseAttachments: (workspace?: string) => ipcRenderer.invoke("desktop:choose-attachments", workspace),
  choosePreviewFile: () => ipcRenderer.invoke("desktop:choose-preview-file"),
  readWorkspaceFile: (relativePath: string, workspace?: string) => ipcRenderer.invoke("desktop:read-workspace-file", relativePath, workspace),
  writeWorkspaceFile: (relativePath: string, content: string, workspace?: string) => ipcRenderer.invoke("desktop:write-workspace-file", relativePath, content, workspace),
  listWorkspaceDirectory: (workspace: string, relativePath?: string) => ipcRenderer.invoke("desktop:list-workspace-directory", workspace, relativePath),
  browserPreview: (command: BrowserPreviewCommand) => ipcRenderer.invoke("browser-preview:command", command),
  send: (command: RuntimeCommand) => ipcRenderer.invoke("runtime:send", command),
  onRuntimeMessage: (listener: (message: RuntimeMessage) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: RuntimeMessage): void => listener(message);
    ipcRenderer.on("runtime:message", handler);
    return () => ipcRenderer.removeListener("runtime:message", handler);
  },
  onBrowserPreviewState: (tabId?: string, listener?: (state: BrowserPreviewState) => void) => {
    const eventChannel = tabId === undefined ? "browser-preview:state" : `browser-preview:state:${tabId}`;
    const stateListener = listener ?? (() => {});
    const handler = (_event: Electron.IpcRendererEvent, state: BrowserPreviewState): void => stateListener(state);
    ipcRenderer.on(eventChannel, handler);
    return () => ipcRenderer.removeListener(eventChannel, handler);
  }
};

contextBridge.exposeInMainWorld("piDesktop", api);