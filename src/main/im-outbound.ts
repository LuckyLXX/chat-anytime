/**
 * IM 出站文本整形（2026-11-12，飞书长连接 P1 第一次真机联调暴露）。
 *
 * 病根：Div 气泡规范注入的是**所有**会话，IM 会话也不例外；而飞书卡片正文是受限
 * markdown，不渲染 HTML ⇒ 模型照着规范回一页 `<assistant_html><div>…</div>`，
 * 手机端看到的是满屏标签、`<style>` 里的 CSS 全文、以及被剥掉排版的正文。
 *
 * 两道防线（本文件是第二道）：
 * 1. `pi-runtime` 给 IM 会话把 Div 档位压成 `off`（治本：模型压根不写气泡）；
 * 2. 这里把**已经写出来的**气泡压平成人能读的 markdown（治存量：会话在桌面端创建、
 *    之后才被 IM 绑定的情况，系统提示词里早就 Bake 了气泡规范）。
 *
 * 为什么只在含 `<assistant_html` 时动手：普通 markdown 回复必须**逐字节不变**——
 * 飞书自己对 markdown 的渲染才是最好的排版，多一次清洗就多一次改坏的机会。
 *
 * 顺序有讲究：先拆标签再解码实体，代码块里被转义的 `&lt;div&gt;` 才能原样留成文本。
 */

/** 兜底文案：整条气泡只剩样式（没有可读正文）时不发一张空卡。 */
export const IM_DIV_FALLBACK = "（这条回复是富样式气泡，手机端显示不了排版；请在桌面端查看原样式。）";

const DIV_BUBBLE_MARK = /<assistant_html[\s>]/iu;

export function toImMarkdown(text: string): string {
  if (!DIV_BUBBLE_MARK.test(text)) return text;
  const stripped = text
    // 非内容块整段丢弃（CSS 全文是最刺眼的部分）。
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    // 代码块先立围栏，后面通用拆标签时正文（已转义）才不会跟着消失。
    .replace(/<pre\b[^>]*>/giu, "\n```\n")
    .replace(/<\/pre>/giu, "\n```\n")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "\n- ")
    .replace(/<\/(td|th)\s*>/giu, " | ")
    .replace(/<\/(div|p|h[1-6]|tr|ul|ol|table|thead|tbody|figure|figcaption|blockquote|section|article|main|header|footer)\s*>/giu, "\n")
    .replace(/<\/?[a-z][^>]*>/giu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    // 行尾空白与表格行尾的悬空分隔符。
    .replace(/[ \t]+$/gmu, "")
    .replace(/[ \t]*\|[ \t]*$/gmu, "")
    // 块级标签换行会叠出多行空白：三连以上永不住宿。
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return stripped.length > 0 ? stripped : IM_DIV_FALLBACK;
}
