import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai";

import type { DivBubbleMode, UiThemeContext } from "../shared/protocol.js";
import { buildDivModePrompt } from "./div-prompt.js";
import { createUiThemeExtension } from "./runtime-ui-theme.js";

/**
 * 「往系统提示词补一行当前界面主题」的**真实会话**验证（2026-10-03）。
 *
 * 源码断言只能钉「接线在那里」，压不住三件读源码很容易看错、错了却静默失效的事：
 * ① `before_agent_start` 返回的 `systemPrompt` 是否**真的**进了 provider 请求（Pi 走
 * forceSystemPrompt 投影，与 systemPromptOverride 是两条不同的路）；
 * ② 主题不变时两次请求的系统提示词是否逐字节相同（前缀缓存的全部前提）；
 * ③ divMode 为 off 时是否真的一个字都不多。
 *
 * 全部跑在真实 AgentSession + 进程内 faux provider（零网络），与
 * codemode-integration.test.ts 同一套骨架。
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir) await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
  }
});

const PALETTE = {
  surface: "#172033",
  surfaceRaised: "#1e293b",
  text: "#eef2ff",
  textMuted: "#a6b1c5",
  border: "#334155",
  accent: "#4f46e5",
  accentSoft: "#25254b"
};

const DARK_CONTEXT: UiThemeContext = { mode: "dark", wallpaper: true, palette: PALETTE };

/**
 * 把请求里的 system 消息摊平成一段文本。两种形态都要覆盖：
 * - 未走 forceSystemPrompt 时，系统提示词是**结构化 sections**，`content` 是空串；
 * - 我们的扩展返回 `systemPrompt` 后，Pi 把整条投影成 head 的一段文本（sections 不再参与）。
 */
function systemText(context: TranscriptContext): string {
  return context.messages
    .filter((message) => message.role === "system")
    .map((message) => {
      const record = message as { content?: unknown; sections?: Record<string, string | null> };
      const parts: string[] = [];
      if (typeof record.content === "string") parts.push(record.content);
      else if (Array.isArray(record.content)) {
        parts.push(record.content.map((part) => (part as { text?: string }).text ?? "").join(""));
      }
      if (record.sections) parts.push(...Object.values(record.sections).filter((value): value is string => typeof value === "string"));
      return parts.join("\n");
    })
    .join("\n");
}

async function makeSession(divMode: DivBubbleMode, context: UiThemeContext | undefined): Promise<{ session: AgentSession; requests: string[]; holder: { context: UiThemeContext | undefined } }> {
  const holder: { context: UiThemeContext | undefined } = { context };
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-div-theme-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createUiThemeExtension({ divMode: () => divMode, context: () => holder.context })],
    // 生产形态同款：Div 气泡规范走系统提示词覆盖，主题那一行动态块走扩展。
    systemPromptOverride: (base) => [base, buildDivModePrompt(divMode)].filter(Boolean).join("\n\n")
  });
  await resourceLoader.reload();

  const faux = fauxProvider();
  const result = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader,
    model: faux.getModel()
  });
  const session = result.session;
  await session.bindExtensions({ onError: () => {} });
  session.agent.streamFunction = faux.provider.streamSimple.bind(faux.provider) as typeof session.agent.streamFunction;
  session.modelRuntime.registerNativeProvider(faux.provider);
  await session.modelRuntime.refresh({ allowNetwork: false });

  const requests: string[] = [];
  // 响应工厂拿到的 context 就是真实发出的请求（system + transcript）。
  faux.setResponses([
    (context) => { requests.push(systemText(context)); return fauxAssistantMessage("第一回合"); },
    (context) => { requests.push(systemText(context)); return fauxAssistantMessage("第二回合"); }
  ]);
  return { session, requests, holder };
}

describe("界面主题提示词注入（真实 AgentSession + faux provider）", () => {
  it("主题块真的进了 provider 请求，且两回合逐字节相同", async () => {
    const { session, requests } = await makeSession("auto", DARK_CONTEXT);
    try {
      await session.prompt("第一问");
      await session.prompt("第二问");
      expect(requests).toHaveLength(2);
      // ① 扩展返回的 systemPrompt 落到请求里（不是只在内存里改了 options）
      expect(requests[0]).toContain("【当前界面主题】深色模式｜聊天区背景：壁纸图片｜主题色值：");
      expect(requests[0]).toContain("surface #172033");
      // 静态配色规范也随 Div 提示词一起在（两档共用）
      expect(requests[0]).toContain("对比度 ≥ 4.5:1");
      // 主题块在最后（追加位置稳定）
      expect(requests[0]!.endsWith("accent-soft #25254b")).toBe(true);
      // ② 前缀缓存纪律：主题没变 → 系统提示词逐字节相同
      expect(requests[1]).toBe(requests[0]);
    } finally {
      session.dispose();
    }
  });

  it("主题中途变了，下一回合立刻跟上（这就是不能烘进会话创建期的原因）", async () => {
    const { session, requests, holder } = await makeSession("auto", DARK_CONTEXT);
    try {
      await session.prompt("第一问");
      expect(requests[0]).toContain("深色模式｜聊天区背景：壁纸图片");
      // 用户切到浅色纯色主题（渲染端会重新上报 ui.themeContext）
      holder.context = { mode: "light", wallpaper: false, palette: { ...PALETTE, surface: "#ffffff", text: "#1e293b" } };
      await session.prompt("第二问");
      expect(requests[1]).toContain("浅色模式｜聊天区背景：纯色面板");
      expect(requests[1]).toContain("surface #ffffff");
      expect(requests[1]).not.toContain("深色模式");
      // 旧快照的 token 不残留（整块重算，不是拼接）
      expect(requests[1]).not.toContain("#172033");
    } finally {
      session.dispose();
    }
  });

  it("divMode 为 off 时请求里只有 Div 提示词的空位，没有主题块", async () => {
    const { session, requests } = await makeSession("off", DARK_CONTEXT);
    try {
      await session.prompt("随便说说");
      expect(requests).toHaveLength(1);
      expect(requests[0]).not.toContain("【当前界面主题】");
      expect(requests[0]).not.toContain("对比度 ≥ 4.5:1");
    } finally {
      session.dispose();
    }
  });

  it("缺少上下文时同样不注入（渲染端未上报也不额外打扰模型）", async () => {
    const { session, requests } = await makeSession("always", undefined);
    try {
      await session.prompt("随便说说");
      expect(requests[0]).toContain("【气泡配色】");
      expect(requests[0]).not.toContain("【当前界面主题】");
    } finally {
      session.dispose();
    }
  });
});
