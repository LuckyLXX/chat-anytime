// 界面主题上下文：把渲染端上报的主题快照，在每回合以一行提示词补给模型。
//
// 为什么需要它：Div 气泡的配色是模型自己写的，而模型看不到界面——不知道当前是深色
// 还是浅色、不知道聊天区背后是不是壁纸、也不知道当前主题的实际色值，于是常把弱化灰
// （#999 一类）当正文、在浅色卡片上写浅色字（2026-10-03 用户报「气泡有时候看不清」）。
//
// 为什么是 `before_agent_start` 而不是 systemPromptOverride：后者只在
// `DefaultResourceLoader.reload()` 里执行一次（会话创建时冻结），主题一改就得重建会话。
// `before_agent_start` 每回合触发，handler 返回 `{ systemPrompt }` 只作用于本次请求
// （Pi 内部走 forceSystemPrompt 投影，不进 transcript、不动工具声明）。文本在主题不变
// 时逐字节相同 ⇒ 系统提示词前缀照常命中缓存；只有用户切主题的那一次会重写一次前缀。
// 对照：计划模式叙事走 `context` 事件往最后一条 user 消息追加，那是「一次性叙事」；
// 这里是「长期事实」，放系统提示词才不产生每回合的新 token。
//
// 与 `src/main/runtime-plan-tools.ts` 同形：内联扩展在 createSession() 内构造，闭包
// 捕获本会话的 recordAgent，所以 divMode 直接读闭包值。

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { DivBubbleMode, UiThemeContext, UiThemePalette } from "../shared/protocol.js";
import { UI_THEME_PALETTE_ORDER, buildUiThemeContextBlock } from "./div-prompt.js";

/** 提示词里允许出现的色值形态（十六进制/rgb()/hsl()/颜色关键字/百分比）。 */
const PALETTE_VALUE_PATTERN = /^[#a-zA-Z0-9(),.%\s/-]{1,40}$/u;

/**
 * 渲染端上报值的归一化。渲染端是自家代码，但这条通道的文本会进系统提示词，所以按
 * 「不可信输入」收口：只接受已知形状，任何越界字段丢弃而不是放行（换行/尖括号/超长
 * 都可能被用来伪造提示词指令）。整体不合法时返回 undefined ⇒ 这一回合不注入。
 */
export function normalizeUiThemeContext(input: unknown): UiThemeContext | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const mode = record.mode;
  if (mode !== "light" && mode !== "dark") return undefined;
  const wallpaper = record.wallpaper === true;
  const palette: Partial<UiThemePalette> = {};
  const source = record.palette;
  if (source && typeof source === "object") {
    const entries = source as Record<string, unknown>;
    for (const [key] of UI_THEME_PALETTE_ORDER) {
      const value = entries[key];
      if (typeof value === "string" && PALETTE_VALUE_PATTERN.test(value)) palette[key] = value;
    }
  }
  return { mode, wallpaper, palette };
}

/** 依赖注入：divMode 来自本会话的 recordAgent 闭包，context 来自模块级内存镜像。 */
export interface UiThemeExtensionDeps {
  divMode: () => DivBubbleMode;
  context: () => UiThemeContext | undefined;
}

export function createUiThemeExtension(deps: UiThemeExtensionDeps): InlineExtension {
  return {
    name: "pidesktop-ui-theme",
    hidden: true,
    factory(pi) {
      pi.on("before_agent_start", (event) => {
        const block = buildUiThemeContextBlock(deps.divMode(), deps.context());
        if (!block) return undefined;
        // 幂等保护：同一 run 内若有别的 handler 或重试路径带着已追加过的文本再来一次，
        // 不重复追加（重复既浪费 token 也会破坏「前缀逐字节稳定」）。
        if (event.systemPrompt.includes(block)) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      });
    }
  };
}
