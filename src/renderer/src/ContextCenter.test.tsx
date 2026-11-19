// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextInspection, RuntimeSnapshot } from "../../shared/protocol";
import { ContextCenter } from "./ContextCenter";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 上下文中心的渲染契约：六区、分段/全文、块与工具展开、空态/错误态。
 * 数据流（session.inspect 的 requestId 认领）在 store 与 wiring 测试里钉，这里只
 * 负责「给定一份 inspection 时页面显示什么」。
 */

function inspection(overrides: Partial<ContextInspection> = {}): ContextInspection {
  return {
    at: Date.parse("2026-11-13T17:42:10+08:00"),
    sessionId: "session-1",
    agentId: "agent-1",
    agentName: "黑鱼河",
    model: { provider: "deepseek", id: "deepseek-v4.1-flash", contextWindow: 200_000, maxTokens: 32_000 },
    thinkingLevel: "max",
    usage: {
      tokens: 118_600,
      contextWindow: 200_000,
      percent: 59.3,
      cacheHitRate: 94.2,
      breakdown: { system: 2_960, tools: 6_248, messages: 108_900 }
    },
    prompt: {
      text: "你是黑鱼河。\n\n以下 Skill 可用……\n\n【工具编排】……\n\n<cwd>\nD:/PiDesktop\n</cwd>",
      blocks: [
        { id: "agent", label: "助手人设", origin: "助手「黑鱼河」的 systemPrompt", present: true, chars: 1_486, text: "你是黑鱼河。只改源码，不重启宿主应用。" },
        { id: "skills", label: "技能清单", origin: "buildSkillsSystemPromptBlock · 会话创建时冻结", present: true, chars: 2_914, text: "以下 Skill 可用：- /skill:电脑控制" },
        { id: "orchestration", label: "工具编排", origin: "TOOL_ORCHESTRATION_PROMPT_BLOCK · 静态规范", present: true, chars: 132, text: "【工具编排】批量读用 codemode。" },
        { id: "memory", label: "记忆索引", origin: "记忆治理块 + 双库快照 · 会话创建时冻结", present: false, chars: 4_081, text: "【长期记忆（memory_* 工具）】" }
      ],
      sections: [{ name: "cwd", origin: "Pi 固定追加的工作目录", chars: 34, text: "<cwd>\nD:/PiDesktop\n</cwd>" }],
      extraSystemMessages: [],
      turnInjections: [
        { label: "界面主题（一行）", origin: "runtime-ui-theme · before_agent_start", active: true, chars: 184, text: "当前界面主题：深色模式" },
        { label: "Div 气泡合规重申", origin: "runtime-div-mode · always 档", active: false, chars: 0 }
      ]
    },
    tools: {
      declared: [
        { name: "bash", description: "执行 shell 命令", parameters: "{\n  \"command\": { \"type\": \"string\" }\n}", tokens: 176, exposure: "direct", source: "builtin", guideline: "Use bash for file operations" },
        { name: "browser_click", description: "点击页面元素", parameters: "{}", tokens: 86, exposure: "direct", source: "app" },
        { name: "mcp__exa__web_search_exa", description: "Exa 搜索", parameters: "{}", tokens: 78, exposure: "direct", source: "mcp" }
      ],
      undeclared: [{ name: "mcp__dbx__query", exposure: "codemode", source: "mcp" }]
    },
    messages: {
      total: 4,
      byRole: [
        { role: "user", count: 1, tokens: 2_640 },
        { role: "assistant", count: 1, tokens: 14_320 },
        { role: "toolResult", count: 1, tokens: 88_980 },
        { role: "system", count: 1, tokens: 2_960 }
      ],
      top: [{ role: "toolResult", tokens: 18_240, preview: "npm test 全部通过…" }],
      images: 1
    },
    runtime: [
      { label: "模型", value: "deepseek-v4.1-flash", note: "deepseek" },
      { label: "技能注入", value: "6 个", frozen: true }
    ],
    ...overrides
  };
}

function snapshot(overrides: Partial<RuntimeSnapshot> = {}): RuntimeSnapshot {
  return {
    agentId: "agent-1",
    agentName: "黑鱼河",
    sessionId: "session-1",
    thinkingLevel: "max",
    busy: false,
    status: "就绪",
    queuedMessages: [],
    messages: [],
    executions: [],
    backgroundProcesses: [],
    sessions: [{ id: "session-1", path: "D:/sessions/s1.jsonl", title: "上下文页面方案设计", workspace: "D:/PiDesktop", agentId: "agent-1", modifiedAt: 1, messageCount: 4 } as RuntimeSnapshot["sessions"][number]],
    recentWorkspaces: [],
    ...overrides
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (window as unknown as { piDesktop: unknown }).piDesktop = { send: vi.fn().mockResolvedValue(undefined) };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useDesktopStore.setState({
    snapshot: snapshot(),
    contextInspection: { requestId: "r1", sessionId: "session-1", loading: false, data: inspection(), at: inspection().at },
    providers: [{ id: "deepseek", name: "DeepSeek", configured: true } as never],
    resources: {
      workflows: { items: [] }, skills: [], commands: [], mcpServers: [], todos: [], memory: [], subagents: [], hooks: [], hooksEnabled: true, automation: [], automationRuns: [], gallery: [], diagnostics: []
    },
    memory: []
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<ContextCenter onClose={() => undefined} />);
  });
  await act(async () => { await Promise.resolve(); });
}

describe("ContextCenter", () => {
  it("渲染头部、六区导航与占用总览", async () => {
    await render();
    const text = container.textContent ?? "";
    expect(text).toContain("上下文中心");
    expect(text).toContain("上下文页面方案设计");
    expect(text).toContain("黑鱼河");
    expect(text).toContain("59.3%");
    expect(text).toContain("118.6K");
    expect(text).toContain("缓存命中");
    expect(container.querySelector('[data-pane="context-center"]')).toBeTruthy();
    expect(container.querySelectorAll(".context-center-nav-item")).toHaveLength(6);
  });

  it("系统提示词：分段模式显示块与未注入对照；全文模式显示完整文本", async () => {
    await render();
    expect(container.textContent).toContain("助手人设");
    expect(container.textContent).toContain("本会话未注入");
    expect(container.textContent).toContain("下一回合将注入");

    const fullButton = Array.from(container.querySelectorAll("#cc-section-prompt .context-center-segmented button")).find((button) => button.textContent === "全文");
    await act(async () => { (fullButton as HTMLButtonElement).click(); });
    expect(container.textContent).toContain("完整提示词");
    expect(container.querySelector(".context-center-pre-full")?.textContent).toContain("你是黑鱼河");
  });

  it("提示词块可展开/收起", async () => {
    await render();
    const blockHead = Array.from(container.querySelectorAll(".context-center-block-head")).find((button) => button.textContent?.includes("助手人设"));
    expect(blockHead).toBeTruthy();
    await act(async () => { (blockHead as HTMLButtonElement).click(); });
    // 默认已展开第一块（init effect），点击后收起
    expect(blockHead?.closest(".context-center-block")?.classList.contains("open")).toBe(false);
    await act(async () => { (blockHead as HTMLButtonElement).click(); });
    expect(blockHead?.closest(".context-center-block")?.classList.contains("open")).toBe(true);
  });

  it("工具区：按来源分组、筛选与 schema 展开", async () => {
    await render();
    expect(container.textContent).toContain("工具声明");
    expect(container.textContent).toContain("个声明");
    const mcpFilter = Array.from(container.querySelectorAll(".context-center-filter")).find((button) => button.textContent?.startsWith("MCP"));
    expect(mcpFilter).toBeTruthy();
    await act(async () => { (mcpFilter as HTMLButtonElement).click(); });
    expect(container.textContent).toContain("mcp__exa__web_search_exa");
    expect(container.textContent).not.toContain("browser_click");

    const toolRow = Array.from(container.querySelectorAll(".context-center-tool-row")).find((button) => button.textContent?.includes("mcp__exa__web_search_exa"));
    await act(async () => { (toolRow as HTMLButtonElement).click(); });
    expect(container.textContent).toContain("来源：MCP");
    expect(container.textContent).toContain("曝光：直连");
  });

  it("资源、消息与运行参数区渲染摘要", async () => {
    await render();
    expect(container.textContent).toContain("资源注入");
    expect(container.textContent).toContain("长期记忆");
    expect(container.textContent).toContain("对话消息");
    expect(container.textContent).toContain("谁在吃上下文");
    expect(container.textContent).toContain("运行参数");
    expect(container.textContent).toContain("技能注入");
  });

  it("没有会话时显示空态，不渲染数据区", async () => {
    useDesktopStore.setState({ snapshot: snapshot({ sessionId: undefined }), contextInspection: undefined });
    await render();
    expect(container.textContent).toContain("先打开一个话题");
    expect(container.querySelector(".context-center-nav")).toBeTruthy();
  });

  it("请求失败且无数据时显示错误与重试", async () => {
    await render();
    // 挂载会先发一次请求（loading）；这里模拟这一轮请求失败的结果。
    await act(async () => {
      useDesktopStore.setState({ contextInspection: { requestId: "r2", sessionId: "session-1", loading: false, error: "该会话不在运行中" } });
    });
    expect(container.textContent).toContain("读不到会话成分");
    expect(container.textContent).toContain("该会话不在运行中");
    expect(container.querySelector(".context-center-retry")).toBeTruthy();
  });
});
