import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 团队模式开关的会话级持久化，落
 * `chatanytime-sessions/<agentId>/team-mode/<sessionId>.json`（原子 tmp+rename），
 * 与 computer-mode-store 同构。
 *
 * 为什么是会话级：本开关决定 team_* 九个工具是否进本次请求的活动工具集。工具数组
 * 是每请求前缀成本的一部分，而绝大多数会话（写代码、查资料、整理文档）不需要
 * 一支智能体团队，不该替它付这份钱。工具集一旦随会话说变就变会整段失效前缀缓存，
 * 所以状态必须跟着会话冻结。
 *
 * 与电脑控制模式的不同：本开关是纯会话意愿，没有全局总闸（MVP）；默认关闭，
 * 只有 session.new 显式继承。关掉只撤工具，不停止已创建的成员。
 */

interface TeamModeFile {
  enabled: boolean;
}

/** 读取会话团队模式开关；缺失/损坏一律按关闭处理（新会话默认不开）。 */
export function readTeamMode(filePath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return Boolean(parsed && typeof parsed === "object" && (parsed as TeamModeFile).enabled === true);
  } catch {
    return false;
  }
}

/** 原子写入会话团队模式开关（tmp + rename）。 */
export function writeTeamMode(filePath: string, enabled: boolean): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ enabled } satisfies TeamModeFile, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}
