import { PlugZap, RefreshCw, Server, ShieldCheck, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { SkillStoreSort } from "../../shared/protocol";
import { newStoreRequestId, SkillStoreBrowser } from "./components/SkillStoreBrowser";
import { useDesktopStore } from "./store";

/**
 * 设置页「内网 Skill 商店」tab（2026-11-10，LanSkills 接入）。
 *
 * 与服务端的分工：地址配置由**主进程**落盘（settings.intranetStore），utility 没有
 * Electron API，浏览类命令由主进程在转发前注入 `baseUrl`；渲染端只发命令、读推送。
 *
 * 与公开商店共用 `SkillStoreBrowser`（浏览/详情/安装/卸载），本文件只负责：
 * 地址配置卡、连接测试、顶部状态条、把结果路由到 `intranetStore` 切片。
 *
 * 主题钩子：`data-pane="intranet-skill-store"`；控件 `intranet-store-url|-save|
 * -test|-change|-refresh`（浏览/安装沿用 `skill-store-*`）。
 */

const INTRANET_SORT_OPTIONS: { value: SkillStoreSort; label: string }[] = [
  { value: "updated_at", label: "最近更新" },
  { value: "name", label: "名称" }
];

export function IntranetSkillStoreSettings(): ReactNode {
  const connection = useDesktopStore((state) => state.intranetSource);
  const intranetStore = useDesktopStore((state) => state.intranetStore);
  const workspace = useDesktopStore((state) => state.snapshot.workspace);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);

  const config = connection.config;

  // 保存成功后（主进程回推 config）自动退出编辑态。
  // 地址变化时浏览器以 baseUrl 为 key 重挂载，列表会自己对新的地址重拉一次，不需要额外 bump。
  useEffect(() => {
    if (connection.config && !connection.saving) setEditing(false);
  }, [connection.config?.baseUrl, connection.saving]);

  function startEdit(): void {
    setUrl(config?.baseUrl ?? "");
    setName(config?.name ?? "");
    setEditing(true);
  }

  function save(): void {
    const requestId = newStoreRequestId();
    useDesktopStore.setState((state) => ({ intranetSource: { ...state.intranetSource, saving: true, error: undefined } }));
    void window.piDesktop.send({ type: "skill-store.source.save", requestId, baseUrl: url, ...(name.trim() ? { name: name.trim() } : {}) });
  }

  function clear(): void {
    const requestId = newStoreRequestId();
    useDesktopStore.setState((state) => ({ intranetSource: { ...state.intranetSource, saving: true, error: undefined } }));
    void window.piDesktop.send({ type: "skill-store.source.clear", requestId });
    setEditing(true);
    setUrl("");
    setName("");
  }

  function test(): void {
    const requestId = newStoreRequestId();
    useDesktopStore.setState((state) => ({ intranetSource: { ...state.intranetSource, saving: true, test: undefined } }));
    void window.piDesktop.send({ type: "skill-store.source.test", requestId });
  }

  const showBrowser = Boolean(config) && !editing;

  return (
    <div className="resource-page skill-store-page intranet-store-page" data-pane="intranet-skill-store">
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>内网 Skill 商店</strong>
          <small>
            {config
              ? `已连接 ${config.name ?? "内网商店"}：${config.baseUrl}`
              : "连接自建 LanSkills 服务（内网），浏览并安装内网技能"}
          </small>
        </span>
        <span className="resource-page-actions">
          {showBrowser && (
            <>
              <label className="skill-store-scope">
                <span>安装到</span>
                <select
                  aria-label="安装作用域"
                  data-control="skill-store-scope"
                  value={scope}
                  onChange={(event) => setScope(event.target.value === "project" ? "project" : "global")}
                >
                  <option value="global">用户全局 pidesktop-skills/</option>
                  <option value="project" disabled={!workspace}>{workspace ? "仅当前项目 .pidesktop-skills/" : "仅当前项目（未打开工作区）"}</option>
                </select>
              </label>
              <button className="secondary-button compact-button" type="button" data-control="intranet-store-test" disabled={connection.saving} onClick={test}><PlugZap size={13} />测试连接</button>
              <button className="secondary-button compact-button" type="button" data-control="intranet-store-change" disabled={connection.saving} onClick={startEdit}><Server size={13} />更改地址</button>
              <button className="secondary-button compact-button" type="button" data-control="intranet-store-refresh" disabled={intranetStore.listLoading} onClick={() => setRefreshTick((tick) => tick + 1)}><RefreshCw size={13} className={intranetStore.listLoading ? "spinning" : undefined} />刷新</button>
            </>
          )}
        </span>
      </header>
      <div className="resource-page-body">
        {!showBrowser ? (
          <section className="resource-card" aria-label="内网商店地址">
            <div className="resource-card-head">
              <span className="resource-card-title"><Server size={14} /><strong>服务地址</strong></span>
              <small>由管理员提供，例如 http://skills.corp.local:8080</small>
            </div>
            <div className="resource-card-body">
              <div className="intranet-store-form">
                <label>
                  <span>商店地址</span>
                  <input
                    aria-label="内网商店地址"
                    data-control="intranet-store-url"
                    placeholder="http://skills.corp.local:8080"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") save(); }}
                  />
                </label>
                <label>
                  <span>显示名（可选）</span>
                  <input
                    aria-label="内网商店显示名"
                    placeholder="例如：平台组技能库"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <div className="intranet-store-form-actions">
                  <button className="primary-button compact-button" type="button" data-control="intranet-store-save" disabled={connection.saving} onClick={save}>
                    {connection.saving ? "连接中…" : "保存并连接"}
                  </button>
                  {config && (
                    <button className="secondary-button compact-button" type="button" onClick={() => setEditing(false)} disabled={connection.saving}>
                      <X size={13} />取消
                    </button>
                  )}
                  {config && (
                    <button className="secondary-button compact-button intranet-store-clear" type="button" onClick={clear} disabled={connection.saving}>
                      清除地址
                    </button>
                  )}
                </div>
              </div>
              {connection.error && <p className="form-error skill-store-error">{connection.error}</p>}
              <details className="intranet-store-help">
                <summary>怎么部署这个内网商店？</summary>
                <div>
                  <p>服务端是独立的 LanSkills 项目（单 Docker 镜像，内网离线可用）：</p>
                  <pre>{`docker compose up -d --build
# 控制台 http://<服务器>:8080/console/（口令 ADMIN_PASSWORD）
# MCP    http://<服务器>:8080/mcp
lanskills push ./my-skill --changelog "首次发布"`}</pre>
                  <p className="muted">地址填服务根地址；反向代理带路径前缀时填完整前缀（如 http://corp.local/store）。</p>
                </div>
              </details>
            </div>
          </section>
        ) : (
          <>
            <div className="intranet-store-status">
              <span className="small muted"><ShieldCheck size={12} /> 内网商店 · {config?.baseUrl}</span>
              {connection.test && (
                <span className={`skill-store-result${connection.test.ok ? " ok" : " error"}`}>
                  {connection.test.ok ? "✓" : "✕"} {connection.test.message}
                  {typeof connection.test.latencyMs === "number" ? ` · ${connection.test.latencyMs}ms` : ""}
                </span>
              )}
            </div>
            <SkillStoreBrowser
              key={config?.baseUrl}
              source="intranet"
              state={intranetStore}
              scope={scope}
              showTop={false}
              sortOptions={INTRANET_SORT_OPTIONS}
              defaultSort="updated_at"
              emptyHint="这个内网商店还没有技能。用控制台（/console/）上传，或执行：lanskills push ./my-skill"
              refreshTick={refreshTick}
              onPatch={(next) => useDesktopStore.setState((state) => ({ intranetStore: { ...state.intranetStore, ...next } }))}
            />
          </>
        )}
      </div>
    </div>
  );
}
