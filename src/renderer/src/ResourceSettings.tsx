import { File, FileCode2, FileText, Image as ImageIcon, KeyRound, Paperclip, Pencil, Plus, Puzzle, RefreshCw, Search, Server, Trash2, Wrench, X, Zap } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { resourceScopeLabels } from "../../shared/locale";
import type { CommandDraft, CommandSummary, McpServerConfigDraft, McpServerStatus, McpServerSummary, ResourceCatalog, RuntimeCommand, SkillSummary } from "../../shared/protocol";
import { MarkdownPreviewContent } from "./components/RichContent";
import { clearSkillDetails, useDesktopStore } from "./store";

/**
 * 资源设置三页（MCP Server / Skill / 自定义命令）。
 *
 * 2026-11-23：原「技能与工具」一个 tab 把三类资源混在一条滚动里（三张卡片纵向
 * 堆叠），与「模型服务 / Agent 角色 / 消息通道」的两段式不一致。按用户口径拆成
 * 三个顶层设置菜单，每页都是「左栏逐条列表 + 右栏编辑/详情」：
 *
 * ① 左栏 `.resource-split-rail`：搜索框 + 列表（`.resource-split-rail-item`，
 *    选中态 `.active`）+ 底部新建；滚动只在 rail-list 里；
 * ② 右栏 `.resource-split-detail`：固定标题条 + 可滚动 `.resource-split-detail-body`，
 *    选中条目的完整操作（启用 / 认证 / 工具暴露 / 编辑 / 删除）与新建·编辑表单都在这里；
 * ③ 三页共用 `data-pane="resource-settings"`，不新增主题钩子；沿用既有
 *    `data-control`（resource-reload / mcp-add / mcp-save / command-add / command-save）
 *    与 `.resource-item` / `.resource-toggle` / `.mcp-config-form` 类名，MCP 表单的
 *    命令载荷回归网（ResourceSettings.test.tsx）因此无需改动断言。
 *
 * 数据流与旧实现逐字节一致：resources.reload / mcp.server.* / skill.toggle /
 * command.* 的命令名与载荷不变；本组页面仍是「即改即发」（无整页保存底栏）。
 * `ResourceSettings` 作为 `McpSettings` 的兼容别名保留，供既有调用点与测试引用。
 *
 * 2026-11-24 Skill 页重排（用户口径：左栏去掉 `/skill:` 前缀、右栏要能看到
 * SKILL.md 正文与附件清单、整页太挤）：左栏只显示 name，徽标从「已启用」
 * （全列表同值，纯噪声）换成作用域；右栏改成「标题条（启用开关常驻）+ 概览 +
 * SKILL.md（预览/源码）+ 附件清单 + 折叠的资源规则」。正文与附件不进
 * ResourceCatalog（高频推送），选中时经 `skill.inspect` 按需读取、`skill-detail`
 * 回推，失败同路带回 error。
 */

interface ResourcePageProps {
  resources: ResourceCatalog;
}

/** 三页共用的命令执行器：本地 busy + 会话 busy 合并，错误就地显示。 */
function useResourceRunner(errorText: string): {
  run(command: RuntimeCommand): Promise<boolean>;
  controlsBusy: boolean;
  localError?: string;
  fail(error: unknown): void;
} {
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const runtimeBusy = useDesktopStore((state) => state.snapshot.busy);
  const controlsBusy = busy || runtimeBusy;

  async function run(command: RuntimeCommand): Promise<boolean> {
    setBusy(true);
    setLocalError(undefined);
    try {
      await window.piDesktop.send(command);
      return true;
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : errorText);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 表单本地校验错误（不经命令回执）也显示在右栏顶部，不静默吞掉。 */
  function fail(error: unknown): void {
    setLocalError(error instanceof Error ? error.message : errorText);
  }

  return { run, controlsBusy, localError, fail };
}

interface SplitPageProps {
  title: string;
  description: string;
  count: number;
  controlsBusy: boolean;
  localError?: string;
  onReload(): void;
  query: string;
  onQuery(value: string): void;
  searchPlaceholder: string;
  railEmpty: string;
  railItems: ReactNode[];
  newLabel?: string;
  newControl?: string;
  onNew?(): void;
  detailTitle: string;
  detailSubtitle: string;
  /** 标题条右侧的常驻操作（Skill 页的启用开关）：不随正文滚走。 */
  detailActions?: ReactNode;
  detail: ReactNode;
}

/** 两段式骨架：页头（标题 + 重载）+ 左栏列表 + 右栏固定标题条与可滚动正文。 */
function SplitPage({
  title, description, count, controlsBusy, localError, onReload,
  query, onQuery, searchPlaceholder, railEmpty, railItems,
  newLabel, newControl, onNew, detailTitle, detailSubtitle, detailActions, detail
}: SplitPageProps): ReactNode {
  return (
    <div className="resource-page resource-split-page" data-pane="resource-settings">
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
        <span className="resource-page-actions">
          <button className="secondary-button compact-button" type="button" data-control="resource-reload" disabled={controlsBusy} onClick={onReload}><RefreshCw size={13} className={controlsBusy ? "spinning" : undefined} />重载资源</button>
        </span>
      </header>
      <div className="resource-split-layout">
        <aside className="resource-split-rail" aria-label={`${title}列表`}>
          <div className="resource-split-rail-head"><strong>{title}</strong><span>{count}</span></div>
          <div className="resource-split-rail-search">
            <Search size={13} />
            <input value={query} placeholder={searchPlaceholder} aria-label={`搜索${title}`} onChange={(event) => onQuery(event.target.value)} />
          </div>
          <div className="resource-split-rail-list">
            {railItems.length === 0
              ? <p className="resource-split-rail-empty">{query.trim() ? `没有匹配「${query.trim()}」的${title}` : railEmpty}</p>
              : railItems}
          </div>
          {onNew && newLabel && <button className="resource-split-rail-new" type="button" data-control={newControl} disabled={controlsBusy} onClick={onNew}><Plus size={13} />{newLabel}</button>}
        </aside>
        <section className="resource-split-detail" aria-label={`${title}详情`}>
          <header className="resource-split-detail-bar">
            <span className="resource-split-detail-title"><strong>{detailTitle}</strong><small>{detailSubtitle}</small></span>
            {detailActions}
          </header>
          <div className="resource-split-detail-body">
            {localError && <p className="form-error resource-error">{localError}</p>}
            {detail}
          </div>
        </section>
      </div>
    </div>
  );
}

interface SplitRailItemProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  active: boolean;
  badge?: ReactNode;
  /** 停用条目的压暗态（不改变选中态，只在视觉上区分）。 */
  muted?: boolean;
  onClick(): void;
}

function SplitRailItem({ icon, title, subtitle, active, badge, muted, onClick }: SplitRailItemProps): ReactNode {
  return (
    <button type="button" className={["resource-split-rail-item", active && "active", muted && "is-muted"].filter(Boolean).join(" ")} onClick={onClick}>
      <span className="resource-split-rail-icon">{icon}</span>
      <span className="resource-split-rail-copy"><strong>{title}</strong><small>{subtitle}</small></span>
      {badge}
    </button>
  );
}

/** MCP Server 状态徽标文案。 */
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

/* ============================================================================
   MCP Server 页
   ========================================================================== */

export function McpSettings({ resources }: ResourcePageProps): ReactNode {
  const { run, controlsBusy, localError, fail } = useResourceRunner("MCP Server 配置无效");
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState<string>();
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

  const servers = resources.mcpServers;
  const visibleServers = servers.filter((server) => `${server.name} ${server.url ?? server.command ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  // 未显式选中时默认展示第一条：列表行内操作（工具暴露 / 编辑 / 删除）始终有落点。
  const selected = servers.find((server) => server.name === selectedName) ?? servers[0];

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

  function openCreate(): void {
    resetMcpForm();
    setMcpFormOpen(true);
  }

  function selectServer(name: string): void {
    setSelectedName(name);
    setMcpFormOpen(false);
  }

  function editMcpServer(server: McpServerSummary): void {
    setSelectedName(server.name);
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
      setSelectedName(server.name);
      resetMcpForm();
      setMcpFormOpen(false);
    } catch (error) {
      // 解析错误由 run 之外的本地错误态承接（表单校验不进命令回执）。
      fail(error);
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

  const railItems = visibleServers.map((server) => (
    <SplitRailItem
      key={server.name}
      icon={<Server size={13} />}
      title={server.name}
      subtitle={`${resourceScopeLabels[server.scope]} · ${mcpStatusLabels[server.status]}`}
      active={!mcpFormOpen && selected?.name === server.name}
      badge={server.disabled ? <em className="resource-split-rail-badge off">停用</em> : <em className="resource-split-rail-badge">{server.toolCount} 工具</em>}
      onClick={() => selectServer(server.name)}
    />
  ));

  const detail = mcpFormOpen
    ? mcpForm()
    : selected
      ? serverDetail(selected)
      : <p className="resource-empty">还没有 MCP Server。点左下「添加 MCP」新建，或把配置写入 <code>.mcp.json</code> 后重载资源。</p>;

  return (
    <SplitPage
      title="MCP Server"
      description="写入 .mcp.json 或用户全局配置；保存后立即生效（增减服务器无需重建会话）"
      count={servers.length}
      controlsBusy={controlsBusy}
      localError={localError}
      onReload={() => void run({ type: "resources.reload" })}
      query={query}
      onQuery={setQuery}
      searchPlaceholder="搜索服务器名称或地址"
      railEmpty="未发现 MCP Server"
      railItems={railItems}
      newLabel="添加 MCP"
      newControl="mcp-add"
      onNew={() => mcpFormOpen ? setMcpFormOpen(false) : openCreate()}
      detailTitle={mcpFormOpen ? (editingMcp ? `编辑 ${editingMcp.name}` : "添加 MCP Server") : (selected?.name ?? "MCP Server")}
      detailSubtitle={mcpFormOpen ? "填写连接信息；保存后立即连接并更新可用工具" : "在右侧管理连接、工具暴露与启用状态；点「编辑」修改完整配置"}
      detail={detail}
    />
  );

  /** 新建 / 编辑表单（保留旧表单的字段与 data-control，供载荷回归网钉住）。 */
  function mcpForm(): ReactNode {
    return (
      <form className="mcp-config-form" onSubmit={(event) => void addMcpServer(event)}>
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
      </form>
    );
  }

  /** 选中条目的完整操作（行内工具暴露 / 启用 / 认证 / 编辑 / 删除）。 */
  function serverDetail(server: McpServerSummary): ReactNode {
    const authorized = server.authState === "authorized";
    // 授权失败但凭据仍保留（可重试）的 server：文案要说清楚「已保留凭据」。
    const retryable = server.authState === "failed";
    const showAuth = !authorized && (server.status === "needs-auth" || server.authState === "pending" || server.authState === "failed" || server.auth === "oauth");
    return (
      <div className="resource-split-detail-stack">
        <div className="resource-item mcp-resource-item" data-mcp-server={server.name}>
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
        {mcpToolCard(server)}
        <p className="resource-form-help">把 <code>{"<name>/SKILL.md"}</code> 之类资源接进 Pi 的 MCP 扩展：直连会把工具声明进每次请求前缀，脚本模式改由 codemode 发现调用。改用「编辑」可修改启动命令、请求头、认证与超时；停用与删除都是即时命令。</p>
        {resources.diagnostics.length > 0 && <div className="resource-diagnostics"><strong>资源诊断</strong>{resources.diagnostics.map((diagnostic) => <p key={diagnostic}>{diagnostic}</p>)}</div>}
      </div>
    );
  }

  /**
   * 工具清单卡片：名字来自当前会话的工具注册表（`mcp__<server>__<tool>`）。
   * 三种态：有工具 → 列表；已连接但没注册到 → 如实说；未连接/停用 → 说明稍后出现。
   * 标签语义按 exposure 分：codemode = 脚本（不声明给模型）、hidden = 角色级关闭；
   * direct 却不在活动集才是「未激活」（注册与激活之间的瞬时态）。
   */
  function mcpToolCard(server: McpServerSummary): ReactNode {
    const tools = server.tools ?? [];
    const activeCount = tools.filter((tool) => tool.active).length;
    const disabled = server.disabled || server.status === "disabled";
    // 状态板报出的 toolCount 与注册表清单可能短时间不同步（例如运行中的应用还没加载
    // 清单投影这一步）：这时不能声称「没有注册工具」，要如实说清单没同步。
    const reported = server.toolCount;
    const summary = tools.length > 0
      ? `${tools.length} 个${activeCount === tools.length ? "" : ` · ${activeCount} 个已声明`}`
      : disabled
        ? "已停用"
        : reported > 0
          ? "清单未同步"
          : server.status === "connected"
            ? "没有注册工具"
            : "连接后显示";
    return (
      <section className="resource-card mcp-tool-card" data-mcp-tools={server.name}>
        <header className="resource-card-head">
          <span className="resource-card-title"><Wrench size={13} /><strong>工具</strong></span>
          <small>{summary}</small>
        </header>
        {tools.length > 0 ? (
          <ul className="mcp-tool-list">
            {tools.map((tool) => {
              const tag = tool.exposure === "codemode" ? "脚本" : tool.exposure === "hidden" ? "已关闭" : !tool.active ? "未激活" : undefined;
              return (
                <li key={tool.fullName} data-tool-active={tool.active ? "true" : "false"}>
                  <span className={`mcp-tool-dot${tool.active ? " is-active" : ""}`} aria-hidden="true" />
                  <code title={tool.fullName}>{tool.name}</code>
                  {tag && <em>{tag}</em>}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="resource-card-body"><p className="mcp-tool-empty">{disabled ? "服务器已停用，不注册工具。" : reported > 0 ? `运行时报告 ${reported} 个工具，但清单还没同步过来：先点右上「重载资源」；仍为空就重启应用（工具名由后台运行时提供）。` : server.status === "connected" ? "服务器已连接，但还没有注册到任何工具——可能需要重新连接或完成授权。" : "连接成功后，这里会列出该服务器注册到会话的工具。"}</p></div>
        )}
      </section>
    );
  }
}

/* ============================================================================
   Skill 页
   ========================================================================== */

export function SkillSettings({ resources }: ResourcePageProps): ReactNode {
  const { run, controlsBusy, localError } = useResourceRunner("资源操作失败");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<"preview" | "source">("preview");
  const skills = resources.skills;
  const visibleSkills = skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected: SkillSummary | undefined = skills.find((skill) => skill.id === selectedId) ?? skills[0];
  // 正文与附件清单按需读取（目录推送不带正文）：缓存放在 store，按 id 归位。
  const detail = useDesktopStore((state) => (selected ? state.skillDetails[selected.id] : undefined));

  useEffect(() => {
    if (!selected || detail) return;
    void window.piDesktop.send({ type: "skill.inspect", id: selected.id });
  }, [selected?.id, detail]);

  const railItems = visibleSkills.map((skill) => (
    <SplitRailItem
      key={skill.id}
      icon={<Puzzle size={13} />}
      title={skill.name}
      subtitle={skill.description || "未填写说明"}
      active={selected?.id === skill.id}
      muted={!skill.enabled}
      // 全部条目都挂「已启用」纯噪声：徽标改显示作用域，停用项才报「停用」。
      badge={<em className={skill.enabled ? "resource-split-rail-badge scope" : "resource-split-rail-badge off"}>{skill.enabled ? resourceScopeLabels[skill.scope] : "停用"}</em>}
      onClick={() => setSelectedId(skill.id)}
    />
  ));

  const files = detail?.files ?? [];
  const filesBytes = files.reduce((sum, file) => sum + file.size, 0);
  // 附件卡右上角的一行小结：读取失败时不能报「无附带文件」（那是说谎）。
  const filesSummary = !detail
    ? "读取中…"
    : detail.error
      ? "读取失败"
      : files.length === 0
        ? "无附带文件"
        : `${files.length}${detail.filesTruncated ? "+" : ""} 个文件 · ${formatBytes(filesBytes)}`;

  /** 重读 SKILL.md（文件可能在外部被编辑过；目录本身没变化，不必重载资源）。 */
  function reloadDetail(): void {
    if (selected) void window.piDesktop.send({ type: "skill.inspect", id: selected.id });
  }

  const detailNode = selected
    ? (
      <div className="skill-detail" data-skill-id={selected.id}>
        <section className="skill-overview">
          <p className="skill-overview-text">{selected.description || "未填写说明"}</p>
          <div className="skill-meta">
            <span><em>来源</em>{selected.source}</span>
            <span><em>作用域</em>{resourceScopeLabels[selected.scope]}</span>
            <span><em>调用</em><code>{`/skill:${selected.name}`}</code></span>
            {selected.disableModelInvocation && <span><em>模型调用</em>仅手动</span>}
          </div>
          {selected.filePath && <code className="skill-path" title={selected.filePath}>{selected.filePath}</code>}
        </section>

        <section className="resource-card skill-card skill-content-card">
          <header className="resource-card-head">
            <span className="resource-card-title"><FileText size={13} /><strong>SKILL.md</strong></span>
            <small>{detail ? (detail.error ? "读取失败" : `${formatBytes(contentBytes(detail.content))} · ${detail.content.split(/\r?\n/u).length} 行`) : "读取中…"}</small>
            <div className="resource-card-actions">
              <div className="skill-view-switch" role="group" aria-label="SKILL.md 显示方式">
                <button type="button" className={view === "preview" ? "active" : ""} aria-pressed={view === "preview"} onClick={() => setView("preview")}>预览</button>
                <button type="button" className={view === "source" ? "active" : ""} aria-pressed={view === "source"} onClick={() => setView("source")}>源码</button>
              </div>
              <button className="icon-button" type="button" title="重新读取 SKILL.md" aria-label="重新读取 SKILL.md" onClick={reloadDetail}><RefreshCw size={13} /></button>
            </div>
          </header>
          <div className="skill-content-body">
            {!detail
              ? <p className="skill-note">正在读取 SKILL.md…</p>
              : detail.error
                ? <p className="skill-error">{detail.error}</p>
                : view === "source"
                  ? <pre className="resource-split-template skill-source"><code>{detail.content}</code></pre>
                  : <MarkdownPreviewContent content={stripFrontmatter(detail.content)} windowed={false} artifactPrefix={`skill-${selected.id}`} onOpenArtifact={ignoreArtifact} />}
            {detail?.contentTruncated && <p className="skill-note">SKILL.md 较大，此处只显示前面一部分；完整内容请直接打开上面的路径。</p>}
          </div>
        </section>

        <section className="resource-card skill-card skill-files-card">
          <header className="resource-card-head">
            <span className="resource-card-title"><Paperclip size={13} /><strong>附件</strong></span>
            <small>{filesSummary}</small>
          </header>
          {files.length > 0 && (
            <ul className="skill-file-list">
              {files.map((file) => (
                <li key={file.path}>
                  <span className="skill-file-icon">{skillFileIcon(file.path)}</span>
                  <code>{file.path}</code>
                  <em>{formatBytes(file.size)}</em>
                </li>
              ))}
            </ul>
          )}
          {detail && files.length === 0 && !detail.error && <div className="skill-content-body"><p className="skill-note">这个 Skill 只包含 SKILL.md，没有附带文件。</p></div>}
          {detail?.filesTruncated && <div className="skill-content-body"><p className="skill-note">附件较多，此处只列出一部分；完整清单请直接打开上面的路径。</p></div>}
        </section>

        <details className="skill-rules">
          <summary>Skill 从哪里来、怎么生效</summary>
          <p>把 <code>{`<slug>/SKILL.md`}</code> 放到全局目录 <code>pidesktop-skills/</code>、共享目录 <code>~/.agents/skills/</code> 或项目目录 <code>.pidesktop-skills/</code> 即可被发现，启用后会注入系统提示供模型调用。标「内置」的是随应用分发的内置 Skill（安装目录 <code>resources/skills/</code>）；要改内置内容，把它的目录复制到全局目录 <code>pidesktop-skills/</code> 即可覆盖（同名优先级：当前项目 &gt; 全局 &gt; 内置 &gt; 共享）。</p>
        </details>
        {resources.diagnostics.length > 0 && <div className="resource-diagnostics"><strong>资源诊断</strong>{resources.diagnostics.map((diagnostic) => <p key={diagnostic}>{diagnostic}</p>)}</div>}
      </div>
    )
    : <p className="resource-empty">当前没有发现 Skill。把 <code>&lt;slug&gt;/SKILL.md</code> 放进资源目录后点「重载资源」。</p>;

  return (
    <SplitPage
      title="Skill"
      description="发现即列在这里；启用后注入系统提示供模型调用"
      count={skills.length}
      controlsBusy={controlsBusy}
      localError={localError}
      // SKILL.md 可能刚在外部改过：重载资源前先清详情缓存，选中效应会重新读取。
      onReload={() => { clearSkillDetails(); void run({ type: "resources.reload" }); }}
      query={query}
      onQuery={setQuery}
      searchPlaceholder="搜索 Skill 名称或说明"
      railEmpty="当前没有发现 Skill"
      railItems={railItems}
      detailTitle={selected?.name ?? "Skill"}
      detailSubtitle={selected ? "SKILL.md 正文与附件清单按需读取；启用开关即时生效" : "选中左侧条目查看内容与附件"}
      detailActions={selected && (
        <label className="resource-switch" title={selected.toggleable ? "启用后注入系统提示，模型可按需调用" : "该 Skill 由运行时动态提供，不可关闭"}>
          <input type="checkbox" checked={selected.enabled} disabled={controlsBusy || !selected.toggleable} onChange={(event) => void run({ type: "skill.toggle", id: selected.id, enabled: event.target.checked })} />
          <span>{selected.enabled ? "已启用" : "已停用"}</span>
        </label>
      )}
      detail={detailNode}
    />
  );
}

/** 设置页没有预览面板：SKILL.md 里的 HTML 围栏会渲染成 artifact 卡，点击不做事（也不该做事）。 */
function ignoreArtifact(): void {}

/** SKILL.md 的 frontmatter 在渲染预览里是噪音（name/description 已在概览展示）；源码视图保留原文。 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "");
}

/** 附件行图标：只按扩展名粗分三类，足够扫读（不解析文件内容）。 */
function skillFileIcon(path: string): ReactNode {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(extension)) return <ImageIcon size={13} />;
  if (["ts", "tsx", "js", "jsx", "mjs", "py", "sh", "ps1", "css", "html", "sql", "json"].includes(extension)) return <FileCode2 size={13} />;
  if (["md", "markdown", "txt", "yaml", "yml", "toml", "ini", "csv"].includes(extension)) return <FileText size={13} />;
  return <File size={13} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 正文字节数（UTF-8）：中文 SKILL.md 的「字符数」与文件大小差三倍，展示必须按字节。 */
function contentBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

/* ============================================================================
   自定义命令页
   ========================================================================== */

export function CommandSettings({ resources }: ResourcePageProps): ReactNode {
  const { run, controlsBusy, localError } = useResourceRunner("资源操作失败");
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState<string>();
  const [commandFormOpen, setCommandFormOpen] = useState(false);
  const [editingCommand, setEditingCommand] = useState<string>();
  const [commandName, setCommandName] = useState("");
  const [commandDescription, setCommandDescription] = useState("");
  const [commandTemplate, setCommandTemplate] = useState("");
  const [commandScope, setCommandScope] = useState<CommandDraft["scope"]>("project");
  const workspaceOpen = useDesktopStore((state) => Boolean(state.snapshot.workspace));

  const commands = resources.commands;
  const visibleCommands = commands.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selected: CommandSummary | undefined = commands.find((entry) => entry.name === selectedName) ?? commands[0];

  /** 编辑已有命令：回填表单并展开（名字锁定，改名=删旧建新）。 */
  function editCommand(entry: CommandSummary): void {
    setSelectedName(entry.name);
    setEditingCommand(entry.name);
    setCommandName(entry.name);
    setCommandDescription(entry.description);
    setCommandTemplate(entry.template ?? "");
    setCommandScope(entry.scope === "project" ? "project" : "global");
    setCommandFormOpen(true);
  }

  function openCreate(): void {
    setEditingCommand(undefined);
    setCommandName("");
    setCommandDescription("");
    setCommandTemplate("");
    setCommandScope(workspaceOpen ? "project" : "global");
    setCommandFormOpen(true);
  }

  function selectCommand(name: string): void {
    setSelectedName(name);
    setCommandFormOpen(false);
  }

  async function saveCommand(event: FormEvent): Promise<void> {
    event.preventDefault();
    const success = await run({ type: "command.save", command: { name: commandName.trim(), description: commandDescription.trim() || undefined, template: commandTemplate, scope: commandScope } });
    if (!success) return;
    setSelectedName(commandName.trim());
    setCommandFormOpen(false);
    setEditingCommand(undefined);
    setCommandName("");
    setCommandDescription("");
    setCommandTemplate("");
  }

  const railItems = visibleCommands.map((entry) => (
    <SplitRailItem
      key={entry.name}
      icon={<Zap size={13} />}
      title={`/${entry.name}`}
      subtitle={entry.description || "自定义命令"}
      active={!commandFormOpen && selected?.name === entry.name}
      badge={<em className="resource-split-rail-badge">{resourceScopeLabels[entry.scope]}</em>}
      onClick={() => selectCommand(entry.name)}
    />
  ));

  const detail = commandFormOpen
    ? (
      <form className="mcp-config-form" onSubmit={(event) => void saveCommand(event)}>
        <div className="mcp-form-grid">
          <label>命令名{editingCommand ? <input value={commandName} disabled title="编辑时不改名；需要改名请删除后新建" /> : <input value={commandName} placeholder="例如 commit（支持中文）" onChange={(event) => setCommandName(event.target.value)} />}</label>
          <label>写入范围<select value={commandScope} onChange={(event) => setCommandScope(event.target.value as CommandDraft["scope"])}><option value="project">当前项目 .pidesktop-commands/</option><option value="global">用户全局 pidesktop-commands/</option></select></label>
          <label className="mcp-form-wide">说明（菜单副标题，可空）<input value={commandDescription} placeholder="例如 为当前改动生成提交信息" onChange={(event) => setCommandDescription(event.target.value)} /></label>
          <label className="mcp-form-wide">提示词模板（$ARGUMENTS 替换为发送时输入的参数）<textarea value={commandTemplate} rows={6} placeholder={"读取暂存区改动，按 type(scope): 中文描述 规范生成提交：$ARGUMENTS"} onChange={(event) => setCommandTemplate(event.target.value)} /></label>
        </div>
        <footer className="mcp-form-actions"><button className="secondary-button compact-button" type="button" disabled={controlsBusy} onClick={() => setCommandFormOpen(false)}><X size={13} />取消</button><button className="primary-button compact-button" type="submit" data-control="command-save" disabled={controlsBusy}>{editingCommand ? <Pencil size={13} /> : <Plus size={13} />}{editingCommand ? "保存修改" : "添加命令"}</button></footer>
      </form>
    )
    : selected
      ? (
        <div className="resource-split-detail-stack">
          <div className="resource-item" data-command-name={selected.name}>
            <div className="resource-item-icon"><Zap size={14} /></div>
            <div className="resource-item-copy"><strong>/{selected.name}</strong><small>{selected.description || "自定义命令"}</small><em>{resourceScopeLabels[selected.scope]}{selected.filePath ? ` · ${selected.filePath}` : ""}</em></div>
            <button className="icon-button" type="button" title={`编辑 ${selected.name}`} aria-label={`编辑命令 ${selected.name}`} disabled={controlsBusy} onClick={() => editCommand(selected)}><Pencil size={14} /></button>
            <button className="icon-button resource-remove" type="button" title={`删除 ${selected.name}`} aria-label={`删除命令 ${selected.name}`} disabled={controlsBusy} onClick={() => void run({ type: "command.delete", name: selected.name, scope: selected.scope === "project" ? "project" : "global" })}><Trash2 size={14} /></button>
          </div>
          <p className="resource-form-help">md 模板文件名即命令名，正文支持 <code>$ARGUMENTS</code> 占位符；放到全局目录 <code>pidesktop-commands/</code> 或项目目录 <code>.pidesktop-commands/</code>（项目同名覆盖全局），也可直接在这里创建维护。输入框 <code>/命令名</code> 调用，改完下次发送即生效。</p>
          {selected.template && <pre className="resource-split-template"><code>{selected.template}</code></pre>}
          {resources.diagnostics.length > 0 && <div className="resource-diagnostics"><strong>资源诊断</strong>{resources.diagnostics.map((diagnostic) => <p key={diagnostic}>{diagnostic}</p>)}</div>}
        </div>
      )
      : <p className="resource-empty">还没有自定义命令。点左下「添加命令」创建，或把 md 模板放进命令目录后重载资源。</p>;

  return (
    <SplitPage
      title="自定义命令"
      description="输入框 /命令名 调用；改完下次发送即生效"
      count={commands.length}
      controlsBusy={controlsBusy}
      localError={localError}
      onReload={() => void run({ type: "resources.reload" })}
      query={query}
      onQuery={setQuery}
      searchPlaceholder="搜索命令名或说明"
      railEmpty="当前没有自定义命令"
      railItems={railItems}
      newLabel="添加命令"
      newControl="command-add"
      onNew={() => commandFormOpen ? setCommandFormOpen(false) : openCreate()}
      detailTitle={commandFormOpen ? (editingCommand ? `编辑 /${editingCommand}` : "添加自定义命令") : (selected ? `/${selected.name}` : "自定义命令")}
      detailSubtitle={commandFormOpen ? "模板里的 $ARGUMENTS 会替换成发送时输入的参数" : "选中左侧命令查看模板；点「编辑」修改或「添加命令」新建"}
      detail={detail}
    />
  );
}

/** 兼容别名：既有调用点与 MCP 表单回归测试仍引用 ResourceSettings。 */
export { McpSettings as ResourceSettings };

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
