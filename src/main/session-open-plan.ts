import type { SessionHeaderLine } from "./session-summary-cache.js";

export { readSessionHeaderLine, type SessionHeaderLine } from "./session-summary-cache.js";

/**
 * `session.open` 的三分支决策（2026-09-25 性能 P0）。
 *
 * 为什么要有这一步：旧实现无论目标会话是否已在内存里，都先
 * `SessionManager.open(target)` 做一次**纯探测**（只为拿 sessionId 与 cwd），
 * 而 `SessionManager.open` 的构造函数会整文件加载全部 entries
 * （`session-manager.js` 的 `loadEntriesFromFile`）。于是：
 *
 * - 切到**已在内存**的会话（分屏格子聚焦、跨助手来回切）也白付一次全文件读，
 *   探测那份解析结果随后被丢弃（`liveSessions.get(...)` 命中后只是 activate）；
 * - 冷切换（本机最大单会话 44 MB，其中 43 MB 是 toolResult 内联 base64 图片）
 *   付**两次**，≈1 s 阻塞。
 *
 * 现在先用**有界读首行**（几百字节）拿 id/cwd：live 命中零读盘，冷路径只 open
 * 一次（传 `cwdOverride` 跳过 Pi 内部那次头部复读）；只有首行读不出时（文件不
 * 存在、不是 Pi 会话、缺 cwd）才退回旧的探测路径——那条路径上的两条既有防御
 * （缺文件时 Pi 会另铸 sessionId 并把安装目录 cwd 写进助手最后工作区；会话路径
 * 与工作区不匹配）**完整保留**，它们各自对应过真实故障（2026-09-16 根因）。
 */
export type SessionOpenPlan = "live" | "cold" | "fallback";

export interface SessionOpenPlanInput {
  /** 解析后的目标会话文件绝对路径。 */
  target: string;
  /** 当前助手的会话根目录（调用方已用 pathIsWithin 校验过目标在根内）。 */
  root: string;
  /** 目标文件当前是否存在（未落盘的空话题不存在）。 */
  exists: boolean;
  /** `liveSessions` 里已有记录的 `getSessionFile()` 等于 target。 */
  liveFileMatches: boolean;
  /** 有界读首行的结果（文件不存在时为 undefined）。 */
  header: SessionHeaderLine | undefined;
}

/**
 * `target`/`root` 只作上下文（路径包含校验已由调用方在做任何全局镜像改写之前完成），
 * 判定本身只看 `exists`/`liveFileMatches`/`header`：
 *
 * - `live`：内存里就有这条记录 → 直接激活，**零读盘**（未落盘的空话题也走这里）；
 * - `cold`：文件存在且首行能给 id + cwd → 只 open 一次并传 cwdOverride；
 * - `fallback`：其余情况走旧的探测路径。
 */
export function planSessionOpen(input: SessionOpenPlanInput): SessionOpenPlan {
  if (input.liveFileMatches) return "live";
  if (input.exists && input.header && input.header.id && input.header.cwd) return "cold";
  return "fallback";
}
