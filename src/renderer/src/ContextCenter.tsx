import { Boxes, ChevronRight, FileText, Gauge, Layers, MessageSquare, RefreshCw, Settings2, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ContextPromptBlock, ContextToolDeclaration, McpServerStatus } from "../../shared/protocol";
import { formatTokenCount } from "./lib/context-usage";
import {
  charCountLabel,
  compositionSegments,
  groupToolDeclarations,
  roleLabel,
  roleShare,
  tokenEstimateFromChars,
  toolExposureLabel,
  toolSourceLabel,
  usagePercentText
} from "./lib/context-inspection-view";
import { useDesktopStore } from "./store";

/**
 * 上下文中心（2026-11-13，用户「想增加一个页面查看当前会话的各个成分」）。
 *
 * 只读的会话成分说明书：占用总览 / 系统提示词 / 工具声明 / 资源注入 / 对话消息 /
 * 运行参数。数据来自按需命令 `session.inspect`（不进 50ms 状态帧），跟随焦点会话；
 * 打开、切会话、手动刷新、回合结束后各拉一次。
 *
 * 三条展示纪律（与主进程 context-inspection 的口径对齐）：
 * 1. 提示词与工具是会话实况（冻结），资源清单是当前配置——分别标注，不混为一谈；
 * 2. 每回合尾部注入是「下一回合将注入」，不进转录，单独成卡；
 * 3. 三段明细与占用总量不同源：条形图只在明细内部算占比，不宣称加总等于总量。
 */
export function ContextCenter({ onClose }: { onClose(): void }): ReactNode {
  const inspectionState = useDesktopStore((state) => state.contextInspection);
  const snapshot = useDesktopStore((state) => state.snapshot);
  const providers = useDesktopStore((state) => state.providers);
  const resources = useDesktopStore((state) => state.resources);
  const memoryTopics = useDesktopStore((state) => state.memory);

  const sessionId = snapshot.sessionId;
  /** 只认当前会话的数据：切会话的瞬间旧快照仍在 store 里，先当作没有。 */
  const inspection = inspectionState?.data && inspectionState.data.sessionId === sessionId ? inspectionState.data : undefined;
  const loading = inspectionState?.loading ?? false;
  const error = inspectionState?.error;

  const [active, setActive] = useState("overview");
  const [promptView, setPromptView] = useState<"split" | "full">("split");
  const [openBlocks, setOpenBlocks] = useState<Set<string>>(() => new Set());
  const [openTools, setOpenTools] = useState<Set<string>>(() => new Set());
  const [toolFilter, setToolFilter] = useState("all");
  const contentRef = useRef<HTMLDivElement>(null);
  const initialisedBlocksFor = useRef<string | undefined>(undefined);
  const previousBusy = useRef(snapshot.busy);

  const requestInspection = useCallback((targetSessionId: string) => {
    const requestId = `inspect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    useDesktopStore.setState((state) => {
      const previous = state.contextInspection;
      const keep = previous?.data?.sessionId === targetSessionId ? { data: previous.data, at: previous.at } : {};
      return { contextInspection: { requestId, sessionId: targetSessionId, loading: true, ...keep } };
    });
    void window.piDesktop.send({ type: "session.inspect", requestId, sessionId: targetSessionId }).catch((cause: unknown) => {
      useDesktopStore.setState((state) => state.contextInspection?.requestId === requestId
        ? {
            contextInspection: {
              ...state.contextInspection,
              loading: false,
              error: cause instanceof Error ? cause.message : "读取会话成分失败"
            }
          }
        : state);
    });
  }, []);

  const retry = useCallback(() => {
    if (sessionId) requestInspection(sessionId);
  }, [requestInspection, sessionId]);

  // 打开与切会话：各拉一次。
  useEffect(() => {
    if (sessionId) requestInspection(sessionId);
  }, [requestInspection, sessionId]);

  // 回合从「运行中」回到就绪后再拉一次：这一轮的消息/工具集已经稳定。
  useEffect(() => {
    const wasBusy = previousBusy.current;
    previousBusy.current = snapshot.busy;
    if (wasBusy && !snapshot.busy && sessionId) requestInspection(sessionId);
  }, [requestInspection, sessionId, snapshot.busy]);

  // 首个可读块默认展开一次；切会话时重来，之后尊重用户的展开状态。
  useEffect(() => {
    if (!inspection) return;
    if (initialisedBlocksFor.current === inspection.sessionId) return;
    initialisedBlocksFor.current = inspection.sessionId;
    const first = inspection.prompt.blocks.find((block) => block.present && block.text.length > 0)
      ?? inspection.prompt.blocks.find((block) => block.text.length > 0);
    setOpenBlocks(first ? new Set([first.id]) : new Set());
    setOpenTools(new Set());
    setToolFilter("all");
    setActive("overview");
    setPromptView("split");
  }, [inspection]);

  // 滚动高亮：happy-dom 里没有 IntersectionObserver 时直接跳过（页面仍可点导航）。
  useEffect(() => {
    const root = contentRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
        if (visible?.target.id) setActive(visible.target.id.replace(/^cc-section-/u, ""));
      },
      { root, threshold: [0.08, 0.4] }
    );
    for (const section of root.querySelectorAll(".context-center-section")) observer.observe(section);
    return () => observer.disconnect();
  }, [inspection, promptView]);

  const jumpTo = (id: string): void => {
    const root = contentRef.current;
    const target = document.getElementById(`cc-section-${id}`);
    if (!root || !target) return;
    setActive(id);
    const top = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 8;
    root.scrollTo?.({ top, behavior: "smooth" });
  };

  const usage = snapshot.contextUsage ?? inspection?.usage;
  const segments = compositionSegments(usage);
  const breakdownTotal = segments.reduce((sum, segment) => sum + segment.value, 0);
  const modelInfo = inspection?.model ?? snapshot.model;
  const providerName = modelInfo ? providers.find((provider) => provider.id === modelInfo.provider)?.name ?? modelInfo.provider : undefined;
  const modelId = modelInfo?.id;
  const sessionTitle = snapshot.sessions.find((session) => session.id === sessionId)?.title ?? "当前话题";
  const updatedAt = inspectionState?.at ?? inspection?.at;

  const promptChars = inspection?.prompt.text.length ?? 0;
  const promptTokens = tokenEstimateFromChars(promptChars);
  const toolTokens = inspection?.tools.declared.reduce((sum, tool) => sum + tool.tokens, 0) ?? 0;
  const messageTokens = inspection?.messages.byRole.reduce((sum, row) => sum + row.tokens, 0) ?? 0;
  const messageCount = inspection?.messages.total ?? 0;

  const groups = useMemo(() => groupToolDeclarations(inspection?.tools.declared ?? []), [inspection]);
  const visibleGroups = toolFilter === "all" ? groups : groups.filter((group) => group.id === toolFilter);
  const filters = [{ id: "all", label: `全部 ${inspection?.tools.declared.length ?? 0}` }, ...groups.map((group) => ({ id: group.id, label: `${group.label} ${group.tools.length}` }))];

  const memoryByLayer = useMemo(() => {
    const counts = { core: 0, standard: 0, archive: 0 };
    for (const topic of memoryTopics) counts[topic.layer ?? "standard"] += 1;
    return counts;
  }, [memoryTopics]);
  const enabledSkills = resources.skills.filter((skill) => skill.enabled);
  const enabledHooks = resources.hooks.filter((hook) => hook.enabled);

  const sections = useMemo(
    () => [
      { id: "overview", label: "占用总览", icon: Gauge, meta: usagePercentText(usage) },
      { id: "prompt", label: "系统提示词", icon: FileText, meta: inspection ? `~${formatTokenCount(promptTokens)}` : "—" },
      { id: "tools", label: "工具声明", icon: Wrench, meta: inspection ? `~${formatTokenCount(toolTokens)}` : "—" },
      { id: "resources", label: "资源注入", icon: Boxes, meta: "6 类" },
      { id: "messages", label: "对话消息", icon: MessageSquare, meta: inspection ? `~${formatTokenCount(messageTokens)}` : "—" },
      { id: "runtime", label: "运行参数", icon: Settings2, meta: inspection ? `${inspection.runtime.length} 项` : "—" }
    ],
    [inspection, messageTokens, promptTokens, toolTokens, usage]
  );

  function toggleBlock(id: string): void {
    setOpenBlocks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleTool(name: string): void {
    setOpenTools((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const presentBlocks = inspection?.prompt.blocks.filter((block) => block.present) ?? [];
  const absentBlocks = inspection?.prompt.blocks.filter((block) => !block.present && block.text.length > 0) ?? [];
  const blockMaxChars = Math.max(1, ...inspection?.prompt.blocks.map((block) => block.chars) ?? [1]);

  return (
    <section className="context-center" data-pane="context-center" aria-label="上下文中心">
      <header className="context-center-head">
        <span className="context-center-icon" aria-hidden="true"><Layers size={17} /></span>
        <div className="context-center-heading">
          <h2>上下文中心</h2>
          <p>
            <b>{sessionTitle}</b>
            {inspection ? ` · ${inspection.agentName}` : ""}
            {modelId ? ` · ${providerName ? `${providerName} ` : ""}${modelId}` : ""}
            {updatedAt ? ` · 更新于 ${new Date(updatedAt).toLocaleTimeString("zh-CN", { hour12: false })}` : ""}
          </p>
        </div>
        <div className="context-center-head-actions">
          <span className="context-center-auto" title="打开、切会话、手动刷新、回合结束后各拉一次；流式期间不重复请求">
            <i />
            回合结束后自动刷新
          </span>
          <button className="context-center-icon-btn" type="button" data-control="context-center-refresh" title="重新读取会话成分" aria-label="重新读取会话成分" onClick={retry} disabled={!sessionId || loading}>
            <RefreshCw size={14} className={loading ? "spinning" : undefined} />
          </button>
          <button className="context-center-icon-btn" type="button" data-control="context-center-close" title="关闭上下文中心" aria-label="关闭上下文中心" onClick={onClose}><X size={15} /></button>
        </div>
      </header>

      <div className="context-center-body">
        <nav className="context-center-nav" aria-label="上下文成分">
          <div className="context-center-nav-label">成分</div>
          {sections.map((section) => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                className={`context-center-nav-item${active === section.id ? " active" : ""}`}
                type="button"
                aria-current={active === section.id ? "true" : undefined}
                onClick={() => jumpTo(section.id)}
              >
                <Icon size={14} />
                <span>{section.label}</span>
                <em>{section.meta}</em>
              </button>
            );
          })}
          <div className="context-center-nav-foot">只读 · 不改会话<br />估算 ≈4 字符/token</div>
        </nav>

        <div className="context-center-content" ref={contentRef}>
          <div className="context-center-inner">
            {!sessionId ? (
              <div className="context-center-empty">
                <Layers size={22} />
                <strong>先打开一个话题</strong>
                <p>上下文中心按焦点会话读取成分：系统提示词、工具声明、资源注入、消息构成与运行参数。</p>
              </div>
            ) : !inspection ? (
              error ? (
                <div className="context-center-empty">
                  <X size={22} />
                  <strong>读不到会话成分</strong>
                  <p>{error}</p>
                  <button className="context-center-retry" type="button" onClick={retry}>重试</button>
                </div>
              ) : (
                <div className="context-center-loading"><RefreshCw size={16} className="spinning" />正在读取会话成分…</div>
              )
            ) : (
              <>
                {error && (
                  <div className="context-center-warning" role="status">
                    <span>刷新失败：{error}（当前显示上次快照）</span>
                    <button type="button" onClick={retry}>重试</button>
                  </div>
                )}
                {/* ── 占用总览 ─────────────────────────────── */}
                <section className="context-center-section" id="cc-section-overview">
                  <div className="context-center-usage">
                    <div className="context-center-usage-top">
                      <div>
                        <div className="context-center-usage-big">
                          <strong className="num">{usagePercentText(usage)}</strong>
                          <span>
                            {usage?.tokens == null
                              ? `窗口 ${formatTokenCount(usage?.contextWindow ?? 0)}`
                              : `≈${formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)} tokens`}
                          </span>
                        </div>
                        <div className="context-center-usage-sub">
                          {breakdownTotal > 0
                            ? `三段明细合计 ≈${formatTokenCount(breakdownTotal)} · 与占用总量不同源，差额来自图片与未计入的请求开销`
                            : "本轮还没有可用的明细估算"}
                        </div>
                      </div>
                      <div className="context-center-facts">
                        <div className="context-center-fact"><span>缓存命中</span><b>{usage?.cacheHitRate == null ? "—" : `${Math.round(usage.cacheHitRate * 10) / 10}%`}</b></div>
                        <div className="context-center-fact"><span>消息</span><b>{messageCount}</b></div>
                        <div className="context-center-fact"><span>工具</span><b>{inspection.tools.declared.length}</b></div>
                        <div className="context-center-fact"><span>图片</span><b>{inspection.messages.images}</b></div>
                      </div>
                    </div>
                    {segments.length > 0 && (
                      <>
                        <div className="context-center-usage-bar" role="img" aria-label={segments.map((segment) => `${segment.label} ${Math.round(segment.percent)}%`).join("，")}>
                          {segments.map((segment) => (
                            <i key={segment.id} className={`seg-${segment.id}`} style={{ width: `${Math.max(segment.percent, 0.6)}%` }} />
                          ))}
                        </div>
                        <div className="context-center-legend">
                          {segments.map((segment) => (
                            <span key={segment.id}><i className={`seg-${segment.id}`} />{segment.label} <b>~{formatTokenCount(segment.value)}</b></span>
                          ))}
                        </div>
                      </>
                    )}
                    <div className="context-center-note">
                      占用总量由 Pi 以最后一次真实 usage 为锚估算；三段明细是本地启发式（chars ÷ 4 + 工具包装开销），只在稳定边界重算，流式期间沿用上一帧。
                    </div>
                  </div>
                </section>

                {/* ── 系统提示词 ───────────────────────────── */}
                <section className="context-center-section" id="cc-section-prompt">
                  <div className="context-center-section-head">
                    <h3>系统提示词</h3>
                    <span className="context-center-section-meta">
                      {charCountLabel(promptChars)} · ~{formatTokenCount(promptTokens)} tokens · {inspection.prompt.sections.length + presentBlocks.length + (inspection.prompt.leading ? 1 : 0)} 个分段
                    </span>
                    <span className="context-center-section-right">
                      <span className="context-center-tag freeze">会话创建时冻结</span>
                      <span className="context-center-segmented" role="group" aria-label="提示词展示方式" data-control="context-center-prompt-view">
                        <button type="button" className={promptView === "split" ? "active" : ""} aria-pressed={promptView === "split"} onClick={() => setPromptView("split")}>分段</button>
                        <button type="button" className={promptView === "full" ? "active" : ""} aria-pressed={promptView === "full"} onClick={() => setPromptView("full")}>全文</button>
                      </span>
                    </span>
                  </div>

                  {promptView === "full" ? (
                    <div className="context-center-card">
                      <div className="context-center-card-head">
                        <div className="context-center-card-title"><h4>完整提示词</h4><p>模型实际拼接的样子（preamble + XML 分段，按出现顺序）</p></div>
                        <span className="context-center-card-size">~{formatTokenCount(promptTokens)} tok</span>
                      </div>
                      <pre className="context-center-pre context-center-pre-full">{inspection.prompt.text || "（本会话没有系统提示词）"}</pre>
                    </div>
                  ) : (
                    <>
                      {inspection.prompt.leading && (
                        <div className="context-center-card">
                          <div className="context-center-card-head">
                            <div className="context-center-card-title"><h4>基础提示词 / 未归因片段</h4><p>preamble 里不属于任何已知注入块的前导文本</p></div>
                            <span className="context-center-card-size">{charCountLabel(inspection.prompt.leading.chars)} · ~{formatTokenCount(tokenEstimateFromChars(inspection.prompt.leading.chars))}</span>
                          </div>
                          <pre className="context-center-pre">{inspection.prompt.leading.text}</pre>
                        </div>
                      )}
                      {presentBlocks.length > 0 && (
                        <div className="context-center-card">
                          <div className="context-center-card-head">
                            <div className="context-center-card-title"><h4>preamble 注入块</h4><p>按构建器标记切出的真实冻结文本；顺序即拼接顺序</p></div>
                            <button className="context-center-ghost" type="button" onClick={() => setOpenBlocks(openBlocks.size > 0 ? new Set() : new Set(presentBlocks.map((block) => block.id)))}>
                              {openBlocks.size > 0 ? "全部收起" : "全部展开"}
                            </button>
                          </div>
                          <div className="context-center-blocks">
                            {presentBlocks.map((block) => (
                              <PromptBlockRow key={block.id} block={block} maxChars={blockMaxChars} open={openBlocks.has(block.id)} onToggle={() => toggleBlock(block.id)} />
                            ))}
                          </div>
                        </div>
                      )}
                      {inspection.prompt.sections.map((section) => (
                        <div className="context-center-card" key={`section-${section.name}`}>
                          <div className="context-center-card-head">
                            <div className="context-center-card-title">
                              <h4>{section.name} <span className="context-center-tag">XML 分段</span></h4>
                              <p>{section.origin}</p>
                            </div>
                            <span className="context-center-card-size">{charCountLabel(section.chars)} · ~{formatTokenCount(tokenEstimateFromChars(section.chars))}</span>
                          </div>
                          <pre className="context-center-pre">{section.text}</pre>
                        </div>
                      ))}
                      {absentBlocks.length > 0 && (
                        <div className="context-center-card">
                          <div className="context-center-card-head">
                            <div className="context-center-card-title"><h4>本会话未注入</h4><p>当前配置里有、但会话创建时没进提示词（改配置要新会话才生效）</p></div>
                          </div>
                          <div className="context-center-blocks">
                            {absentBlocks.map((block) => (
                              <PromptBlockRow key={`absent-${block.id}`} block={block} maxChars={blockMaxChars} open={openBlocks.has(block.id)} onToggle={() => toggleBlock(block.id)} absent />
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="context-center-card">
                        <div className="context-center-card-head">
                          <div className="context-center-card-title">
                            <h4>每回合尾部注入 <span className="context-center-tag live">下一回合将注入</span></h4>
                            <p>由 before_agent_start 扩展追加到本次请求，不进转录、不动工具声明；文本不变时前缀缓存照常命中</p>
                          </div>
                        </div>
                        {inspection.prompt.turnInjections.map((entry) => (
                          <div className="context-center-inject" key={entry.label}>
                            <div className="context-center-inject-main">
                              <div className="context-center-inject-name">
                                <b>{entry.label}</b>
                                {entry.active ? <span className="context-center-tag live">生效</span> : <span className="context-center-tag">未注入</span>}
                              </div>
                              <p>{entry.origin}{entry.active && entry.text ? <><br /><span className="context-center-mono">{entry.text}</span></> : null}</p>
                            </div>
                            <span className="context-center-inject-size">{entry.active ? `${charCountLabel(entry.chars)} · ~${formatTokenCount(tokenEstimateFromChars(entry.chars))}` : "—"}</span>
                          </div>
                        ))}
                        <div className="context-center-note">计划模式叙事与钩子 additionalContext 走对话尾部，不进系统提示词。</div>
                      </div>
                      <div className="context-center-card">
                        <div className="context-center-card-head">
                          <div className="context-center-card-title"><h4>运行中追加的系统消息</h4><p>工具集变化时 Pi 会追加 system 消息补丁，同样占用上下文</p></div>
                        </div>
                        {inspection.prompt.extraSystemMessages.length === 0 ? (
                          <div className="context-center-empty-line">本会话没有追加的系统消息。</div>
                        ) : (
                          inspection.prompt.extraSystemMessages.map((entry, index) => (
                            <div className="context-center-inject" key={`extra-${index}`}>
                              <div className="context-center-inject-main"><p className="context-center-mono">{entry.preview}</p></div>
                              <span className="context-center-inject-size">{charCountLabel(entry.chars)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  )}
                  <div className="context-center-section-note">
                    ⓘ 分段来自会话转录里真实的 system 消息 sections（折叠后的当前状态），不是按当前配置重算；技能清单、子智能体清单与记忆索引在会话创建时冻结，之后新增要新会话才进提示词。
                  </div>
                </section>

                {/* ── 工具声明 ─────────────────────────────── */}
                <section className="context-center-section" id="cc-section-tools">
                  <div className="context-center-section-head">
                    <h3>工具声明</h3>
                    <span className="context-center-section-meta">
                      {inspection.tools.declared.length} 个声明 · ~{formatTokenCount(toolTokens)} tokens
                      {inspection.tools.undeclared.length > 0 ? ` · 另有 ${inspection.tools.undeclared.length} 个脚本可调未声明` : ""}
                    </span>
                    <span className="context-center-section-right"><span className="context-center-tag freeze">请求前缀 · tool 段</span></span>
                  </div>
                  <div className="context-center-filters" data-control="context-center-tool-filter">
                    {filters.map((filter) => (
                      <button key={filter.id} type="button" className={`context-center-filter${toolFilter === filter.id ? " active" : ""}`} aria-pressed={toolFilter === filter.id} onClick={() => setToolFilter(filter.id)}>
                        {filter.label}
                      </button>
                    ))}
                  </div>
                  {visibleGroups.length === 0 ? (
                    <div className="context-center-empty-line">本会话没有声明任何工具。</div>
                  ) : (
                    visibleGroups.map((group) => (
                      <div className="context-center-card context-center-tool-group" key={group.id}>
                        <div className="context-center-tool-group-head">
                          <b>{group.label}</b>
                          <span>{group.tools.length} 个</span>
                          <em>~{formatTokenCount(group.tokens)} tok</em>
                        </div>
                        <div className="context-center-tool-rows">
                          {group.tools.map((tool) => (
                            <ToolRow key={tool.name} tool={tool} open={openTools.has(tool.name)} onToggle={() => toggleTool(tool.name)} />
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                  {inspection.tools.undeclared.length > 0 && (
                    <div className="context-center-hidden">
                      <h4>已注册、未声明（不占前缀）</h4>
                      <p>这些工具不进入请求前缀，只从脚本里可调；主会话里模型看不到它们的 schema。</p>
                      <div className="context-center-hidden-list">
                        {inspection.tools.undeclared.map((tool) => (
                          <code key={tool.name} className="context-center-mono">{tool.name} · {toolExposureLabel(tool.exposure as ContextToolDeclaration["exposure"])}</code>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="context-center-section-note">
                    ⓘ token 估算 = 下发给模型的完整声明 JSON ÷ 4 + 4（函数包装开销）；清单取自 session.state.tools，即模型实际看到的声明，不是注册表全量。同名工具的 schema 或描述变化会重新估算。
                  </div>
                </section>

                {/* ── 资源注入 ─────────────────────────────── */}
                <section className="context-center-section" id="cc-section-resources">
                  <div className="context-center-section-head">
                    <h3>资源注入</h3>
                    <span className="context-center-section-meta">6 类 · 当前配置</span>
                    <span className="context-center-section-right"><span className="context-center-tag warn">仅技能 / 子智能体 / 记忆进提示词</span></span>
                  </div>
                  <div className="context-center-res-grid">
                    <div className="context-center-res-card">
                      <div className="context-center-res-head">
                        <h4>技能</h4><span>{enabledSkills.length} / {resources.skills.length} 启用</span>
                        <span className="context-center-res-badge"><span className="context-center-tag freeze">已注入提示词</span></span>
                      </div>
                      <div className="context-center-res-body">
                        {enabledSkills.length === 0 ? <div className="context-center-empty-line">没有启用的技能。</div> : enabledSkills.slice(0, 8).map((skill) => (
                          <div className="context-center-res-row" key={skill.id}>
                            <div><span className="context-center-res-name">{skill.name}</span><span className="context-center-res-desc">{skill.description}</span></div>
                            <span className="context-center-tag live">启用</span>
                          </div>
                        ))}
                        {enabledSkills.length > 8 && <div className="context-center-res-more">还有 {enabledSkills.length - 8} 个已启用技能…</div>}
                      </div>
                      <div className="context-center-res-foot">按助手 skillOverrides 过滤；清单在会话创建时写入 preamble，之后变更需新会话。</div>
                    </div>

                    <div className="context-center-res-card">
                      <div className="context-center-res-head">
                        <h4>子智能体</h4><span>{resources.subagents.length} 个</span>
                        <span className="context-center-res-badge"><span className="context-center-tag freeze">已注入提示词</span></span>
                      </div>
                      <div className="context-center-res-body">
                        {resources.subagents.length === 0 ? <div className="context-center-empty-line">没有可委派的子智能体。</div> : resources.subagents.slice(0, 8).map((entry) => (
                          <div className="context-center-res-row" key={entry.id}>
                            <div><span className="context-center-res-name">{entry.name}</span><span className="context-center-res-desc">{entry.description || "自定义子智能体"}</span></div>
                            {entry.color && <span className="context-center-tag">{entry.color}</span>}
                          </div>
                        ))}
                      </div>
                      <div className="context-center-res-foot">清单是 delegate_agent 的唯一合法取值；子代理会话不继承主会话的钩子与 MCP。</div>
                    </div>

                    <div className="context-center-res-card">
                      <div className="context-center-res-head">
                        <h4>钩子</h4><span>{enabledHooks.length} 条启用</span>
                        <span className="context-center-res-badge"><span className="context-center-tag live">运行期行为</span></span>
                      </div>
                      <div className="context-center-res-body">
                        {enabledHooks.length === 0 ? <div className="context-center-empty-line">没有启用的钩子。</div> : enabledHooks.slice(0, 8).map((hook) => (
                          <div className="context-center-res-row" key={`${hook.scope}:${hook.name}`}>
                            <div><span className="context-center-res-name">{hook.name}</span><span className="context-center-res-desc">{hook.event} · {hook.actionPreview}</span></div>
                            <span className="context-center-tag">{hook.blocking ? "拦截" : hook.scope}</span>
                          </div>
                        ))}
                      </div>
                      <div className="context-center-res-foot">钩子命令输出只有 additionalContext 通道能进对话尾部，永远不进系统提示词。</div>
                    </div>

                    <div className="context-center-res-card">
                      <div className="context-center-res-head">
                        <h4>MCP 服务</h4><span>{resources.mcpServers.length} 个</span>
                        <span className="context-center-res-badge"><span className="context-center-tag live">运行期行为</span></span>
                      </div>
                      <div className="context-center-res-body">
                        {resources.mcpServers.length === 0 ? <div className="context-center-empty-line">没有配置 MCP 服务。</div> : resources.mcpServers.map((server) => (
                          <div className="context-center-res-row" key={server.name}>
                            <div>
                              <span className="context-center-res-name">{server.name}</span>
                              <span className="context-center-res-desc">
                                {server.transport.toUpperCase()} · {server.exposure === "codemode" ? "脚本曝光" : "直连曝光"} · {server.toolCount} 个工具
                                {server.error ? ` · ${server.error}` : ""}
                              </span>
                            </div>
                            <span className={`context-center-tag${server.status === "connected" || server.status === "cached" ? " live" : server.disabled || server.status === "disabled" ? "" : " warn"}`}>
                              {server.disabled || server.status === "disabled" ? "已停用" : mcpStatusLabel(server.status)}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="context-center-res-foot">只展示名字、传输、曝光与工具数；headers / env / 凭据不下发到页面。</div>
                    </div>

                    <div className="context-center-res-card">
                      <div className="context-center-res-head">
                        <h4>斜杠命令</h4><span>{resources.commands.length} 个</span>
                        <span className="context-center-res-badge"><span className="context-center-tag">当前配置</span></span>
                      </div>
                      <div className="context-center-res-body">
                        {resources.commands.length === 0 ? <div className="context-center-empty-line">没有自定义命令。</div> : resources.commands.slice(0, 8).map((command) => (
                          <div className="context-center-res-row" key={command.name}>
                            <div><span className="context-center-res-name">/{command.name}</span><span className="context-center-res-desc">{command.description || "自定义命令"}</span></div>
                            <span className="context-center-tag">{command.scope}</span>
                          </div>
                        ))}
                      </div>
                      <div className="context-center-res-foot">命令是模板文件，不进提示词；输入 / 时才触发。</div>
                    </div>

                    <div className="context-center-res-card">
                      <div className="context-center-res-head">
                        <h4>长期记忆</h4><span>核心 {memoryByLayer.core} / 标准 {memoryByLayer.standard} / 归档 {memoryByLayer.archive}</span>
                        <span className="context-center-res-badge"><span className="context-center-tag freeze">已注入提示词</span></span>
                      </div>
                      <div className="context-center-res-body">
                        <div className="context-center-res-row"><div><span className="context-center-res-name">索引快照</span><span className="context-center-res-desc">会话创建时写入 preamble；正文不注入，模型按需 memory_read</span></div><span className="context-center-tag">冻结</span></div>
                        <div className="context-center-res-row"><div><span className="context-center-res-name">分层</span><span className="context-center-res-desc">核心常驻要点 · 标准按需查 · 归档不进索引</span></div><span className="context-center-tag">{memoryTopics.length} 个主题</span></div>
                      </div>
                      <div className="context-center-res-foot">记忆按助手分库；索引预算与条目见记忆中心。归档主题仍可检索，但不进模型索引。</div>
                    </div>
                  </div>
                  <div className="context-center-section-note">
                    ⓘ 资源清单来自当前配置（设置里改了立刻反映），但只有注入提示词的那部分冻结在会话里；钩子与 MCP 是运行期行为，不在提示词里。
                  </div>
                </section>

                {/* ── 对话消息 ─────────────────────────────── */}
                <section className="context-center-section" id="cc-section-messages">
                  <div className="context-center-section-head">
                    <h3>对话消息</h3>
                    <span className="context-center-section-meta">{messageCount} 条 · ~{formatTokenCount(messageTokens)} tokens</span>
                    <span className="context-center-section-right"><span className="context-center-tag">本地估算</span></span>
                  </div>
                  <div className="context-center-card">
                    <div className="context-center-msg-table">
                      <div className="context-center-msg-row head"><span>角色</span><span className="num">条数</span><span className="num">估算 tokens</span><span>占消息段</span></div>
                      {inspection.messages.byRole.map((row) => (
                        <div className="context-center-msg-row" key={row.role}>
                          <span><i className={`context-center-dot role-${row.role}`} />{roleLabel(row.role)}</span>
                          <span className="num">{row.count}</span>
                          <span className="num">{row.tokens.toLocaleString("en-US")}</span>
                          <span className="context-center-msg-bar"><i className={`role-${row.role}`} style={{ width: `${Math.max(roleShare(row.tokens, messageTokens), row.tokens > 0 ? 1 : 0)}%` }} /></span>
                        </div>
                      ))}
                    </div>
                    <div className="context-center-facts context-center-facts-inline">
                      <span className="context-center-tag">工具结果 {inspection.messages.byRole.find((row) => row.role === "toolResult")?.count ?? 0} 条</span>
                      <span className="context-center-tag">图片 {inspection.messages.images} 张</span>
                      <span className="context-center-tag">追加系统消息 {inspection.prompt.extraSystemMessages.length} 条</span>
                    </div>
                  </div>
                  <div className="context-center-card">
                    <div className="context-center-card-head">
                      <div className="context-center-card-title"><h4>谁在吃上下文</h4><p>按单条估算排序的前 5 条</p></div>
                    </div>
                    <div className="context-center-top-list">
                      {inspection.messages.top.map((entry, index) => (
                        <div className="context-center-top-row" key={`${entry.role}-${index}`}>
                          <span className="context-center-tag">{roleLabel(entry.role)}</span>
                          <span className="context-center-top-preview">{entry.preview}</span>
                          <span className="context-center-mono num">~{formatTokenCount(entry.tokens)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="context-center-section-note">
                    ⓘ 消息段复用 Pi 的 estimateTokens（与压缩阈值同口径）；首条系统消息携带系统提示词，Pi 的现有口径里它同时计入消息段，本页照实展示（不二次扣减）。图片只计数量，不展开 base64。
                  </div>
                </section>

                {/* ── 运行参数 ─────────────────────────────── */}
                <section className="context-center-section" id="cc-section-runtime">
                  <div className="context-center-section-head">
                    <h3>运行参数</h3>
                    <span className="context-center-section-meta">{inspection.runtime.length} 项 · 决定模型看到什么、能做什么</span>
                  </div>
                  <div className="context-center-card">
                    <div className="context-center-params">
                      {inspection.runtime.map((row) => (
                        <div className="context-center-param" key={row.label}>
                          <span>{row.label}</span>
                          <b>{row.value}{row.note ? <span className="context-center-param-note">{row.note}</span> : null}{row.frozen ? <span className="context-center-tag freeze">冻结</span> : null}</b>
                        </div>
                      ))}
                    </div>
                  </div>
                </section>

                <div className="context-center-foot">
                  ⓘ 只读视图 · 数据在打开页面与每次回合结束后按需拉取（不进入 50ms 状态帧）· 估算口径 ≈4 字符/token · 不展示密钥与请求头
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** MCP 连接态的中文标签（status 是 Pi 的状态板口径，不是 HTTP 状态码）。 */
function mcpStatusLabel(status: McpServerStatus): string {
  switch (status) {
    case "connected":
      return "已连接";
    case "cached":
      return "已缓存";
    case "failed":
      return "连接失败";
    case "needs-auth":
      return "需要认证";
    default:
      return "未连接";
  }
}

/** preamble 注入块：折叠展开 + 字数/token + 占比条。 */
function PromptBlockRow({ block, maxChars, open, onToggle, absent = false }: { block: ContextPromptBlock; maxChars: number; open: boolean; onToggle(): void; absent?: boolean }): ReactNode {
  return (
    <div className={`context-center-block${open ? " open" : ""}`}>
      <button className="context-center-block-head" type="button" aria-expanded={open} onClick={onToggle}>
        <span className="context-center-block-title">
          <b>{block.label}</b>
          {absent && <span className="context-center-tag warn">本会话未注入</span>}
          <span className="context-center-block-origin">{block.origin}</span>
        </span>
        <span className="context-center-block-bar" aria-hidden="true"><i style={{ width: `${Math.max(6, Math.round((block.chars / maxChars) * 100))}%` }} /></span>
        <span className="context-center-block-size">{charCountLabel(block.chars)} · ~{formatTokenCount(tokenEstimateFromChars(block.chars))}</span>
        <ChevronRight size={13} className="context-center-chev" />
      </button>
      {open && <pre className="context-center-pre context-center-block-text">{block.text || "（空）"}</pre>}
    </div>
  );
}

/** 工具声明行：描述 + 展开后的 schema / promptGuidelines。 */
function ToolRow({ tool, open, onToggle }: { tool: ContextToolDeclaration; open: boolean; onToggle(): void }): ReactNode {
  return (
    <div className={`context-center-tool${open ? " open" : ""}`}>
      <button className="context-center-tool-row" type="button" aria-expanded={open} onClick={onToggle}>
        <span className="context-center-tool-name context-center-mono">{tool.name}</span>
        <span className="context-center-tool-desc">
          {tool.description}
          {tool.guideline ? <span className="context-center-tag accent">promptGuideline</span> : null}
        </span>
        <span className="context-center-tool-tokens num">~{tool.tokens}</span>
        <ChevronRight size={12} className="context-center-chev" />
      </button>
      {open && (
        <div className="context-center-tool-detail">
          <p>{tool.description || "（没有描述）"}</p>
          <pre className="context-center-pre context-center-schema">{tool.parameters || "（没有参数 schema）"}</pre>
          <div className="context-center-tool-meta">
            <span>来源：{toolSourceLabel(tool.source)}</span>
            <span>曝光：{toolExposureLabel(tool.exposure)}</span>
            {tool.guideline ? <span>promptGuidelines：{tool.guideline}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}
