import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Plan mode persistence, session-scoped at
 * `chatanytime-sessions/<agentId>/plans/<sessionId>.json` (atomic tmp+rename).
 * The store holds only the enabled flag — the plan itself lives in the
 * session transcript as the exit_plan_mode tool-call argument (reconstructable
 * from the log), per the deepseek-harness "one home per fact" decision.
 * Approved plans are additionally written to `<workspace>/docs/plans/` by the
 * main-process side of the approval (never by the model), so planning keeps
 * zero write side effects until the user approves.
 */

interface PlanModeFile {
  enabled: boolean;
}

/** 批准后计划落盘目录（相对工作区）。 */
export const PLANS_DIR = "docs/plans";

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/gu;

/**
 * 派生落盘文件名：优先取计划首个 markdown 标题（`# xxx`），否则回落为
 * 「plan」。净化路径分隔符与 Windows 非法字符，防目录穿越。
 */
export function planFileName(plan: string, date = new Date()): string {
  const heading = /^#\s+(.+?)\s*$/mu.exec(plan.trim());
  const base = heading?.[1]?.trim() || "plan";
  const safe = base.replace(INVALID_FILENAME_CHARS, "-").replace(/\s+/gu, "-").replace(/-+/gu, "-").replace(/\.md$/iu, "").replace(/^[-.]+|[-.]+$/gu, "").slice(0, 80);
  const stamp = date.toISOString().slice(0, 10);
  return `${stamp}-${safe || "plan"}.md`;
}

/** 读取会话计划模式开关；缺失/损坏一律按关闭处理。 */
export function readPlanMode(filePath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return Boolean(parsed && typeof parsed === "object" && (parsed as PlanModeFile).enabled === true);
  } catch {
    return false;
  }
}

/** 原子写入会话计划模式开关（tmp + rename）。 */
export function writePlanMode(filePath: string, enabled: boolean): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ enabled } satisfies PlanModeFile, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

/**
 * 批准时把计划写入 `<workspace>/docs/plans/YYYY-MM-DD-<title>.md`。
 * 返回保存后的相对路径；失败返回错误信息（不抛——留档是次要能力，
 * 批准本身不以落盘成败为转移）。
 */
export function saveApprovedPlan(workspace: string, plan: string): { path: string } | { error: string } {
  try {
    const dir = join(workspace, PLANS_DIR);
    mkdirSync(dir, { recursive: true });
    // 同日同名已存在时追加序号，不覆盖旧留档。
    const base = planFileName(plan);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : ".md";
    let candidate = base;
    for (let index = 2; existsSync(join(dir, candidate)); index++) {
      candidate = `${stem}-${index}${ext}`;
    }
    const filePath = join(dir, candidate);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${plan.trimEnd()}\n`, "utf8");
    renameSync(tempPath, filePath);
    return { path: join(PLANS_DIR, candidate) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}