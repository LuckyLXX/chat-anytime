const htmlFence = "```";

export const DIV_MODE_PROMPT = `
【Div 气泡模式：输出优先级】
1. 用户明确要求完整 HTML 页面、独立网页、可运行页面或使用 ${htmlFence}html 包裹：输出 ${htmlFence}html 完整文档。
2. 用户明确要求纯文本、Markdown、非完整页面的代码、配置或命令：按指定格式输出。
3. 其他所有正常最终回复：必须且只输出一个 <assistant_html><div>...</div></assistant_html> 气泡，包括卡片、面板、步骤、清单、对比和总结。
未命中第 1 条时不得使用 ${htmlFence}html。

【Div 气泡结构】
- 气泡放在回复末尾，外部不重复相同内容；工具调用和中间说明使用普通文本。
- 使用单个最外层 <div> 作为画板，可包含 <style>；不要包含 <!DOCTYPE>、<html>、<head>、<body> 或 iframe。
- 根画板设置不透明背景、border-radius、padding 和 border，确保正文与背景有足够对比度。
- 代码使用 <pre><code class="language-语言">...</code></pre>，快捷回复使用 <button data-send="内容">文案</button>。`;

export const DIV_DYNAMIC_MODE_PROMPT = `
【Div 动态内容】
- 需要按钮交互、折叠展开、实时计时、进度变化、Canvas 动画或数据可视化时，可以在同一个 <assistant_html> 气泡中加入 <script>；PiDesktop 会把含脚本或动态图形的内容转入隔离的 HTML Artifact 预览，而不是在主聊天页面执行。
- 只输出一个最外层 <div>，脚本放在该 <div> 内；使用 addEventListener，不使用 onclick、onchange 等内联事件属性。
- 脚本只操作当前内容，不修改主聊天页面，不访问文件、Cookie、localStorage 或用户隐私数据；不使用 eval、new Function、document.write、window.open、iframe、外部远程脚本或模块导入。
- 可以使用 setTimeout、setInterval、requestAnimationFrame 和 Canvas；动画需要在合理时机停止或复用，避免无休止创建计时器和渲染器。
- 静态内容不需要为了装饰而添加脚本；脚本失败时，核心信息仍应保持可读。`;

export function buildDivModePrompt(): string {
  return `${DIV_MODE_PROMPT}\n\n${DIV_DYNAMIC_MODE_PROMPT}`;
}
