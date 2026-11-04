import { Check, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ModelOption, ProviderOption } from "../../../shared/protocol";
import { filterProviderModels } from "../lib/model-list";
import { MODEL_MENU_SEARCH_MIN, activeModelName, modelMenuPlacement, providerMenuEntries, type ModelMenuPlacement } from "../lib/model-menu";

/**
 * 输入框右下角的「模型快捷切换」菜单：两段式（供应商 → 模型）。
 *
 * 一级只有供应商行（展示名 + 当前模型名 / 模型数），点开某个供应商后在侧边展开
 * 二级面板列出它的模型；供应商下模型多（≥ MODEL_MENU_SEARCH_MIN）时二级顶部带
 * 搜索框（按名称或 ID 过滤）。原实现是一个按供应商分组的平铺列表——OpenRouter
 * 这类几百条模型的渠道只能靠滚动翻，故改成两级收窄。
 *
 * 交互与键盘（都在这一个组件内，父级只管开关 + 选中）：
 * - 点供应商打开二级；**已打开二级时**鼠标横移到另一个供应商直接切换（级联菜单惯例）；
 * - ↑/↓ 在当前层内移动焦点，→（或在供应商行上回车）打开二级，← 或 Esc 回到一级，
 *   一级再按 Esc 关闭整个菜单（用 stopPropagation 抢在父级 document 的 Esc 处理之前）；
 * - 打开二级时二级面板接管焦点（有搜索框就落在搜索框，否则第一条模型），鼠标打开则不抢焦点；
 * - 当前模型所在供应商高亮，二级里该模型带勾。
 *
 * 几何：二级面板优先向右展开，放不下翻到左侧，两侧都不放不下退化成单列（就地替换
 * 供应商列）——判定在 `model-menu.ts` 的纯函数里，本组件只负责量矩形。
 */
export function ModelMenu({
  models,
  providers,
  value,
  onSelect,
  onClose,
  rootRef
}: {
  /** 已按场景过滤好的可选模型（`selectableCatalogModels(models).filter(m => m.configured)`）。 */
  models: ModelOption[];
  providers: ProviderOption[];
  /** 当前值：「provider/id」；空串表示未选。 */
  value: string;
  onSelect(value: string): void;
  /** 一级菜单上按 Esc：关闭整个菜单（父级 setComposerMenu(undefined)）。 */
  onClose(): void;
  /** 弹层根节点（父级需要量几何或滚动时用；可选）。 */
  rootRef?: (element: HTMLDivElement | null) => void;
}): ReactNode {
  const entries = useMemo(() => providerMenuEntries(models, providers, value), [models, providers, value]);
  const [openProvider, setOpenProvider] = useState<string>();
  const [search, setSearch] = useState("");
  const [placement, setPlacement] = useState<ModelMenuPlacement>("right");
  const [pendingFocusProvider, setPendingFocusProvider] = useState<string>();
  const popoverRef = useRef<HTMLDivElement>(null);
  const providerListRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 二级面板打开后是否把焦点交给它（键盘路径为真，鼠标路径为假）。 */
  const focusPanelOnOpen = useRef(false);

  const openEntry = entries.find((entry) => entry.provider === openProvider);
  const visibleModels = useMemo(() => (openEntry ? filterProviderModels(openEntry.models, search) : []), [openEntry, search]);

  // 打开时的落点：焦点落在当前模型所在的供应商（没有则第一行），并滚到可见处
  // ——旧实现是「打开后滚到选中模型」，两段式之后对应的一级行就是供应商。
  useEffect(() => {
    const list = providerListRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>("button.model-menu-provider.active");
    const target = active ?? list.querySelector<HTMLElement>("button.model-menu-provider");
    target?.focus?.();
    active?.scrollIntoView?.({ block: "nearest" });
  }, []);

  // 面板几何：优先右侧 → 左侧 → 单列（见 model-menu.modelMenuPlacement）。
  useLayoutEffect(() => {
    if (!openProvider) {
      setPlacement("right");
      return;
    }
    const panel = panelRef.current;
    const popover = popoverRef.current;
    if (!panel || !popover) return;
    const popoverRect = popover.getBoundingClientRect();
    const bounds = popover.closest(".conversation-pane")?.getBoundingClientRect();
    setPlacement(modelMenuPlacement({
      popoverLeft: popoverRect.left,
      popoverRight: popoverRect.right,
      boundsLeft: bounds?.left ?? 0,
      boundsRight: bounds && bounds.right > bounds.left ? bounds.right : window.innerWidth,
      panelWidth: panel.offsetWidth
    }));
    if (openEntry?.active) modelListRef.current?.querySelector<HTMLElement>("button.active")?.scrollIntoView?.({ block: "nearest" });
    if (focusPanelOnOpen.current) {
      focusPanelOnOpen.current = false;
      (searchRef.current ?? modelListRef.current?.querySelector<HTMLElement>("button"))?.focus();
    }
  }, [openProvider, openEntry?.active]);

  // 「返回上一级」后把焦点还给刚收起的那一行（等供应商列重新可见之后再聚焦）。
  useEffect(() => {
    if (!pendingFocusProvider) return;
    const target = Array.from(providerListRef.current?.querySelectorAll<HTMLElement>("button.model-menu-provider") ?? [])
      .find((button) => button.dataset.provider === pendingFocusProvider);
    target?.focus();
    setPendingFocusProvider(undefined);
  }, [pendingFocusProvider, openProvider]);

  function openProviderPanel(provider: string, source: "pointer" | "keyboard"): void {
    if (openProvider === provider) return;
    focusPanelOnOpen.current = source === "keyboard";
    setSearch("");
    setOpenProvider(provider);
  }

  function backToProviders(): void {
    const previous = openProvider;
    setOpenProvider(undefined);
    setSearch("");
    if (previous) setPendingFocusProvider(previous);
  }

  /** 当前层内按 ↑/↓ 移动焦点（在搜索框上按 ↓ 落到第一条模型）。 */
  function moveFocus(container: HTMLElement | null, delta: number): void {
    if (!container) return;
    const items = Array.from(container.querySelectorAll<HTMLElement>("button:not(:disabled)"));
    if (items.length === 0) return;
    const current = items.findIndex((item) => item === document.activeElement);
    const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : (current + delta + items.length) % items.length;
    items[next]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (openProvider) backToProviders();
      else onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      moveFocus(openProvider ? modelListRef.current : providerListRef.current, delta);
      return;
    }
    if (event.key === "ArrowLeft" && openProvider) {
      event.preventDefault();
      backToProviders();
      return;
    }
    if (event.key === "ArrowRight" && !openProvider) {
      const focused = document.activeElement as HTMLElement | null;
      const provider = focused?.dataset.provider;
      if (provider) {
        event.preventDefault();
        openProviderPanel(provider, "keyboard");
      }
    }
  }

  return (
    <div
      className={["composer-select-menu", "model-select-menu", openProvider ? "model-menu-open" : "", openProvider && placement === "compact" ? "model-menu-compact" : ""].filter(Boolean).join(" ")}
      data-composer-zone="popup"
      role="menu"
      aria-label="模型快捷切换"
      ref={(element) => { popoverRef.current = element; rootRef?.(element); }}
      onKeyDown={handleKeyDown}
    >
      <div className="model-menu-providers" ref={providerListRef} role="group" aria-label="供应商">
        {entries.length === 0 && <p className="model-menu-empty">暂无已配置模型：请先在设置 → 模型服务里配置服务商并勾选模型</p>}
        {entries.map((entry) => {
          const opened = entry.provider === openProvider;
          const currentName = entry.active ? activeModelName(entry, value) : undefined;
          return (
            <button
              className={["model-menu-provider", entry.active ? "active" : "", opened ? "open" : ""].filter(Boolean).join(" ")}
              data-provider={entry.provider}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={opened}
              title={currentName ? `${entry.providerName} · 当前 ${currentName}` : `${entry.providerName} · ${entry.models.length} 个模型`}
              key={entry.provider}
              onClick={(event) => openProviderPanel(entry.provider, event.detail === 0 ? "keyboard" : "pointer")}
              onMouseEnter={() => { if (openProvider && !opened) openProviderPanel(entry.provider, "pointer"); }}
            >
              <span className="model-menu-provider-copy">
                <strong>{entry.providerName}</strong>
                <small>{currentName ?? `${entry.models.length} 个模型`}</small>
              </span>
              <ChevronRight size={13} className={["model-menu-chevron", opened && placement === "left" ? "flip" : ""].filter(Boolean).join(" ")} />
            </button>
          );
        })}
      </div>
      {openEntry && (
        <div
          className={["model-menu-panel", placement === "left" ? "flip" : "", placement === "compact" ? "inline" : ""].filter(Boolean).join(" ")}
          role="menu"
          aria-label={`${openEntry.providerName} 的模型`}
          ref={panelRef}
        >
          <header className="model-menu-head">
            <button className="model-menu-back" type="button" title="返回供应商列表" aria-label="返回供应商列表" onClick={backToProviders}><ChevronLeft size={13} /></button>
            <strong className="model-menu-title">{openEntry.providerName}</strong>
            <small>{openEntry.models.length} 个模型</small>
          </header>
          {openEntry.models.length >= MODEL_MENU_SEARCH_MIN && (
            <div className="model-menu-search">
              <Search size={12} />
              <input
                ref={searchRef}
                value={search}
                placeholder="搜索模型名称或 ID"
                aria-label="搜索模型"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          )}
          <div className="model-menu-models" ref={modelListRef}>
            {visibleModels.length === 0 && <p className="model-menu-empty">没有匹配「{search.trim()}」的模型</p>}
            {visibleModels.map((model) => {
              const itemValue = `${openEntry.provider}/${model.id}`;
              const active = itemValue === value;
              return (
                <button
                  className={["model-menu-model", active ? "active" : ""].filter(Boolean).join(" ")}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  title={`${model.name}（${model.id}）`}
                  key={model.id}
                  onClick={() => onSelect(itemValue)}
                >
                  <span>{model.name}</span>
                  {active && <Check size={13} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
