import { describe, expect, it } from "vitest";
import type { ContextToolDeclaration, ContextUsage } from "../../../shared/protocol";
import {
  charCountLabel,
  compositionSegments,
  groupToolDeclarations,
  roleLabel,
  roleShare,
  tokenEstimateFromChars,
  toolExposureLabel,
  toolSourceLabel,
  usagePercentText
} from "./context-inspection-view";

function tool(name: string, source: ContextToolDeclaration["source"], tokens = 100): ContextToolDeclaration {
  return { name, description: `${name} 描述`, parameters: "{}", tokens, exposure: "direct", source };
}

describe("groupToolDeclarations", () => {
  it("按来源与名字前缀分组，保留规则顺序，空组不出现", () => {
    const groups = groupToolDeclarations([
      tool("bash", "builtin", 10),
      tool("read", "builtin", 5),
      tool("memory_search", "app", 20),
      tool("todo_write", "app", 30),
      tool("browser_click", "app", 40),
      tool("ssh_exec", "app", 50),
      tool("team_spawn", "app", 60),
      tool("design_apply", "app", 70),
      tool("codemode", "app", 80),
      tool("mcp__exa__search", "mcp", 90),
      tool("some_custom", "app", 100),
      tool("ext_tool", "other", 110)
    ]);
    expect(groups.map((group) => group.id)).toEqual(["builtin", "tasks", "browser", "ssh", "team", "design", "mcp", "app", "other"]);
    expect(groups[0]!.tokens).toBe(15);
    expect(groups[1]!.tools.map((entry) => entry.name)).toEqual(["memory_search", "todo_write"]);
    expect(groups[5]!.tools.map((entry) => entry.name)).toEqual(["design_apply", "codemode"]);
    expect(groups[7]!.tools.map((entry) => entry.name)).toEqual(["some_custom"]);
  });

  it("MCP 名字优先归 MCP，不因 source=builtin 被当成内置", () => {
    // Pi 的共享 resource 工具不带 mcp__ 前缀、来源常是 builtin:mcp；这里只按规则
    // 顺序：内置规则在前会先命中。页面用 source 展示，分组只影响归类，不篡改 source。
    const groups = groupToolDeclarations([tool("mcp__dbx__query", "mcp", 12), tool("list_mcp_resources", "builtin", 8)]);
    expect(groups.find((group) => group.id === "mcp")?.tools.map((entry) => entry.name)).toEqual(["mcp__dbx__query"]);
    expect(groups.find((group) => group.id === "builtin")?.tools.map((entry) => entry.name)).toEqual(["list_mcp_resources"]);
  });

  it("空列表返回空数组", () => {
    expect(groupToolDeclarations([])).toEqual([]);
  });
});

describe("标签与计数", () => {
  it("曝光与来源标签覆盖四态", () => {
    expect(toolExposureLabel("direct")).toBe("直连");
    expect(toolExposureLabel("codemode")).toBe("脚本曝光");
    expect(toolExposureLabel("deferred")).toBe("延迟曝光");
    expect(toolExposureLabel("unknown")).toBe("未知曝光");
    expect(toolSourceLabel("builtin")).toBe("内置");
    expect(toolSourceLabel("app")).toBe("应用注入");
    expect(toolSourceLabel("mcp")).toBe("MCP");
    expect(toolSourceLabel("other")).toBe("其它");
  });

  it("字数与 token 估算同主进程口径", () => {
    expect(charCountLabel(11_838)).toBe("11,838 字");
    expect(tokenEstimateFromChars(0)).toBe(0);
    expect(tokenEstimateFromChars(1)).toBe(1);
    expect(tokenEstimateFromChars(11_838)).toBe(2_960);
  });

  it("角色标签与占比", () => {
    expect(roleLabel("user")).toBe("用户消息");
    expect(roleLabel("toolResult")).toBe("工具结果");
    expect(roleLabel("system")).toBe("系统消息（首条）");
    expect(roleLabel("weird")).toBe("weird");
    expect(roleShare(50, 200)).toBe(25);
    expect(roleShare(1, 0)).toBe(0);
  });
});

describe("compositionSegments", () => {
  const usage: ContextUsage = {
    tokens: 118_600,
    contextWindow: 200_000,
    percent: 59.3,
    cacheHitRate: 94.2,
    breakdown: { system: 2_960, tools: 6_248, messages: 108_900 }
  };

  it("按三段合计计算占比，不混用窗口总量", () => {
    const segments = compositionSegments(usage);
    expect(segments.map((segment) => segment.id)).toEqual(["system", "tools", "messages"]);
    expect(segments.reduce((sum, segment) => sum + segment.percent, 0)).toBeCloseTo(100, 5);
    expect(segments[2]!.percent).toBeGreaterThan(90);
  });

  it("没有明细/全零时返回空数组（页面隐藏堆叠条）", () => {
    expect(compositionSegments(undefined)).toEqual([]);
    expect(compositionSegments({ ...usage, breakdown: { system: 0, tools: 0, messages: 0 } })).toEqual([]);
  });
});

describe("usagePercentText", () => {
  it("保留一位小数，未知显示破折号", () => {
    expect(usagePercentText({ tokens: 10, contextWindow: 100, percent: 59.34, cacheHitRate: null })).toBe("59.3%");
    expect(usagePercentText({ tokens: null, contextWindow: 100, percent: null, cacheHitRate: null })).toBe("—");
    expect(usagePercentText(undefined)).toBe("—");
  });
});
