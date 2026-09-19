import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { SessionSummary, ThinkingLevel } from "../shared/protocol.js";

export function workspaceHash(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 20);
}

/**
 * 置顶集合的匹配键：路径分隔符归一 + 大小写不敏感。
 *
 * 置顶是用户动作，落盘的是**当时那一刻**的路径写法；而侧边栏列表每帧由
 * `refreshSessions` 从 Pi 的列表服务重建，同一会话可能以另一种分隔符/大小写
 * 回来（Windows 盘符大小写、正反斜杠）。旧实现是 `pinnedPaths.includes(item.path)`
 * 精确比较 —— 只要两处写法差一个字符，置顶就会「看起来没生效」（Pin 图标不出现）。
 * 与 `mergeSessionSummary`/`backfillUnpersistedSessions` 的 key 口径保持一致。
 */
export function sessionPathKey(path: string): string {
  return resolve(path).replaceAll("\\", "/").toLowerCase();
}

/**
 * 规范化置顶路径数组：剔除空项/非字符串、按匹配键去重（保留首次出现顺序）。
 * 读回路径与写入路径共用，保证 settings.json 里不堆积同义重复项。
 */
export function normalizePinnedSessionPaths(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) continue;
    const key = sessionPathKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(entry);
  }
  return kept.length > 0 ? kept : undefined;
}

/**
 * 置顶/取消置顶的集合更新（不可变）。判据用匹配键而非字面量，因此：
 * ① 取消置顶时能删掉「写法略有差异」的那一条；② 重复置顶同一会话不会堆积，
 * 且保留**首次落盘的那份写法**（不因列表刷新的写法差异而改写用户目录）；
 * ③ 与本次无关的项保持原顺序。
 */
export function togglePinnedSessionPath(pinnedPaths: readonly string[] | undefined, path: string, pinned: boolean): string[] | undefined {
  const list = pinnedPaths ?? [];
  const key = sessionPathKey(path);
  const present = list.some((item) => sessionPathKey(item) === key);
  if (pinned) return normalizePinnedSessionPaths(present ? list : [...list, path]);
  if (!present) return normalizePinnedSessionPaths(list);
  return normalizePinnedSessionPaths(list.filter((item) => sessionPathKey(item) !== key));
}

/** 该会话是否在置顶集合里（大小写/分隔符无关比较，见 {@link sessionPathKey}）。 */
export function isSessionPinned(pinnedPaths: readonly string[] | undefined, path: string): boolean {
  if (!pinnedPaths || pinnedPaths.length === 0) return false;
  const key = sessionPathKey(path);
  return pinnedPaths.some((item) => sessionPathKey(item) === key);
}

export function agentWorkspaceSessionDir(agentRoot: string, agentId: string, workspace: string): string {
  return join(agentRoot, "chatanytime-sessions", agentId, workspaceHash(workspace));
}

/**
 * 会话文件名 → sessionId 匹配。Pi 的 SessionManager 以
 * `<ISO 时间戳>_<sessionId>.jsonl` 命名会话文件（session-manager.js 的
 * create/fork 落盘点同构），因此**不能**按 `<sessionId>.jsonl` 拼路径
 * （历史 bug：自动化运行记录跨角色回看永远找不到会话）；此处匹配
 * `_<sessionId>.jsonl` 结尾，同时兼容裸 `<sessionId>.jsonl`（旧文件/手工复制）。
 * `_` 锚点让「id 是另一个 id 的后缀」不会误命中；大小写不敏感（Windows 文件名
 * 不区分大小写，sessionId 本身是小写 hex）。
 */
export function sessionFileMatchesId(fileName: string, sessionId: string): boolean {
  if (!sessionId) return false;
  const name = fileName.toLowerCase();
  const id = sessionId.toLowerCase();
  return name === `${id}.jsonl` || name.endsWith(`_${id}.jsonl`);
}

export function resolveNewSessionDefaults<TModel>(hasExistingMessages: boolean, agentModel: TModel | undefined, globalModel: TModel | undefined, agentThinking: ThinkingLevel, globalThinking: ThinkingLevel): { model: TModel | undefined; thinkingLevel: ThinkingLevel | undefined } {
  if (hasExistingMessages) return { model: undefined, thinkingLevel: undefined };
  return { model: agentModel ?? globalModel, thinkingLevel: agentThinking ?? globalThinking };
}

/**
 * 会话文件是否落在该会话目录下（绝对路径 + 大小写不敏感；Windows/macOS 文件名
 * 大小写不敏感，Pi 的落盘目录由 cwd 解析而来，两侧写法可能不同）。
 */
export function sameSessionDir(expectedDir: string | undefined, actualDir: string): boolean {
  if (!expectedDir) return false;
  return resolve(expectedDir).toLowerCase() === resolve(actualDir).toLowerCase();
}

/**
 * 侧边栏「合成空话题」行的失效清理。
 *
 * 新建话题在首条 assistant 消息前**不落盘**（Pi `_persist` 挂在 hasAssistant）
 * 时，列表里的那一行完全由 live 记录合成（`ensureSessionInList` /
 * `backfillUnpersistedSessions`），**不写入任何持久状态**——所以 live 记录一旦
 * 被闲置驱逐（`MAX_PARKED_SESSIONS`）或进程重启，那一行就成了死行：文件从未
 * 存在，点击必然失败。它也不能靠「实例 id」之类的标记清理（重启后无从比对），
 * 唯一可靠的判据是：空话题（messageCount 0）且既没有活记录、文件也不存在。
 *
 * 置顶行保留：置顶是用户显式动作，宁留一行可点失败的置顶，也不静默删除用户
 * 标记过的条目（当前会话没有「取消置顶」以外的清理入口）。
 */
export function pruneVanishedSessions(
  list: SessionSummary[],
  liveFiles: readonly (string | undefined)[],
  fileExists: (path: string) => boolean
): SessionSummary[] {
  const live = new Set(liveFiles.filter((path): path is string => Boolean(path)).map((path) => resolve(path).toLowerCase()));
  const kept = list.filter((item) => {
    if (item.messageCount > 0 || item.pinned) return true;
    if (live.has(resolve(item.path).toLowerCase())) return true;
    return fileExists(item.path);
  });
  return kept.length === list.length ? list : kept;
}

/**
 * 会话列表“已就绪”不只是非空：还必须是按当前 Agent 的目录作用域拉取的。
 * 切换 Agent 后旧列表虽非空，但作用域已变，createSession 必须重拉——
 * 否则话题页会继续显示上一个角色的会话。
 */
export function sessionListReadyFor(listCount: number, listAgentId: string | undefined, agentId: string | undefined): boolean {
  return listCount > 0 && listAgentId === agentId;
}

/**
 * 侧边栏列表的稳定顺序：置顶项在前，同档按 modifiedAt 降序。
 *
 * `mergeSessionSummary` / `backfillUnpersistedSessions` 与 `refreshSessions` 原先
 * 一律按 modifiedAt 排序，而「置顶」只在渲染端分组排序时才生效 —— 结果是新会话
 * 一合并进列表就可能排在置顶项**之前**（列表自身的顺序与用户看到的顺序不一致）。
 * 排序口径统一收到这里，两端不再各自维护一套。
 */
export function sortSessionSummaries(list: readonly SessionSummary[]): SessionSummary[] {
  return [...list].sort((left, right) => (Number(right.pinned ?? false) - Number(left.pinned ?? false)) || right.modifiedAt - left.modifiedAt);
}

/**
 * 把一条会话摘要合并进侧边栏列表（内存级 upsert，不触磁盘扫描）。
 * 语义与 refreshSessions 的去重/排序完全一致：按绝对路径去重、置顶优先、同档按
 * modifiedAt 降序（见 {@link sortSessionSummaries}）。已存在的条目保持不变（精确
 * 信息由 refreshSessions 校正），仅真正新增的会话（新建话题、删除当前会话后自动
 * 补的空白会话）被插入——保证新会话创建后左侧第一时间可见，发送消息时 runStatus
 * "running" 也能通过 patchSessionRunStatus 即时打上「执行中」圆点，不再依赖全量
 * 磁盘扫描的耗时返回。
 */
export function mergeSessionSummary(list: SessionSummary[], incoming: SessionSummary): SessionSummary[] {
  const key = (item: SessionSummary) => resolve(item.path).toLowerCase();
  const keyOfIncoming = key(incoming);
  return sortSessionSummaries([...list.filter((item) => key(item) !== keyOfIncoming), incoming]);
}

/** 回填用的活跃会话最小投影（来自 liveSessions 记录，见 backfillUnpersistedSessions）。 */
export interface LiveSessionSeed {
  sessionId: string;
  path: string | undefined;
  workspace: string;
  agentId: string;
  activatedAt: number;
  title?: string;
  runStatus?: SessionSummary["runStatus"];
}

/**
 * 全量磁盘重建后的回填：会话文件直到首条 assistant 消息才落盘（Pi
 * SessionManager._persist 的 hasAssistant 门槛），新建的空会话只存在于
 * liveSessions。refreshSessions 若不回填，任何迟到的全量刷新（后台/停靠
 * 会话回合结束后的 500ms 防抖、pin/rename/delete 后的显式刷新）都会把刚建
 * 的新话题从侧边栏抹掉，直到用户发出第一条消息。已在磁盘列表中的会话不动；
 * 回填优先沿用重建前列表里的同名条目（保留重命名/置顶/圆点），否则按 seed
 * 合成；runStatus 以 live 记录为准覆盖。无回填时原样返回入参引用。
 */
export function backfillUnpersistedSessions(
  list: SessionSummary[],
  previous: readonly SessionSummary[],
  live: readonly LiveSessionSeed[],
  listAgentId: string | undefined
): SessionSummary[] {
  if (live.length === 0) return list;
  const key = (path: string) => resolve(path).toLowerCase();
  const listedKeys = new Set(list.map((item) => key(item.path)));
  const previousByKey = new Map(previous.map((item) => [key(item.path), item]));
  let next = list;
  for (const seed of live) {
    if (!seed.path || seed.agentId !== listAgentId) continue;
    const seedKey = key(seed.path);
    if (listedKeys.has(seedKey)) continue;
    listedKeys.add(seedKey);
    const prior = previousByKey.get(seedKey);
    const synthetic: SessionSummary = {
      id: seed.sessionId,
      path: seed.path,
      workspace: seed.workspace,
      title: seed.title ?? "新会话",
      modifiedAt: seed.activatedAt,
      messageCount: 0,
      // 回填行来自 live 记录，本身不知道置顶状态；但重建前列表里的同名条目知道
      //（`prior`），必须带过来 —— 否则一次全量刷新就会把置顶标记从该行抹掉。
      ...(prior?.pinned ? { pinned: true } : {})
    };
    const base = prior ?? synthetic;
    next = mergeSessionSummary(next, seed.runStatus ? { ...base, runStatus: seed.runStatus } : base);
  }
  return next;
}
