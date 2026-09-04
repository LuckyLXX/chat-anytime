import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 界面动效的挂载/延迟卸载基建（2026-09 全局动效改造）。
 *
 * 进入动画由纯 CSS 挂载 animation 播放（沿用 menu-pop-in/dock-slide-in 模式，
 * 零 JS）；本模块只补齐 React 条件渲染天生缺失的「退出动画」：
 *
 * - useExitPresence(open, exitMs)：open 变 false 后保留 exitMs 毫秒的渲染窗口
 *   （rendered=true、exiting=true），供 CSS 播退场动画，之后才真正卸载。
 *   动效被关停（外观「界面动效」开关关闭 → html[data-ui-motion="off"]，或系统
 *   prefers-reduced-motion）时退场时长按 0 处理，立即卸载——与 styles.css 里
 *   两处关停块的 animation: none 规则保持一致，不会出现「动画不播但延迟卸载」。
 *   close 期间重新 open 会取消卸载（竞态安全）。
 *
 * - ExitWrap：常驻的 display:contents 透明包装层。必须常驻而不能只在退场时
 *   插入——否则 React 子树重挂载会重置内部状态（如 SettingsDialog 的 tab）。
 *   display:contents 使包装层不参与布局（子元素 fixed 定位照常）、从可访问性
 *   树消失；退场时加 is-exiting class + inert（子树不可交互、不可聚焦），
 *   styles.css 的 .ui-presence.is-exiting 系列选择器在其上播退场动画。
 *
 * ⚠️ 调用方传入的 exitMs 必须与 styles.css 中对应退场 animation 的时长一致
 *（styles.css「退场时长对照」注释块有清单），改动任一侧都要同步另一侧。
 */

/** 判断界面动效是否被整体关停（外观开关或系统减弱动态效果）。 */
function motionDisabled(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.uiMotion === "off") return true;
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 退出动画的延迟卸载钩子。
 *
 * @param open    业务开关；true 立即（下一帧内）渲染，false 进入退场窗口。
 * @param exitMs  退场动画时长（毫秒），与 CSS 退场 animation 时长保持一致；
 *                动效关停时内部按 0 处理。
 * @returns rendered：是否继续渲染（含退场窗口）；exiting：是否处于退场中。
 */
export function useExitPresence(open: boolean, exitMs: number): { rendered: boolean; exiting: boolean } {
  const [rendered, setRendered] = useState(open);
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timerRef.current);
    if (open) {
      setRendered(true);
      setExiting(false);
      return;
    }
    // 关停态下退场动画不会播，保留渲染窗口只会拖慢卸载——立即收尾。
    const ms = motionDisabled() ? 0 : Math.max(0, exitMs);
    if (ms === 0) {
      setRendered(false);
      setExiting(false);
      return;
    }
    setExiting(true);
    timerRef.current = window.setTimeout(() => {
      setRendered(false);
      setExiting(false);
    }, ms);
    return () => window.clearTimeout(timerRef.current);
  }, [open, exitMs]);

  return { rendered, exiting };
}

/**
 * 带值保持的变体：驱动源是一个可空业务值（如 permission 请求对象）而非布尔。
 * 原先 `{value && <Dialog request={value}/>}` 靠 truthy 窄化类型，退场窗口里
 * value 已清空但组件仍在渲染——本钩子在退场期间返回最后一个非空值
 *（last-value ref），完全卸载后清引用。调用处模式：
 * `const p = useExitPresenceValue(permission, 130);`
 * `{p.rendered && (() => { const permission = p.value; return permission ? <ExitWrap …/> : null; })()}`
 */
export function useExitPresenceValue<T>(value: T | null | undefined, exitMs: number): { rendered: boolean; exiting: boolean; value: T | undefined } {
  const presence = useExitPresence(value != null, exitMs);
  const lastRef = useRef<T | undefined>(undefined);
  useEffect(() => {
    if (value != null) lastRef.current = value;
    else if (!presence.rendered) lastRef.current = undefined;
  }, [value, presence.rendered]);
  return { ...presence, value: presence.rendered ? (value ?? lastRef.current) : undefined };
}

/**
 * 条件渲染的常驻包装层：`{rendered && <ExitWrap exiting={exiting}><Dialog/></ExitWrap>}`。
 * 退场时 inert 屏蔽交互（防点击已关闭的对话框），CSS 退场动画挂在 is-exiting
 * 的后代选择器上（见 styles.css .ui-presence 一节）。
 */
export function ExitWrap({ exiting, children }: { exiting: boolean; children: ReactNode }): ReactNode {
  return (
    <div className={exiting ? "ui-presence is-exiting" : "ui-presence"} inert={exiting}>
      {children}
    </div>
  );
}
