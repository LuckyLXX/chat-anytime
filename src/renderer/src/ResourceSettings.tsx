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
  const [mcpEnv, setMcpEnv] = useState("");
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
    setMcpEnv("");
  }

  function editMcpServer(server: McpServerSummary): void {
    setEditingMcp({ name: server.name, scope: server.scope });
    setMcpName(server.name);
    setMcpScope(server.scope);
    setMcpTransport(server.transport);
    setMcpCommand(server.command ?? "npx");
    setMcpArgs((server.args ?? []).join("\n"));
    setMcpEnv(Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"));
    setMcpUrl(server.url ?? "");
    setMcpAuth(server.auth ?? "none");
    setMcpBearerTokenEnv(server.bearerTokenEnv ?? "");
    setMcpFormOpen(true);
  }

  async function addMcpServer(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const server: McpServerConfigDraft = {
        name: mcpName.trim(),
        scope: mcpScope,
        transport: mcpTransport,
        ...(mcpTransport === "stdio"
          ? {
              command: mcpCommand.trim(),
              args: mcpArgs.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean),
              env: parseKeyValueLines(mcpEnv)
            }
          : {
              url: mcpUrl.trim(),
              auth: mcpAuth,
              ...(mcpAuth === "bearer-env" ? { bearerTokenEnv: mcpBearerTokenEnv.trim() } : {})
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

  return (
    <div className="resource-page" data-pane="resource-settings">
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>技能与工具</strong>
          <small>自研 MCP / Skill / Todo / 子代理能力；Pi 的第三方扩展接入已移除，MCP 由内置客户端直连</small>
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
            <small>写入 .mcp.json 或用户全局配置；保存后重建会话以加载新工具</small>
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
                {mcpTransport === "stdio" ? <>
                  <label>启动命令<input value={mcpCommand} placeholder="npx" onChange={(event) => setMcpCommand(event.target.value)} /></label>
                  <label className="mcp-form-wide">参数（每行一个）<textarea value={mcpArgs} rows={3} placeholder={"-y\ncontext7-mcp"} onChange={(event) => setMcpArgs(event.target.value)} /></label>
                  <label className="mcp-form-wide">环境变量（可选，每行 KEY=VALUE）<textarea value={mcpEnv} rows={2} placeholder="API_KEY=xxx" onChange={(event) => setMcpEnv(event.target.value)} /></label>
                </> : <>
                  <label className="mcp-form-wide">服务器地址<input value={mcpUrl} placeholder="https://mcp.example.com/mcp" onChange={(event) => setMcpUrl(event.target.value)} /></label>
                  <label>认证<select value={mcpAuth} onChange={(event) => setMcpAuth(event.target.value as NonNullable<McpServerConfigDraft["auth"]>)}><option value="none">无</option><option value="oauth">OAuth</option><option value="bearer-env">Bearer 环境变量</option></select></label>
                  {mcpAuth === "bearer-env" && <label>Token 环境变量<input value={mcpBearerTokenEnv} placeholder="MCP_TOKEN" onChange={(event) => setMcpBearerTokenEnv(event.target.value)} /></label>}
                </>}
              </div>
              <p className="resource-form-help">{editingMcp ? `正在编辑 ${editingMcp.name}：名称即配置键不可改；切换「写入范围」会把该条目迁移到另一个配置文件，停用状态保留。保存后重载工具并重建会话。` : "添加后会写入 MCP 配置并重建会话以加载新工具。stdio 服务通常由 npx 首次启动；敏感值建议用环境变量名，不要直接写入配置。"}</p>
              {mcpTransport === "http" && <p className="resource-form-help">认证选 OAuth：保存后回到列表点「认证」，会自动打开系统浏览器完成授权，回调后自动重连；凭据保存在本地（刷新令牌长期有效），只有被授权服务器判定失效时才会提示「重新授权」——那时已保存的凭据仍会保留并优先重试。Bearer 环境变量优先于 OAuth。</p>}
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

/** `KEY=VALUE` 逐行解析（MCP 环境变量输入；非法行直接抛错，由调用方兜住）。 */
function parseKeyValueLines(value: string): Record<string, string> | undefined {
  const entries = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`环境变量格式无效：${line}，应为 KEY=VALUE`);
    const key = line.slice(0, separator).trim();
    const entryValue = line.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) throw new Error(`环境变量名无效：${key}`);
    return [key, entryValue] as const;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
