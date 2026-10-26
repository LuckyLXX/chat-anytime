import { type ReactNode } from "react";
import { useOverlayLayer } from "../lib/overlay-layers";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  /** 置灰不可点（如分屏格满时的「分屏到右侧」）。 */
  disabled?: boolean;
  onClick(): void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose(): void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): ReactNode {
  // 右键菜单的遮罩是整窗透明的（pointer-events 拦全局）：它一旦打开，原生浏览器视图
  // 也必须让位，否则菜单/“点空白关闭”在预览面板那一侧会被 WebContentsView 吃掉。
  useOverlayLayer(true);
  return (
    <div className="context-menu-overlay" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }}>
      <div
        className="context-menu"
        style={{ left: Math.min(x, window.innerWidth - 180), top: Math.min(y, window.innerHeight - items.length * 34 - 12) }}
        role="menu"
        onClick={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <button key={item.label} type="button" className={`context-menu-item${item.danger ? " danger" : ""}`} role="menuitem" aria-disabled={item.disabled} disabled={item.disabled} onClick={() => { if (item.disabled) return; onClose(); item.onClick(); }}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
