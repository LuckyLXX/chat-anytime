import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 设置页「资源三拆 + 四页两段式」接线契约（源码断言型，2026-11-23）。
 *
 * 为什么必须是源码断言：布局是渲染端展示层，happy-dom 不解析外部样式表、
 * 也不实现 grid/滚动链；真值只在真实 Chromium 里验。这里只钉「四处注册齐全」与
 * 「两栏 class 存在」，防止未来重构把三个顶层菜单又合并回一条滚动。
 *
 * 用户口径（2026-11-23）：MCP Server / Skill / 自定义命令 从原「技能与工具」
 * 拆成三个顶层设置菜单；连「子智能体」共四页全部改成「左栏逐条列表 +
 * 右栏编辑/详情」两段式，与模型服务 / Agent 角色 / 消息通道一致。
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n?/g, "\n");

const app = read("../renderer/src/App.tsx");
const resources = read("../renderer/src/ResourceSettings.tsx");
const subagents = read("../renderer/src/SubagentSettings.tsx");
const styles = read("../renderer/src/styles.css");
const guide = read("../../docs/theme-guide.md");

describe("资源设置三拆：四个顶层菜单", () => {
  it("SettingsTab 联合类型收进 mcp / skills / commands（旧 resources 保留兼容）", () => {
    expect(app).toContain('"mcp" | "skills" | "commands"');
    expect(app).toContain('"resources"');
  });

  it("左侧导航用三菜单替换「技能与工具」", () => {
    expect(app).toContain('onClick={() => setTab("mcp")}>MCP Server</button>');
    expect(app).toContain('onClick={() => setTab("skills")}>Skill</button>');
    expect(app).toContain('onClick={() => setTab("commands")}>自定义命令</button>');
    expect(app).not.toContain('>技能与工具</button>');
  });

  it("内容分支分别渲染三个两段式组件", () => {
    expect(app).toContain('tab === "mcp" ? <McpSettings resources={resources} />');
    expect(app).toContain('tab === "skills" ? <SkillSettings resources={resources} />');
    expect(app).toContain('tab === "commands" ? <CommandSettings resources={resources} />');
    expect(app).toContain('import { McpSettings, SkillSettings, CommandSettings } from "./ResourceSettings"');
  });

  it("命令面板三条都能直达", () => {
    expect(app).toContain('{ tab: "mcp", label: "MCP Server" }');
    expect(app).toContain('{ tab: "skills", label: "Skill" }');
    expect(app).toContain('{ tab: "commands", label: "自定义命令" }');
  });

  it("三个页面组件各自导出，且 ResourceSettings 仍是兼容别名", () => {
    for (const name of ["McpSettings", "SkillSettings", "CommandSettings"]) {
      expect(resources).toContain(`export function ${name}(`);
    }
    expect(resources).toContain("export { McpSettings as ResourceSettings }");
  });
});

describe("四页两段式骨架", () => {
  it("资源三页 + 子智能体页都用 .resource-split-layout / rail / detail", () => {
    for (const source of [resources, subagents]) {
      expect(source).toContain('className="resource-page resource-split-page"');
      expect(source).toContain('className="resource-split-layout"');
      expect(source).toContain('className="resource-split-rail"');
      expect(source).toContain('className="resource-split-detail"');
      expect(source).toContain('className="resource-split-detail-body"');
    }
  });

  it("滚动下移到 rail-list / detail-body，页头与详情条固定", () => {
    expect(styles).toContain(".resource-split-page .resource-split-layout { display: grid;");
    expect(styles).toContain(".resource-split-page .resource-split-rail-list { display: flex; flex: 1 1 auto; flex-direction: column; gap: 3px; min-height: 0; overflow-y: auto; }");
    expect(styles).toContain(".resource-split-page .resource-split-detail-body { display: flex; flex: 1 1 auto; flex-direction: column; gap: 11px; min-height: 0; padding: 13px 16px 18px; overflow-y: auto; }");
    expect(styles).toContain("@media (max-width: 900px) { .resource-split-page .resource-split-layout { grid-template-columns: 200px minmax(0, 1fr); } }");
  });

  it("主题文档同步描述三段式与子智能体两段式", () => {
    expect(guide).toContain(".resource-split-layout");
    expect(guide).toContain("MCP Server");
    expect(guide).toContain("自定义命令");
  });
});
