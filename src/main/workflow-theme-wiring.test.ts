import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 工作流编排的主题接线契约（2026-11-19，方案 §9 / §10 步骤八）。
 *
 * 两件事在这里钉住：
 *
 * 1. `ResourceCatalog.workflows` 是**轻量目录**（`{workspace?, items}`，只有
 *    id/名称/用途/节点数/可运行/问题计数）：全文走 `workflow.get`，否则每次资源刷新
 *    都会把 32×8000 字的节点 prompt 复制一遍。空目录、构建器、demo 与渲染端兜底
 *    空目录必须同形状，漏一处就是「目录读不到」或「整包定义进快照」。
 *
 * 2. 主题钩子的**五处镜像**（AGENTS.md / docs/theme-guide.md / 内置 skill 的
 *    SKILL.md / references/variables.md / scripts/check_theme.py）必须同时含有工作流
 *    与 composer 状态条的钩子。测试不手抄清单，而是从**组件源码**里抽出实际的
 *    `data-pane` / `data-control` / `data-composer-zone` 取值再逐处比对——组件新增控件
 *    却漏写镜像时会在这里失败，而不是等主题作者用拼错的钩子静默失效。
 *
 * 行尾：本地工作区 LF、CI 检出 CRLF，读入即归一化。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");
const normalize = (body: string): string => body.replace(/\r\n/gu, "\n");

const protocol = read("../shared/protocol.ts");
const workflowProtocol = read("../shared/workflow-protocol.ts");
const resourceCatalog = read("resource-catalog.ts");
const runtime = read("pi-runtime.ts");
const store = read("../renderer/src/store.ts");
const demoApi = read("../renderer/src/demo-api.ts");

const workflowCenter = read("../renderer/src/WorkflowCenter.tsx");
const workflowCanvas = read("../renderer/src/components/WorkflowCanvas.tsx");
const workflowInspector = read("../renderer/src/components/WorkflowNodeInspector.tsx");
const workflowRunDetails = read("../renderer/src/components/WorkflowRunDetails.tsx");
const workflowRunStrip = read("../renderer/src/components/WorkflowRunStrip.tsx");
const conversationPane = read("../renderer/src/ConversationPane.tsx");
const teamStrip = read("../renderer/src/components/TeamStrip.tsx");
const app = read("../renderer/src/App.tsx");

const MIRRORS = [
  "../../AGENTS.md",
  "../../docs/theme-guide.md",
  "../../resources/skills/pidesktop-theme-creator/SKILL.md",
  "../../resources/skills/pidesktop-theme-creator/references/variables.md",
  "../../resources/skills/pidesktop-theme-creator/scripts/check_theme.py"
] as const;
const mirrorBodies = MIRRORS.map((mirror) => normalize(read(mirror)));

/** 组件里实际写出的某类钩子取值（去重、稳定排序）。 */
function hookValues(source: string, attribute: "pane" | "control" | "composer-zone"): string[] {
  const pattern = new RegExp(`data-${attribute}="([a-z0-9-]+)"`, "gu");
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1]!))].sort();
}

/** 钩子名在文本里必须是一个完整 token（`workflow-run` 不能被 `workflow-run-start` 冒充）。 */
function containsHook(body: string, name: string): boolean {
  return new RegExp(`(?<![a-z0-9-])${name}(?![a-z0-9-])`, "u").test(body);
}

/** 从 check_theme.py 里取出 `NAME = frozenset({...})` 的实际取值集合。 */
function checkerSet(source: string, name: string): Set<string> {
  const match = new RegExp(`${name} = frozenset\\(\\{([\\s\\S]*?)\\}\\)`, "u").exec(source);
  if (!match) throw new Error(`check_theme.py 里找不到 ${name}`);
  return new Set([...match[1]!.matchAll(/"([a-z0-9-]+)"/gu)].map((item) => item[1]!));
}

const workflowPaneSources: Array<{ hook: string; owner: string; body: string }> = [
  { hook: "workflow-center", owner: "WorkflowCenter.tsx", body: workflowCenter },
  { hook: "workflow-list", owner: "WorkflowCenter.tsx", body: workflowCenter },
  { hook: "workflow-main", owner: "WorkflowCenter.tsx", body: workflowCenter },
  { hook: "workflow-runs", owner: "WorkflowCenter.tsx", body: workflowCenter },
  { hook: "workflow-canvas", owner: "components/WorkflowCanvas.tsx", body: workflowCanvas },
  { hook: "workflow-inspector", owner: "components/WorkflowNodeInspector.tsx", body: workflowInspector },
  { hook: "workflow-run-details", owner: "components/WorkflowRunDetails.tsx", body: workflowRunDetails },
  { hook: "workflow-run-strip", owner: "components/WorkflowRunStrip.tsx", body: workflowRunStrip },
  { hook: "composer-status-stack", owner: "ConversationPane.tsx", body: conversationPane }
];

const workflowControls = [
  ...new Set([
    ...hookValues(workflowCenter, "control"),
    ...hookValues(workflowCanvas, "control"),
    ...hookValues(workflowInspector, "control"),
    ...hookValues(workflowRunDetails, "control"),
    ...hookValues(workflowRunStrip, "control"),
    ...hookValues(app, "control"),
    ...hookValues(conversationPane, "control")
  ].filter((value) => value.startsWith("workflow-")))
].sort();

const composerZones = [
  ...new Set([
    ...hookValues(conversationPane, "composer-zone"),
    ...hookValues(workflowRunStrip, "composer-zone"),
    ...hookValues(teamStrip, "composer-zone")
  ].filter((value) => value === "status-stack" || value === "workflow" || value === "team"))
].sort();

describe("资源目录：workflows 轻量目录", () => {
  it("协议层声明 {workspace?, items}，且 items 只是摘要", () => {
    expect(protocol).toContain("workflows: { workspace?: string; items: WorkflowSummary[] };");
    // 渲染端/主进程都从 protocol 取这个类型（workflow-protocol 是唯一定义处）。
    expect(protocol).toContain('export type { WorkflowCommand, WorkflowResult, WorkflowRunsSnapshot, WorkflowSummary, WorkflowRunSummary } from "./workflow-protocol.js";');
    expect(workflowProtocol).toContain("export interface WorkflowSummary {");
    // 摘要字段就是这几个：全文（nodes/edges/prompt）不在目录层出现。
    const summary = /export interface WorkflowSummary \{([\s\S]*?)\n\}/u.exec(workflowProtocol)?.[1] ?? "";
    expect(summary).toContain("nodeCount");
    expect(summary).toContain("runnable");
    expect(summary).toContain("issueCount");
    expect(summary).not.toContain("nodes:");
    expect(summary).not.toContain("prompt");
  });

  it("构建器与空目录常量的形状一致（缺省 workspace 时不写这个键）", () => {
    expect(resourceCatalog).toContain("export const emptyResourceCatalog: ResourceCatalog = {");
    expect(resourceCatalog).toContain("workflows: { items: [] },");
    expect(resourceCatalog).toContain("input.workflows?.workspace ? { workspace: input.workflows.workspace } : {}");
    expect(resourceCatalog).toContain("items: input.workflows ? structuredClone(input.workflows.items) : []");
  });

  it("utility 发目录时带轻量工作流快照，全文留给 workflow.get", () => {
    expect(runtime).toContain("workflows: workflowCatalogItems(catalogWorkspace)");
    expect(runtime).toContain("function workflowCatalogItems(targetWorkspace: string | undefined): { workspace?: string; items: WorkflowSummary[] }");
    // 只复制摘要条目：catalog.workflows → items，不是整份定义。
    expect(runtime).toContain("return { workspace: catalog.workspace, items: catalog.workflows.map((entry) => ({ ...entry })) };");
  });

  it("渲染端兜底空目录与 demo 夹具都带 workflows（否则 demo/冷启动整块目录缺失）", () => {
    expect(store).toContain("const emptyResources: ResourceCatalog = { workflows: { items: [] }");
    expect(demoApi).toContain("const demoResources: ResourceCatalog = {");
    expect(demoApi).toContain("workflows: { items: [] }");
  });
});

describe("主题钩子：组件实际写出的钩子", () => {
  it("工作流中心 / 画布 / 检查器 / 运行详情 / 运行条各在自己的区域上", () => {
    for (const { hook, owner, body } of workflowPaneSources) {
      expect(body, `${owner} 缺少 data-pane="${hook}"`).toContain(`data-pane="${hook}"`);
    }
  });

  it("composer 状态条堆栈：容器是 composer-status-stack，分区是 status-stack", () => {
    expect(conversationPane).toContain('data-pane="composer-status-stack" data-composer-zone="status-stack"');
    // 计划 / 团队 / 工作流三条都在堆栈里，队列与输入行各自占位。
    expect(conversationPane).toContain('has-status-stack');
    expect(conversationPane).toContain("{data.planMode && (");
    expect(workflowRunStrip).toContain('data-composer-zone="workflow" data-pane="workflow-run-strip"');
  });

  it("侧栏/折叠窄条入口与工作流控件都在", () => {
    expect(app).toContain('data-control="workflow-center-open"');
    expect(workflowControls).toContain("workflow-center-open");
    expect(workflowControls).toContain("workflow-stop");
    expect(workflowControls).toContain("workflow-run-details");
    expect(workflowControls.length).toBeGreaterThanOrEqual(40);
  });
});

describe("主题钩子：五处镜像一次同步", () => {
  it("工作流与状态条的区域钩子逐处出现", () => {
    const panes = [...workflowPaneSources.map((entry) => entry.hook), "workflow-run-details", "workflow-run-strip"];
    for (const pane of panes) {
      for (const [index, mirror] of MIRRORS.entries()) {
        expect(containsHook(mirrorBodies[index]!, pane), `${mirror} 缺少 data-pane 取值 ${pane}`).toBe(true);
      }
      expect(checkerSet(mirrorBodies[4]!, "KNOWN_PANES"), `check_theme.py KNOWN_PANES 缺少 ${pane}`).toContain(pane);
    }
  });

  it("composer 分区钩子（status-stack / workflow / team）逐处出现", () => {
    expect(composerZones).toEqual(["status-stack", "team", "workflow"]);
    for (const zone of composerZones) {
      for (const [index, mirror] of MIRRORS.entries()) {
        expect(containsHook(mirrorBodies[index]!, zone), `${mirror} 缺少 data-composer-zone 取值 ${zone}`).toBe(true);
      }
      expect(checkerSet(mirrorBodies[4]!, "KNOWN_COMPOSER_ZONES"), `check_theme.py KNOWN_COMPOSER_ZONES 缺少 ${zone}`).toContain(zone);
    }
  });

  it("组件里每个 workflow-* 控件都在五处镜像里，且检查器接受", () => {
    const accepted = checkerSet(mirrorBodies[4]!, "KNOWN_CONTROLS");
    for (const control of workflowControls) {
      for (const [index, mirror] of MIRRORS.entries()) {
        expect(containsHook(mirrorBodies[index]!, control), `${mirror} 缺少 data-control 取值 ${control}`).toBe(true);
      }
      expect(accepted, `check_theme.py KNOWN_CONTROLS 缺少 ${control}`).toContain(control);
    }
  });

  it("镜像里的取值与检查器名单一致（不多写不存在的钩子）", () => {
    const panes = checkerSet(mirrorBodies[4]!, "KNOWN_PANES");
    const controls = checkerSet(mirrorBodies[4]!, "KNOWN_CONTROLS");
    const rendererSources = [
      app,
      conversationPane,
      teamStrip,
      workflowCenter,
      workflowCanvas,
      workflowInspector,
      workflowRunDetails,
      workflowRunStrip
    ].join("\n");
    const emittedPanes = new Set(hookValues(rendererSources, "pane"));
    const emittedControls = new Set(hookValues(rendererSources, "control"));
    // 反向：检查器 / 镜像里写的工作流钩子必须在源码里真实存在（残留的旧名字会被主题作者当真）。
    for (const pane of [...panes].filter((value) => value.startsWith("workflow-") || value === "composer-status-stack")) {
      expect(emittedPanes, `check_theme.py 声明了不存在的区域 ${pane}`).toContain(pane);
    }
    for (const control of [...controls].filter((value) => value.startsWith("workflow-"))) {
      expect(emittedControls, `check_theme.py 声明了不存在的控件 ${control}`).toContain(control);
    }
    for (const control of workflowControls) expect(controls).toContain(control);
  });
});

describe("主题钩子：检查器脚本真的接受组件新钩子", () => {
  it("check_theme.py 对只用工作流钩子的结构主题判通过", () => {
    const probe = spawnSync("python", ["-c", "pass"], { encoding: "utf8" });
    if (probe.error) return; // 没有 Python 的机器上跳过这一层（字符串名单断言已在上面覆盖）

    const dir = mkdtempSync(join(tmpdir(), "pidesktop-theme-hooks-"));
    try {
      const css = [
        "/* Theme Name: workflow hooks probe */",
        "/* theme type: structural */",
        ':root[data-theme-effective="light"] { --surface: #ffffff; --text: #1e293b; }',
        ':root[data-theme-effective="dark"] { --surface: #0f172a; --text: #f8fafc; }',
        // 九个区域 + 状态条容器与分区
        '[data-pane="workflow-center"] { border-right: 2px solid var(--accent); }',
        '[data-pane="workflow-list"] [data-control="workflow-open"] { border-radius: 6px; }',
        '[data-pane="workflow-main"] [data-control="workflow-save"] { color: var(--text); }',
        '[data-pane="workflow-canvas"] [data-control="workflow-node-add"] { border-radius: 6px; }',
        '[data-pane="workflow-inspector"] [data-control="workflow-rework-gate"] { color: var(--text); }',
        '[data-pane="workflow-runs"] [data-control="workflow-run-open"] { border-radius: 6px; }',
        '[data-pane="workflow-run-details"] [data-control="workflow-run-content-artifact"] { color: var(--text); }',
        '[data-pane="workflow-run-strip"] [data-control="workflow-run-dismiss"] { border-radius: 999px; }',
        '[data-pane="composer-status-stack"] [data-composer-zone="status-stack"] { gap: 4px; }',
        '[data-composer-zone="workflow"] [data-control="workflow-stop"] { color: var(--danger); }',
        '[data-composer-zone="team"] { gap: 4px; }',
        '[data-control="workflow-center-open"] { border-radius: 6px; }',
        '[data-control="workflow-inspector-workflow-tab"] { color: var(--text-muted); }',
        ""
      ].join("\n");
      const cssPath = join(dir, "theme.css");
      writeFileSync(cssPath, css, "utf8");
      const result = spawnSync("python", [join(__dirname, "../../resources/skills/pidesktop-theme-creator/scripts/check_theme.py"), cssPath], {
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("[通过]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
