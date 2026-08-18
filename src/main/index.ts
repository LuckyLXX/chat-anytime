import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, utilityProcess, type UtilityProcess } from "electron";
import { spawn } from "node-pty";
import { migrateSettings, normalizeVision } from "./settings.js";
import { importExternalAttachment, workspaceRelativeAttachment } from "./attachments.js";
import type { BrowserPreviewCommand, BrowserPreviewState, DesktopBootstrap, DesktopSettings, PromptAttachment, ResourceCatalog, RuntimeCommand, RuntimeMessage, RuntimeSnapshot, TerminalCommand, TerminalEventData, WorkspaceDirectoryListing, WorkspaceEntryResult, WorkspaceFilePreview, WorkspaceFileSearchResult, WorkspaceFileWriteResult } from "../shared/protocol.js";
import { createWorkspaceDirectory, createWorkspaceFile, deleteWorkspaceEntry, listWorkspaceDirectory, readWorkspaceFilePreview, renameWorkspaceEntry, searchWorkspaceFiles, writeWorkspaceFile } from "./workspace-preview.js";
import { BrowserPreviewController } from "./browser-preview.js";
import { TerminalManager, type PtyProcess, type PtySpawnOptions } from "./terminal-pty.js";

let mainWindow: BrowserWindow | undefined;
let runtimeProcess: UtilityProcess | undefined;
let latestSnapshot: RuntimeSnapshot | undefined;
let latestCatalog: Extract<RuntimeMessage, { type: "catalog" }> | undefined;
let latestResources: ResourceCatalog | undefined;
let settingsCache: DesktopSettings | undefined;
let credentialsCache: Record<string, string> = {};
let securityWarning: string | undefined;
let browserPreviewController: BrowserPreviewController | undefined;

const spawnNodePty = (file: string, args: string[], options: PtySpawnOptions): PtyProcess => spawn(file, args, options);
const terminalManager = new TerminalManager({
  spawnPty: spawnNodePty,
  publish: (terminalId, event: TerminalEventData) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(`terminal:data:${terminalId}`, event);
  },
  defaultCwd: () => loadSettings().workspace
});

function settingsPath(): string { return join(app.getPath("userData"), "settings.json"); }
function credentialsPath(): string { return join(app.getPath("userData"), "credentials.json"); }
function writeJson(path: string, value: unknown): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
function readJson(path: string): unknown {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; } catch { return undefined; }
}
const imageMimeByExtension: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

async function readAttachmentSelection(paths: string[], workspace?: string): Promise<PromptAttachment[]> {
  const root = workspace ? resolve(workspace) : undefined;
  const rootReal = root ? await realpath(root) : undefined;
  const result: PromptAttachment[] = [];
  for (const path of paths) {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`附件不是普通文件：${path}`);
    if (info.size > 20 * 1024 * 1024) throw new Error(`附件超过 20 MB 限制：${path}`);
    const name = path.split(/[\\/]/u).at(-1) ?? path;
    const mimeType = imageMimeByExtension[extname(name).toLowerCase()];
    if (mimeType) {
      const data = (await readFile(path)).toString("base64");
      result.push({ kind: "image", name, mimeType, size: info.size, data });
      continue;
    }
    if (!root || !rootReal) throw new Error(`请先打开工作区，再添加项目文件：${name}`);
    const candidate = resolve(path);
    const candidateReal = await realpath(candidate);
    let relativePath: string;
    try {
      relativePath = workspaceRelativeAttachment(rootReal, candidateReal);
    } catch {
      relativePath = await importExternalAttachment(rootReal, candidateReal);
    }
    result.push({ kind: "file", name, path: relativePath, relativePath, size: info.size });
  }
  return result;
}
function loadCredentials(): Record<string, string> {
  const raw = readJson(credentialsPath());
  if (!raw || typeof raw !== "object" || !safeStorage.isEncryptionAvailable()) return {};
  const result: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    try { result[id] = safeStorage.decryptString(Buffer.from(value, "base64")); } catch { /* ignore corrupt entries */ }
  }
  return result;
}
function saveCredential(providerId: string, apiKey: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const raw = readJson(credentialsPath());
    const encrypted: Record<string, string> = raw && typeof raw === "object" ? { ...(raw as Record<string, string>) } : {};
    const encryptedValue = safeStorage.encryptString(apiKey).toString("base64");
    if (safeStorage.decryptString(Buffer.from(encryptedValue, "base64")) !== apiKey) return false;
    encrypted[providerId] = encryptedValue;
    writeJson(credentialsPath(), encrypted);
    credentialsCache[providerId] = apiKey;
    return true;
  } catch { return false; }
}
function deleteCredential(providerId: string): void {
  delete credentialsCache[providerId];
  try {
    const raw = readJson(credentialsPath());
    if (!raw || typeof raw !== "object") return;
    const encrypted = { ...(raw as Record<string, string>) };
    delete encrypted[providerId];
    writeJson(credentialsPath(), encrypted);
  } catch { /* an absent encrypted file is equivalent to a deleted key */ }
}
function loadSettings(): DesktopSettings {
  if (settingsCache) return settingsCache;
  const raw = readJson(settingsPath());
  const migrated = migrateSettings(raw);
  settingsCache = migrated.settings;
  credentialsCache = loadCredentials();
  if (migrated.legacyApiKey) {
    if (saveCredential("chatanytime-openai-compatible", migrated.legacyApiKey)) {
      writeJson(settingsPath(), settingsCache);
    } else {
      credentialsCache["chatanytime-openai-compatible"] = migrated.legacyApiKey;
      securityWarning = "系统加密存储不可用，旧 API Key 未写入新明文文件，仅在本次运行中使用。";
      console.warn("系统加密存储不可用，保留旧 API Key 配置并仅在内存中使用。");
    }
  } else if (!existsSync(settingsPath())) writeJson(settingsPath(), settingsCache);
  return settingsCache;
}
function persistSettings(): void { if (settingsCache) writeJson(settingsPath(), settingsCache); }
function updateSettings(command: RuntimeCommand): void {
  const settings = loadSettings();
  switch (command.type) {
    case "workspace.open": settings.workspace = command.path; break;
    case "session.pin": settings.pinnedSessionPaths = command.pinned ? [...(settings.pinnedSessionPaths ?? []), command.path] : (settings.pinnedSessionPaths ?? []).filter((item) => item !== command.path); break;
    case "session.new": if (command.workspace) settings.workspace = command.workspace; break;
    case "session.open": if (command.workspace) settings.workspace = command.workspace; break;
    case "agent.select": settings.currentAgentId = command.agentId; break;
    case "agent.save": settings.agents = settings.agents.some((item) => item.id === command.agent.id) ? settings.agents.map((item) => item.id === command.agent.id ? command.agent : item) : [...settings.agents, command.agent]; break;
    case "agent.archive":
      settings.agents = settings.agents.map((item) => item.id === command.agentId && item.id !== "default" ? { ...item, archived: command.archived } : item);
      if (settings.currentAgentId === command.agentId && command.archived) settings.currentAgentId = "default";
      break;
    case "settings.save": settings.model = command.settings.model; settings.thinkingLevel = command.settings.thinkingLevel; settings.accessMode = command.settings.accessMode; settings.appearance = command.settings.appearance; break;
    case "appearance.save": settings.appearance = command.appearance; break;
    case "provider.save": {
      settings.providers = settings.providers.some((item) => item.id === command.provider.id) ? settings.providers.map((item) => item.id === command.provider.id ? command.provider : item) : [...settings.providers, command.provider];
      if (command.apiKey?.trim() && !saveCredential(command.provider.id, command.apiKey.trim())) {
        mainWindow?.webContents.send("runtime:message", { type: "log", level: "warn", message: "系统加密存储不可用，API Key 未保存。" } satisfies RuntimeMessage);
      }
      break;
    }
    case "provider.models.save":
      settings.providers = settings.providers.some((item) => item.id === command.provider.id) ? settings.providers.map((item) => item.id === command.provider.id ? command.provider : item) : [...settings.providers, command.provider];
      break;
    case "auth.set":
      if (command.apiKey.trim() && !saveCredential(command.provider, command.apiKey.trim())) {
        mainWindow?.webContents.send("runtime:message", { type: "log", level: "warn", message: "系统加密存储不可用，API Key 未保存。" } satisfies RuntimeMessage);
      }
      break;
    case "provider.delete":
      settings.providers = settings.providers.filter((item) => item.id !== command.providerId);
      if (settings.model?.provider === command.providerId) settings.model = undefined;
      settings.agents = settings.agents.map((agent) => agent.defaultModel?.provider === command.providerId ? { ...agent, defaultModel: undefined } : agent);
      deleteCredential(command.providerId);
      break;
    case "vision.save":
      settings.vision = normalizeVision(command.vision) ?? { enabled: false, provider: "", model: "" };
      break;
  }
  persistSettings();
}
function runtimeEntry(): string { return join(__dirname, "pi-runtime.js"); }
function sendToRuntime(command: RuntimeCommand): void { if (!runtimeProcess) throw new Error("Pi 运行时当前不可用"); runtimeProcess.postMessage(command); }
function startRuntime(): void {
  runtimeProcess = utilityProcess.fork(runtimeEntry(), [], { serviceName: "Pi 运行时", stdio: "pipe" });
  runtimeProcess.on("message", (message: RuntimeMessage) => {
    if (message.type === "state") latestSnapshot = message.snapshot;
    if (message.type === "catalog") latestCatalog = message;
    if (message.type === "resources") latestResources = message.resources;
    if (message.type === "custom-models") {
      const source = loadSettings();
      source.providers = source.providers.map((provider) => provider.id === message.providerId ? { ...provider, models: message.models } : provider);
      persistSettings();
    }
    mainWindow?.webContents.send("runtime:message", message);
  });
  runtimeProcess.on("exit", (code) => { runtimeProcess = undefined; mainWindow?.webContents.send("runtime:message", { type: "error", message: `Pi 运行时意外停止（退出代码 ${code}），请重启应用。` } satisfies RuntimeMessage); });
  // Forward Pi runtime stdio only in development: in packaged builds the Pi
  // runtime is chatty (per-token/tool logs) and piping it through synchronous
  // console I/O on the main thread slows runtime→renderer message forwarding.
  if (!app.isPackaged) {
    runtimeProcess.stdout?.on("data", (chunk) => console.log(`[pi-runtime] ${String(chunk).trimEnd()}`));
    runtimeProcess.stderr?.on("data", (chunk) => console.error(`[pi-runtime] ${String(chunk).trimEnd()}`));
  }
  const settings = loadSettings();
  sendToRuntime({ type: "initialize", settings, apiKeys: credentialsCache });
}
function createWindow(): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const nextWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 1040, minHeight: 680, backgroundColor: "#f5f5f2", titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default", webPreferences: { preload: join(__dirname, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: !rendererUrl } });
  const previewController = new BrowserPreviewController(nextWindow, (state, tabId) => {
    if (!nextWindow.isDestroyed()) nextWindow.webContents.send(`browser-preview:state:${tabId}`, state);
  });
  mainWindow = nextWindow;
  browserPreviewController = previewController;
  nextWindow.on("closed", () => {
    previewController.dispose();
    if (browserPreviewController === previewController) browserPreviewController = undefined;
    if (mainWindow === nextWindow) mainWindow = undefined;
  });
  nextWindow.webContents.setWindowOpenHandler(({ url }) => { void import("electron").then(({ shell }) => shell.openExternal(url)); return { action: "deny" }; });
  if (rendererUrl) void nextWindow.loadURL(rendererUrl); else void nextWindow.loadFile(join(__dirname, "../renderer/index.html"));
}
function isTerminalCommand(value: unknown): value is TerminalCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  if (typeof command.terminalId !== "string" || !command.terminalId.trim()) return false;
  switch (command.type) {
    case "create":
      return typeof command.cols === "number" && typeof command.rows === "number" && (command.cwd === undefined || typeof command.cwd === "string") && (command.shell === undefined || typeof command.shell === "string");
    case "input":
      return typeof command.data === "string";
    case "resize":
      return typeof command.cols === "number" && typeof command.rows === "number";
    case "kill":
      return true;
    default:
      return false;
  }
}

function registerIpc(): void {
  ipcMain.handle("desktop:bootstrap", (): DesktopBootstrap => {
    const source = loadSettings();
    const settings: DesktopSettings = { ...source, providers: source.providers.map((provider) => ({ ...provider, keyConfigured: Boolean(credentialsCache[provider.id]) })) };
    return { platform: process.platform, version: app.getVersion(), securityWarning, settings, runtime: latestSnapshot, catalog: latestCatalog ? { models: latestCatalog.models, providers: latestCatalog.providers } : undefined, resources: latestResources };
  });
  ipcMain.handle("desktop:choose-workspace", async (): Promise<string | undefined> => { const result = mainWindow ? await dialog.showOpenDialog(mainWindow, { title: "选择项目工作区", properties: ["openDirectory", "createDirectory"] }) : await dialog.showOpenDialog({ title: "选择项目工作区", properties: ["openDirectory", "createDirectory"] }); return result.canceled ? undefined : result.filePaths[0]; });
  ipcMain.handle("desktop:choose-preview-file", async (): Promise<WorkspaceFilePreview | undefined> => {
    const workspace = loadSettings().workspace;
    if (!workspace) throw new Error("请先打开工作区，再选择预览文件");
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, { title: "选择预览文件", defaultPath: workspace, properties: ["openFile"], filters: [{ name: "常见代码、Markdown 和资源", extensions: ["md", "markdown", "mdx", "js", "ts", "tsx", "jsx", "json", "css", "html", "htm", "svg", "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "*" ] }] })
      : await dialog.showOpenDialog({ title: "选择预览文件", defaultPath: workspace, properties: ["openFile"] });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const rootReal = await realpath(resolve(workspace));
    const candidateReal = await realpath(result.filePaths[0]);
    let relativePath: string;
    try {
      relativePath = workspaceRelativeAttachment(rootReal, candidateReal);
    } catch (error) {
      if (error instanceof Error && error.message === "附件必须位于当前工作区内") throw new Error("预览文件必须位于当前工作区内");
      throw error;
    }
    return readWorkspaceFilePreview(rootReal, relativePath);
  });
  ipcMain.handle("desktop:choose-attachments", async (_event, workspace?: string): Promise<PromptAttachment[]> => { const result = mainWindow ? await dialog.showOpenDialog(mainWindow, { title: "添加附件", properties: ["openFile", "multiSelections"], filters: [{ name: "图片和项目文件", extensions: ["png", "jpg", "jpeg", "webp", "gif", "*" ] }] }) : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] }); return result.canceled ? [] : readAttachmentSelection(result.filePaths, workspace); });
  // 部分剪贴板来源（微信/QQ 截图、浏览器“复制图片”）只写位图格式，渲染进程的
  // paste 事件里拿不到文件；由主进程读系统剪贴板兜底，PNG base64 返回。
  ipcMain.handle("desktop:read-clipboard-image", (): { data: string } | undefined => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return undefined;
    const png = image.toPNG();
    return png.length > 0 ? { data: png.toString("base64") } : undefined;
  });
  ipcMain.handle("desktop:read-workspace-file", async (_event, relativePath: string, workspace?: string): Promise<WorkspaceFilePreview> => {
    const resolvedWorkspace = workspace ?? loadSettings().workspace;
    if (!resolvedWorkspace) throw new Error("请先打开工作区，再预览文件");
    if (typeof relativePath !== "string") throw new Error("预览文件路径无效");
    return readWorkspaceFilePreview(resolvedWorkspace, relativePath);
  });
  ipcMain.handle("desktop:write-workspace-file", async (_event, relativePath: string, content: string, workspace?: string): Promise<WorkspaceFileWriteResult> => {
    const resolvedWorkspace = workspace ?? loadSettings().workspace;
    if (!resolvedWorkspace) throw new Error("请先打开工作区，再保存文件");
    if (typeof relativePath !== "string") throw new Error("保存文件路径无效");
    if (typeof content !== "string") throw new Error("文件内容无效");
    return writeWorkspaceFile(resolvedWorkspace, relativePath, content);
  });
  ipcMain.handle("desktop:list-workspace-directory", async (_event, workspace: string, relativePath?: string): Promise<WorkspaceDirectoryListing> => {
    if (typeof workspace !== "string" || !workspace.trim()) throw new Error("请指定要浏览的工作区");
    return listWorkspaceDirectory(workspace, relativePath);
  });
  ipcMain.handle("desktop:search-workspace-files", async (_event, workspace: string, query: string): Promise<WorkspaceFileSearchResult> => {
    if (typeof workspace !== "string" || !workspace.trim()) throw new Error("请指定要搜索的工作区");
    if (typeof query !== "string") throw new Error("搜索词无效");
    return searchWorkspaceFiles(workspace, query);
  });
  ipcMain.handle("desktop:create-workspace-file", async (_event, workspace: string, relativePath: string): Promise<WorkspaceEntryResult> => {
    if (typeof workspace !== "string" || !workspace.trim()) throw new Error("请指定要操作的工作区");
    if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("文件路径无效");
    return createWorkspaceFile(workspace, relativePath);
  });
  ipcMain.handle("desktop:create-workspace-directory", async (_event, workspace: string, relativePath: string): Promise<WorkspaceEntryResult> => {
    if (typeof workspace !== "string" || !workspace.trim()) throw new Error("请指定要操作的工作区");
    if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("文件夹路径无效");
    return createWorkspaceDirectory(workspace, relativePath);
  });
  ipcMain.handle("desktop:delete-workspace-entry", async (_event, workspace: string, relativePath: string): Promise<WorkspaceEntryResult> => {
    if (typeof workspace !== "string" || !workspace.trim()) throw new Error("请指定要操作的工作区");
    if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("删除路径无效");
    return deleteWorkspaceEntry(workspace, relativePath);
  });
  ipcMain.handle("desktop:rename-workspace-entry", async (_event, workspace: string, relativePath: string, newName: string): Promise<WorkspaceEntryResult> => {
    if (typeof workspace !== "string" || !workspace.trim()) throw new Error("请指定要操作的工作区");
    if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("重命名路径无效");
    if (typeof newName !== "string") throw new Error("新名称无效");
    return renameWorkspaceEntry(workspace, relativePath, newName);
  });
  ipcMain.handle("browser-preview:command", async (_event, command: BrowserPreviewCommand): Promise<BrowserPreviewState> => {
    if (!browserPreviewController) throw new Error("浏览器预览当前不可用");
    return browserPreviewController.handle(command);
  });
  ipcMain.handle("terminal:command", (_event, command: TerminalCommand): void => {
    if (!isTerminalCommand(command)) throw new Error("终端命令无效");
    terminalManager.handle(command);
  });
  ipcMain.handle("runtime:send", (_event, command: RuntimeCommand): void => { updateSettings(command); sendToRuntime(command); });
}
app.whenReady().then(() => { Menu.setApplicationMenu(null); registerIpc(); startRuntime(); createWindow(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { browserPreviewController?.dispose(); terminalManager.disposeAll(); runtimeProcess?.kill(); });
