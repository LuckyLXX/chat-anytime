import { type ReactNode } from "react";

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  onClick(): void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose(): void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): ReactNode {
  return (
    <div className="context-menu-overlay" onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }}>
      <div
        className="context-menu"
        style={{ left: Math.min(x, window.innerWidth - 180), top: Math.min(y, window.innerHeight - items.length * 34 - 12) }}
        role="menu"
        onClick={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <button key={item.label} type="button" className={`context-menu-item${item.danger ? " danger" : ""}`} role="menuitem" onClick={() => { onClose(); item.onClick(); }}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
