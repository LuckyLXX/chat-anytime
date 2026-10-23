import { KeyRound, Pencil, Plus, Puzzle, RefreshCw, Server, Trash2, X, Zap } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { resourceScopeLabels } from "../../shared/locale";
import type { CommandDraft, CommandSummary, McpServerConfigDraft, McpServerStatus, McpServerSummary, ResourceCatalog, RuntimeCommand } from "../../shared/protocol";
import { useDesktopStore } from "./store";

/**
 * 技能与工具页（设置页「技能与工具」tab，2026-09-23 从 App.tsx 抽出并重排）。
 *
 * 原实现是 App.tsx 里的 `ResourceSettings`（约 190 行），结构上已是组件，但视觉
 * 停在旧语言：根容器 `.resource-settings` 自带 `padding + overflow-y:auto`，三个
 * 分区（MCP Server / Skill / 自定义命令）只有一条 `.resource-section-heading` 灰字
 * 标题，与分区卡片体系（角色页/通用页/模型服务页）不一致；「重载资源」按钮虽在
 * 顶部，但页面标题条与分区同权重。
 *
 * 本轮重排：① 顶部固定条（标题 + 一句话说明 + 重载资源）；② 正文可滚动，三个分区
 * 各是一张 `.resource-card`（标题 + 计数 + 动作 + 正文），与其它设置页的分区卡片
 * 同构；③ 新增主题钩子 `data-pane="resource-settings"` 与 `data-control="resource-reload"`
 * / `"mcp-add"` / `"mcp-save"` / `"command-add"` / `"command-save"`；④ 行内列表沿用
 * 既有的 `.resource-item` / `.resource-toggle` 等类名（子智能体、钩子两页共用，
 * 本轮一并收口）。
 *
 * 本页是「即改即发」页（没有整页保存语义），因此**不加固定操作条**——每个开关、
 * 每条删除都是即时命令，这与用户对本轮的对齐口径一致（只读/即改即发页不加底栏）。
 * 数据流与旧实现逐字节一致：resources.reload / mcp.server.* / skill.toggle /
 * command.* 的命令名与载荷不变。
 */

interface ResourceSettingsProps {
  resources: ResourceCatalog;
}

/** MCP Server 状态徽标文案（原在 App.tsx，2026-09-23 随本页组件迁入）。 */
const mcpStatusLabels: Record<McpServerStatus, string> = {
  connected: "已连接",
  cached: "有缓存",
  failed: "连接失败",
  "needs-auth": "需要认证",
  "not-connected": "未连接",
  disabled: "已停用"
};

/**
 * OAuth 高级选项的表单态（全字符串：输入框友好；提交时转成 McpOAuthAdvanced，
 * 空字段丢弃、callbackPort 转数字，校验口径以主进程的 normalizeMcpOAuth 为准）。
 */
interface McpOauthFormState {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  callbackPort: string;
  scope: string;
  clientName: string;
  clientRegistration: "" | "dcr" | "cimd";
  authServerMetadataUrl: string;
}

const EMPTY_MCP_OAUTH: McpOauthFormState = {
  clientId: "",
  clientSecret: "",
  callbackUrl: "",
  callbackPort: "",
  scope: "",
  clientName: "",
  clientRegistration: "",
  authServerMetadataUrl: ""
};

export function ResourceSettings({ resources }: ResourceSettingsProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [editingMcp, setEditingMcp] = useState<{ name: string; scope: McpServerConfigDraft["scope"] }>();
  const [mcpName, setMcpName] = useState("");
  const [mcpScope, setMcpScope] = useState<McpServerConfigDraft["scope"]>("project");
  const [mcpTransport, setMcpTransport] = useState<McpServerConfigDraft["transport"]>("stdio");
  const [mcpCommand, setMcpCommand] = useState("npx");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpAuth, setMcpAuth] = useState<NonNullable<McpServerConfigDraft["auth"]>>("none");
  const [mcpBearerTokenEnv, setMcpBearerTokenEnv] = useState("");
  const [mcpHeaders, setMcpHeaders] = useState("");
  const [mcpEnv, setMcpEnv] = useState("");
  const [mcpTimeout, setMcpTimeout] = useState("");
  const [mcpExposure, setMcpExposure] = useState<NonNullable<McpServerConfigDraft["exposure"]>>("direct");
  const [mcpOauthOpen, setMcpOauthOpen] = useState(false);
  const [mcpOauth, setMcpOauth] = useState<McpOauthFormState>(EMPTY_MCP_OAUTH);
  const [commandFormOpen, setCommandFormOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<string>();
  const [commandName, setCommandName] = useState("");
  const [commandDescription, setCommandDescription] = useState("");
  const [commandTemplate, setCommandTemplate] = useState("");
  const [commandScope, setCommandScope] = useState<CommandDraft["scope"]>("project");
  const workspaceOpen = useDesktopStore((state) => Boolean(state.snapshot.workspace));
  const runtimeBusy = useDesktopStore((state) => state.snapshot.busy);
  const controlsBusy = busy || runtimeBusy;

  async function run(command: RuntimeCommand): Promise<boolean> {
    setBusy(true);
    setLocalError(undefined);
    try {
      await window.piDesktop.send(command);
      return true;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "资源操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 编辑已有命令：回填表单并展开（名字锁定，改名=删旧建新）。 */
  function editCommand(entry: CommandSummary): void {
    setEditingCommand(entry.name);
    setCommandName(entry.name);
    setCommandDescription(entry.description);
    setCommandTemplate(entry.template ?? "");
    setCommandScope(entry.scope === "project" ? "project" : "global");
    setCommandFormOpen(true);
  }

  async function saveCommand(event: FormEvent): Promise<void> {
    event.preventDefault();
    const success = await run({ type: "command.save", command: { name: commandName.trim(), description: commandDescription.trim() || undefined, template: commandTemplate, scope: commandScope } });
    if (!success) return;
    setCommandFormOpen(false);
    setEditingCommand(undefined);
    setCommandName("");
    setCommandDescription("");
    setCommandTemplate("");
  }

  /** OAuth 高级选项的字段更新助手（一个对象态，避免再开 8 个 useState）。 */
  function setOauthField<K extends keyof McpOauthFormState>(key: K, value: McpOauthFormState[K]): void {
    setMcpOauth((current) => ({ ...current, [key]: value }));
  }

  /** 新增/编辑共用表单：编辑时记下原位置（名称锁定，写入范围可改＝迁移）。 */
  function resetMcpForm(): void {
    setEditingMcp(undefined);
    setMcpName("");
    setMcpScope("project");
    setMcpTransport("stdio");
    setMcpCommand("npx");
    setMcpArgs("");
    setMcpUrl("");
    setMcpAuth("none");
    setMcpBearerTokenEnv("");
    setMcpHeaders("");
    setMcpEnv("");
    setMcpTimeout("");
    setMcpExposure("direct");
    setMcpOauth(EMPTY_MCP_OAUTH);
    setMcpOauthOpen(false);
  }

  function editMcpServer(server: McpServerSummary): void {
    setEditingMcp({ name: server.name, scope: server.scope });
    setMcpName(server.name);
    setMcpScope(server.scope);
    setMcpTransport(server.transport);
    setMcpCommand(server.command ?? "npx");
    setMcpArgs((server.args ?? []).join("\n"));
    setMcpEnv(formatKeyValueLines(server.env));
    setMcpUrl(server.url ?? "");
    setMcpAuth(server.auth ?? "none");
    setMcpBearerTokenEnv(server.bearerTokenEnv ?? "");
    setMcpHeaders(formatKeyValueLines(server.headers));
    setMcpTimeout(server.timeout === undefined ? "" : String(server.timeout));
    setMcpExposure(server.exposure ?? "direct");
    setMcpOauth({
      clientId: server.oauth?.clientId ?? "",
      clientSecret: server.oauth?.clientSecret ?? "",
      callbackUrl: server.oauth?.callbackUrl ?? "",
      callbackPort: server.oauth?.callbackPort === undefined ? "" : String(server.oauth.callbackPort),
      scope: server.oauth?.scope ?? "",
      clientName: server.oauth?.clientName ?? "",
      clientRegistration: server.oauth?.clientRegistration ?? "",
      authServerMetadataUrl: server.oauth?.authServerMetadataUrl ?? ""
    });
    setMcpOauthOpen(Boolean(server.oauth));
    setMcpFormOpen(true);
  }

  async function addMcpServer(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      // HTTP 请求头在草稿阶段就解析（非法行要在这里报出来，而不是默默丢掉）。
      const httpHeaders = mcpTransport === "http" ? parseKeyValueLines(mcpHeaders, HEADER_LINES) : undefined;
      const rawTimeout = mcpTimeout.trim();
      const timeout = rawTimeout === "" ? undefined : Number(rawTimeout);
      // OAuth 高级选项：空字段丢弃；callbackPort 只在填写时转数字（校验在主进程口径）。
      const oauth: McpServerConfigDraft["oauth"] = mcpTransport === "http" && mcpAuth !== "bearer-env"
        ? (() => {
            const port = mcpOauth.callbackPort.trim();
            const draft = {
              ...(mcpOauth.clientId.trim() ? { clientId: mcpOauth.clientId.trim() } : {}),
              ...(mcpOauth.clientSecret.trim() ? { clientSecret: mcpOauth.clientSecret.trim() } : {}),
              ...(mcpOauth.callbackUrl.trim() ? { callbackUrl: mcpOauth.callbackUrl.trim() } : {}),
              ...(port ? { callbackPort: Number(port) } : {}),
              ...(mcpOauth.scope.trim() ? { scope: mcpOauth.scope.trim() } : {}),
              ...(mcpOauth.clientName.trim() ? { clientName: mcpOauth.clientName.trim() } : {}),
              ...(mcpOauth.clientRegistration ? { clientRegistration: mcpOauth.clientRegistration } : {}),
              ...(mcpOauth.authServerMetadataUrl.trim() ? { authServerMetadataUrl: mcpOauth.authServerMetadataUrl.trim() } : {})
            };
            return Object.keys(draft).length > 0 ? draft : undefined;
          })()
        : undefined;
      const server: McpServerConfigDraft = {
        name: mcpName.trim(),
        scope: mcpScope,
        transport: mcpTransport,
        exposure: mcpExposure,
        ...(timeout !== undefined ? { timeout } : {}),
        ...(mcpTransport === "stdio"
          ? {
              command: mcpCommand.trim(),
              args: mcpArgs.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
              env: parseKeyValueLines(mcpEnv, ENV_VAR_LINES)
            }
          : {
              url: mcpUrl.trim(),
              auth: mcpAuth,
              ...(mcpAuth === "bearer-env" ? { bearerTokenEnv: mcpBearerTokenEnv.trim() } : {}),
              ...(httpHeaders ? { headers: httpHeaders } : {}),
              ...(oauth ? { oauth } : {})
            })
      };
      const success = await run({ type: "mcp.server.save", server, ...(editingMcp ? { original: editingMcp } : {}) });
      if (!success) return;
      resetMcpForm();
      setMcpFormOpen(false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "MCP Server 配置无效");
    }
  }

  /**
   * 列表内直接切换工具暴露（不用打开编辑表单）：把摘要投影还原成完整草稿再保存。
   * 表单路径要求用户记得点「保存修改」，这里改完即存——避免「改了没生效」的错觉。
   */
  async function saveMcpExposure(server: McpServerSummary, exposure: "direct" | "codemode"): Promise<void> {
    const draft: McpServerConfigDraft = {
      name: server.name,
      scope: server.scope,
      transport: server.transport,
      ...(server.command ? { command: server.command } : {}),
      ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(server.auth ? { auth: server.auth } : {}),
      ...(server.bearerTokenEnv ? { bearerTokenEnv: server.bearerTokenEnv } : {}),
      ...(server.env ? { env: server.env } : {}),
      ...(server.headers ? { headers: server.headers } : {}),
      ...(server.oauth ? { oauth: server.oauth } : {}),
      ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
      exposure
    };
    await run({ type: "mcp.server.save", server: draft, original: { name: server.name, scope: server.scope } });
  }

  return (
    <div className="resource-page" data-pane="resource-settings">
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>技能与工具</strong>
          <small>自研 Skill / Todo / 子代理能力；MCP 由 Pi 的内置扩展负责连接与授权</small>
        </span>
        <span className="resource-page-actions">
          <button className="secondary-button compact-button" type="button" data-control="resource-reload" disabled={controlsBusy} onClick={() => void run({ type: "resources.reload" })}><RefreshCw size={13} className={controlsBusy ? "spinning" : undefined} />重载资源</button>
        </span>
      </header>
      <div className="resource-page-body">
        {localError && <p className="form-error resource-error">{localError}</p>}

        <section className="resource-card" aria-label="MCP Server">
          <div className="resource-card-head">
            <span className="resource-card-title"><Server size={14} /><strong>MCP Server</strong></span>
            <small>写入 .mcp.json 或用户全局配置；保存后立即生效（增减服务器无需重建会话）</small>
            <span className="resource-card-actions">
              <small className="resource-card-count">{resources.mcpServers.length} 个</small>
              <button className="secondary-button compact-button" type="button" data-control="mcp-add" disabled={controlsBusy} onClick={() => { if (!mcpFormOpen) resetMcpForm(); setMcpFormOpen((open) => !open); }}><Plus size={13} />{mcpFormOpen ? "收起" : "添加"}</button>
            </span>
          </div>
          <div className="resource-card-body">
            {mcpFormOpen && <form className="mcp-config-form" onSubmit={(event) => void addMcpServer(event)}>
              <div className="mcp-form-grid">
                <label>名称{editingMcp ? <input value={mcpName} disabled title="名称即配置键，不支持改名；需要改名请删除后新建" /> : <input value={mcpName} placeholder="例如 context7" onChange={(event) => setMcpName(event.target.value)} />}</label>
                <label>写入范围<select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpServerConfigDraft["scope"])}><option value="project">当前项目 .mcp.json</option><option value="global">用户全局配置</option></select></label>
                <label>连接方式<select value={mcpTransport} onChange={(event) => setMcpTransport(event.target.value as McpServerConfigDraft["transport"])}><option value="stdio">本地命令（stdio）</option><option value="http">远程地址（HTTP）</option></select></label>
                <label>工具暴露<select value={mcpExposure} onChange={(event) => setMcpExposure(event.target.value as NonNullable<McpServerConfigDraft["exposure"]>)}><option value="direct">直连（工具声明给模型）</option><option value="codemode">脚本（codemode，不占前缀）</option></select></label>
                {mcpTransport === "stdio" ? <>
                  <label>启动命令<input value={mcpCommand} placeholder="npx" onChange={(event) => setMcpCommand(event.target.value)} /></label>
                  <label className="mcp-form-wide">参数（每行一个）<textarea value={mcpArgs} rows={3} placeholder={"-y\ncontext7-mcp"} onChange={(event) => setMcpArgs(event.target.value)} /></label>
                  <label className="mcp-form-wide">环境变量（可选，每行 KEY=VALUE）<textarea value={mcpEnv} rows={2} placeholder="API_KEY=xxx" onChange={(event) => setMcpEnv(event.target.value)} /></label>
                  <label>超时（秒，可选）<input value={mcpTimeout} inputMode="numeric" placeholder="120" onChange={(event) => setMcpTimeout(event.target.value)} /></label>
                </> : <>
                  <label className="mcp-form-wide">服务器地址<input value={mcpUrl} placeholder="https://mcp.example.com/mcp" onChange={(event) => setMcpUrl(event.target.value)} /></label>
                  <label>认证<select value={mcpAuth} onChange={(event) => setMcpAuth(event.target.value as NonNullable<McpServerConfigDraft["auth"]>)}><option value="none">无</option><option value="oauth">OAuth</option><option value="bearer-env">Bearer 环境变量</option></select></label>
                  {mcpAuth === "bearer-env" && <label>Token 环境变量<input value={mcpBearerTokenEnv} placeholder="MCP_TOKEN" onChange={(event) => setMcpBearerTokenEnv(event.target.value)} /></label>}
                  <label className="mcp-form-wide">请求头（可选，每行 名称=值）<textarea value={mcpHeaders} rows={2} placeholder={"X-API-Key=your-key"} onChange={(event) => setMcpHeaders(event.target.value)} /></label>
                  <label>超时（秒，可选）<input value={mcpTimeout} inputMode="numeric" placeholder="120" onChange={(event) => setMcpTimeout(event.target.value)} /></label>
                  {mcpAuth !== "bearer-env" && <div className="mcp-form-wide mcp-oauth-advanced">
                    <button type="button" className="secondary-button compact-button" onClick={() => setMcpOauthOpen((open) => !open)}>{mcpOauthOpen ? "收起 OAuth 高级选项" : "OAuth 高级选项（预注册客户端等，可选）"}</button>
                    {mcpOauthOpen && <div className="mcp-oauth-grid">
                      <label>客户端 ID<input value={mcpOauth.clientId} placeholder="不填则动态注册" onChange={(event) => setOauthField("clientId", event.target.value)} /></label>
                      <label>客户端密钥<input value={mcpOauth.clientSecret} placeholder="可用 ${ENV} 引用环境变量" onChange={(event) => setOauthField("clientSecret", event.target.value)} /></label>
                      <label>回调地址<input value={mcpOauth.callbackUrl} placeholder="http://127.0.0.1:1456/callback" onChange={(event) => setOauthField("callbackUrl", event.target.value)} /></label>
                      <label>回调端口<input value={mcpOauth.callbackPort} inputMode="numeric" placeholder="不填则随机" onChange={(event) => setOauthField("callbackPort", event.target.value)} /></label>
                      <label>授权范围<input value={mcpOauth.scope} placeholder="空格分隔；缺省用服务端声明的范围" onChange={(event) => setOauthField("scope", event.target.value)} /></label>
                      <label>客户端注册<select value={mcpOauth.clientRegistration} onChange={(event) => setOauthField("clientRegistration", event.target.value as McpOauthFormState["clientRegistration"])}><option value="">默认（dcr 动态注册）</option><option value="dcr">dcr（动态注册）</option><option value="cimd">cimd（Client ID 文档）</option></select></label>
                      <label>客户端名<input value={mcpOauth.clientName} placeholder="pi" onChange={(event) => setOauthField("clientName", event.target.value)} /></label>
                      <label>授权服务器元数据<input value={mcpOauth.authServerMetadataUrl} placeholder="https://…（服务端指向错时用）" onChange={(event) => setOauthField("authServerMetadataUrl", event.target.value)} /></label>
                    </div>}
                  </div>}
                </>}
              </div>
              <p className="resource-form-help">{editingMcp ? `正在编辑 ${editingMcp.name}：名称即配置键不可改；切换「写入范围」会把该条目迁移到另一个配置文件，停用状态保留。保存后立即生效（增减服务器无需重建会话）。` : "添加后会写入 MCP 配置并立即加载。stdio 服务通常由 npx 首次启动；敏感值建议用环境变量名或 ${名称} 引用，不要直接写入配置。"}</p>
              {mcpExposure === "codemode" && <p className="resource-form-help">脚本模式：该服务器的工具不再声明给模型，改为在 codemode 脚本里用 searchTools() / ALL_TOOLS 发现并调用，工具定义不进每次请求的前缀（省 token）。代价是模型必须先写脚本、调用会合并进同一张脚本卡片；适合低频服务器，搜索类这类每轮都要用的建议保持直连。保存后会在后台重新连接并更新工具：工具变化完成即生效，无需发送消息或新建话题。</p>}
              {mcpTransport === "http" && <p className="resource-form-help">认证选 OAuth：保存后回到列表点「认证」，会自动打开系统浏览器完成授权，回调后自动重连；凭据保存在本地（刷新令牌长期有效），只有被授权服务器判定失效时才会提示「重新授权」——那时已保存的凭据仍会保留并优先重试。Bearer 环境变量优先于 OAuth（它的令牌会覆盖请求头里的 Authorization，其余头保留）；该字段填的是**环境变量名**（如 EXA_TOKEN，不是令牌本身），值在系统环境变量里设置，改完需重启应用生效。请求头按字面带上；写了 Authorization 就不再自动走 OAuth；只写 X-API-Key 这类网关头不影响该判定（服务端若答 401 仍会进入「需要认证」并提示走 OAuth，需要彻底避开可用 Bearer 环境变量）。不支持动态客户端注册的服务器用「OAuth 高级选项」填预注册的客户端 ID/密钥与回调地址。注意：环境变量值、请求头值与客户端密钥里的 {"${名称}"} 会被替换成该环境变量的值、「!命令」会执行命令并把输出代入（Pi 展开规则）；敏感值建议用 {"${环境变量}"} 或 Bearer 环境变量而不是明文。</p>}
              <footer className="mcp-form-actions"><button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={() => { resetMcpForm(); setMcpFormOpen(false); }}><X size={13} />取消</button><button className="primary-button compact-button" type="submit" data-control="mcp-save" disabled={controlsBusy}>{editingMcp ? <Pencil size={13} /> : <Plus size={13} />}{editingMcp ? "保存修改" : "添加 MCP"}</button></footer>
            </form>}
            {resources.mcpServers.length === 0
              ? <p className="resource-empty">未发现 MCP Server。点击「添加」，或将已有配置放入 `.mcp.json`。</p>
              : (
                <div className="resource-list">
                  {resources.mcpServers.map((server) => {
                    const authorized = server.authState === "authorized";
                    // 授权失败但凭据仍保留（可重试）的 server：文案要说清楚「已保留凭据」，
                    // 否则用户会以为凭据丢了、只能从头授权。
                    const retryable = server.authState === "failed";
                    // 需要认证（401 / 授权中 / 上次失败）或显式选了 OAuth 才给入口；已授权则给「清除凭据」。
                    const showAuth = !authorized && (server.status === "needs-auth" || server.authState === "pending" || server.authState === "failed" || server.auth === "oauth");
                    return (
                      <div className="resource-item mcp-resource-item" key={server.name} data-mcp-server={server.name}>
                        <div className={`resource-item-icon mcp-status-icon ${server.status}`}><Server size={14} /></div>
                        <div className="resource-item-copy">
                          <strong>{server.name}</strong>
                          <small>{resourceScopeLabels[server.scope]} · {server.authState === "pending" ? "等待浏览器授权…" : retryable ? "凭据已保留，待重新授权" : mcpStatusLabels[server.status]} · {server.toolCount} 个工具{server.resourceCount === undefined ? "" : ` · ${server.resourceCount} 个资源`}{server.failedAgoSeconds !== undefined ? ` · ${server.failedAgoSeconds} 秒前失败` : ""}</small>
                          {server.error && <em>{server.error}</em>}
                        </div>
                        <label className="resource-toggle mcp-exposure-toggle" title="工具暴露：直连 = 工具声明给模型（占前缀）；脚本 = codemode，不声明、不占前缀">
                          <select
                            aria-label={`${server.name} 工具暴露`}
                            value={server.exposure ?? "direct"}
                            disabled={controlsBusy || server.disabled}
                            onChange={(event) => void saveMcpExposure(server, event.target.value as "direct" | "codemode")}
                          >
                            <option value="direct">直连</option>
                            <option value="codemode">脚本</option>
                          </select>
                        </label>
                        <label className="resource-toggle"><input type="checkbox" checked={!server.disabled} disabled={controlsBusy} onChange={(event) => void run({ type: "mcp.server.toggle", name: server.name, enabled: event.target.checked })} /><span>启用</span></label>
                        {showAuth && <button className="secondary-button compact-button mcp-auth-button" type="button" disabled={controlsBusy} title={server.authState === "pending" ? "重新打开浏览器里的授权页" : retryable ? `先用已保留的凭据重试 ${server.name}；不行会打开浏览器授权页` : `用浏览器完成 ${server.name} 的 OAuth 授权`} onClick={() => void run({ type: "mcp.server.auth", name: server.name })}><KeyRound size={13} />{server.authState === "pending" ? "重新打开授权页" : retryable ? "重新授权" : "认证"}</button>}
                        {authorized && <button className="secondary-button compact-button mcp-auth-button" type="button" disabled={controlsBusy} title={`清除 ${server.name} 已保存的 OAuth 凭据`} onClick={() => void run({ type: "mcp.server.auth.clear", name: server.name })}>清除凭据</button>}
                        <button className="icon-button" type="button" title={`编辑 ${server.name}`} aria-label={`编辑 MCP ${server.name}`} disabled={controlsBusy} onClick={() => editMcpServer(server)}><Pencil size={14} /></button>
                        <button className="icon-button resource-remove" type="button" title={`删除 ${server.name}`} aria-label={`删除 MCP ${server.name}`} disabled={controlsBusy} onClick={() => void run({ type: "mcp.server.delete", name: server.name, scope: server.scope })}><Trash2 size={14} /></button>
                      </div>
                    );
                  })}
                </div>
              )}
          </div>
        </section>

        <section className="resource-card" aria-label="Skill">
          <div className="resource-card-head">
            <span className="resource-card-title"><Puzzle size={14} /><strong>Skill</strong></span>
            <small>发现即列在这里；启用后注入系统提示供模型调用</small>
            <span className="resource-card-actions"><small className="resource-card-count">{resources.skills.length} 个已发现</small></span>
          </div>
          <div className="resource-card-body">
            <p className="resource-form-help">把 <code>{`<slug>/SKILL.md`}</code> 放到全局目录 <code>pidesktop-skills/</code>、共享目录 <code>~/.agents/skills/</code> 或项目目录 <code>.pidesktop-skills/</code> 即可被发现，启用后会注入系统提示供模型调用。标「内置」的是随应用分发的内置 Skill（安装目录 <code>resources/skills/</code>）；要改内置内容，把它的目录复制到全局目录 <code>pidesktop-skills/</code> 即可覆盖（同名优先级：当前项目 &gt; 全局 &gt; 内置 &gt; 共享）。</p>
            {resources.skills.length === 0
              ? <p className="resource-empty">当前没有发现 Skill。</p>
              : (
                <div className="resource-list">
                  {resources.skills.map((skill) => (
                    <div className="resource-item" key={skill.id} data-skill-id={skill.id}>
                      <div className="resource-item-icon"><Puzzle size={14} /></div>
                      <div className="resource-item-copy"><strong>/skill:{skill.name}</strong><small>{skill.description}</small><em>{resourceScopeLabels[skill.scope]} · {skill.source}{skill.disableModelInvocation ? " · 仅手动调用" : ""}</em></div>
                      <label className="resource-toggle" title={skill.toggleable ? undefined : "该 Skill 由运行时动态提供，不可关闭"}><input type="checkbox" checked={skill.enabled} disabled={controlsBusy || !skill.toggleable} onChange={(event) => void run({ type: "skill.toggle", id: skill.id, enabled: event.target.checked })} /><span>启用</span></label>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </section>

        <section className="resource-card" aria-label="自定义命令">
          <div className="resource-card-head">
            <span className="resource-card-title"><Zap size={14} /><strong>自定义命令</strong></span>
            <small>输入框 <code>/命令名</code> 调用；改完下次发送即生效</small>
            <span className="resource-card-actions">
              <small className="resource-card-count">{resources.commands.length} 个</small>
              <button className="secondary-button compact-button" type="button" data-control="command-add" disabled={controlsBusy} onClick={() => { if (!commandFormOpen) { setEditingCommand(undefined); setCommandName(""); setCommandDescription(""); setCommandTemplate(""); setCommandScope(workspaceOpen ? "project" : "global"); } setCommandFormOpen((open) => !open); }}><Plus size={13} />{commandFormOpen ? "收起" : "添加"}</button>
            </span>
          </div>
          <div className="resource-card-body">
            <p className="resource-form-help">md 模板文件名即命令名，正文支持 <code>$ARGUMENTS</code> 占位符；放到全局目录 <code>pidesktop-commands/</code> 或项目目录 <code>.pidesktop-commands/</code>（项目同名覆盖全局），也可直接在这里创建维护。输入框 <code>/命令名</code> 调用，改完下次发送即生效。</p>
            {commandFormOpen && <form className="mcp-config-form" onSubmit={(event) => void saveCommand(event)}>
              <div className="mcp-form-grid">
                <label>命令名{editingCommand ? <input value={commandName} disabled title="编辑时不改名；需要改名请删除后新建" /> : <input value={commandName} placeholder="例如 commit（支持中文）" onChange={(event) => setCommandName(event.target.value)} />}</label>
                <label>写入范围<select value={commandScope} onChange={(event) => setCommandScope(event.target.value as CommandDraft["scope"])}><option value="project">当前项目 .pidesktop-commands/</option><option value="global">用户全局 pidesktop-commands/</option></select></label>
                <label className="mcp-form-wide">说明（菜单副标题，可空）<input value={commandDescription} placeholder="例如 为当前改动生成提交信息" onChange={(event) => setCommandDescription(event.target.value)} /></label>
                <label className="mcp-form-wide">提示词模板（$ARGUMENTS 替换为发送时输入的参数）<textarea value={commandTemplate} rows={6} placeholder={"读取暂存区改动，按 type(scope): 中文描述 规范生成提交：$ARGUMENTS"} onChange={(event) => setCommandTemplate(event.target.value)} /></label>
              </div>
              <footer className="mcp-form-actions"><button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={() => setCommandFormOpen(false)}><X size={13} />取消</button><button className="primary-button compact-button" type="submit" data-control="command-save" disabled={controlsBusy}>{editingCommand ? <Pencil size={13} /> : <Plus size={13} />}{editingCommand ? "保存修改" : "添加命令"}</button></footer>
            </form>}
            {resources.commands.length === 0
              ? <p className="resource-empty">当前没有发现自定义命令。点击「添加」创建，或把 md 模板放入命令目录。</p>
              : (
                <div className="resource-list">
                  {resources.commands.map((entry) => (
                    <div className="resource-item" key={entry.name} data-command-name={entry.name}>
                      <div className="resource-item-icon"><Zap size={14} /></div>
                      <div className="resource-item-copy"><strong>/{entry.name}</strong><small>{entry.description || "自定义命令"}</small><em>{resourceScopeLabels[entry.scope]}{entry.filePath ? ` · ${entry.filePath}` : ""}</em></div>
                      <button className="icon-button" type="button" title={`编辑 ${entry.name}`} aria-label={`编辑命令 ${entry.name}`} disabled={controlsBusy} onClick={() => editCommand(entry)}><Pencil size={14} /></button>
                      <button className="icon-button resource-remove" type="button" title={`删除 ${entry.name}`} aria-label={`删除命令 ${entry.name}`} disabled={controlsBusy} onClick={() => void run({ type: "command.delete", name: entry.name, scope: entry.scope === "project" ? "project" : "global" })}><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
              )}
          </div>
        </section>

        {resources.diagnostics.length > 0 && <div className="resource-diagnostics"><strong>资源诊断</strong>{resources.diagnostics.map((diagnostic) => <p key={diagnostic}>{diagnostic}</p>)}</div>}
      </div>
    </div>
  );
}

/** `KEY=VALUE` 逐行解析的键名规则（环境变量名 / 请求头名）。 */
const ENV_VAR_LINES = { label: "环境变量", keyPattern: /^[A-Za-z_][A-Za-z0-9_]*$/u };
/** RFC 7230 token：header 名允许的字符集（比环境变量名宽，含 `-` `.` `_`）。 */
const HEADER_LINES = { label: "请求头", keyPattern: /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u };

/** `名称=值` 逐行解析（MCP 环境变量 / 请求头输入；非法行直接抛错，由调用方兜住）。 */
function parseKeyValueLines(value: string, rules: { label: string; keyPattern: RegExp }): Record<string, string> | undefined {
  const entries = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`${rules.label}格式无效：${line}，应为 名称=值`);
    const key = line.slice(0, separator).trim();
    const entryValue = line.slice(separator + 1).trim();
    if (!rules.keyPattern.test(key)) throw new Error(`${rules.label}名称无效：${key}`);
    return [key, entryValue] as const;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** 反向：配置里的键值对 → 表单的多行文本（编辑回填）。 */
function formatKeyValueLines(entries: Record<string, string> | undefined): string {
  return Object.entries(entries ?? {}).map(([key, value]) => `${key}=${value}`).join("\n");
}
