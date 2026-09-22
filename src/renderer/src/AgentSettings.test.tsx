// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProfile, ModelOption, ProviderOption, ResourceCatalog } from "../../shared/protocol";
import { AgentSettings } from "./AgentSettings";

/**
 * 角色页（设置页「Agent 角色」tab）的结构钩子契约 + 关键行为回归网。
 *
 * 为什么需要：本轮（2026-09-22）把这一页从 App.tsx 抽出并重排，顺带新增了两个
 * 主题契约钩子（`data-pane="agent-settings"` 与 `data-control="agent-new"` /
 * `agent-save`）。这几个字符串是**公开主题 API**，五处镜像（AGENTS.md、
 * docs/theme-guide.md、pidesktop-theme-creator 的 SKILL.md 与 check_theme.py、
 * 源码）必须与这里一致——与 GalleryWall.test.tsx / SshFilesPanel.test.tsx 同一口径。
 *
 * 同时钉住三件容易在后续改动里静默坏掉的事：
 * ① 分区卡片必须存在（重排的核心诉求就是「有分区」）；
 * ② 「使用中」徽标只标在快照 agentId 那个角色上；
 * ③ 角色列表搜索与 Skill 搜索真的在过滤。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const tools: AgentProfile["tools"] = { read: true, bash: true, powershell: false, edit: true, write: true, grep: true, find: true, ls: true };

const agents: AgentProfile[] = [
  { id: "default", name: "默认助手", description: "通用任务", systemPrompt: "你是默认助手。", divMode: "auto", defaultThinkingLevel: "medium", tools },
  { id: "heiyuhe", name: "黑鱼河", description: "本项目的更新者", systemPrompt: "你是黑鱼河。", divMode: "auto", defaultThinkingLevel: "high", tools, skillOverrides: { "skill:notes": false }, toolOverrides: { ssh: false } }
];

const resources: ResourceCatalog = {
  skills: [
    { id: "skill:computer-use", name: "电脑控制", description: "操作桌面窗口", source: "随应用分发", scope: "bundled", defaultEnabled: true, enabled: true, toggleable: true, disableModelInvocation: false },
    { id: "skill:code-review", name: "code-review", description: "审查代码变更", source: "用户资源", scope: "global", defaultEnabled: true, enabled: true, toggleable: true, disableModelInvocation: false },
    { id: "skill:notes", name: "project-notes", description: "整理项目文档", source: "当前项目", scope: "project", defaultEnabled: true, enabled: true, toggleable: true, disableModelInvocation: false },
    // 补足到 >8 个：搜索框在 Skill 较多时才渲染（与设置页模型列表同一做法），
    // 这条阈值本身就是被测对象之一。
    ...["archify", "rolldek-image", "md-to-pdf", "find-skills", "typesafe-ai", "web-tasks"].map((name, index) => ({
      id: `skill:${name}`,
      name,
      description: `辅助能力 ${name}`,
      source: "用户资源",
      scope: "global" as const,
      defaultEnabled: index % 2 === 0,
      enabled: true,
      toggleable: true,
      disableModelInvocation: false
    })),
    // 运行时动态提供的 Skill（不可切换）：批量全选/全不选不得写它的键。
    { id: "skill:runtime-dynamic", name: "runtime-dynamic", description: "运行时动态提供", source: "当前项目", scope: "project", defaultEnabled: true, enabled: true, toggleable: false, disableModelInvocation: false }
  ],
  commands: [],
  mcpServers: [
    { name: "docs", scope: "project", transport: "stdio", command: "npx", status: "connected", toolCount: 8, disabled: false },
    { name: "figma", scope: "global", transport: "http", url: "https://mcp.figma.com/mcp", auth: "oauth", status: "disabled", toolCount: 0, disabled: true }
  ],
  todos: [],
  memory: [],
  subagents: [],
  hooks: [],
  hooksEnabled: true,
  automation: [],
  automationRuns: [],
  gallery: [],
  diagnostics: []
};

const models: ModelOption[] = [{ provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: ["text"], imageInput: false, configured: true }];
const providers: ProviderOption[] = [{ id: "anthropic", name: "Anthropic", configured: true }];

interface Handlers {
  selects: string[];
  creates: number;
  saved: number;
  duplicated: number;
  archived: number;
  updates: Array<Partial<AgentProfile>>;
  skillOverride: Array<[string, boolean]>;
  toolOverride: Array<[string, boolean]>;
}

function render(overrides: { activeAgentId?: string; selectedAgentId?: string; agents?: AgentProfile[] } = {}): Handlers {
  const handlers: Handlers = { selects: [], creates: 0, saved: 0, duplicated: 0, archived: 0, updates: [], skillOverride: [], toolOverride: [] };
  act(() => {
    root.render(
      <AgentSettings
        agents={overrides.agents ?? agents}
        activeAgentId={overrides.activeAgentId ?? "default"}
        selectedAgentId={overrides.selectedAgentId ?? "default"}
        models={models}
        providers={providers}
        resources={resources}
        onSelect={(id) => handlers.selects.push(id)}
        onCreate={() => { handlers.creates += 1; }}
        onUpdate={(patch) => handlers.updates.push(patch)}
        onUpdateSkillOverride={(id, enabled) => handlers.skillOverride.push([id, enabled])}
        onUpdateToolOverride={(key, enabled) => handlers.toolOverride.push([key, enabled])}
        onSave={() => { handlers.saved += 1; }}
        onDuplicate={() => { handlers.duplicated += 1; }}
        onArchive={() => { handlers.archived += 1; }}
      />
    );
  });
  return handlers;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("角色页主题钩子契约", () => {
  it("带区域钩子与两个控件钩子", () => {
    render();
    expect(container.querySelector('[data-pane="agent-settings"]')).not.toBeNull();
    expect(container.querySelector('[data-control="agent-new"]')).not.toBeNull();
    expect(container.querySelector('[data-control="agent-save"]')).not.toBeNull();
  });

  it("六个分区卡片都在（重排的核心诉求：有明确分区）", () => {
    render();
    const sections = [...container.querySelectorAll(".agent-card")].map((card) => card.getAttribute("aria-label"));
    expect(sections).toEqual(["身份", "人格与系统提示词", "对话行为", "技能", "扩展能力", "内建工具权限"]);
  });

  it("操作条与编辑器主体是并列的两个子节点（保存条固定在顶部、不被滚走的结构前提）", () => {
    render();
    const editor = container.querySelector(".agent-editor")!;
    const children = [...editor.children].map((child) => child.className);
    expect(children[0]).toContain("agent-editor-bar");
    expect(children[1]).toContain("agent-editor-body");
  });
});

describe("角色列表", () => {
  it("「使用中」徽标只出现在快照 agentId 那一行", () => {
    render({ activeAgentId: "heiyuhe", selectedAgentId: "default" });
    const badges = container.querySelectorAll(".agent-rail-live");
    expect(badges.length).toBe(1);
    expect(badges[0]!.closest(".agent-rail-item")!.textContent).toContain("黑鱼河");
  });

  it("搜索框按名称与说明过滤，未命中时给空态", () => {
    render();
    const search = container.querySelector<HTMLInputElement>('[aria-label="搜索角色"]')!;
    type(search, "更新者");
    expect(container.querySelectorAll(".agent-rail-item").length).toBe(1);
    type(search, "不存在的角色");
    expect(container.querySelectorAll(".agent-rail-item").length).toBe(0);
    expect(container.querySelector(".agent-rail-empty")).not.toBeNull();
    // 空态不能把「新建角色」也一起藏掉，否则用户被卡死
    expect(container.querySelector('[data-control="agent-new"]')).not.toBeNull();
  });

  it("归档角色不进入列表", () => {
    render({ agents: [...agents, { ...agents[1]!, id: "old", name: "旧角色", archived: true }] });
    expect(container.textContent).not.toContain("旧角色");
  });

  it("点击角色行回传 id", () => {
    const handlers = render();
    click(container.querySelectorAll(".agent-rail-item")[1]!);
    expect(handlers.selects).toEqual(["heiyuhe"]);
  });
});

describe("Skill 与工具开关", () => {
  it("Skill overlay 生效：被角色关掉的 Skill 不出现在已选 chips", () => {
    render({ selectedAgentId: "heiyuhe" });
    const chips = [...container.querySelectorAll(".agent-chip")].map((chip) => chip.textContent);
    expect(chips.some((text) => text!.includes("电脑控制"))).toBe(true);
    expect(chips.some((text) => text!.includes("project-notes"))).toBe(false);
  });

  it("Skill 搜索按名称与说明过滤（Skill 较多时才渲染搜索框，与模型列表同一阈值）", () => {
    render();
    const search = container.querySelector<HTMLInputElement>('[aria-label="搜索 Skill"]');
    expect(search, "Skill > 8 时应渲染搜索框").not.toBeNull();
    type(search!, "审查");
    const names = [...container.querySelectorAll(".agent-picker-list .agent-check-name")].map((node) => node.textContent);
    expect(names).toEqual(["code-review"]);
    // 说明也能命中（搜「辅助能力」能捞到那批占位 Skill）
    type(search!, "辅助能力 archify");
    expect([...container.querySelectorAll(".agent-picker-list .agent-check-name")].map((node) => node.textContent)).toEqual(["archify"]);
  });

  it("能力工具 overlay：ssh 显式禁用后开关为未勾选，浏览器缺省为勾选", () => {
    render({ selectedAgentId: "heiyuhe" });
    const rows = [...container.querySelectorAll(".agent-switch-row")];
    const sshRow = rows.find((row) => row.textContent!.includes("SSH"))!;
    const browserRow = rows.find((row) => row.textContent!.includes("浏览器"))!;
    expect(sshRow.querySelector<HTMLInputElement>("input")!.checked).toBe(false);
    expect(browserRow.querySelector<HTMLInputElement>("input")!.checked).toBe(true);
  });

  it("切换开关回传 overlay 键（MCP 用 mcp:<server> 键域）", () => {
    const handlers = render();
    const rows = [...container.querySelectorAll(".agent-switch-row")];
    const mcpRow = rows.find((row) => row.textContent!.includes("docs"))!;
    click(mcpRow.querySelector("input")!);
    expect(handlers.toolOverride).toEqual([["mcp:docs", false]]);
  });

  it("全选/全不选一次性提交完整 overlay，不碰运行时动态提供的 Skill", () => {
    const handlers = render();
    const byText = (text: string) => [...container.querySelectorAll("button")].find((button) => button.textContent!.includes(text))!;
    const toggleableIds = resources.skills.filter((skill) => skill.toggleable).map((skill) => skill.id);
    click(byText("全选"));
    // 关键回归点：必须是一次 patch 带上全部可切换键——旧的循环逐键写法会在
    // 同一事件里用旧闭包互相覆盖，最终只剩最后一个技能生效（真机实测）。
    expect(handlers.updates.length).toBe(1);
    expect(Object.keys(handlers.updates[0]!.skillOverrides!).sort()).toEqual([...toggleableIds].sort());
    expect(Object.values(handlers.updates[0]!.skillOverrides!).every((value) => value === true)).toBe(true);
    click(byText("全不选"));
    expect(handlers.updates.length).toBe(2);
    expect(Object.values(handlers.updates[1]!.skillOverrides!).every((value) => value === false)).toBe(true);
  });

  it("恢复默认 = 清空角色级 overlay（回到各 Skill 自身 defaultEnabled）", () => {
    const handlers = render({ selectedAgentId: "heiyuhe" });
    const byText = (text: string) => [...container.querySelectorAll("button")].find((button) => button.textContent!.includes(text))!;
    // heiyuhe 预置了 skillOverrides，按钮应可用
    expect((byText("恢复默认") as HTMLButtonElement).disabled).toBe(false);
    click(byText("恢复默认"));
    expect(handlers.updates).toEqual([{ skillOverrides: undefined }]);
  });

  it("单键勾选回传 overlay 键；运行时动态 Skill 的勾选框禁用", () => {
    const handlers = render();
    const rows = [...container.querySelectorAll(".agent-picker-list label.agent-check")];
    const dynamicRow = rows.find((row) => row.textContent!.includes("runtime-dynamic"))!;
    expect(dynamicRow.querySelector<HTMLInputElement>("input")!.disabled).toBe(true);
    const target = rows.find((row) => row.textContent!.includes("rolldek-image"))!;
    click(target.querySelector("input")!);
    expect(handlers.skillOverride).toEqual([["skill:rolldek-image", true]]);
  });

  it("内建工具勾选回写 tools；MCP 已停用的服务器仍可见（带说明）", () => {
    render();
    const inputs = [...container.querySelectorAll<HTMLInputElement>(".agent-tool-grid input")];
    // 8 个内建工具：read/bash/powershell/edit/write/grep/find/ls，powershell 缺省关
    expect(inputs.length).toBe(8);
    expect(inputs.filter((input) => input.checked).length).toBe(7);
    const figmaRow = [...container.querySelectorAll(".agent-switch-row")].find((row) => row.textContent!.includes("figma"))!;
    expect(figmaRow.textContent).toContain("已在 MCP 设置中停用");
  });
});

describe("操作条", () => {
  it("默认角色的归档按钮禁用（不能归档 default）", () => {
    render({ selectedAgentId: "default" });
    const archive = [...container.querySelectorAll("button")].find((button) => button.textContent!.includes("归档"))!;
    expect((archive as HTMLButtonElement).disabled).toBe(true);
  });

  it("非默认角色可归档，且保存/复制回传", () => {
    const handlers = render({ selectedAgentId: "heiyuhe" });
    const byText = (text: string) => [...container.querySelectorAll("button")].find((button) => button.textContent!.includes(text))!;
    expect((byText("归档") as HTMLButtonElement).disabled).toBe(false);
    click(byText("保存角色"));
    click(byText("复制"));
    expect([handlers.saved, handlers.duplicated]).toEqual([1, 1]);
  });
});
