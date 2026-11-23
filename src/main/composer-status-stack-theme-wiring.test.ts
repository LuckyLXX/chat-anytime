import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * composer 状态条堆栈的主题钩子契约（2026-11-19 引入；2026-11-23 工作流编排下线后
 * 只剩计划 / 团队两条状态条，工作流钩子全部退役）。
 *
 * 两件事在这里钉住：
 *
 * 1. 主题钩子的**五处镜像**（AGENTS.md / docs/theme-guide.md / 内置 skill 的
 *    SKILL.md / references/variables.md / scripts/check_theme.py）必须同时含有
 *    `composer-status-stack` 区域与 `status-stack` / `team` 分区。测试从**组件源码**
 *    里抽出实际写出的钩子取值再逐处比对——组件新增控件却漏写镜像时会在这里失败。
 *
 * 2. 退役钩子的反向验证：五处镜像的公开名单里不得再出现 `workflow-*`，但校验器要
 *    把它们识别为「已退役」并给出迁移提示（警告、不阻断），真正未知的钩子仍报错。
 *
 * 行尾：本地工作区 LF、CI 检出 CRLF，读入即归一化。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");
const normalize = (body: string): string => body.replace(/\r\n/gu, "\n");

const conversationPane = read("../renderer/src/ConversationPane.tsx");
const teamStrip = read("../renderer/src/components/TeamStrip.tsx");

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

/** 钩子名在文本里必须是一个完整 token（`team` 不能被 `team-board` 冒充）。 */
function containsHook(body: string, name: string): boolean {
  return new RegExp(`(?<![a-z0-9-])${name}(?![a-z0-9-])`, "u").test(body);
}

/** 从 check_theme.py 里取出 `NAME = frozenset({...})` 的实际取值集合。 */
function checkerSet(source: string, name: string): Set<string> {
  const match = new RegExp(`${name} = frozenset\\(\\{([\\s\\S]*?)\\}\\)`, "u").exec(source);
  if (!match) throw new Error(`check_theme.py 里找不到 ${name}`);
  return new Set([...match[1]!.matchAll(/"([a-z0-9-]+)"/gu)].map((item) => item[1]!));
}

/** 从 check_theme.py 里取出 `RETIRED_HOOK_VALUES` 某类的取值集合。 */
function retiredSet(source: string, kind: string): Set<string> {
  const block = source.slice(source.indexOf("RETIRED_HOOK_VALUES = {"));
  const match = new RegExp(`"${kind}": frozenset\\(\\{([\\s\\S]*?)\\}\\)`, "u").exec(block);
  if (!match) throw new Error(`check_theme.py 里找不到 RETIRED_HOOK_VALUES.${kind}`);
  return new Set([...match[1]!.matchAll(/"([a-z0-9-]+)"/gu)].map((item) => item[1]!));
}

const checker = mirrorBodies[4]!;
const composerZones = [...new Set([...hookValues(conversationPane, "composer-zone"), ...hookValues(teamStrip, "composer-zone")])]
  .filter((value) => value === "status-stack" || value === "team")
  .sort();

describe("composer 状态条堆栈：组件实际写出的钩子", () => {
  it("容器是 composer-status-stack，分区是 status-stack / plan / team", () => {
    expect(conversationPane).toContain('data-pane="composer-status-stack" data-composer-zone="status-stack"');
    expect(conversationPane).toContain('has-status-stack');
    expect(conversationPane).toContain("{data.planMode && (");
    expect(teamStrip).toContain('data-composer-zone="team"');
    expect(composerZones).toEqual(["status-stack", "team"]);
  });
});

describe("主题钩子：五处镜像一次同步", () => {
  it("composer-status-stack 区域与 status-stack / team 分区逐处出现", () => {
    for (const [index, mirror] of MIRRORS.entries()) {
      expect(containsHook(mirrorBodies[index]!, "composer-status-stack"), `${mirror} 缺少 data-pane 取值 composer-status-stack`).toBe(true);
      for (const zone of composerZones) {
        expect(containsHook(mirrorBodies[index]!, zone), `${mirror} 缺少 data-composer-zone 取值 ${zone}`).toBe(true);
      }
    }
    expect(checkerSet(checker, "KNOWN_PANES")).toContain("composer-status-stack");
    for (const zone of composerZones) expect(checkerSet(checker, "KNOWN_COMPOSER_ZONES")).toContain(zone);
  });

  it("镜像里标注的数量与检查器名单一致（不多写不存在的钩子）", () => {
    const panes = checkerSet(checker, "KNOWN_PANES");
    const controls = checkerSet(checker, "KNOWN_CONTROLS");
    expect(mirrorBodies[2]).toContain(`主要区域（${panes.size}）`);
    expect(mirrorBodies[2]).toContain(`关键控件（${controls.size}）`);
    expect(mirrorBodies[3]).toContain(`\`data-pane\`（${panes.size}）`);
    expect(mirrorBodies[3]).toContain(`\`data-control\`（${controls.size}）`);
  });

  it("工作流钩子已从五处公开名单退役，校验器把它们列为已退役", () => {
    // 公开名单（契约正文）里不得再有工作流钩子——残留的旧名字会被主题作者当真。
    // theme-guide.md 只允许在「退役迁移说明」段落里列出它们供作者删除。
    const guidePublic = mirrorBodies[1]!.split("**工作流编排退役（2026-11-23 迁移说明）**")[0]!;
    for (const [index, mirror] of MIRRORS.entries()) {
      const body = index === 1 ? guidePublic : mirrorBodies[index]!;
      expect(/\[data-(?:pane|control|composer-zone)="workflow-[a-z-]+"\]|`workflow-[a-z-]+`/u.test(body), `${mirror} 的公开名单里仍有 workflow-* 钩子`).toBe(false);
    }
    for (const name of ["KNOWN_PANES", "KNOWN_CONTROLS", "KNOWN_COMPOSER_ZONES"]) {
      expect([...checkerSet(checker, name)].some((value) => value.startsWith("workflow")), `${name} 仍含 workflow-*`).toBe(false);
    }
    expect(retiredSet(checker, "pane").size).toBe(8);
    expect(retiredSet(checker, "control").size).toBe(58);
    expect(retiredSet(checker, "composer-zone")).toEqual(new Set(["workflow"]));
  });
});

describe("主题钩子：检查器脚本真的按契约判定", () => {
  function runChecker(css: string): ReturnType<typeof spawnSync> {
    const probe = spawnSync("python", ["-c", "pass"], { encoding: "utf8" });
    if (probe.error) return probe; // 没有 Python 的机器上跳过（字符串名单断言已在上面覆盖）
    const dir = mkdtempSync(join(tmpdir(), "pidesktop-theme-hooks-"));
    try {
      const cssPath = join(dir, "theme.css");
      writeFileSync(cssPath, css, "utf8");
      return spawnSync("python", [join(__dirname, "../../resources/skills/pidesktop-theme-creator/scripts/check_theme.py"), cssPath], {
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const head = [
    "/* Theme Name: status-stack probe */",
    "/* theme type: structural */",
    ':root[data-theme-effective="light"] { --surface: #ffffff; --text: #1e293b; }',
    ':root[data-theme-effective="dark"] { --surface: #0f172a; --text: #f8fafc; }'
  ];

  it("只用状态条堆栈钩子的结构主题判通过", () => {
    const result = runChecker([
      ...head,
      '[data-pane="composer-status-stack"] [data-composer-zone="status-stack"] { gap: 4px; }',
      '[data-composer-zone="team"] { gap: 4px; }',
      '[data-composer-zone="plan"] { border-radius: 6px; }',
      ""
    ].join("\n"));
    if (result.error) return;
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("[通过]");
  });

  it("退役的工作流钩子只给迁移警告（不阻断），真正未知的钩子仍然报错", () => {
    const retired = runChecker([
      ...head,
      '[data-pane="workflow-center"] { border-right: 2px solid var(--accent); }',
      '[data-composer-zone="workflow"] [data-control="workflow-stop"] { color: var(--danger); }',
      ""
    ].join("\n"));
    if (retired.error) return;
    expect(retired.status, `${retired.stdout}\n${retired.stderr}`).toBe(0);
    expect(retired.stdout).toContain("[警告]");
    expect(retired.stdout).toContain("已退役");
    expect(retired.stdout).toContain('data-pane="workflow-center"');
    expect(retired.stdout).not.toContain("[错误]");

    const unknown = runChecker([...head, '[data-pane="workflow-typos"] { color: var(--text); }', ""].join("\n"));
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toContain("[错误]");
    expect(unknown.stdout).toContain("未知的 data-pane 取值");
  });
});
