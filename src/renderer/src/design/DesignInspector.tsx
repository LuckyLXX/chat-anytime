import { useState, type ReactNode } from "react";
import type { DesignDoc, DesignNode, DesignNodePatch } from "../../../shared/design-schema.js";

/** 属性检查器：选中节点的几何/外观/文本属性编辑（输入 → onNodePatch，防抖收敛由宿主负责）。 */

interface NumberFieldProps {
  label: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  fallback: number;
  onChange(value: number | undefined): void;
}

function NumberField({ label, value, min, max, step, fallback, onChange }: NumberFieldProps): ReactNode {
  return (
    <label className="design-field design-field-number">
      <span>{label}</span>
      <input
        type="number"
        value={value === undefined ? "" : value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(event) => {
          const raw = event.target.value === "" ? undefined : Number(event.target.value);
          onChange(raw === undefined || Number.isNaN(raw) ? undefined : raw);
        }}
        onBlur={(event) => {
          if (event.target.value === "") onChange(fallback);
        }}
      />
    </label>
  );
}

export function DesignInspector({ doc, selected, onPatch }: {
  doc: DesignDoc;
  /** 当前选中节点；undefined 时显示文档信息。 */
  selected: DesignNode | undefined;
  onPatch(nodeId: string, patch: DesignNodePatch): void;
}): ReactNode {
  const [showShadow, setShowShadow] = useState(false);
  if (!selected) {
    return (
      <div className="design-inspector" data-pane="design-inspector" aria-label="属性">
        <div className="design-inspector-heading">属性</div>
        <div className="design-doc-info">
          <div className="design-field"><span>文档</span><strong title={doc.name}>{doc.name}</strong></div>
          <div className="design-field"><span>画布</span><em>{doc.canvas.width} × {doc.canvas.height}</em></div>
          <div className="design-field"><span>图层数</span><em>{countNodes(doc.nodes)}</em></div>
          <p className="design-inspector-hint">选中画布或图层的节点后编辑属性；双击文本节点可直接改字。</p>
        </div>
      </div>
    );
  }
  const patch = (fields: DesignNodePatch): void => onPatch(selected.id, fields);
  return (
    <div className="design-inspector" data-pane="design-inspector" aria-label="属性">
      <div className="design-inspector-heading">属性 · {selected.type}</div>
      <label className="design-field"><span>名称</span><input value={selected.name ?? ""} placeholder={`${selected.type}`} onChange={(event) => patch({ name: event.target.value })} /></label>
      <div className="design-field-grid">
        <NumberField label="X" value={selected.x} fallback={0} onChange={(value) => patch({ x: value ?? 0 })} />
        <NumberField label="Y" value={selected.y} fallback={0} onChange={(value) => patch({ y: value ?? 0 })} />
        <NumberField label="W" value={selected.w} min={1} fallback={selected.w} onChange={(value) => patch({ w: value ?? selected.w })} />
        <NumberField label="H" value={selected.h} min={1} fallback={selected.h} onChange={(value) => patch({ h: value ?? selected.h })} />
      </div>
      <div className="design-field-row">
        <label className="design-field design-field-color"><span>填充</span><span className="design-color-input"><input type="color" value={safeColor(selected.fill)} disabled={!selected.fill} aria-label="填充颜色" onChange={(event) => patch({ fill: event.target.value })} /><input value={selected.fill ?? ""} placeholder="无" onChange={(event) => patch({ fill: event.target.value })} /></span></label>
        <button type="button" className="design-field-clear" title="清除填充" onClick={() => patch({ fill: undefined })}>×</button>
      </div>
      <div className="design-field-row">
        <label className="design-field design-field-color"><span>描边</span><span className="design-color-input"><input type="color" value={safeColor(selected.stroke)} disabled={!selected.stroke} aria-label="描边颜色" onChange={(event) => patch({ stroke: event.target.value })} /><input value={selected.stroke ?? ""} placeholder="无" onChange={(event) => patch({ stroke: event.target.value })} /></span></label>
        <NumberField label="宽" value={selected.strokeWidth} min={0} fallback={1} onChange={(value) => patch({ strokeWidth: value ?? 0 })} />
        <button type="button" className="design-field-clear" title="清除描边" onClick={() => patch({ stroke: undefined, strokeWidth: undefined })}>×</button>
      </div>
      <div className="design-field-grid">
        <NumberField label="圆角" value={selected.radius} min={0} fallback={0} onChange={(value) => patch({ radius: value ?? 0 })} />
        <NumberField label="透明度" value={selected.opacity === undefined ? undefined : Math.round(selected.opacity * 100)} min={0} max={100} fallback={100} onChange={(value) => patch({ opacity: value === undefined ? undefined : Math.min(100, Math.max(0, value)) / 100 })} />
      </div>
      {selected.shadow && <div className="design-field"><span>阴影</span><em className="design-shadow-preview">{selected.shadow}</em></div>}
      {!selected.shadow && <button type="button" className="design-shadow-toggle" onClick={() => setShowShadow((open) => !open)}>{showShadow ? "收起阴影" : "添加阴影"}</button>}
      {showShadow && !selected.shadow && (
        <label className="design-field"><span>box-shadow</span><input placeholder="0 8px 24px rgba(0,0,0,.12)" onKeyDown={(event) => {
          if (event.key === "Enter") patch({ shadow: (event.target as HTMLInputElement).value });
        }} /></label>
      )}
      {selected.type === "text" && (
        <>
          <label className="design-field"><span>文本</span><textarea value={selected.text ?? ""} rows={3} onChange={(event) => patch({ text: event.target.value })} /></label>
          <div className="design-field-grid">
            <NumberField label="字号" value={selected.fontSize} min={1} max={400} fallback={14} onChange={(value) => patch({ fontSize: value ?? 14 })} />
            <NumberField label="字重" value={selected.fontWeight} min={1} max={1000} fallback={400} onChange={(value) => patch({ fontWeight: value ?? 400 })} />
          </div>
          <label className="design-field design-field-color"><span>颜色</span><span className="design-color-input"><input type="color" value={safeColor(selected.color)} aria-label="文字颜色" onChange={(event) => patch({ color: event.target.value })} /><input value={selected.color ?? ""} placeholder="#111827" onChange={(event) => patch({ color: event.target.value })} /></span></label>
          <label className="design-field"><span>对齐</span>
            <select value={selected.align ?? "left"} onChange={(event) => patch({ align: event.target.value as DesignNode["align"] })}>
              <option value="left">左对齐</option>
              <option value="center">居中</option>
              <option value="right">右对齐</option>
            </select>
          </label>
          <NumberField label="行高" value={selected.lineHeight} min={0.5} max={10} step={0.1} fallback={1.4} onChange={(value) => patch({ lineHeight: value ?? 1.4 })} />
        </>
      )}
      {selected.type === "image" && (
        <label className="design-field"><span>图片地址</span><input value={selected.src ?? ""} placeholder="https://… 或 data:image/…" onChange={(event) => patch({ src: event.target.value })} /></label>
      )}
    </div>
  );
}

/** 颜色输入只认 #rrggbb，其余回落灰色（type=color 对非法值会黑掉）。 */
function safeColor(value: string | undefined): string {
  return value && /^#[0-9a-fA-F]{6}$/u.test(value) ? value : "#888888";
}

function countNodes(nodes: readonly DesignNode[]): number {
  let total = 0;
  for (const node of nodes) {
    total += 1;
    if (node.children) total += countNodes(node.children);
  }
  return total;
}
