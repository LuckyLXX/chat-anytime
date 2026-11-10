import { Download, Search, ShieldAlert, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  RuntimeCommand,
  SkillStoreCategory,
  SkillStoreInstallSummary,
  SkillStoreSkill,
  SkillStoreSort,
  SkillStoreSource
} from "../../../shared/protocol";
import type { SkillStoreState } from "../store";

/**
 * 商店浏览/安装的共用面板（公开 SkillHub 与内网 LanSkills 共用一套 UI）。
 *
 * 两个来源只在三处不同：命令里的 `source`、排序选项（内网没有下载/评分维度）、
 * 是否显示「热门 Top 50」。其余（搜索/分类/分页/详情抽屉/安装确认/卸载/错误内联）
 * 完全共用——这样修一次两边都生效，不会漂移。
 *
 * 主题钩子沿用 `skill-store-*`（两页同名，靠 data-pane 区分作用域）；
 * 各页自己的头部控件（刷新/作用域/地址配置）用所属 tab 的钩子。
 */

const PAGE_SIZE = 20;

/** 请求 id：列表/详情/安装并发时靠它认领结果（与公开商店同一套状态机）。 */
export function newStoreRequestId(): string {
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

function sourceLabel(source: SkillStoreSource): string {
  return source === "intranet" ? "内网 Skill 商店" : "公开 SkillHub";
}

export interface SkillStoreBrowserProps {
  source: SkillStoreSource;
  state: SkillStoreState;
  scope: "global" | "project";
  /** 该来源是否有「热门 Top 50」（内网商店没有）。 */
  showTop: boolean;
  sortOptions: { value: SkillStoreSort; label: string }[];
  defaultSort: SkillStoreSort;
  emptyHint: string;
  /** 外部触发刷新（头部刷新按钮 / 保存地址后）。值变化即重拉分类与列表。 */
  refreshTick: number;
  /** 把局部状态写回对应来源的状态切片（public → skillStore，intranet → intranetStore）。 */
  onPatch: (next: Partial<SkillStoreState>) => void;
}

export function SkillStoreBrowser({ source, state, scope, showTop, sortOptions, defaultSort, emptyHint, refreshTick, onPatch }: SkillStoreBrowserProps): ReactNode {
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [sortBy, setSortBy] = useState<SkillStoreSort>(defaultSort);
  const [page, setPage] = useState(1);
  const [openSlug, setOpenSlug] = useState<string>();
  const [pendingInstall, setPendingInstall] = useState<SkillStoreSkill>();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const patch = useCallback((next: Partial<SkillStoreState>) => onPatch(next), [onPatch]);

  const fetchList = useCallback((next?: { keyword?: string; category?: string; sortBy?: SkillStoreSort; order?: "asc" | "desc"; page?: number }) => {
    const requestId = newStoreRequestId();
    const query = {
      keyword: next?.keyword ?? keyword,
      category: next?.category ?? category,
      sortBy: next?.sortBy ?? sortBy,
      order: next?.order ?? "desc" as const,
      page: next?.page ?? page,
      pageSize: PAGE_SIZE
    };
    patch({ listRequestId: requestId, listLoading: true, listError: undefined, listQuery: query });
    void window.piDesktop.send({ type: "skill-store.list", requestId, source, query });
  }, [category, keyword, page, patch, sortBy, source]);

  const fetchCategories = useCallback(() => {
    patch({ categoriesLoading: true });
    void window.piDesktop.send({ type: "skill-store.categories", requestId: newStoreRequestId(), source });
  }, [patch, source]);

  // 首屏 / 外部刷新：分类 + 列表各拉一次（分类是运行时字典，不硬编码）。
  useEffect(() => {
    fetchCategories();
    fetchList({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  // 关键词 300ms 防抖（每次输入都打商店既慢又浪费配额）。
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
    const requestId = newStoreRequestId();
    setOpenSlug(skill.slug);
    setPendingInstall(undefined);
    patch({ detailRequestId: requestId, detailLoading: true, detail: undefined, detailVersions: [], detailFiles: [], detailTotalBytes: 0, detailReadme: undefined, detailError: undefined });
    void window.piDesktop.send({ type: "skill-store.detail", requestId, source, slug: skill.slug });
  }, [patch, source]);

  const sendInstall = useCallback((skill: SkillStoreSkill, confirmReplace: boolean) => {
    const requestId = newStoreRequestId();
    patch({ installing: { requestId, slug: skill.slug }, lastInstall: undefined });
    void window.piDesktop.send({ type: "skill-store.install", requestId, source, slug: skill.slug, scope, ...(confirmReplace ? { confirmReplace: true } : {}) });
  }, [patch, scope, source]);

  const context = useMemo(() => ({
    categories: state.categories,
    installs: state.installs.filter((record) => record.sourceId === source)
  }), [source, state.categories, state.installs]);

  // 同名技能可能被另一个来源装过：徽标不算它，但详情里要提示（安装会因异源冲突被拒）。
  const otherSourceInstall = useCallback((slug: string): SkillStoreInstallSummary | undefined => (
    state.installs.find((record) => record.slug === slug && record.sourceId !== source)
  ), [source, state.installs]);

  const detailInstall = state.detail ? state.installs.find((record) => record.slug === state.detail?.slug && record.scope === scope && record.sourceId === source) : undefined;
  const otherInstallOfDetail = state.detail ? otherSourceInstall(state.detail.slug) : undefined;
  const pageCount = Math.max(1, Math.ceil(state.listTotal / PAGE_SIZE));

  return (
    <>
      <p className="skill-store-notice">
        <ShieldAlert size={13} />
        <span>技能包来自{source === "intranet" ? "内网商店" : "第三方"}，安装<strong>只落盘不执行</strong>；包内脚本由模型后续按需读取。安装前请查看文件清单与 SKILL.md 预览，自行判断安全性。</span>
      </p>

      <section className="resource-card" aria-label="浏览与搜索">
        <div className="resource-card-head">
          <span className="resource-card-title"><Search size={14} /><strong>浏览</strong></span>
          <small>{source === "intranet" ? "搜索走内网商店接口；分类字典由服务端聚合" : "搜索走 SkillHub 公开接口；分类字典运行时拉取"}</small>
          <span className="resource-card-actions">
            <small className="resource-card-count">{state.listLoading ? "加载中…" : `${state.listTotal} 个结果`}</small>
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
                disabled={state.categoriesLoading}
                onChange={(event) => { setCategory(event.target.value); setPage(1); fetchList({ category: event.target.value, page: 1 }); }}
              >
                <option value="">全部分类</option>
                {state.categories.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
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
                {sortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            {showTop && (
              <button
                className="secondary-button compact-button"
                type="button"
                data-control="skill-store-top"
                onClick={() => {
                  patch({ topLoading: true, topError: undefined });
                  void window.piDesktop.send({ type: "skill-store.top", requestId: newStoreRequestId(), source });
                }}
              >热门 Top 50</button>
            )}
          </div>
          {state.listError && <p className="form-error skill-store-error">{state.listError}</p>}
          {state.topError && <p className="form-error skill-store-error">热门榜：{state.topError}</p>}
          <div className="skill-store-pager" data-control="skill-store-page">
            <button className="secondary-button compact-button" type="button" disabled={page <= 1 || state.listLoading} onClick={() => { const next = page - 1; setPage(next); fetchList({ page: next }); }}>上一页</button>
            <small>第 {page} / {pageCount} 页</small>
            <button className="secondary-button compact-button" type="button" disabled={page >= pageCount || state.listLoading} onClick={() => { const next = page + 1; setPage(next); fetchList({ page: next }); }}>下一页</button>
          </div>
        </div>
      </section>

      {showTop && state.topSkills.length > 0 && <section className="resource-card" aria-label="热门 Top 50">
        <div className="resource-card-head">
          <span className="resource-card-title"><Download size={14} /><strong>热门 Top 50</strong></span>
          <small>{state.topLoading ? "加载中…" : "按下载量排序"}</small>
        </div>
        <div className="resource-card-body">
          <div className="skill-store-grid">
            {state.topSkills.map((skill) => <SkillCard key={`top-${skill.slug}`} skill={skill} installs={context.installs} categories={context.categories} onOpen={openDetail} />)}
          </div>
        </div>
      </section>}

      <section className="resource-card" aria-label="技能列表">
        <div className="resource-card-head">
          <span className="resource-card-title"><Search size={14} /><strong>{state.listLoading ? "正在加载…" : "搜索结果"}</strong></span>
          <small>{sourceLabel(source)}</small>
        </div>
        <div className="resource-card-body">
          {!state.listLoading && state.listSkills.length === 0 && !state.listError
            ? <p className="resource-empty">{emptyHint}</p>
            : (
              <div className="skill-store-grid">
                {state.listSkills.map((skill) => <SkillCard key={skill.slug} skill={skill} installs={context.installs} categories={context.categories} onOpen={openDetail} />)}
              </div>
            )}
        </div>
      </section>

      {state.lastInstall && (
        <p className={`skill-store-result${state.lastInstall.ok ? " ok" : " error"}`} role="status">
          {state.lastInstall.ok ? "✓" : "✕"} {state.lastInstall.ok ? state.lastInstall.message : `${state.lastInstall.slug ? `${state.lastInstall.slug}：` : ""}${state.lastInstall.message}`}
          {state.lastInstall.installDir && <em> · {state.lastInstall.installDir}</em>}
        </p>
      )}

      {openSlug && (
        <div className="skill-store-detail" role="dialog" aria-label="技能详情">
          <header className="skill-store-detail-head">
            <strong>{state.detail?.name ?? openSlug}</strong>
            <button className="icon-button" type="button" data-control="skill-store-close-detail" aria-label="关闭详情" onClick={() => { setOpenSlug(undefined); setPendingInstall(undefined); patch({ detail: undefined, detailReadme: undefined, detailError: undefined }); }}><X size={14} /></button>
          </header>
          <div className="skill-store-detail-body">
            {state.detailLoading && <p className="resource-empty">正在读取详情…</p>}
            {state.detailError && <p className="form-error skill-store-error">{state.detailError}</p>}
            {state.detail && (
              <>
                <p className="skill-store-detail-summary">{state.detail.descriptionZh ?? state.detail.description}</p>
                <dl className="skill-store-facts">
                  <dt>来源</dt><dd>{state.detail.publisherName ?? state.detail.ownerName ?? sourceLabel(source)}{state.detail.canonicalName ? ` · ${state.detail.canonicalName}` : ""}</dd>
                  <dt>版本</dt><dd>{state.detail.latestVersion?.version ?? state.detail.version ?? "—"}</dd>
                  <dt>文件</dt><dd>{state.detailFiles.length} 个 · {formatBytes(state.detailTotalBytes)}{state.detailFiles.some((file) => file.size > 1024 * 1024) ? " · 含超过 1MB 的大文件，面板不支持安装" : ""}</dd>
                  <dt>分类</dt><dd>{categoryLabel(context.categories, state.detail.category) ?? "—"}</dd>
                  <dt>风险</dt><dd>{state.detail.requiresApiKey ? "需要 API Key（安装后另配密钥）" : "无额外 API Key 要求"}{state.detail.securityStatusText ? ` · ${state.detail.securityStatusText}` : ""}</dd>
                  <dt>安装态</dt><dd>{detailInstall ? `已安装（${detailInstall.version}，${detailInstall.scope === "project" ? "当前项目" : "用户全局"}）${state.detail.latestVersion && detailInstall.version !== state.detail.latestVersion.version ? " · 有更新" : ""}` : "未安装"}</dd>
                </dl>
                {otherInstallOfDetail && (
                  <p className="skill-store-result error">同名目录已由「{sourceLabel(otherInstallOfDetail.sourceId ?? "public")}」安装；本次安装会因异源冲突被拒绝，请先在对应商店卸载。</p>
                )}
                {state.detailVersions.length > 1 && (
                  <details className="skill-store-versions">
                    <summary>历史版本（{state.detailVersions.length}）</summary>
                    <ul>
                      {state.detailVersions.slice(0, 10).map((version) => <li key={version.version}><strong>{version.version}</strong>{version.changelog ? ` · ${version.changelog}` : ""}</li>)}
                    </ul>
                  </details>
                )}
                <details className="skill-store-files">
                  <summary>文件清单（{state.detailFiles.length}）</summary>
                  <ul>
                    {state.detailFiles.slice(0, 80).map((file) => <li key={file.path}><code>{file.path}</code><span>{formatBytes(file.size)}</span></li>)}
                  </ul>
                  {state.detailFiles.length > 80 && <small>仅显示前 80 个文件…</small>}
                </details>
                {state.detailReadme && (
                  <details className="skill-store-readme">
                    <summary>SKILL.md 预览</summary>
                    <pre>{state.detailReadme.slice(0, 6000)}</pre>
                  </details>
                )}
                {pendingInstall ? (
                  <div className="skill-store-confirm" role="group" aria-label="安装确认">
                    <p><strong>确认安装 {pendingInstall.name}</strong></p>
                    <ul>
                      <li>来源：{state.detail.publisherName ?? state.detail.ownerName ?? sourceLabel(source)}{state.detail.canonicalName ? `（${state.detail.canonicalName}）` : ""}</li>
                      <li>版本：{state.detail.latestVersion?.version ?? state.detail.version ?? "—"}</li>
                      <li>文件：{state.detailFiles.length} 个 · 合计 {formatBytes(state.detailTotalBytes)}</li>
                      <li>作用域：{scope === "project" ? "仅当前项目 .pidesktop-skills/" : "用户全局 pidesktop-skills/"}</li>
                      <li>风险：{state.detail.requiresApiKey ? "需要 API Key" : "无需 API Key"}；安装只落盘，不执行包内代码</li>
                    </ul>
                    <div className="skill-store-confirm-actions">
                      <button className="secondary-button compact-button" type="button" onClick={() => setPendingInstall(undefined)}>取消</button>
                      <button className="primary-button compact-button" type="button" data-control="skill-store-confirm-install" disabled={Boolean(state.installing)} onClick={() => sendInstall(pendingInstall, Boolean(detailInstall))}>{state.installing ? "安装中…" : detailInstall ? "覆盖安装" : "确认安装"}</button>
                    </div>
                  </div>
                ) : (
                  <div className="skill-store-detail-actions">
                    <button
                      className="primary-button compact-button"
                      type="button"
                      data-control="skill-store-install"
                      disabled={Boolean(state.installing)}
                      onClick={() => setPendingInstall(state.detail)}
                    ><Download size={13} />{state.installing ? `正在安装 ${state.installing.slug}…` : detailInstall ? "覆盖安装" : "安装"}</button>
                    {detailInstall && (
                      <button
                        className="secondary-button compact-button skill-store-uninstall"
                        type="button"
                        data-control="skill-store-uninstall"
                        disabled={Boolean(state.installing)}
                        onClick={() => {
                          if (!window.confirm(`卸载 ${detailInstall.slug}（${detailInstall.scope === "project" ? "当前项目" : "用户全局"}）？只删除本商店安装的目录，其他同名技能不受影响。`)) return;
                          const requestId = newStoreRequestId();
                          patch({ installing: { requestId, slug: detailInstall.slug }, lastInstall: undefined });
                          void window.piDesktop.send({ type: "skill-store.uninstall", requestId, source, slug: detailInstall.slug, scope: detailInstall.scope } satisfies RuntimeCommand);
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
    </>
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
          {skill.ownerName ? `${skill.ownerName} · ` : ""}{skill.category ? `${categoryLabel(categories, skill.category)} · ` : ""}{skill.version ? `v${skill.version} · ` : ""}{skill.downloads > 0 ? `下载 ${formatCount(skill.downloads)} · ` : ""}{skill.stars > 0 ? `收藏 ${formatCount(skill.stars)}` : ""}
        </span>
      </span>
    </button>
  );
}
