import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, RuntimeCommand, RuntimeMessage } from "../shared/protocol.js";

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
  chooseAttachments: (workspace?: string) => ipcRenderer.invoke("desktop:choose-attachments", workspace),
  readWorkspaceFile: (relativePath: string) => ipcRenderer.invoke("desktop:read-workspace-file", relativePath),
  send: (command: RuntimeCommand) => ipcRenderer.invoke("runtime:send", command),
  onRuntimeMessage: (listener: (message: RuntimeMessage) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: RuntimeMessage): void => listener(message);
    ipcRenderer.on("runtime:message", handler);
    return () => ipcRenderer.removeListener("runtime:message", handler);
  }
};

contextBridge.exposeInMainWorld("piDesktop", api);
