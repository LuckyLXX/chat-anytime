import { contextBridge, ipcRenderer } from "electron";
import type { BrowserElementPick, BrowserPreviewCommand, BrowserPreviewState, BrowserTabsEvent, DesktopApi, RuntimeCommand, RuntimeMessage, TerminalCommand, TerminalEventData } from "../shared/protocol.js";

const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("desktop:choose-workspace"),
  chooseAttachments: (workspace?: string) => ipcRenderer.invoke("desktop:choose-attachments", workspace),
  readClipboardImage: () => ipcRenderer.invoke("desktop:read-clipboard-image"),
  choosePreviewFile: () => ipcRenderer.invoke("desktop:choose-preview-file"),
  readWorkspaceFile: (relativePath: string, workspace?: string) => ipcRenderer.invoke("desktop:read-workspace-file", relativePath, workspace),
  writeWorkspaceFile: (relativePath: string, content: string, workspace?: string) => ipcRenderer.invoke("desktop:write-workspace-file", relativePath, content, workspace),
  listWorkspaceDirectory: (workspace: string, relativePath?: string) => ipcRenderer.invoke("desktop:list-workspace-directory", workspace, relativePath),
  searchWorkspaceFiles: (workspace: string, query: string) => ipcRenderer.invoke("desktop:search-workspace-files", workspace, query),
  createWorkspaceFile: (workspace: string, relativePath: string) => ipcRenderer.invoke("desktop:create-workspace-file", workspace, relativePath),
  createWorkspaceDirectory: (workspace: string, relativePath: string) => ipcRenderer.invoke("desktop:create-workspace-directory", workspace, relativePath),
  deleteWorkspaceEntry: (workspace: string, relativePath: string) => ipcRenderer.invoke("desktop:delete-workspace-entry", workspace, relativePath),
  renameWorkspaceEntry: (workspace: string, relativePath: string, newName: string) => ipcRenderer.invoke("desktop:rename-workspace-entry", workspace, relativePath, newName),
  revealInExplorer: (workspace: string, relativePath?: string) => ipcRenderer.invoke("desktop:reveal-in-explorer", workspace, relativePath),
  statWorkspaceFile: (workspace: string, relativePath: string) => ipcRenderer.invoke("desktop:stat-workspace-file", workspace, relativePath),
  browserPreview: (command: BrowserPreviewCommand) => ipcRenderer.invoke("browser-preview:command", command),
  browserAutomationCancel: (tabId: string) => ipcRenderer.invoke("browser-automation:cancel", tabId),
  terminal: (command: TerminalCommand) => ipcRenderer.invoke("terminal:command", command),
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
  },
  onBrowserTabsChanged: (listener: (event: BrowserTabsEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: BrowserTabsEvent): void => listener(event);
    ipcRenderer.on("browser-preview:tabs", handler);
    return () => ipcRenderer.removeListener("browser-preview:tabs", handler);
  },
  onBrowserElementPicked: (listener: (pick: BrowserElementPick) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, pick: BrowserElementPick): void => listener(pick);
    ipcRenderer.on("browser-preview:pick", handler);
    return () => ipcRenderer.removeListener("browser-preview:pick", handler);
  },
  onTerminalData: (terminalId: string, listener: (event: TerminalEventData) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: TerminalEventData): void => listener(event);
    const channel = `terminal:data:${terminalId}`;
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  }
};

contextBridge.exposeInMainWorld("piDesktop", api);