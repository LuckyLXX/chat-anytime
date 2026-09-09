import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { ExitWrap, useExitPresenceValue } from "./Presence";

export interface LightboxImage {
  src: string;
  alt?: string;
  title?: string;
}

/**
 * 全屏图片放大预览（气泡图片、消息图片块、输入框附件预览共用）。
 *
 * 必须 portal 到 document.body：消息气泡带 `content-visibility: auto`
 *（长会话只渲染可视区，见 styles.css `.timeline > .message`），该属性隐含
 * paint containment，会让 `position: fixed` 的后代以气泡为包含块——内联渲染时
 * 遮罩与放大图被气泡宽度裁切，只有 portal 到 body 才是真正的全屏层。
 * Escape / 点击遮罩 / 关闭按钮三条关闭路径与 160ms 退场动画都在组件内收口。
 */
export function ImageLightbox({ image, onClose }: { image: LightboxImage | undefined; onClose(): void }): ReactNode {
  const presence = useExitPresenceValue(image, 160);
  const open = image !== undefined;

  useEffect(() => {
    if (!open) return;
    function close(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open, onClose]);

  const current = presence.value;
  if (!presence.rendered || !current || typeof document === "undefined") return null;
  return createPortal(
    <ExitWrap exiting={presence.exiting}>
      <div className="modal-backdrop image-lightbox" role="presentation" onMouseDown={onClose}>
        <div className="image-lightbox-content" role="dialog" aria-modal="true" aria-label={current.alt ? `图片预览：${current.alt}` : "图片预览"} onMouseDown={(event) => event.stopPropagation()}>
          <button className="icon-button modal-close" type="button" title="关闭图片" aria-label="关闭图片" onClick={onClose}><X size={17} /></button>
          <img src={current.src} alt={current.alt ?? ""} title={current.title} />
        </div>
      </div>
    </ExitWrap>,
    document.body
  );
}
