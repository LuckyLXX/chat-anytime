/**
 * 窗口内直接快捷键（2026-11-05）。
 *
 * 与 `shared/shortcuts.ts` 的分别：那边是**主进程注册的 OS 全局**加速键
 *（Ctrl+Shift+Space 在任意应用里唤回 PiDesktop），这边是**渲染端窗口内**的
 * 直接动作——Ctrl+N 新建话题、Ctrl+Shift+B 打开浏览器、Ctrl+, 打开设置，
 * 以及本来就有的 Ctrl+K 命令面板。窗口内的键不在系统层注册，因此不会占用
 * 其他软件的 Ctrl+N / Ctrl+,。
 *
 * 判定收在纯函数里（不碰 DOM），App 只负责把命令发给对应闭包：
 * - `event.key` 大小写不敏感，但 **Shift 有无是硬条件**（Ctrl+B 不触发浏览器，
 *   Ctrl+Shift+K 也不触发面板——编辑器里那两组合另有语义）；
 * - Alt 一律不匹配（AltGr 在部分键盘布局上表现为 Ctrl+Alt，不能被当成命令）；
 * - `repeat` 由调用方过滤（按住 Ctrl+N 不该连开一串话题）。
 */
export type AppShortcutCommand = "palette" | "new-session" | "browser" | "settings";

/** 给界面与面板徽章看的平台无关写法（与 Accelerator 的 CommandOrControl 对齐）。 */
export const APP_SHORTCUT_LABELS: Record<AppShortcutCommand, string> = {
  palette: "Ctrl+K",
  "new-session": "Ctrl+N",
  browser: "Ctrl+Shift+B",
  settings: "Ctrl+,"
};

export interface ShortcutEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * 把一次 keydown 映射成窗口内命令；不是我们的组合键时返回 undefined。
 * 只做判定，不 preventDefault——调用方先确认命中再拦默认行为。
 */
export function matchAppShortcut(event: ShortcutEventLike): AppShortcutCommand | undefined {
  const modifier = event.ctrlKey === true || event.metaKey === true;
  if (!modifier || event.altKey === true) return undefined;
  const key = event.key.toLowerCase();
  if (event.shiftKey === true) return key === "b" ? "browser" : undefined;
  if (key === "k") return "palette";
  if (key === "n") return "new-session";
  if (key === ",") return "settings";
  return undefined;
}
