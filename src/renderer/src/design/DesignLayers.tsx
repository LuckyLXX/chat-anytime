import { Eye, EyeOff, Frame, Image as ImageIcon, Square, Type } from "lucide-react";
import type { ReactNode } from "react";
import type { DesignNode } from "../../../shared/design-schema.js";

/** 图层树：递归缩进列表 + 显隐 toggle + 点选联动（选中态高亮）。 */

const typeIcons: Record<DesignNode["type"], ReactNode> = {
  frame: <Frame size={13} />,
  rect: <Square size={13} />,
  text: <Type size={13} />,
  image: <ImageIcon size={13} />
};

export function DesignLayers({ nodes, selectedId, expandedIds, onSelect, onToggleVisible }: {
  nodes: readonly DesignNode[];
  selectedId: string | undefined;
  expandedIds: ReadonlySet<string>;
  onSelect(nodeId: string): void;
  onToggleVisible(node: DesignNode): void;
}): ReactNode {
  return (
    <div className="design-layers" data-pane="design-layers" role="tree" aria-label="图层">
      <div className="design-layers-heading">图层</div>
      {nodes.length === 0 ? <div className="design-layers-empty">暂无图层</div> : <ul className="design-layer-list">{nodes.map((node) => <LayerRow key={node.id} node={node} depth={0} selectedId={selectedId} expandedIds={expandedIds} onSelect={onSelect} onToggleVisible={onToggleVisible} />)}</ul>}
    </div>
  );
}

function LayerRow({ node, depth, selectedId, expandedIds, onSelect, onToggleVisible }: {
  node: DesignNode;
  depth: number;
  selectedId: string | undefined;
  expandedIds: ReadonlySet<string>;
  onSelect(nodeId: string): void;
  onToggleVisible(node: DesignNode): void;
}): ReactNode {
  const hasChildren = Boolean(node.children && node.children.length > 0);
  const expanded = expandedIds.has(node.id);
  return (
    <li>
      <div
        className={`design-layer-row${node.id === selectedId ? " active" : ""}${node.visible === false ? " hidden" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        role="treeitem"
        aria-selected={node.id === selectedId}
        aria-expanded={hasChildren ? expanded : undefined}
        data-node-type={node.type}
        onClick={() => onSelect(node.id)}
      >
        <span className="design-layer-icon">{typeIcons[node.type]}</span>
        <span className="design-layer-name" title={node.name ?? node.id}>{node.name || `${node.type} ${node.id.slice(0, 6)}`}</span>
        <button
          type="button"
          className="design-layer-visibility"
          title={node.visible === false ? "显示" : "隐藏"}
          aria-label={node.visible === false ? `显示 ${node.name ?? node.id}` : `隐藏 ${node.name ?? node.id}`}
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
          {node.children!.map((child) => <LayerRow key={child.id} node={child} depth={depth + 1} selectedId={selectedId} expandedIds={expandedIds} onSelect={onSelect} onToggleVisible={onToggleVisible} />)}
        </ul>
      )}
    </li>
  );
}
