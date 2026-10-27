import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { SessionSearchHit } from "../../../shared/protocol";
import { filterPaletteActions, groupPaletteActions, type PaletteAction } from "../lib/command-palette";
import { highlightSnippet } from "./SessionSearchResults";

/**
 * 命令面板：Ctrl/Cmd+K 呼出，输入过滤，↑↓ 选择，Enter 执行，Esc 关闭。
 *
 * 两种模式（「两段式」会话检索）：
 * - commands：过滤动作表；查询非空时列表**最后一行**永远是「搜索会话内容：<查询>」，
 *   所以输入一句历史对话不会落到「没有匹配的动作」。
 * - sessions：回车那一行后面板不关闭，原地变成会话全文检索结果；再回车打开会话并
 *   定位到那条消息，Esc 退回命令列表（不是关闭面板）。
 *
 * 动作由 App 构造并通过 props 传入（闭包里是真实的 App 状态与命令），
 * 检索结果同样由 App 从 store 传入（`sessionSearch`），面板只负责展示与键盘导航；
 * 过滤/分组在 lib/command-palette.ts 里可单测。打开时重置查询、选中项与模式；
 * 禁用动作可见但不可执行（保留「为什么不可用」的上下文）。
 */

/** 会话检索的最短查询长度：与侧栏检索（App 内的防抖 effect）保持同一口径。 */
export const PALETTE_SEARCH_MIN_CHARS = 2;

/** 面板内的会话检索结果（App 从 store 的 `paletteSearch` 切片传入）。 */
export interface PaletteSessionSearchState {
  query: string;
  hits: readonly SessionSearchHit[];
  loading: boolean;
  scanned?: number;
  total?: number;
  error?: string;
}

type PaletteMode = "commands" | "sessions";

export function CommandPalette({ open, actions, onClose, sessionSearch, agents, onSearchQueryChange, onOpenHit }: {
  open: boolean;
  actions: readonly PaletteAction[];
  onClose(): void;
  sessionSearch?: PaletteSessionSearchState;
  /** 助手清单（settings.agents）：命中行上的助手徽标由本组件解析显示名。 */
  agents?: readonly { id: string; name: string; archived?: boolean }[];
  /** 检索模式下的查询推送（App 据此防抖发 `session.search`）；离开模式/关面板推空串。 */
  onSearchQueryChange?(query: string): void;
  onOpenHit?(hit: SessionSearchHit): void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<PaletteMode>("commands");
  const [activeIndex, setActiveIndex] = useState(0);
  const [hitIndex, setHitIndex] = useState(0);
  const agentNames = useMemo<Record<string, string>>(
    () => Object.fromEntries((agents ?? []).map((agent) => [agent.id, agent.archived ? `${agent.name}（已归档）` : agent.name])),
    [agents]
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const trimmed = query.trim();
  const filtered = useMemo(() => filterPaletteActions(actions, query), [actions, query]);
  // 非空查询时永远垫一条会话检索入口：分组名不在 PALETTE_GROUP_ORDER 里，
  // groupPaletteActions 会把它追加到最后（键盘导航同样能走到）。
  const searchEntry = useMemo<PaletteAction | undefined>(() => (mode === "commands" && trimmed
    ? { id: "session.search.query", title: `搜索会话内容：${trimmed}`, group: "会话检索", enterSearch: true }
    : undefined), [mode, trimmed]);
  const groups = useMemo(() => {
    const base = groupPaletteActions(filtered);
    return searchEntry ? [...base, { title: "会话检索", actions: [searchEntry] }] : base;
  }, [filtered, searchEntry]);
  const flat = useMemo(() => groups.flatMap((group) => group.actions), [groups]);
  // 选中项重置只跟随「用户输入的查询 / 模式」：App 每次重渲染都会送来新的 actions
  // 数组（flat 随之换身份），若 effect 依赖 flat，侧栏任何状态变化都会把选中项弹回第一条。
  const flatRef = useRef(flat);
  flatRef.current = flat;

  const hits = sessionSearch?.hits ?? [];
  const searchQuery = (sessionSearch?.query ?? "").trim();
  // 就绪与否看**输入框里**的字数（立即可用），结果是否属于当前查询看 App 推回
  // 的 sessionSearch.query——两者不一致的那一小段（防抖 + IPC 往返）按「搜索中」
  // 处理，绝不把上一查的命中或空结果当成这一查的答案。
  const searchReady = trimmed.length >= PALETTE_SEARCH_MIN_CHARS;
  const searchSynced = searchQuery === trimmed;
  const searchLoading = (!searchSynced && searchReady) || sessionSearch?.loading === true;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setMode("commands");
    setActiveIndex(0);
    setHitIndex(0);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // 查询推给 App 的时机：只有检索模式下才推（命令模式下不打断侧栏检索，
  // 也不让每次输入都跑一遍全文检索）；离开检索模式/关闭面板推空串。
  // onSearchQueryChange 必须是稳定身份（App 传 useState setter），否则本 effect 会自激。
  useEffect(() => {
    if (open && mode === "sessions") onSearchQueryChange?.(query);
    else onSearchQueryChange?.("");
  }, [open, mode, query, onSearchQueryChange]);

  useEffect(() => {
    // 首个可用动作：结果第一条可能是禁用项（例如无工作区时的「新建话题」）；
    // 命令全不匹配时 filtered 为空，此时第一条就是会话检索入口。
    const list = flatRef.current;
    const firstEnabled = list.findIndex((action) => !action.disabled);
    setActiveIndex(firstEnabled >= 0 ? firstEnabled : 0);
  }, [query, mode]);

  // 检索模式下查询变化/结果变化都回到第一条命中，避免沿用上一轮的索引。
  useEffect(() => {
    setHitIndex(0);
  }, [mode, searchQuery]);

  // 选中项滚进视口：结果多时键盘导航不会把选中行推到面板外。
  useEffect(() => {
    if (!open) return;
    const selector = mode === "sessions"
      ? `[data-palette-hit="${String(hitIndex)}"]`
      : `[data-palette-index="${String(activeIndex)}"]`;
    panelRef.current?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, hitIndex, mode, open]);

  if (!open) return null;

  function enterSearchMode(): void {
    setMode("sessions");
    setHitIndex(0);
    // 查询保留：动态入口把用户刚打的字直接带进检索。
  }

  function run(action: PaletteAction): void {
    if (action.disabled) return;
    if (action.enterSearch) {
      enterSearchMode();
      return;
    }
    onClose();
    try {
      const result = action.run?.();
      if (result && typeof (result as Promise<void>).then === "function") void (result as Promise<void>).catch(() => undefined);
    } catch {
      // 动作自己负责把失败变成用户可见的提示；面板不为它兜底。
    }
  }

  function openHit(hit: SessionSearchHit | undefined): void {
    if (!hit) return;
    onClose();
    onOpenHit?.(hit);
  }

  function move(delta: number): void {
    if (mode === "sessions") {
      if (hits.length === 0) return;
      setHitIndex((current) => (current + delta + hits.length) % hits.length);
      return;
    }
    if (flat.length === 0) return;
    let next = activeIndex;
    for (let step = 0; step < flat.length; step += 1) {
      next = (next + delta + flat.length) % flat.length;
      if (!flat[next]?.disabled) {
        setActiveIndex(next);
        return;
      }
    }
  }

  function leaveSearchMode(): void {
    setMode("commands");
    setQuery("");
    setActiveIndex(0);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (mode === "sessions") openHit(hits[Math.min(hitIndex, hits.length - 1)]);
      else {
        const action = flat[activeIndex];
        if (action) run(action);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (mode === "sessions") leaveSearchMode();
      else onClose();
    }
  }

  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板" ref={panelRef}>
        <div className="command-palette-input-row">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={mode === "sessions"
              ? "搜索会话内容：标题与正文，至少 2 个字"
              : "输入动作名，例如「新建」「模型」「浅色」"}
            aria-label={mode === "sessions" ? "搜索会话内容" : "搜索命令"}
            spellCheck={false}
            onKeyDown={onKeyDown}
          />
          {mode === "sessions" ? <span className="command-palette-mode">会话检索</span> : null}
        </div>
        {mode === "sessions" ? (
          <div className="command-palette-list" role="listbox" aria-label="会话内容检索结果">
            <div className="command-palette-group-title">
              <span>消息内容</span>
              {searchReady
                ? <em>{searchLoading ? "搜索中…" : typeof sessionSearch?.scanned === "number" ? `${hits.length} 条 · 扫描 ${String(sessionSearch.scanned)} 个会话` : `${hits.length} 条`}</em>
                : null}
            </div>
            {!searchReady ? <p className="command-palette-status">输入至少 {PALETTE_SEARCH_MIN_CHARS} 个字开始检索会话内容（标题与正文）</p> : null}
            {sessionSearch?.error ? <p className="command-palette-empty">{sessionSearch.error}</p> : null}
            {searchReady && searchLoading && hits.length === 0 ? <p className="command-palette-status">搜索中…</p> : null}
            {searchReady && !searchLoading && !sessionSearch?.error && hits.length === 0 ? <p className="command-palette-empty">没有匹配的消息</p> : null}
            {hits.map((hit, index) => (
              <button
                key={`${hit.path}:${String(hit.timestamp)}:${hit.role}:${String(index)}`}
                type="button"
                role="option"
                aria-selected={index === hitIndex}
                className={`command-palette-item command-palette-hit${index === hitIndex ? " active" : ""}`}
                data-palette-hit={index}
                onMouseMove={() => setHitIndex(index)}
                onClick={() => openHit(hit)}
              >
                <span className="command-palette-hit-head">
                  <strong>{hit.title}</strong>
                  {agents ? <span className="command-palette-hit-agent" title={`助手：${agentNames[hit.agentId] ?? "已归档助手"}`}>{agentNames[hit.agentId] ?? "已归档助手"}</span> : null}
                  <em>{hit.role === "user" ? "你" : "助手"}</em>
                  {hit.archived ? <span className="command-palette-hit-archived">已归档</span> : null}
                </span>
                <span className="command-palette-hit-snippet">{highlightSnippet(hit.snippet, trimmed)}</span>
                <span className="command-palette-hit-meta" title={hit.workspace}>{hit.workspace}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="command-palette-list" role="listbox" aria-label="命令">
            {groups.map((group) => (
              <section className="command-palette-group" key={group.title}>
                <div className="command-palette-group-title">{group.title}</div>
                {group.actions.map((action) => {
                  const index = flat.indexOf(action);
                  return (
                    <button
                      key={action.id}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`command-palette-item${index === activeIndex ? " active" : ""}`}
                      data-palette-index={index}
                      disabled={action.disabled}
                      onMouseMove={() => { if (!action.disabled) setActiveIndex(index); }}
                      onClick={() => run(action)}
                    >
                      <span className="command-palette-item-title">{action.title}</span>
                      {action.hint ? <span className="command-palette-item-hint">{action.hint}</span> : null}
                    </button>
                  );
                })}
              </section>
            ))}
            {flat.length === 0 ? <p className="command-palette-empty">没有匹配的动作</p> : null}
          </div>
        )}
        <div className="command-palette-footer">
          <span>↑↓ 选择</span>
          {mode === "sessions"
            ? <><span>Enter 打开会话</span><span>Esc 返回命令</span></>
            : <><span>Enter 执行</span><span>Esc 关闭</span></>}
        </div>
      </div>
    </div>
  );
}
