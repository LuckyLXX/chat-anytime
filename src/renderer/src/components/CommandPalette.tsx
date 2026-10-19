import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { filterPaletteActions, groupPaletteActions, type PaletteAction } from "../lib/command-palette";

/**
 * 命令面板：Ctrl/Cmd+K 呼出，输入过滤，↑↓ 选择，Enter 执行，Esc 关闭。
 *
 * 动作由 App 构造并通过 props 传入（闭包里是真实的 App 状态与命令），
 * 组件本身只做展示与键盘导航；过滤/分组在 lib/command-palette.ts 里可单测。
 * 打开时重置查询与选中项；禁用动作可见但不可执行（保留「为什么不可用」的上下文）。
 */
export function CommandPalette({ open, actions, onClose }: {
  open: boolean;
  actions: readonly PaletteAction[];
  onClose(): void;
}): ReactNode {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => filterPaletteActions(actions, query), [actions, query]);
  const groups = useMemo(() => groupPaletteActions(filtered), [filtered]);
  const flat = useMemo(() => groups.flatMap((group) => group.actions), [groups]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    // 首个可用动作：结果第一条可能是禁用项（例如无工作区时的「新建话题」）。
    const firstEnabled = filtered.findIndex((action) => !action.disabled);
    setActiveIndex(firstEnabled >= 0 ? firstEnabled : 0);
    // filtered 由 query 派生，这里只在查询变化时重置选中项。
  }, [query]);

  // 选中项滚进视口：结果多时键盘导航不会把选中行推到面板外。
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>(`[data-palette-index="${String(activeIndex)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  if (!open) return null;

  function run(action: PaletteAction): void {
    if (action.disabled) return;
    onClose();
    try {
      const result = action.run();
      if (result && typeof (result as Promise<void>).then === "function") void (result as Promise<void>).catch(() => undefined);
    } catch {
      // 动作自己负责把失败变成用户可见的提示；面板不为它兜底。
    }
  }

  function move(delta: number): void {
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

  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="命令面板" ref={panelRef}>
        <div className="command-palette-input-row">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="输入动作名，例如「新建」「模型」「浅色」"
            aria-label="搜索命令"
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const action = flat[activeIndex];
                if (action) run(action);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
          />
        </div>
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
        <div className="command-palette-footer">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
