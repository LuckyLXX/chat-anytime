import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 设计模式开关的会话级持久化，落 `chatanytime-sessions/<agentId>/design-mode/<sessionId>.json`
 * （原子 tmp+rename），与 plan-store 同构。
 *
 * 为什么是会话级：设计模式决定 design_* 工具是否进本次请求的活动工具集（前缀
 * 缓存纪律：工具数组是每请求前缀成本的一部分，8 个设计工具≈1.5K tokens，不
 * 进设计模式的会话不该替它付这份钱）。工具集一旦随会话说变就变会整段失效前缀
 * 缓存，所以状态必须跟着会话冻结——用户在设计会话里连续工作时工具集不变，切
 * 到别的会话也不受牵连（plan-store 同款理由）。
 *
 * 与 settings.design.enabled 的关系：那个是全局总闸（缺省启用，设置页可关），
 * 关掉时任何会话都不给设计工具；本开关是会话级意愿，两者都满足才注入。
 */

interface DesignModeFile {
  enabled: boolean;
}

/** 读取会话设计模式开关；缺失/损坏一律按关闭处理（新会话默认不进设计模式）。 */
export function readDesignMode(filePath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return Boolean(parsed && typeof parsed === "object" && (parsed as DesignModeFile).enabled === true);
  } catch {
    return false;
  }
}

/** 原子写入会话设计模式开关（tmp + rename）。 */
export function writeDesignMode(filePath: string, enabled: boolean): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ enabled } satisfies DesignModeFile, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}
