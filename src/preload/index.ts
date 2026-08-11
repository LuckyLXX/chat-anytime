import { contextBridge, ipcRenderer } from "electron";
import type { BrowserPreviewCommand, DesktopApi, RuntimeCommand, RuntimeMessage } from "../shared/protocol.js";

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
  chooseAttachments: (workspace?: string) => ipcRenderer.invoke("desktop:choose-attachments", workspace),
  choosePreviewFile: () => ipcRenderer.invoke("desktop:choose-preview-file"),
  readWorkspaceFile: (relativePath: string) => ipcRenderer.invoke("desktop:read-workspace-file", relativePath),
  browserPreview: (command: BrowserPreviewCommand) => ipcRenderer.invoke("browser-preview:command", command),
  send: (command: RuntimeCommand) => ipcRenderer.invoke("runtime:send", command),
  onRuntimeMessage: (listener: (message: RuntimeMessage) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: RuntimeMessage): void => listener(message);
    ipcRenderer.on("runtime:message", handler);
    return () => ipcRenderer.removeListener("runtime:message", handler);
  },
  onBrowserPreviewState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]): void => listener(state);
    ipcRenderer.on("browser-preview:state", handler);
    return () => ipcRenderer.removeListener("browser-preview:state", handler);
  }
};

contextBridge.exposeInMainWorld("piDesktop", api);
