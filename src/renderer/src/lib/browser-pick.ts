// Text composition for the manual element-pick flow (browser preview →
// composer). Pure over the protocol type so it is unit-testable.

import type { BrowserElementPick } from "../../../shared/protocol.js";

/** One-line element description for the confirm card, e.g. `<button type="submit"> "登录"`. */
export function formatPickedElementDescription(pick: BrowserElementPick): string {
  const el = pick.element;
  const attrs = [
    el.role ? ` role="${el.role}"` : "",
    el.type ? ` type="${el.type}"` : "",
    el.name ? ` name=${JSON.stringify(el.name)}` : ""
  ].join("");
  const label = el.text ? ` ${JSON.stringify(el.text.slice(0, 120))}` : "";
  return `<${el.tag}${attrs}>${label}`;
}

/** Composer message built from a picked element (source URL + description + content). */
export function composePickText(pick: BrowserElementPick): string {
  const el = pick.element;
  const lines = [
    "【来自内置浏览器】",
    `页面：${pick.url}`,
    `元素：${formatPickedElementDescription(pick)}`
  ];
  if (el.path) lines.push(`路径：${el.path}`);
  if (el.href) lines.push(`链接：${el.href}`);
  if (el.src) lines.push(`图片：${el.src}`);
  if (el.text) lines.push("", "内容：", el.text);
  return lines.join("\n");
}

/** 选中卡片「发送」时写入聊天输入框的完整文本：元素块 + 用户备注（空备注只发元素块）。 */
export function composePickMessage(pick: BrowserElementPick, note: string): string {
  const trimmed = note.trim();
  return trimmed ? `${composePickText(pick)}\n\n${trimmed}` : composePickText(pick);
}
