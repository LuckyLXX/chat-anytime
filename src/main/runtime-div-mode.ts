// Div 气泡模式的每回合尾部重申：把 always 档那一行「最终回复必须是一页气泡」追加到
// 系统提示词最末尾。
//
// 为什么要它：静态规范（div-prompt.ts 的 DIV_MODE_PROMPT 等四块）只在会话创建时经
// `systemPromptOverride` 进提示词一次，然后被技能清单、工具编排、子智能体、记忆索引
// 挤到中段；长任务跑几十轮工具调用之后，它离生成点已经两三万 token，模型回落到
// 「写报告」的 Markdown 习惯（2026-11-02 用户报「开了还是都用 markdown」，真实会话
// 日志实测：always 档最终回复气泡 4 / 纯 Markdown 3，失败的全是最长的两个任务）。
//
// 为什么是 `before_agent_start` 而不是把静态块写更强：位置就是变量——同一句话放在
// 系统提示词末尾比放在中段更接近生成点，且不必改写整段规范；文本逐字节稳定 ⇒ 前缀
// 缓存照常命中（与 runtime-ui-theme.ts 完全同形，后者注入了「当前界面主题」那一行）。
// 注册顺序有意义：本扩展排在 createUiThemeExtension 之后，所以最终尾部是
// 「…主题块 → 本轮输出格式那一行」，div-theme-integration.test.ts 钉住这个次序。
//
// auto/off 档返回 undefined：auto 档本来就是让模型按场景自己判断，加这句会把它退化成
// always；off 档一个字都不该多。

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { DivBubbleMode } from "../shared/protocol.js";
import { buildDivModeReminder } from "./div-prompt.js";

/** 依赖注入：divMode 来自本会话的 recordAgent 闭包（与 runtime-ui-theme.ts 同形）。 */
export interface DivModeExtensionDeps {
  divMode: () => DivBubbleMode;
}

export function createDivModeExtension(deps: DivModeExtensionDeps): InlineExtension {
  return {
    name: "pidesktop-div-mode",
    hidden: true,
    factory(pi) {
      pi.on("before_agent_start", (event) => {
        const reminder = buildDivModeReminder(deps.divMode());
        if (!reminder) return undefined;
        // 幂等保护：重试路径带着已追加过的文本再来一次时不重复追加（重复既浪费 token
        // 也破坏「前缀逐字节稳定」）。
        if (event.systemPrompt.includes(reminder)) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${reminder}` };
      });
    }
  };
}
