import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 电脑控制模式开关的会话级持久化，落
 * `chatanytime-sessions/<agentId>/computer-mode/<sessionId>.json`（原子 tmp+rename），
 * 与 design-mode-store 同构。
 *
 * 为什么是会话级：本开关决定 computer_* 五个工具是否进本次请求的活动工具集。
 * 工具数组是每请求前缀成本的一部分——五个 computer_* 定义实测 ≈580 tokens
 * （windows 64 / screenshot 111 / click 205 / type 97 / press 101），而绝大多数
 * 会话（写代码、查资料、整理文档）根本不会操作桌面窗口，不该替它付这份钱。
 * 工具集一旦随会话说变就变会整段失效前缀缓存，所以状态必须跟着会话冻结。
 *
 * 与 settings.computer.enabled 的关系：那个是全局总闸（缺省启用，设置页可关），
 * 关掉时任何会话都不给电脑控制工具（能力下架）；本开关是会话级意愿（本会话要
 * 不要操作用户的桌面），两者都满足才注入。
 */

interface ComputerModeFile {
  enabled: boolean;
}

/** 读取会话电脑控制模式开关；缺失/损坏一律按关闭处理（新会话默认不开）。 */
export function readComputerMode(filePath: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return Boolean(parsed && typeof parsed === "object" && (parsed as ComputerModeFile).enabled === true);
  } catch {
    return false;
  }
}

/** 原子写入会话电脑控制模式开关（tmp + rename）。 */
export function writeComputerMode(filePath: string, enabled: boolean): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ enabled } satisfies ComputerModeFile, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}
