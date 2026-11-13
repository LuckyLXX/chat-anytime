import type { ContextToolDeclaration, ContextUsage } from "../../../shared/protocol";

/**
 * 上下文中心的纯展示函数：工具分组、标签、占比。
 *
 * 分组是**渲染端**的事：主进程只给出 source（builtin/app/mcp/other）与名字，
 * 具体展示成「任务与记忆 / 浏览器 / SSH」这类用户语言由 UI 决定，改文案不动协议。
 */

export interface ToolGroup {
  id: string;
  label: string;
  tools: ContextToolDeclaration[];
  /** 组内 token 合计（本地估算，页面带 ~ 前缀展示）。 */
  tokens: number;
}

interface GroupRule {
  id: string;
  label: string;
  match(tool: ContextToolDeclaration): boolean;
}

/** 顺序即页面上的分组顺序；第一条命中的规则生效。 */
const GROUP_RULES: readonly GroupRule[] = [
  { id: "builtin", label: "内置工具", match: (tool) => tool.source === "builtin" },
  { id: "tasks", label: "任务与记忆", match: (tool) => /^(memory_|todo_|ask_|delegate_)/u.test(tool.name) },
  { id: "automation", label: "自动化", match: (tool) => tool.name.startsWith("automation_") },
  { id: "browser", label: "浏览器", match: (tool) => tool.name.startsWith("browser_") },
  { id: "ssh", label: "SSH", match: (tool) => tool.name.startsWith("ssh_") },
  { id: "team", label: "团队协作", match: (tool) => tool.name.startsWith("team_") },
  { id: "design", label: "设计与脚本", match: (tool) => tool.name.startsWith("design_") || tool.name === "codemode" },
  { id: "mcp", label: "MCP", match: (tool) => tool.source === "mcp" },
  { id: "app", label: "应用工具", match: (tool) => tool.source === "app" },
  { id: "other", label: "其它", match: () => true }
];

/** 按规则分组；空组不返回（页面上没有内容的组不该占位置）。 */
export function groupToolDeclarations(tools: readonly ContextToolDeclaration[]): ToolGroup[] {
  const buckets = new Map<string, ContextToolDeclaration[]>();
  for (const tool of tools) {
    const rule = GROUP_RULES.find((entry) => entry.match(tool));
    const id = rule?.id ?? "other";
    const bucket = buckets.get(id);
    if (bucket) bucket.push(tool);
    else buckets.set(id, [tool]);
  }
  return GROUP_RULES.flatMap((rule) => {
    const bucket = buckets.get(rule.id);
    if (!bucket || bucket.length === 0) return [];
    return [{
      id: rule.id,
      label: rule.label,
      tools: bucket,
      tokens: bucket.reduce((sum, tool) => sum + tool.tokens, 0)
    }];
  });
}

/** 暴露方式的中文标签（决定是否进入请求前缀）。 */
export function toolExposureLabel(exposure: ContextToolDeclaration["exposure"]): string {
  switch (exposure) {
    case "direct":
      return "直连";
    case "codemode":
      return "脚本曝光";
    case "deferred":
      return "延迟曝光";
    default:
      return "未知曝光";
  }
}

/** 工具来源的中文标签。 */
export function toolSourceLabel(source: ContextToolDeclaration["source"]): string {
  switch (source) {
    case "builtin":
      return "内置";
    case "app":
      return "应用注入";
    case "mcp":
      return "MCP";
    default:
      return "其它";
  }
}

/** `11838` → `11,838 字`。 */
export function charCountLabel(chars: number): string {
  return `${chars.toLocaleString("en-US")} 字`;
}

/** 与主进程同口径的字符估算（ceil(chars/4)）；只用于页面上的 ~token 小字。 */
export function tokenEstimateFromChars(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / 4);
}

export interface CompositionSegment {
  id: "system" | "tools" | "messages";
  label: string;
  value: number;
  /** 占「三段明细合计」的百分比（不是占窗口——与使用说明一致）。 */
  percent: number;
}

/**
 * 三段明细的堆叠条。分母用三段合计（明细自己的构成），不是上下文窗口：
 * 总量与明细不同源，混用会做出一个「加起来不等于 100%」的条。
 */
export function compositionSegments(usage: ContextUsage | undefined): CompositionSegment[] {
  const breakdown = usage?.breakdown;
  if (!breakdown) return [];
  const total = breakdown.system + breakdown.tools + breakdown.messages;
  if (total <= 0) return [];
  return [
    { id: "system", label: "系统提示词", value: breakdown.system, percent: (breakdown.system / total) * 100 },
    { id: "tools", label: "工具声明", value: breakdown.tools, percent: (breakdown.tools / total) * 100 },
    { id: "messages", label: "对话消息", value: breakdown.messages, percent: (breakdown.messages / total) * 100 }
  ];
}

export function roleLabel(role: string): string {
  switch (role) {
    case "user":
      return "用户消息";
    case "assistant":
      return "助手消息";
    case "toolResult":
      return "工具结果";
    case "system":
      return "系统消息（首条）";
    default:
      return role;
  }
}

/** 角色表的占比条：以消息段总量为分母（系统消息也计入，与 Pi 口径一致）。 */
export function roleShare(tokens: number, total: number): number {
  if (total <= 0) return 0;
  return (tokens / total) * 100;
}

/** 页面左上角的「当前会话导航摘要」用：整数百分比，无数据时 `—`。 */
export function usagePercentText(usage: ContextUsage | undefined): string {
  if (!usage || usage.percent == null) return "—";
  return `${Math.round(usage.percent * 10) / 10}%`;
}
