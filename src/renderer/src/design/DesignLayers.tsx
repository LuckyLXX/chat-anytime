import { ChevronDown, ChevronRight, Eye, EyeOff, Frame, Image as ImageIcon, Lock, LockOpen, Square, Type } from "lucide-react";
import type { ReactNode } from "react";
import type { DesignNode } from "../../../shared/design-schema.js";

/**
 * 图层树（参考设计工具层级面板）：折叠箭头（frame）+ 类型图标 + 悬停操作
 * （锁定/显隐）+ 点选联动（选中高亮）。折叠态由 DesignStudio 的 expandedIds 持有
 * （文档切换时默认全展开）。
 */

const typeIcons: Record<DesignNode["type"], ReactNode> = {
  frame: <Frame size={13} />,
  rect: <Square size={13} />,
  text: <Type size={13} />,
  image: <ImageIcon size={13} />
};

export function DesignLayers({ nodes, selectedId, expandedIds, onSelect, onToggleVisible, onToggleLock, onToggleExpand }: {
  nodes: readonly DesignNode[];
  selectedId: string | undefined;
  expandedIds: ReadonlySet<string>;
  onSelect(nodeId: string): void;
  onToggleVisible(node: DesignNode): void;
  onToggleLock(node: DesignNode): void;
  onToggleExpand(node: DesignNode): void;
}): ReactNode {
  return (
    <div className="design-layers" data-pane="design-layers" role="tree" aria-label="图层">
      <div className="design-layers-heading">图层</div>
      {nodes.length === 0 ? <div className="design-layers-empty">暂无图层</div> : <ul className="design-layer-list">{nodes.map((node) => <LayerRow key={node.id} node={node} depth={0} selectedId={selectedId} expandedIds={expandedIds} onSelect={onSelect} onToggleVisible={onToggleVisible} onToggleLock={onToggleLock} onToggleExpand={onToggleExpand} />)}</ul>}
    </div>
  );
}

function LayerRow({ node, depth, selectedId, expandedIds, onSelect, onToggleVisible, onToggleLock, onToggleExpand }: {
  node: DesignNode;
  depth: number;
  selectedId: string | undefined;
  expandedIds: ReadonlySet<string>;
  onSelect(nodeId: string): void;
  onToggleVisible(node: DesignNode): void;
  onToggleLock(node: DesignNode): void;
  onToggleExpand(node: DesignNode): void;
}): ReactNode {
  const hasChildren = Boolean(node.children && node.children.length > 0);
  const expanded = expandedIds.has(node.id);
  const locked = node.locked === true;
  const label = node.name || `${node.type} ${node.id.slice(0, 6)}`;
  return (
    <li>
      <div
        className={`design-layer-row${node.id === selectedId ? " active" : ""}${node.visible === false ? " hidden" : ""}${locked ? " locked" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        role="treeitem"
        aria-selected={node.id === selectedId}
        aria-expanded={hasChildren ? expanded : undefined}
        data-node-type={node.type}
        data-row-locked={locked || undefined}
        onClick={() => onSelect(node.id)}
      >
        {hasChildren ? (
          <button
            type="button"
            className="design-layer-chevron"
            title={expanded ? "折叠" : "展开"}
            aria-label={`${expanded ? "折叠" : "展开"} ${label}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand(node);
            }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="design-layer-chevron design-layer-chevron-empty" />
        )}
        <span className="design-layer-icon">{typeIcons[node.type]}</span>
        <span className="design-layer-name" title={label}>{label}</span>
        <button
          type="button"
          className="design-layer-action"
          data-control="design-layer-lock"
          title={locked ? "解锁" : "锁定（画布上不可拖动/删除）"}
          aria-label={`${locked ? "解锁" : "锁定"} ${label}`}
          aria-pressed={locked}
          onClick={(event) => {
            event.stopPropagation();
            onToggleLock(node);
          }}
        >
          {locked ? <Lock size={12} /> : <LockOpen size={12} />}
        </button>
        <button
          type="button"
          className="design-layer-action"
          title={node.visible === false ? "显示" : "隐藏"}
          aria-label={`${node.visible === false ? "显示" : "隐藏"} ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleVisible(node);
          }}
        >
          {node.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
      {hasChildren && expanded && (
        <ul>
          {node.children!.map((child) => <LayerRow key={child.id} node={child} depth={depth + 1} selectedId={selectedId} expandedIds={expandedIds} onSelect={onSelect} onToggleVisible={onToggleVisible} onToggleLock={onToggleLock} onToggleExpand={onToggleExpand} />)}
        </ul>
      )}
    </li>
  );
}
