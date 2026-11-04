import { Download, RefreshCw, Search, ShieldAlert, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RuntimeCommand, SkillStoreCategory, SkillStoreInstallSummary, SkillStoreSkill, SkillStoreSort } from "../../shared/protocol";
import { useDesktopStore } from "./store";

/**
 * 设置页「Skill 商店」tab（2026-11-04）。
 *
 * 数据流：本组件只发命令、读推送状态，**不 await 结果**（`runtime:send` 永不 reject）：
 *   window.piDesktop.send({type:"skill-store.list", requestId, query})
 *     → utility skill-store-client 拉 https://api.skillhub.cn
 *     → post({type:"skill-store-result", result:{kind, requestId, ok, …}})
 *     → store 的 applySkillStoreResult 按 requestId 认领
 *     → 本组件重渲染
 * 所以每个请求都带 `crypto.randomUUID()` 生成的 requestId，列表/详情并发时状态不串台。
 *
 * 与「技能与工具」页的分工：商店只管**发现与安装**，启用/停用/查看路径仍在
 * 「技能与工具」。安装只落盘、不执行包内代码；包内脚本由模型后续按需 read。
 *
 * 主题钩子：`data-pane="skill-store"`；控件 `skill-store-refresh` / `-scope` /
 * `-search` / `-category` / `-sort` / `-top` / `-page` / `-open` / `-install` /
 * `-confirm-install` / `-uninstall` / `-close-detail`。
 */

const PAGE_SIZE = 20;

const SORT_OPTIONS: { value: SkillStoreSort; label: string }[] = [
  { value: "score", label: "综合评分" },
  { value: "downloads", label: "下载量" },
  { value: "stars", label: "收藏数" },
  { value: "updated_at", label: "最近更新" }
];

function newRequestId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function formatCount(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return String(value);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function categoryLabel(categories: SkillStoreCategory[], key: string | undefined): string | undefined {
  if (!key) return undefined;
  return categories.find((item) => item.key === key)?.name ?? key;
}

export function SkillStoreSettings(): ReactNode {
  const skillStore = useDesktopStore((state) => state.skillStore);
  const resources = useDesktopStore((state) => state.resources);
  const workspace = useDesktopStore((state) => state.snapshot.workspace);
  const [scope, setScope] = useState<"global" | "project">("global");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [sortBy, setSortBy] = useState<SkillStoreSort>("score");
  const [page, setPage] = useState(1);
  const [openSlug, setOpenSlug] = useState<string>();
  const [pendingInstall, setPendingInstall] = useState<SkillStoreSkill>();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const initialized = useRef(false);

  const patch = useCallback((next: Partial<ReturnType<typeof useDesktopStore.getState>["skillStore"]>) => {
    useDesktopStore.setState((state) => ({ skillStore: { ...state.skillStore, ...next } }));
  }, []);

  const fetchList = useCallback((next?: { keyword?: string; category?: string; sortBy?: SkillStoreSort; order?: "asc" | "desc"; page?: number }) => {
    const requestId = newRequestId();
    const query = {
      keyword: next?.keyword ?? keyword,
      category: next?.category ?? category,
      sortBy: next?.sortBy ?? sortBy,
      order: next?.order ?? "desc" as const,
      page: next?.page ?? page,
      pageSize: PAGE_SIZE
    };
    patch({ listRequestId: requestId, listLoading: true, listError: undefined, listQuery: query });
    void window.piDesktop.send({ type: "skill-store.list", requestId, query });
  }, [category, keyword, page, patch, sortBy]);

  const fetchCategories = useCallback(() => {
    patch({ categoriesLoading: true });
    void window.piDesktop.send({ type: "skill-store.categories", requestId: newRequestId() });
  }, [patch]);

  // 首屏：分类字典 + 列表各拉一次（分类是运行时字典，不硬编码）。
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    fetchCategories();
    fetchList({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 关键词 300ms 防抖（每次输入都打共享 API 既慢又浪费配额）。
  function onKeywordChange(value: string): void {
    setKeyword(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setPage(1);
      fetchList({ keyword: value, page: 1 });
    }, 300);
  }

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const openDetail = useCallback((skill: SkillStoreSkill) => {
    const requestId = newRequestId();
    setOpenSlug(skill.slug);
    setPendingInstall(undefined);
    patch({ detailRequestId: requestId, detailLoading: true, detail: undefined, detailVersions: [], detailFiles: [], detailTotalBytes: 0, detailReadme: undefined, detailError: undefined });
    void window.piDesktop.send({ type: "skill-store.detail", requestId, slug: skill.slug });
  }, [patch]);

  const sendInstall = useCallback((skill: SkillStoreSkill, confirmReplace: boolean) => {
    const requestId = newRequestId();
    patch({ installing: { requestId, slug: skill.slug }, lastInstall: undefined });
    void window.piDesktop.send({ type: "skill-store.install", requestId, slug: skill.slug, scope, ...(confirmReplace ? { confirmReplace: true } : {}) });
  }, [patch, scope]);

  const context = useMemo(() => ({
    categories: skillStore.categories,
    installs: skillStore.installs,
    discoveredSkills: resources.skills
  }), [resources.skills, skillStore.categories, skillStore.installs]);

  const detailInstall = skillStore.detail ? skillStore.installs.find((record) => record.slug === skillStore.detail?.slug && record.scope === scope) : undefined;
  const pageCount = Math.max(1, Math.ceil(skillStore.listTotal / PAGE_SIZE));

  return (
    <div className="resource-page skill-store-page" data-pane="skill-store">
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>Skill 商店</strong>
          <small>来自 SkillHub（api.skillhub.cn）的公开技能；安装后在「技能与工具」里管理启用</small>
        </span>
        <span className="resource-page-actions">
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
          <button className="secondary-button compact-button" type="button" data-control="skill-store-refresh" disabled={skillStore.listLoading} onClick={() => { fetchCategories(); fetchList(); }}><RefreshCw size={13} className={skillStore.listLoading ? "spinning" : undefined} />刷新</button>
        </span>
      </header>
      <div className="resource-page-body">
        <p className="skill-store-notice">
          <ShieldAlert size={13} />
          <span>技能包来自第三方，安装<strong>只落盘不执行</strong>；包内脚本由模型后续按需读取。安装前请查看文件清单与 SKILL.md 预览，自行判断安全性。</span>
        </p>

        <section className="resource-card" aria-label="浏览与搜索">
          <div className="resource-card-head">
            <span className="resource-card-title"><Search size={14} /><strong>浏览</strong></span>
            <small>搜索走 SkillHub 公开接口；分类字典运行时拉取</small>
            <span className="resource-card-actions">
              <small className="resource-card-count">{skillStore.listLoading ? "加载中…" : `${skillStore.listTotal} 个结果`}</small>
            </span>
          </div>
          <div className="resource-card-body">
            <div className="skill-store-browse">
              <label className="skill-store-search">
                <Search size={13} />
                <input
                  aria-label="搜索技能"
                  data-control="skill-store-search"
                  placeholder="搜索技能名或关键词"
                  value={keyword}
                  onChange={(event) => onKeywordChange(event.target.value)}
                />
              </label>
              <label>
                <span>分类</span>
                <select
                  aria-label="分类筛选"
                  data-control="skill-store-category"
                  value={category}
                  disabled={skillStore.categoriesLoading}
                  onChange={(event) => { setCategory(event.target.value); setPage(1); fetchList({ category: event.target.value, page: 1 }); }}
                >
                  <option value="">全部分类</option>
                  {skillStore.categories.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
                </select>
              </label>
              <label>
                <span>排序</span>
                <select
                  aria-label="排序方式"
                  data-control="skill-store-sort"
                  value={sortBy}
                  onChange={(event) => { const next = event.target.value as SkillStoreSort; setSortBy(next); setPage(1); fetchList({ sortBy: next, page: 1 }); }}
                >
                  {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <button
                className="secondary-button compact-button"
                type="button"
                data-control="skill-store-top"
                onClick={() => {
                  patch({ topLoading: true, topError: undefined });
                  void window.piDesktop.send({ type: "skill-store.top", requestId: newRequestId() });
                }}
              >热门 Top 50</button>
            </div>
            {skillStore.listError && <p className="form-error skill-store-error">{skillStore.listError}</p>}
            {skillStore.topError && <p className="form-error skill-store-error">热门榜：{skillStore.topError}</p>}
            <div className="skill-store-pager" data-control="skill-store-page">
              <button className="secondary-button compact-button" type="button" disabled={page <= 1 || skillStore.listLoading} onClick={() => { const next = page - 1; setPage(next); fetchList({ page: next }); }}>上一页</button>
              <small>第 {page} / {pageCount} 页</small>
              <button className="secondary-button compact-button" type="button" disabled={page >= pageCount || skillStore.listLoading} onClick={() => { const next = page + 1; setPage(next); fetchList({ page: next }); }}>下一页</button>
            </div>
          </div>
        </section>

        {skillStore.topSkills.length > 0 && <section className="resource-card" aria-label="热门 Top 50">
          <div className="resource-card-head">
            <span className="resource-card-title"><Download size={14} /><strong>热门 Top 50</strong></span>
            <small>{skillStore.topLoading ? "加载中…" : "按下载量排序"}</small>
          </div>
          <div className="resource-card-body">
            <div className="skill-store-grid">
              {skillStore.topSkills.map((skill) => <SkillCard key={`top-${skill.slug}`} skill={skill} installs={context.installs} categories={context.categories} onOpen={openDetail} />)}
            </div>
          </div>
        </section>}

        <section className="resource-card" aria-label="技能列表">
          <div className="resource-card-head">
            <span className="resource-card-title"><Search size={14} /><strong>{skillStore.listLoading ? "正在加载…" : "搜索结果"}</strong></span>
            <small>{context.discoveredSkills.length} 个技能已在本机发现</small>
          </div>
          <div className="resource-card-body">
            {!skillStore.listLoading && skillStore.listSkills.length === 0 && !skillStore.listError
              ? <p className="resource-empty">没有匹配的技能。换个关键词，或点「热门 Top 50」看看大家都在用什么。</p>
              : (
                <div className="skill-store-grid">
                  {skillStore.listSkills.map((skill) => <SkillCard key={skill.slug} skill={skill} installs={context.installs} categories={context.categories} onOpen={openDetail} />)}
                </div>
              )}
          </div>
        </section>

        {skillStore.lastInstall && (
          <p className={`skill-store-result${skillStore.lastInstall.ok ? " ok" : " error"}`} role="status">
            {skillStore.lastInstall.ok ? "✓" : "✕"} {skillStore.lastInstall.ok ? skillStore.lastInstall.message : `${skillStore.lastInstall.slug ? `${skillStore.lastInstall.slug}：` : ""}${skillStore.lastInstall.message}`}
            {skillStore.lastInstall.installDir && <em> · {skillStore.lastInstall.installDir}</em>}
          </p>
        )}
      </div>

      {openSlug && (
        <div className="skill-store-detail" role="dialog" aria-label="技能详情">
          <header className="skill-store-detail-head">
            <strong>{skillStore.detail?.name ?? openSlug}</strong>
            <button className="icon-button" type="button" data-control="skill-store-close-detail" aria-label="关闭详情" onClick={() => { setOpenSlug(undefined); setPendingInstall(undefined); patch({ detail: undefined, detailReadme: undefined, detailError: undefined }); }}><X size={14} /></button>
          </header>
          <div className="skill-store-detail-body">
            {skillStore.detailLoading && <p className="resource-empty">正在读取详情…</p>}
            {skillStore.detailError && <p className="form-error skill-store-error">{skillStore.detailError}</p>}
            {skillStore.detail && (
              <>
                <p className="skill-store-detail-summary">{skillStore.detail.descriptionZh ?? skillStore.detail.description}</p>
                <dl className="skill-store-facts">
                  <dt>来源</dt><dd>{skillStore.detail.publisherName ?? skillStore.detail.ownerName ?? "未知"}{skillStore.detail.canonicalName ? ` · ${skillStore.detail.canonicalName}` : ""}</dd>
                  <dt>版本</dt><dd>{skillStore.detail.latestVersion?.version ?? skillStore.detail.version ?? "—"}</dd>
                  <dt>文件</dt><dd>{skillStore.detailFiles.length} 个 · {formatBytes(skillStore.detailTotalBytes)}{skillStore.detailFiles.some((file) => file.size > 1024 * 1024) ? " · 含超过 1MB 的大文件，面板不支持安装" : ""}</dd>
                  <dt>分类</dt><dd>{categoryLabel(context.categories, skillStore.detail.category) ?? "—"}</dd>
                  <dt>风险</dt><dd>{skillStore.detail.requiresApiKey ? "需要 API Key（安装后另配密钥）" : "无额外 API Key 要求"}{skillStore.detail.securityStatusText ? ` · ${skillStore.detail.securityStatusText}` : ""}</dd>
                  <dt>安装态</dt><dd>{detailInstall ? `已安装（${detailInstall.version}，${detailInstall.scope === "project" ? "当前项目" : "用户全局"}）${skillStore.detail.latestVersion && detailInstall.version !== skillStore.detail.latestVersion.version ? " · 有更新" : ""}` : "未安装"}</dd>
                </dl>
                {skillStore.detailVersions.length > 1 && (
                  <details className="skill-store-versions">
                    <summary>历史版本（{skillStore.detailVersions.length}）</summary>
                    <ul>
                      {skillStore.detailVersions.slice(0, 10).map((version) => <li key={version.version}><strong>{version.version}</strong>{version.changelog ? ` · ${version.changelog}` : ""}</li>)}
                    </ul>
                  </details>
                )}
                <details className="skill-store-files">
                  <summary>文件清单（{skillStore.detailFiles.length}）</summary>
                  <ul>
                    {skillStore.detailFiles.slice(0, 80).map((file) => <li key={file.path}><code>{file.path}</code><span>{formatBytes(file.size)}</span></li>)}
                  </ul>
                  {skillStore.detailFiles.length > 80 && <small>仅显示前 80 个文件…</small>}
                </details>
                {skillStore.detailReadme && (
                  <details className="skill-store-readme">
                    <summary>SKILL.md 预览</summary>
                    <pre>{skillStore.detailReadme.slice(0, 6000)}</pre>
                  </details>
                )}
                {pendingInstall ? (
                  <div className="skill-store-confirm" role="group" aria-label="安装确认">
                    <p><strong>确认安装 {pendingInstall.name}</strong></p>
                    <ul>
                      <li>来源：{skillStore.detail.publisherName ?? skillStore.detail.ownerName ?? "未知"}{skillStore.detail.canonicalName ? `（${skillStore.detail.canonicalName}）` : ""}</li>
                      <li>版本：{skillStore.detail.latestVersion?.version ?? skillStore.detail.version ?? "—"}</li>
                      <li>文件：{skillStore.detailFiles.length} 个 · 合计 {formatBytes(skillStore.detailTotalBytes)}</li>
                      <li>作用域：{scope === "project" ? "仅当前项目 .pidesktop-skills/" : "用户全局 pidesktop-skills/"}</li>
                      <li>风险：{skillStore.detail.requiresApiKey ? "需要 API Key" : "无需 API Key"}；安装只落盘，不执行包内代码</li>
                    </ul>
                    <div className="skill-store-confirm-actions">
                      <button className="secondary-button compact-button" type="button" onClick={() => setPendingInstall(undefined)}>取消</button>
                      <button className="primary-button compact-button" type="button" data-control="skill-store-confirm-install" disabled={Boolean(skillStore.installing)} onClick={() => sendInstall(pendingInstall, Boolean(detailInstall))}>{skillStore.installing ? "安装中…" : detailInstall ? "覆盖安装" : "确认安装"}</button>
                    </div>
                  </div>
                ) : (
                  <div className="skill-store-detail-actions">
                    <button
                      className="primary-button compact-button"
                      type="button"
                      data-control="skill-store-install"
                      disabled={Boolean(skillStore.installing)}
                      onClick={() => setPendingInstall(skillStore.detail)}
                    ><Download size={13} />{skillStore.installing ? `正在安装 ${skillStore.installing.slug}…` : detailInstall ? "覆盖安装" : "安装"}</button>
                    {detailInstall && (
                      <button
                        className="secondary-button compact-button skill-store-uninstall"
                        type="button"
                        data-control="skill-store-uninstall"
                        disabled={Boolean(skillStore.installing)}
                        onClick={() => {
                          if (!window.confirm(`卸载 ${detailInstall.slug}（${detailInstall.scope === "project" ? "当前项目" : "用户全局"}）？只删除本商店安装的目录，其他同名技能不受影响。`)) return;
                          const requestId = newRequestId();
                          patch({ installing: { requestId, slug: detailInstall.slug }, lastInstall: undefined });
                          void window.piDesktop.send({ type: "skill-store.uninstall", requestId, slug: detailInstall.slug, scope: detailInstall.scope });
                        }}
                      ><Trash2 size={13} />卸载</button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 技能卡片（网格单元）；点整卡开详情。 */
function SkillCard({ skill, installs, categories, onOpen }: { skill: SkillStoreSkill; installs: SkillStoreInstallSummary[]; categories: SkillStoreCategory[]; onOpen: (skill: SkillStoreSkill) => void }): ReactNode {
  const installed = installs.find((record) => record.slug === skill.slug);
  const hasUpdate = Boolean(installed && skill.version && installed.version !== skill.version);
  return (
    <button type="button" className="skill-store-card" data-control="skill-store-open" data-skill-slug={skill.slug} onClick={() => onOpen(skill)}>
      <span className="skill-store-card-icon">
        {skill.iconUrl ? <img src={skill.iconUrl} alt="" loading="lazy" onError={(event) => { (event.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} /> : <span className="skill-store-card-icon-fallback">{skill.name.slice(0, 1)}</span>}
      </span>
      <span className="skill-store-card-main">
        <span className="skill-store-card-title">
          <strong>{skill.name}</strong>
          {installed && <em className={`skill-store-badge${hasUpdate ? " update" : ""}`}>{hasUpdate ? "有更新" : "已安装"}</em>}
          {skill.requiresApiKey && <em className="skill-store-badge risk">需要 API Key</em>}
          {skill.pricingType === "paid" && <em className="skill-store-badge risk">付费</em>}
        </span>
        <span className="skill-store-card-desc">{skill.descriptionZh ?? skill.description ?? "无描述"}</span>
        <span className="skill-store-card-meta">
          {skill.ownerName ? `${skill.ownerName} · ` : ""}{skill.category ? `${categoryLabel(categories, skill.category)} · ` : ""}{skill.version ? `v${skill.version} · ` : ""}下载 {formatCount(skill.downloads)} · 收藏 {formatCount(skill.stars)}
        </span>
      </span>
    </button>
  );
}
