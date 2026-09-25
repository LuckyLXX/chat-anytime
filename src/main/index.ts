import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, protocol, safeStorage, shell, utilityProcess, type UtilityProcess } from "electron";
import { spawn } from "node-pty";
import appIconPath from "./assets/icon.ico?asset";
import { resolveBundledSkillsDir, resolveBundledSubagentsDir } from "./bundled-skills.js";
import { migrateSettings, mergeBrowserSettings, normalizeJev, normalizeVision, recordAgentWorkspace, forgetAgentWorkspace, withBrowserDownloadPrefs } from "./settings.js";
import { manualDownloadPrefs } from "./browser-manual-download.js";
import { mergeSavedAppearance, settingsForRenderer } from "./appearance-assets.js";
import { createSettingsPersistence, diffSettings, readSettingsFile, settingsPath as settingsFilePath, type SettingsPersistence } from "./settings-store.js";
import { togglePinnedSessionPath } from "./session-scope.js";
import { importExternalAttachment, workspaceRelativeAttachment } from "./attachments.js";
import type { BrowserDownloadPrefs, BrowserPreviewCommand, BrowserPreviewState, DesktopBootstrap, DesktopSettings, GalleryServiceProbe, PromptAttachment, ResourceCatalog, RuntimeCommand, RuntimeMessage, RuntimeSnapshot, SshCommand, SshCommandResult, SshEventData, SshRevealEvent, TerminalCommand, TerminalEventData, ThemeAssetMap, WorkspaceDirectoryListing, WorkspaceEntryResult, WorkspaceFilePreview, WorkspaceFileSearchResult, WorkspaceFileStat, WorkspaceFileWriteResult } from "../shared/protocol.js";
import { PREVIEW_FILE_SCHEME, parseWorkspaceFilePreviewUrl } from "../shared/protocol.js";
import { isThemeAssetUrl, parseThemeAssetUrl } from "../shared/theme-assets.js";
import { serveThemeAsset } from "./theme-assets.js";
import { createWorkspaceDirectory, createWorkspaceFile, deleteWorkspaceEntry, listWorkspaceDirectory, previewFileMimeType, readWorkspaceFilePreview, renameWorkspaceEntry, resolveWorkspaceEntry, safeRelativePath, searchWorkspaceFiles, statWorkspaceFile, writeWorkspaceFile } from "./workspace-preview.js";
import { pruneDisabledModelRefs } from "./model-catalog.js";
import { BrowserPreviewController } from "./browser-preview.js";
import { BrowserAutomationController } from "./browser-automation.js";
import { ComputerOverlayController } from "./computer-overlay.js";
import { DesignSnapshotController } from "./design-snapshot.js";
import { galleryThumbsDirFor, readGalleryThumb, resolveGalleryAgentDir } from "./gallery-store.js";
import { clampServiceWait, waitForService } from "./gallery-service.js";
import { TerminalManager, type PtyProcess, type PtySpawnOptions } from "./terminal-pty.js";
import { Client as Ssh2Client } from "ssh2";
import { createSshHostStore, type SshHostCrypto } from "./ssh-host-store.js";
import { createSshKnownHostsStore } from "./ssh-known-hosts.js";
import { SshConnectionManager, type SshClientLike } from "./ssh-connections.js";

/**
 * 关闭 Chromium 的「原生窗口遮挡检测」（Windows）：不关它，浏览器自动化截图会在
 * 「主窗口被别的应用完全遮住」这个最常见的场景下必然失败。
 *
 * 因果链（2026-09-24 真机探针 p6，默认模式实测）：主窗口被完全遮挡 →
 * 主渲染端 `document.visibilityState === "hidden"`、**rAF 与 ResizeObserver 回调全停**
 * → 预览面板的视口量测永远不落定 → 浏览器自动化标签页拿不到 bounds（原生视图因此
 * 一直 setVisible(false)）→ browser_screenshot 8 秒「标签页未能变为可见」超时。
 * 而**出帧本身没问题**：同探针里遮挡中 CDP Page.captureScreenshot 仍 65ms 出真帧，
 * 字节数与窗口可见时逐字节一致。同一探针加本开关后：遮挡中 visibilityState 保持
 * "visible"、rAF/RO 照常、标签页自身 rAF 也在跑，截图恢复正常。
 *
 * 代价（用户 2026-09-24 明确接受）：被遮挡 / 在别的虚拟桌面时窗口仍继续渲染，
 * 多花一点 CPU/GPU。
 *
 * 合并而非覆盖：将来别处若也追加 disable-features，这里把已有值接在前面。
 */
const disabledFeatures = ["CalculateNativeWinOcclusion"];
const existingDisabledFeatures = app.commandLine.getSwitchValue("disable-features").split(",").filter(Boolean);
app.commandLine.appendSwitch("disable-features", [...new Set([...existingDisabledFeatures, ...disabledFeatures])].join(","));

let mainWindow: BrowserWindow | undefined;
let runtimeProcess: UtilityProcess | undefined;
let latestSnapshot: RuntimeSnapshot | undefined;
let latestCatalog: Extract<RuntimeMessage, { type: "catalog" }> | undefined;
let latestResources: ResourceCatalog | undefined;
let settingsCache: DesktopSettings | undefined;
let credentialsCache: Record<string, string> = {};
let securityWarning: string | undefined;
let browserPreviewController: BrowserPreviewController | undefined;
let browserAutomationController: BrowserAutomationController | undefined;
let computerOverlayController: ComputerOverlayController | undefined;
// 设计导出缩略图（design_export 回执附图）：离屏渲染导出 HTML 并截图，无需真实预览标签页。
const designSnapshotController = new DesignSnapshotController();
/**
 * TypeSafe（Jev）密钥在 credentials.json 里的条目名。它不是 Pi 的 provider——Jev
 * 通路自己发 HTTP，而 provider 那条链已收敛到 Pi 的 ModelRuntime。凭据仍走同一
 * safeStorage 通道与同一文件（静私不外流、不越权改 provider），所以只用一个新的
 * 条目名而不是新增一套存储。
 */
const JEV_CREDENTIAL_ID = "typesafe";

const spawnNodePty = (file: string, args: string[], options: PtySpawnOptions): PtyProcess => spawn(file, args, options);
const terminalManager = new TerminalManager({
  spawnPty: spawnNodePty,
  publish: (terminalId, event: TerminalEventData) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(`terminal:data:${terminalId}`, event);
  },
  defaultCwd: () => loadSettings().workspace
});

// —— SSH：主机库（密码 safeStorage 加密，不可用时明文降级并标记）+ 连接管理 ——
const sshCrypto: SshHostCrypto = {
  encrypt: (plain) => {
    if (safeStorage.isEncryptionAvailable()) {
      return { secret: `enc:${safeStorage.encryptString(plain).toString("base64")}`, insecure: false };
    }
    return { secret: `plain:${Buffer.from(plain, "utf8").toString("base64")}`, insecure: true };
  },
  decrypt: (secret) => {
    if (secret.startsWith("enc:")) {
      try {
        return safeStorage.decryptString(Buffer.from(secret.slice(4), "base64"));
      } catch {
        return "";
      }
    }
    if (secret.startsWith("plain:")) {
      try {
        return Buffer.from(secret.slice(6), "base64").toString("utf8");
      } catch {
        return "";
      }
    }
    return "";
  },
  isAvailable: () => safeStorage.isEncryptionAvailable()
};
// ssh2 Client 的最小结构适配（运行时形状一致，接口层只声明用到的方法）。
const createSsh2Client = (): SshClientLike => new Ssh2Client() as unknown as SshClientLike;
let sshConnectionManager: SshConnectionManager | undefined;
function ensureSshManager(): SshConnectionManager {
  // 延迟创建：app.getPath("userData") 在模块顶层即可用，但 host store 的
  // 明文降级警告依赖 safeStorage 就绪状态，统一在首次使用时创建。
  sshConnectionManager ??= new SshConnectionManager({
    createClient: createSsh2Client,
    hostStore: createSshHostStore({ filePath: join(app.getPath("userData"), "pidesktop-ssh-hosts.json"), crypto: sshCrypto }),
    knownHosts: createSshKnownHostsStore(join(app.getPath("userData"), "pidesktop-ssh-known-hosts.json")),
    publish: (terminalId, event: SshEventData) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(`ssh:data:${terminalId}`, event);
    },
    reveal: (event: SshRevealEvent) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ssh:reveal", event);
    }
  });
  return sshConnectionManager;
}

function settingsPath(): string { return settingsFilePath(app.getPath("userData")); }
function credentialsPath(): string { return join(app.getPath("userData"), "credentials.json"); }
function writeJson(path: string, value: unknown): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}
function readJson(path: string): unknown {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined; } catch { return undefined; }
}
const imageMimeByExtension: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

// 工作区文件走自定义协议 pidesktop-file:// 由主进程流式读取：PDF 在 iframe 内
// 交给 Chromium 内置查看器，栅格图片供聊天气泡 <img> 引用工作区相对路径
// （渲染端 origin 不是工作区，相对路径没有基准，必须经协议映射）。
// 必须在 app ready 之前注册 scheme 特权。
protocol.registerSchemesAsPrivileged([
  { scheme: PREVIEW_FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
]);

/**
 * 工作区文件与主题资产两条通路共用 `pidesktop-file://`，靠 host 区分：
 * `theme` = 主题资产（图片 / 字体，落盘在 agentDir），`preview` = 工作区文件。
 */
function registerPreviewFileProtocol(): void {
  protocol.handle(PREVIEW_FILE_SCHEME, async (request) => {
    const themeAsset = parseThemeAssetUrl(request.url);
    if (themeAsset) return serveThemeAsset(themeAsset);
    // host 是 theme 但解析不通过 = 穿越/绝对路径/非法编码：明确 403，不落回预览分支。
    if (isThemeAssetUrl(request.url)) return new Response("主题资产地址非法", { status: 403 });
    const parsed = parseWorkspaceFilePreviewUrl(request.url);
    if (!parsed) return new Response("预览地址无效", { status: 400 });
    try {
      const rootReal = await realpath(resolve(parsed.workspace));
      if (rootReal && !safeRelativePath(rootReal, parsed.relativePath)) {
        return new Response("预览文件必须位于当前工作区内", { status: 403 });
      }
      const candidate = resolve(rootReal, ...parsed.relativePath.split("/"));
      const info = await stat(candidate);
      if (!info.isFile()) return new Response("只能预览普通文件", { status: 404 });
      const mimeType = previewFileMimeType(candidate);
      if (!mimeType) return new Response("该文件类型不支持预览", { status: 415 });
      return new Response(Readable.toWeb(createReadStream(candidate)) as ReadableStream, {
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(info.size),
          // 同路径文件可能被重新生成（AI 覆盖写同名图片），禁止直接复用缓存，
          // 但保留条件请求语义（无 ETag 时 Chromium 仍会发 If-Modified-Since）。
          "Cache-Control": "no-cache"
        }
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return new Response("文件不存在或已被删除", { status: 404 });
      throw error;
    }
  });
}

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
  // 资产（主题/壁纸内联 base64）按优先级从 settings.json / appearance-assets.json
  // 合并回 raw.appearance，内存形状与旧版完全一致（migrateSettings 零改动）。
  const { raw, assetsSource } = readSettingsFile(app.getPath("userData"));
  if (assetsSource === "inline") persistSettings().markInlineAssets();
  const migrated = migrateSettings(raw);
  settingsCache = migrated.settings;
  credentialsCache = loadCredentials();
  if (migrated.legacyApiKey) {
    if (saveCredential("chatanytime-openai-compatible", migrated.legacyApiKey)) {
      persistSettings().writeNow({ small: true, assets: false });
    } else {
      credentialsCache["chatanytime-openai-compatible"] = migrated.legacyApiKey;
      securityWarning = "系统加密存储不可用，旧 API Key 未写入新明文文件，仅在本次运行中使用。";
      console.warn("系统加密存储不可用，保留旧 API Key 配置并仅在内存中使用。");
    }
  } else if (!existsSync(settingsPath())) persistSettings().writeNow({ small: true, assets: false });
  return settingsCache;
}

/**
 * settings 写入纪律（2026-09-25 性能 P0）：脏标记 + 300 ms debounce + 原子写 + 存储分层。
 * 调度器本体在 settings-store.ts（可单测）；这里只提供当前内存引用与数据目录。
 */
let settingsPersistence: SettingsPersistence | undefined;
function persistSettings(): SettingsPersistence {
  settingsPersistence ??= createSettingsPersistence({ userDataDir: app.getPath("userData"), getSettings: () => settingsCache });
  return settingsPersistence;
}

function updateSettings(command: RuntimeCommand): void {
  const settings = loadSettings();
  // 脏标记口径：switch 之前的浅快照（顶层键引用级，零成本）；详见 settings-store.ts。
  const previous = { ...settings };
  switch (command.type) {
    // 工作区按助手记忆（agentWorkspaces 双写对称：main 持久化 + utility 内存镜像共用
    // 同一组纯函数）。settings.workspace 停写、保留为一次性迁移兜底（e42c139 回退教训）。
    case "workspace.open": settings.agentWorkspaces = recordAgentWorkspace(settings.agentWorkspaces, settings.currentAgentId, command.path); break;
    case "workspace.remove":
      settings.agentWorkspaces = forgetAgentWorkspace(settings.agentWorkspaces, settings.currentAgentId, command.workspace);
      // legacy 兜底与移除目标同路径时一并清除，否则重启 initialize 又把它拉起（回潮）。
      if (settings.workspace && resolve(settings.workspace).toLowerCase() === resolve(command.workspace).toLowerCase()) settings.workspace = undefined;
      break;
    // 置顶集合的重写走路径匹配键（分隔符/大小写归一）——见 session-scope 的
    // togglePinnedSessionPath：字面量比较会让「同一会话的两种写法」重复落盘。
    case "session.pin": settings.pinnedSessionPaths = togglePinnedSessionPath(settings.pinnedSessionPaths, command.path, command.pinned); break;
    case "session.new": if (command.workspace) settings.agentWorkspaces = recordAgentWorkspace(settings.agentWorkspaces, settings.currentAgentId, command.workspace); break;
    // 分屏后台格（activate:false）不激活、不改全局镜像——与 utility 端语义对称，不记。
    case "session.open": if (command.workspace && command.activate !== false) settings.agentWorkspaces = recordAgentWorkspace(settings.agentWorkspaces, settings.currentAgentId, command.workspace); break;
    case "agent.select": settings.currentAgentId = command.agentId; break;
    case "agent.save": settings.agents = settings.agents.some((item) => item.id === command.agent.id) ? settings.agents.map((item) => item.id === command.agent.id ? command.agent : item) : [...settings.agents, command.agent]; break;
    case "agent.archive":
      settings.agents = settings.agents.map((item) => item.id === command.agentId && item.id !== "default" ? { ...item, archived: command.archived } : item);
      if (settings.currentAgentId === command.agentId && command.archived) settings.currentAgentId = "default";
      break;
    // 镜像必须与 protocol 的 settings.save Pick 逐字段对齐：漏一个字段就是「保存后重启即丢」
    // （ssh 曾因这个 Pick 里有、这里没镜像而中招，2026-09）。jev 同时把用户填的密钥写进
    // credentials.json 的 safeStorage 通道（配置进 settings.json、密钥不进）。
    case "settings.save": settings.model = command.settings.model; settings.thinkingLevel = command.settings.thinkingLevel; settings.accessMode = command.settings.accessMode; settings.appearance = mergeSavedAppearance(command.settings.appearance, settings.appearance); settings.browser = mergeBrowserSettings(command.settings.browser, settings.browser); settings.jev = normalizeJev(command.settings.jev); settings.computer = command.settings.computer; settings.design = command.settings.design; settings.ssh = command.settings.ssh; settings.defaultWorkspace = command.settings.defaultWorkspace; break;
    // 渲染端手里的主题已没有 assets（见 appearance-assets.ts）：按 id 把主进程存的
    // 那份保留回来，只有携带了 assets 的那条（外观页保存主题）才覆盖。
    case "appearance.save": settings.appearance = mergeSavedAppearance(command.appearance, settings.appearance); break;
    case "provider.save": {
      settings.providers = settings.providers.some((item) => item.id === command.provider.id) ? settings.providers.map((item) => item.id === command.provider.id ? command.provider : item) : [...settings.providers, command.provider];
      // 自定义服务清空全部模型也是合法操作：持久化的默认/助手默认/视觉引用
      // 不能继续指向已移除的模型（与 provider.models.save 同款落位）。
      Object.assign(settings, pruneDisabledModelRefs(settings, command.provider.id, command.provider.models));
      if (command.apiKey?.trim() && !saveCredential(command.provider.id, command.apiKey.trim())) {
        mainWindow?.webContents.send("runtime:message", { type: "log", level: "warn", message: "系统加密存储不可用，API Key 未保存。" } satisfies RuntimeMessage);
      }
      break;
    }
    case "provider.models.save":
      settings.providers = settings.providers.some((item) => item.id === command.provider.id) ? settings.providers.map((item) => item.id === command.provider.id ? command.provider : item) : [...settings.providers, command.provider];
      // 与 provider.delete 同款落位：持久化的默认模型/助手默认/视觉模型不能
      // 指向已取消勾选的模型（否则重启后又拉起被移除的模型，与 utility 端现
      // 存副本行为不一致）。取消全部模型以清空某服务是合法操作（2026-09）。
      // Object.assign 保持 loadSettings 缓存对象身份，persistSettings 落盘的是同一引用。
      Object.assign(settings, pruneDisabledModelRefs(settings, command.provider.id, command.provider.models));
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
      // 视觉模型引用同一并失效（2026-09-02 审查：与模型清理同口径，否则视觉识别持续失败且无提示）。
      if (settings.vision?.provider === command.providerId) settings.vision = { ...settings.vision, enabled: false };
      deleteCredential(command.providerId);
      break;
    case "vision.save":
      settings.vision = normalizeVision(command.vision) ?? { enabled: false, provider: "", model: "" };
      break;
    // Jev 配置与密钥分开落位：配置进 settings.json（经 normalizeJev 归一，非法值回落
    // 默认而不是丢弃整条），密钥进 credentials.json（与 provider apiKey 同一 safeStorage
    // 通道；加密不可用时只发警告、不写明文）。配置里刻意不带密钥字段。
    case "jev.save": {
      settings.jev = normalizeJev(command.jev);
      if (command.apiKey?.trim() && !saveCredential(JEV_CREDENTIAL_ID, command.apiKey.trim())) {
        mainWindow?.webContents.send("runtime:message", { type: "log", level: "warn", message: "系统加密存储不可用，TypeSafe API Key 未保存。" } satisfies RuntimeMessage);
      }
      break;
    }
    case "jev.clearKey":
      deleteCredential(JEV_CREDENTIAL_ID);
      break;
    // 测试连接：**不落盘任何东西**——它只是一次读操作（发一次真请求看能不能通）。
    // 草稿密钥不写 credentials.json：用户可能只是试一下，尚未确定要保存。
    // 但主进程手里有**已保存**的密钥，utility 侧拿不到（它只在内存镜像里），
    // 所以这里要把保存值补进命令再下发（命令里带 key 时不覆盖）。
    case "jev.test":
      sendToRuntime({ ...command, ...(command.apiKey?.trim() ? {} : { apiKey: credentialsCache[JEV_CREDENTIAL_ID] }) });
      return;
    case "memory.save":
      settings.memory = command.memory;
      break;
    case "hooks.settings":
      settings.hooks = command.hooks;
      break;
  }
  persistSettings().schedule(diffSettings(previous, settings));
}

/**
 * 人工下载的生效配置：settings.browser 的两个字段 + 系统下载目录兜底。
 * 主进程是这两个字段的唯一写入方（浏览器面板 → `download-prefs-set`），因此
 * 设置页保存别的项不会抹掉它（`mergeBrowserSettings` 在两侧镜像都改用合并口径）。
 */
function browserDownloadPrefs(): BrowserDownloadPrefs {
  return manualDownloadPrefs(loadSettings().browser, app.getPath("downloads"));
}

function updateBrowserDownloadPrefs(patch: { dir?: string; ask?: boolean }): BrowserDownloadPrefs {
  const settings = loadSettings();
  const previous = { ...settings };
  settings.browser = withBrowserDownloadPrefs(settings.browser, patch);
  persistSettings().schedule(diffSettings(previous, settings));
  return manualDownloadPrefs(settings.browser, app.getPath("downloads"));
}

/** 系统「选择文件夹」：用户取消返回 undefined（调用方保持原值不变）。 */
async function chooseDownloadDirectory(owner: BrowserWindow): Promise<string | undefined> {
  const options: Electron.OpenDialogOptions = { title: "选择下载保存位置", defaultPath: browserDownloadPrefs().dir, properties: ["openDirectory", "createDirectory"] };
  const result = owner.isDestroyed() ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
  return result.canceled ? undefined : result.filePaths[0];
}

/** 系统「另存为」：可改目录与文件名；用户取消返回 undefined（卡片保持不变）。 */
async function chooseDownloadSavePath(owner: BrowserWindow, defaultPath: string): Promise<string | undefined> {
  const options: Electron.SaveDialogOptions = { title: "另存为", defaultPath };
  const result = owner.isDestroyed() ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(owner, options);
  return result.canceled || !result.filePath ? undefined : result.filePath;
}
function runtimeEntry(): string { return join(__dirname, "pi-runtime.js"); }
function sendToRuntime(command: RuntimeCommand): void { if (!runtimeProcess) throw new Error("Pi 运行时当前不可用"); runtimeProcess.postMessage(command); }

// 桌面通知是主进程专属能力（utility 进程没有 Electron API），钩子的 notify
// 动作经 hook-notify 推送到达这里；该消息不转发渲染器。聊天软件同款免打扰
// 语义：通知关于用户正在查看的会话（激活或分屏格子中可见，由 utility 端以
// visible 标记）、且窗口处于焦点且未最小化时不再打扰——回复就在眼前；后台
// 会话跑完、窗口失焦/最小化时照常提醒。visible 缺省时回退到激活会话比对。
function showHookNotification(title: string, body: string, sessionId?: string, visible?: boolean): void {
  const beingViewed = visible ?? (sessionId !== undefined && latestSnapshot?.sessionId === sessionId);
  if (
    beingViewed &&
    mainWindow && !mainWindow.isDestroyed() &&
    mainWindow.isFocused() && !mainWindow.isMinimized()
  ) {
    return;
  }
  if (!Notification.isSupported()) {
    console.warn(`钩子通知（系统不支持桌面通知）：${title} ${body}`);
    return;
  }
  const notification = new Notification({ title, body });
  notification.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notification.show();
}
function startRuntime(): void {
  runtimeProcess = utilityProcess.fork(runtimeEntry(), [], { serviceName: "Pi 运行时", stdio: "pipe" });
  runtimeProcess.on("message", (message: RuntimeMessage) => {
    if (message.type === "hook-notify") {
      showHookNotification(message.title, message.body, message.sessionId, message.visible);
      return;
    }
    if (message.type === "open-external") {
      // MCP OAuth 授权页：用系统默认浏览器打开（utility 进程无 Electron API）。
      void import("electron").then(({ shell }) => shell.openExternal(message.url)).catch((error) => {
        console.warn(`打开外部链接失败：${message.url} ${String(error)}`);
      });
      return;
    }
    if (message.type === "browser-automation.request") {
      // AI 浏览器操作：在 main 进程驱动可见预览标签页，完成后原路回传。
      if (browserAutomationController) {
        void browserAutomationController.handle(message.sessionKey, message.request).then((result) => {
          runtimeProcess?.postMessage({ type: "browser-automation.result", requestId: message.requestId, result });
        });
      } else {
        runtimeProcess?.postMessage({ type: "browser-automation.result", requestId: message.requestId, result: { ok: false, error: "浏览器自动化控制器当前不可用（窗口未创建）" } });
      }
      return;
    }
    if (message.type === "ssh-automation.request") {
      // AI SSH 操作（连接/执行/交互输入/读取）：连接归 tab 所有，会话销毁不释放。
      void ensureSshManager().handleAutomation(message.sessionKey, message.request).then((result) => {
        runtimeProcess?.postMessage({ type: "ssh-automation.result", requestId: message.requestId, result });
      });
      return;
    }
    if (message.type === "computer-overlay.request") {
      // 电脑控制操作提示条：在屏幕右下角显示「AI 正在操作 XX」（用户焦点在目标窗口，
      // 应用内 toast 看不到；悬浮条 click-through、自动淡出，纯提示不拦截输入）。
      if (message.kind === "hide") computerOverlayController?.hide();
      else computerOverlayController?.show(message.text ?? "");
      return;
    }
    if (message.type === "browser-automation.session-disposed") {
      // 会话销毁（驱逐/删除/移除工作区）：释放其绑定的自动化标签页，
      // 防止隐藏的 pi-browser-* 标签各自挂着一个渲染进程无限累积。
      browserAutomationController?.releaseSession(message.sessionKey);
      return;
    }
    if (message.type === "design-snapshot.request") {
      // 设计导出缩略图：离屏渲染 + 截图，handle 永不 reject（内部兜底 ok:false）。
      void designSnapshotController.handle(message.request).then((result) => {
        runtimeProcess?.postMessage({ type: "design-snapshot.result", requestId: message.requestId, result });
      });
      return;
    }
    if (message.type === "state") latestSnapshot = message.snapshot;
    if (message.type === "catalog") latestCatalog = message;
    if (message.type === "resources") latestResources = message.resources;
    if (message.type === "custom-models") {
      const source = loadSettings();
      const previous = { ...source };
      source.providers = source.providers.map((provider) => provider.id === message.providerId ? { ...provider, models: message.models } : provider);
      persistSettings().schedule(diffSettings(previous, source));
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
  // 内置 Skill 目录（安装目录 resources/skills，dev 下是仓库 resources/skills）
  // 由主进程解析后随 initialize 下发：utility 进程没有 Electron API。安装目录的
  // skill 目录就是「内置 skill 的目录」，运行时直接扫（不复制到用户目录）。
  const bundledSkillsDir = resolveBundledSkillsDir(app.getAppPath(), app.isPackaged);
  if (!bundledSkillsDir) console.warn("未找到内置 Skill 目录（resources/skills），本次不注入内置来源");
  // 内置子智能体目录（<安装目录>/subagents，dev 下是仓库 resources/subagents）：
  // 同 skills 口径，直接读取、不复制到用户目录；用户自建的同名定义会盖掉它。
  const bundledSubagentsDir = resolveBundledSubagentsDir(app.getAppPath(), app.isPackaged);
  if (!bundledSubagentsDir) console.warn("未找到内置子智能体目录（resources/subagents），本次不注入内置来源");
  // 主题重资产不过 IPC（2026-09-25）：主题 `.assets` 只有「当前生效」那一份渲染端会用，
  // 且已通过 customCssAssets 带到，utility 侧压根不读 appearance。实测主目录里 19.6MB
  // 的主题 base64 之前每次 bootstrap / 保存 / 初始化都搭车过一次进程边界。
  sendToRuntime({ type: "initialize", settings: settingsForRenderer(settings), apiKeys: credentialsCache, bundledSkillsDir, bundledSubagentsDir });
}
function createWindow(): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const nextWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 1040, minHeight: 680, backgroundColor: "#f5f5f2", titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default", icon: process.platform === "win32" || process.platform === "linux" ? appIconPath : undefined, webPreferences: { preload: join(__dirname, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: !rendererUrl } });
  const previewController = new BrowserPreviewController(nextWindow, (state, tabId) => {
    if (!nextWindow.isDestroyed()) nextWindow.webContents.send(`browser-preview:state:${tabId}`, state);
  }, (event) => {
    // AI（或用户）创建/关闭标签页时同步预览面板的标签列表。
    if (!nextWindow.isDestroyed()) nextWindow.webContents.send("browser-preview:tabs", event);
  }, (pick) => {
    // 用户手动点选的页面元素（发送到聊天框流程）。
    if (!nextWindow.isDestroyed()) nextWindow.webContents.send("browser-preview:pick", pick);
  }, (tabId) => {
    // 下载策略：AI 自动化绑定且 navigate 过工作区的标签页静默落盘到工作区；其余
    // （用户自己在预览面板里浏览的标签）走人工策略——按设置直接存默认目录，或
    // 先落盘再弹「保存 / 另存为 / 取消」卡片。
    const automation = browserAutomationController?.downloadPolicy(tabId);
    if (automation && automation !== "cancel") return automation;
    const prefs = browserDownloadPrefs();
    return prefs.ask ? { dir: prefs.dir, ask: true } : { dir: prefs.dir };
  }, (info) => {
    // 下载结果（已保存/已取消）由自动化控制器汇总进下一次操作回执。
    browserAutomationController?.handleDownload(info);
  }, {
    // 人工下载的配置与两个系统对话框（设置写入由主进程单点落盘，不经渲染端 settings）。
    prefs: () => browserDownloadPrefs(),
    setPrefs: (patch) => updateBrowserDownloadPrefs(patch),
    chooseDirectory: () => chooseDownloadDirectory(nextWindow),
    chooseSavePath: (defaultPath) => chooseDownloadSavePath(nextWindow, defaultPath)
  });
  mainWindow = nextWindow;
  browserPreviewController = previewController;
  browserAutomationController = new BrowserAutomationController(previewController, (tabId) => {
    // AI 开始操作某个标签页：让预览面板自动展开并激活它（用户可见）。
    if (!nextWindow.isDestroyed()) nextWindow.webContents.send("browser-preview:tabs", { action: "automation-started", tabId });
  });
  computerOverlayController ??= new ComputerOverlayController();
  nextWindow.on("closed", () => {
    previewController.dispose();
    browserAutomationController?.dispose();
    if (browserPreviewController === previewController) browserPreviewController = undefined;
    if (browserAutomationController) browserAutomationController = undefined;
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
      return typeof command.cols === "number" && typeof command.rows === "number" && (command.cwd === undefined || typeof command.cwd === "string") && (command.shell === undefined || typeof command.shell === "string") && (command.initialCommand === undefined || typeof command.initialCommand === "string");
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

function isSshCommand(value: unknown): value is SshCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  switch (command.type) {
    case "connect":
      return typeof command.terminalId === "string" && command.terminalId.trim() !== "" && typeof command.hostId === "string" && command.hostId.trim() !== "" && typeof command.cols === "number" && typeof command.rows === "number" && (command.trustFingerprint === undefined || typeof command.trustFingerprint === "boolean");
    case "input":
      return typeof command.terminalId === "string" && command.terminalId.trim() !== "" && typeof command.data === "string";
    case "resize":
      return typeof command.terminalId === "string" && command.terminalId.trim() !== "" && typeof command.cols === "number" && typeof command.rows === "number";
    case "kill":
      return typeof command.terminalId === "string" && command.terminalId.trim() !== "";
    case "host.save": {
      const host = command.host;
      if (!host || typeof host !== "object") return false;
      const draft = host as Record<string, unknown>;
      return typeof draft.name === "string" && typeof draft.host === "string" && typeof draft.username === "string" && (draft.port === undefined || typeof draft.port === "number") && (draft.groupId === undefined || typeof draft.groupId === "string") && (command.password === undefined || typeof command.password === "string");
    }
    case "host.delete":
      return typeof command.hostId === "string" && command.hostId.trim() !== "";
    case "group.save": {
      const group = command.group;
      return Boolean(group) && typeof group === "object" && typeof (group as Record<string, unknown>).name === "string" && ((group as Record<string, unknown>).id === undefined || typeof (group as Record<string, unknown>).id === "string");
    }
    case "group.delete":
      return typeof command.groupId === "string" && command.groupId.trim() !== "";
    case "sftp.list":
      return typeof command.terminalId === "string" && command.terminalId.trim() !== "" && (command.path === undefined || typeof command.path === "string");
    case "sftp.upload":
      return typeof command.terminalId === "string" && command.terminalId.trim() !== "" && typeof command.transferId === "string" && command.transferId.trim() !== "" && typeof command.remoteDir === "string" && Array.isArray(command.localPaths) && command.localPaths.length > 0 && command.localPaths.every((item) => typeof item === "string" && item.trim() !== "");
    case "sftp.download":
      return typeof command.terminalId === "string" && command.terminalId.trim() !== "" && typeof command.transferId === "string" && command.transferId.trim() !== "" && Array.isArray(command.remotePaths) && command.remotePaths.length > 0 && command.remotePaths.every((item) => typeof item === "string" && item.trim() !== "") && typeof command.workspace === "string" && command.workspace.trim() !== "";
    case "sftp.cancel":
      return typeof command.terminalId === "string" && command.terminalId.trim() !== "" && typeof command.transferId === "string" && command.transferId.trim() !== "";
    case "hosts":
      return true;
    default:
      return false;
  }
}

function registerIpc(): void {
  ipcMain.handle("desktop:bootstrap", (): DesktopBootstrap => {
    const source = loadSettings();
    const settings: DesktopSettings = settingsForRenderer({ ...source, providers: source.providers.map((provider) => ({ ...provider, keyConfigured: Boolean(credentialsCache[provider.id]) })), jevKeyConfigured: Boolean(credentialsCache[JEV_CREDENTIAL_ID]) });
    return { platform: process.platform, version: app.getVersion(), securityWarning, settings, runtime: latestSnapshot, catalog: latestCatalog ? { models: latestCatalog.models, providers: latestCatalog.providers } : undefined, resources: latestResources };
  });
  // 渲染端按需取某条自定义主题的资产（外观页「应用/编辑该主题」时）。单条按需拉取
  // 代替全量搭车：自定义主题目前由用户手动导入，体量一两条的量级。
  ipcMain.handle("appearance:theme-assets", (_event, themeId: string): ThemeAssetMap | undefined => {
    return loadSettings().appearance.customThemes.find((theme) => theme.id === themeId)?.assets;
  });
  ipcMain.handle("desktop:choose-workspace", async (): Promise<string | undefined> => { const result = mainWindow ? await dialog.showOpenDialog(mainWindow, { title: "选择项目工作区", properties: ["openDirectory", "createDirectory"] }) : await dialog.showOpenDialog({ title: "选择项目工作区", properties: ["openDirectory", "createDirectory"] }); return result.canceled ? undefined : result.filePaths[0]; });
  ipcMain.handle("desktop:choose-preview-file", async (): Promise<WorkspaceFilePreview | undefined> => {
    const workspace = loadSettings().workspace;
    if (!workspace) throw new Error("请先打开工作区，再选择预览文件");
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, { title: "选择预览文件", defaultPath: workspace, properties: ["openFile"], filters: [{ name: "常见代码、Markdown 和资源", extensions: ["md", "markdown", "mdx", "js", "ts", "tsx", "jsx", "json", "css", "html", "htm", "svg", "pdf", "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "*" ] }] })
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
  // 人工 SFTP 上传：**不限制在工作区内**——用户上传的文件通常来自桌面/下载目录，
  // 卡在工作区里没法用（与 AI 侧必须锁工作区的不对称是有意的：AI 是不可信调用方）。
  // 只回路径不读内容，读取交给主进程的传输服务流式处理。
  ipcMain.handle("desktop:choose-ssh-upload-files", async (_event, workspace?: string): Promise<string[]> => {
    const defaultPath = typeof workspace === "string" && workspace.trim() ? workspace : undefined;
    const options: Electron.OpenDialogOptions = { title: "选择要上传到远程主机的文件", properties: ["openFile", "multiSelections"], ...(defaultPath ? { defaultPath } : {}) };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });
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
  ipcMain.handle("desktop:reveal-in-explorer", async (_event, workspace: string, relativePath?: string): Promise<void> => {
    // 文件选中（showItemInFolder）、目录进入（openPath）——与资源管理器「打开」语义一致。
    const location = await resolveWorkspaceEntry(workspace, relativePath);
    if (location.kind === "file") shell.showItemInFolder(location.absolutePath);
    else await shell.openPath(location.absolutePath);
  });
  ipcMain.handle("desktop:stat-workspace-file", async (_event, workspace: string, relativePath: string): Promise<WorkspaceFileStat> => {
    if (typeof workspace !== "string" || !workspace.trim()) throw new Error("请指定要操作的工作区");
    if (typeof relativePath !== "string" || !relativePath.trim()) throw new Error("文件路径无效");
    return statWorkspaceFile(workspace, relativePath);
  });
  ipcMain.handle("browser-preview:command", async (_event, command: BrowserPreviewCommand): Promise<BrowserPreviewState> => {
    if (!browserPreviewController) throw new Error("浏览器预览当前不可用");
    return browserPreviewController.handle(command);
  });
  ipcMain.handle("browser-automation:cancel", (_event, tabId: string): void => {
    if (!browserAutomationController) throw new Error("浏览器自动化当前不可用");
    if (typeof tabId !== "string" || !tabId.trim()) throw new Error("标签页 id 无效");
    browserAutomationController.cancelTab(tabId);
  });
  // —— 作品（Gallery）：主进程侧的两个能力 ——
  // ① 运行：把作品入口（本地文件/目录首页）映射成 loopback 静态服务的 http 地址。
  //    为什么绕主进程：BrowserStaticServer 的实例归 BrowserAutomationController，
  //    只有主进程持有它（页面因此拿到真实 http origin，而非 file://）。
  ipcMain.handle("gallery:file-url", async (_event, filePath: string, workspace?: string): Promise<string> => {
    if (!browserAutomationController) throw new Error("本地预览服务当前不可用");
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("作品入口路径无效");
    return browserAutomationController.fileUrl(filePath, workspace);
  });
  // ② 缩略图：作品清单全局跨工作区，缩略图存全局 agentDir（在工作区外），
  //    而 pidesktop-file:// 只服务工作区内文件，所以走这条专用只读通道。
  //    直接回 data URL（已缩到 1024 宽，单张 100–300 KB）。
  ipcMain.handle("gallery:thumb", async (_event, fileName: string): Promise<string | undefined> => {
    if (typeof fileName !== "string" || !fileName.trim()) return undefined;
    const data = readGalleryThumb(galleryThumbsDirFor(resolveGalleryAgentDir()), fileName);
    return data ? `data:image/png;base64,${data.toString("base64")}` : undefined;
  });
  ipcMain.handle("terminal:command", (_event, command: TerminalCommand): void => {
    if (!isTerminalCommand(command)) throw new Error("终端命令无效");
    terminalManager.handle(command);
  });
  // 服务型作品「运行」：先探测地址，连不上就等启动命令把服务跑起来。
  // 带 terminalId 时同时盯进程状态：命令立刻报错退出就立即回报（附退出码与输出
  // 尾部），不让用户干等满超时——「命令写错了」与「服务还在启动」必须分得开。
  ipcMain.handle("gallery:await-service", async (_event, input: { url?: unknown; terminalId?: unknown; timeoutMs?: unknown } | undefined): Promise<GalleryServiceProbe> => {
    const url = typeof input?.url === "string" ? input.url : "";
    if (!url.trim()) return { ok: false, reason: "invalid-url" };
    const terminalId = typeof input?.terminalId === "string" && input.terminalId.trim() ? input.terminalId : undefined;
    return waitForService({
      url,
      timeoutMs: clampServiceWait(input?.timeoutMs),
      watch: terminalId ? () => {
        const status = terminalManager.status(terminalId);
        // exitCode 有值才算「本次的启动命令已经退出」；未创建与还活着都返回 undefined
        //（开标签与等待是两个 IPC，后者先到是常态——绝不能把「还没创建」当失败）。
        // 每次「运行」都用新的终端 id，所以这里不会读到上一次尝试的残留记录。
        return status.exitCode === undefined ? undefined : { exited: true, exitCode: status.exitCode, tail: status.tail };
      } : undefined
    });
  });
  ipcMain.handle("ssh:command", (_event, command: SshCommand): SshCommandResult | Promise<SshCommandResult> => {
    if (!isSshCommand(command)) throw new Error("SSH 命令无效");
    // SFTP 是流式异步操作（上传/下载要跨秒到分钟），走独立异步入口；
    // 其余命令保持原有的同步语义（终端输入/连接等必须即时返回）。
    const manager = ensureSshManager();
    return manager.handleAsync(command) ?? manager.handle(command);
  });
  ipcMain.handle("runtime:send", (_event, command: RuntimeCommand): void => { updateSettings(command); sendToRuntime(command); });
}
app.whenReady().then(() => { Menu.setApplicationMenu(null); registerPreviewFileProtocol(); registerIpc(); startRuntime(); createWindow(); app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { settingsPersistence?.flush(); browserAutomationController?.dispose(); computerOverlayController?.dispose(); browserPreviewController?.dispose(); terminalManager.disposeAll(); sshConnectionManager?.disposeAll(); runtimeProcess?.kill(); });
