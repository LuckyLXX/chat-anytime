import type { ChatMessage, ToolExecution } from "../../../shared/protocol";

/** 带身份保留的每消息执行子集派生器：见 createMessageExecutionSubsetter。 */
export interface MessageExecutionSubsetter {
  (messages: ChatMessage[], executions: ToolExecution[]): ToolExecution[][];
}

/** 无工具调用消息的稳定空子集：避免调用处 `?? []` 每帧生成新数组击穿 memo。 */
export const EMPTY_EXECUTIONS: ToolExecution[] = [];

interface SubsetCacheEntry {
  message: ChatMessage;
  callIds: string[];
  subset: ToolExecution[];
}

/**
 * 创建「身份保留」的每消息执行子集派生器。MessageView 只消费本消息 tool-call
 * id 命中的 execution（changedFilesForMessage 按 callIds 过滤，ActionTimeline /
 * actionTimelineStats 按 call.id 查 Map），把全量 executions 传进每个气泡会让
 * 任一条 execution 流式变化时所有气泡的 executions prop 换引用、击穿 memo。
 *
 * 派生器跨帧缓存每条消息的 { message, callIds, subset }：消息引用未变（store 的
 * uuid 复用 + 分组器身份保留保证内容未变时引用稳定）、callIds 未变、子集内每条
 * execution 引用未变且命中数一致时，复用上一帧子集数组。流式期间通常只有正在
 * 执行工具的那条消息的子集换引用，历史气泡全部跳过重渲染。
 *
 * 子集按 execution 在全量数组中的顺序排列，与 changedFilesForMessage 直接遍历
 * 全量数组的语义一致（同一文件多次写入时 last-wins 取最后一次调用）。
 *
 * 实例须用 useRef 持有以跨渲染保留缓存；缓存随每次调用就地更新，与返回数组一致。
 */
export function createMessageExecutionSubsetter(): MessageExecutionSubsetter {
  let cache: SubsetCacheEntry[] = [];
  return (messages, executions) => {
    const byId = new Map(executions.map((execution) => [execution.id, execution]));
    const orderByid = new Map(executions.map((execution, index) => [execution.id, index]));
    const nextCache: SubsetCacheEntry[] = [];
    const result: ToolExecution[][] = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!;
      const callIds = message.blocks
        .filter((block): block is Extract<ChatMessage["blocks"][number], { type: "tool-call" }> => block.type === "tool-call")
        .map((block) => block.id);
      const cached = cache[index];
      if (cached
        && cached.message === message
        && cached.callIds.length === callIds.length
        && cached.callIds.every((id, position) => id === callIds[position])
        // 子集内每条 execution 引用未变（store 逐项身份保留保证内容未变时引用稳定）……
        && cached.subset.every((execution) => byId.get(execution.id) === execution)
        // ……且命中数一致（防止「删一条又新增一条」时数量巧合相等而漏更新）。
        && cached.subset.length === callIds.reduce((count, id) => count + (byId.has(id) ? 1 : 0), 0)) {
        nextCache.push(cached);
        result.push(cached.subset);
        continue;
      }
      const subset = callIds
        .map((id) => byId.get(id))
        .filter((execution): execution is ToolExecution => execution !== undefined)
        .sort((left, right) => (orderByid.get(left.id) ?? 0) - (orderByid.get(right.id) ?? 0));
      nextCache.push({ message, callIds, subset });
      result.push(subset);
    }
    cache = nextCache;
    return result;
  };
}
