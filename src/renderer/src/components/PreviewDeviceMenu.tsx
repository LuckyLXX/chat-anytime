import { Check, Monitor, Shrink, Smartphone, StretchHorizontal, Tablet } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PREVIEW_DEVICE_PRESETS, previewDevicePreset, type PreviewDeviceId } from "../lib/preview-device";

function DeviceGlyph({ device, size = 15 }: { device: PreviewDeviceId; size?: number }): ReactNode {
  if (device === "desktop") return <Monitor size={size} />;
  if (device === "tablet") return <Tablet size={size} />;
  if (device === "phone") return <Smartphone size={size} />;
  return <StretchHorizontal size={size} />;
}

/**
 * 设备视口切换菜单（浏览器预览工具栏与 HTML 工件预览标签栏共用）：
 * 预设设备 + 适应窗口/原始尺寸两项缩放策略。scalePercent 用于在触发按钮上
 * 显示当前缩放（适应窗口把超宽设备缩小时）。
 */
export function PreviewDeviceMenu({ device, fit, scalePercent, disabled, onDeviceChange, onFitChange, onMenuOpenChange }: {
  device: PreviewDeviceId;
  fit: boolean;
  /** 当前缩放百分比（1 = 100%）。 */
  scalePercent: number;
  disabled?: boolean;
  onDeviceChange(id: PreviewDeviceId): void;
  onFitChange(fit: boolean): void;
  /** 菜单开合回调：浏览器预览借它临时隐藏 native 视图，避免菜单被盖住。 */
  onMenuOpenChange?(open: boolean): void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  function toggle(next: boolean): void {
    setOpen(next);
    onMenuOpenChange?.(next);
  }

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) toggle(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        toggle(false);
      }
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  const zoomed = scalePercent < 99.5;
  return (
    <div className="preview-device-menu" ref={rootRef}>
      <button
        type="button"
        className={device !== "responsive" ? "active" : ""}
        title="切换设备视口（桌面 / 平板 / 手机 / 自适应）"
        aria-label="切换设备视口"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => toggle(!open)}
      >
        <DeviceGlyph device={device} />
        {device !== "responsive" && <span className="preview-device-width">{previewDevicePreset(device).width}</span>}
        {zoomed && <span className="preview-device-zoom">{Math.round(scalePercent)}%</span>}
      </button>
      {open && (
        <div className="preview-device-pop" role="menu" aria-label="设备视口">
          {PREVIEW_DEVICE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="menuitemradio"
              aria-checked={device === preset.id}
              className={device === preset.id ? "active" : ""}
              onClick={() => { onDeviceChange(preset.id); toggle(false); }}
            >
              <DeviceGlyph device={preset.id} size={14} />
              <span>{preset.label}</span>
              {preset.width > 0 ? <kbd>{preset.width}px</kbd> : <kbd>跟随面板</kbd>}
              {device === preset.id && <Check size={13} />}
            </button>
          ))}
          <div className="preview-device-sep" role="separator" />
          <button type="button" role="menuitemradio" aria-checked={fit} className={fit ? "active" : ""} onClick={() => { onFitChange(true); toggle(false); }}>
            <Shrink size={14} />
            <span>适应窗口</span>
            <kbd>超宽自动缩小</kbd>
            {fit && <Check size={13} />}
          </button>
          <button type="button" role="menuitemradio" aria-checked={!fit} className={!fit ? "active" : ""} onClick={() => { onFitChange(false); toggle(false); }}>
            <StretchHorizontal size={14} />
            <span>原始尺寸</span>
            <kbd>1:1 不缩放</kbd>
            {!fit && <Check size={13} />}
          </button>
        </div>
      )}
    </div>
  );
}
