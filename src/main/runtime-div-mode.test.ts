import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DivBubbleMode } from "../shared/protocol.js";
import { DIV_MODE_REMINDER, buildDivModeReminder } from "./div-prompt.js";
import { createDivModeExtension } from "./runtime-div-mode.js";

/**
 * 气泡合规重申（2026-11-02）。
 *
 * 这层的失败是静默的：扩展注册错了、档位判断写反了、或者干脆没返回 systemPrompt，
 * 表现都只是「模型又用 Markdown 回了」，不会有任何报错——所以这里把三种档位、幂等与
 * 字节稳定逐项钉死（与 runtime-ui-theme.test.ts 同型）。
 */

/** 捕获 pi.on 注册的处理器（只关心 before_agent_start）。 */
function captureHandlers(): { api: ExtensionAPI; handlers: Record<string, (event: unknown, ctx: unknown) => unknown> } {
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers[event] = handler;
      return () => {};
    }
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

function runBeforeAgentStart(divMode: DivBubbleMode, systemPrompt: string): unknown {
  const { api, handlers } = captureHandlers();
  const extension = createDivModeExtension({ divMode: () => divMode });
  if (typeof extension === "function") throw new Error("扩展被声明成工厂函数，本用例只覆盖内联对象形态");
  extension.factory(api);
  const handler = handlers.before_agent_start;
  if (!handler) throw new Error("扩展没有注册 before_agent_start");
  return handler({ type: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt }, {});
}

describe("buildDivModeReminder", () => {
  it("只有 always 档有声，auto/off 一个字都不多", () => {
    expect(buildDivModeReminder("always")).toBe(DIV_MODE_REMINDER);
    expect(buildDivModeReminder("auto")).toBeUndefined();
    expect(buildDivModeReminder("off")).toBeUndefined();
  });

  it("重申本身只说「是什么形状」，不重复整段静态规范", () => {
    // 静态规范（结构/配色/媒体/动态）已经在系统提示词里，这里只补合规压力；
    // 长度失控会把整条缓存前缀的收益吃掉。
    expect(DIV_MODE_REMINDER.length).toBeLessThan(200);
    expect(DIV_MODE_REMINDER).toContain("<assistant_html>");
    expect(DIV_MODE_REMINDER).toContain("气泡外不出现任何 Markdown");
    // 例外条款必须留着，否则用户要求「完整 HTML 页面 / 纯文本」时被反向顶掉
    expect(DIV_MODE_REMINDER).toContain("仅当用户明确要求完整 HTML 页面或指定格式时例外");
  });
});

describe("createDivModeExtension", () => {
  it("always 档把重申追加到系统提示词末尾", () => {
    const result = runBeforeAgentStart("always", "BASE PROMPT") as { systemPrompt?: string } | undefined;
    expect(result?.systemPrompt).toBe(`BASE PROMPT\n\n${DIV_MODE_REMINDER}`);
    expect(result?.systemPrompt?.endsWith(DIV_MODE_REMINDER)).toBe(true);
  });

  it("auto/off 档不碰提示词（零行为变化）", () => {
    expect(runBeforeAgentStart("auto", "BASE")).toBeUndefined();
    expect(runBeforeAgentStart("off", "BASE")).toBeUndefined();
  });

  it("幂等：已含重申时不重复追加（保前缀字节稳定）", () => {
    const first = runBeforeAgentStart("always", "BASE") as { systemPrompt: string };
    expect(runBeforeAgentStart("always", first.systemPrompt)).toBeUndefined();
  });

  it("两次注入逐字节相同", () => {
    const a = runBeforeAgentStart("always", "BASE") as { systemPrompt: string };
    const b = runBeforeAgentStart("always", "BASE") as { systemPrompt: string };
    expect(a.systemPrompt).toBe(b.systemPrompt);
  });
});
