// 记忆能力簇（照 runtime-todo-tools 的形态）：memory_* customTools、静态
// 治理块、会话级索引快照块。dsh 缓存哲学：动态状态不进系统提示词——快照在
// createSession 时取一次、整个会话字节冻结（与会话历史同前缀稳定）；会话内
// 的新鲜度由 memory_write / memory_list 的工具结果承担（追加在对话尾部，
// 纯追加不破坏前缀 KV cache）。没有每轮注入，也不建 before_agent_start 扩展。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryTopic } from "../shared/protocol.js";
import { memoryTopicVisibleIn, type MemoryStore } from "./memory-store.js";
import { Type } from "typebox";

const SNAPSHOT_MAX_LINES = 40;

/** 引导模型正确使用记忆工具的治理块：静态字节，enabled 时拼进 systemPromptOverride。 */
export function buildMemorySystemPromptBlock(): string {
  return [
    "【长期记忆（memory_* 工具）】",
    "何时记：用户明确说“记住/以后都这样”；重复出现的稳定偏好；明确纠错；影响未来判断的决策理由；本项目中已验证过的协作约定。",
    "何时不记：随时间变化的临时状态（任务进度用 todo_write）；模型可自行推理的常识；从单次行为的推断；密钥等敏感凭证。",
    "怎么写：写前先 memory_read 既有主题；同主题用 memory_write 整体替换且不得丢失既有要点；description 保持一句话；时间敏感的内容在正文标注日期（至少到日）。",
    "确认边界：普通写入直接做、完成后一句话告知；删除主题或大段改写先向用户说明并取得确认。",
    "索引预算：主题总数超过约 15 个时，主动把相近主题合并重写为一个。"
  ].join("\n");
}

/**
 * 会话创建时调用一次，返回值拼进 systemPromptOverride 后整个会话不再变化
 * （记忆库为空时返回 undefined，不注入）。截断兜底：正常治理下不会触顶。
 */
export function buildMemorySnapshotBlock(indexMarkdown: string): string | undefined {
  const body = indexMarkdown.trim();
  if (!body) return undefined;
  const lines = body.split("\n");
  const truncated = lines.length > SNAPSHOT_MAX_LINES;
  return [
    "【长期记忆索引】",
    "以下是本会话开始时可用的记忆主题（只列标题与一句话描述）；需要正文用 memory_read 按标题读取，不确定有没有相关记忆时用 memory_search 检索：",
    truncated ? lines.slice(0, SNAPSHOT_MAX_LINES).join("\n") : body,
    ...(truncated ? [`（主题较多，仅显示前 ${SNAPSHOT_MAX_LINES} 行；完整清单用 memory_list 查看）`] : [])
  ].join("\n");
}

export interface MemoryToolContext {
  store: MemoryStore;
  /** 会话工作区：工作区绑定主题的写入、读取与检索都以此过滤。 */
  workspace: string | undefined;
  /** 总开关（settings.memory?.enabled !== false），调用时实时判断，停用无需重建会话。 */
  enabled: () => boolean;
}

const DISABLED_REPLY = "长期记忆功能当前已停用，本次操作未执行（可在记忆面板重新开启）。";

function scopeLabel(topic: MemoryTopic): string {
  return topic.workspace ? `绑定工作区 ${topic.workspace}` : "全局";
}

/** Build the memory customTools (write/read/list/search/delete). */
export function buildMemoryTools({ store, workspace, enabled }: MemoryToolContext): ToolDefinition[] {
  const disabled = () => !enabled();
  /** 模型侧读取按工作区隔离：其他工作区绑定的主题视为不存在。 */
  const readVisible = (name: string): MemoryTopic | undefined => {
    const topic = store.read(name);
    return topic && memoryTopicVisibleIn(topic, workspace) ? topic : undefined;
  };

  return [
    defineTool({
      name: "memory_write",
      label: "写入记忆",
      description: [
        "写入或更新一条长期记忆主题（按标题定位，整主题替换：topic+description+content 一起发送，没有部分更新）。",
        "改写既有主题前必须先 memory_read 读出当前内容，替换时不得丢失既有要点；新主题则直接写入。",
        "topic 是稳定的主题名（如“用户偏好”“<项目名>协作约定”），description 是索引用的一句话，content 是 markdown 正文。"
      ].join(""),
      promptSnippet: "memory_write: 整主题写入/更新长期记忆",
      parameters: Type.Object({
        topic: Type.String({ description: "主题标题（既有主题重写时保持原标题）" }),
        description: Type.String({ description: "一句话索引描述" }),
        content: Type.String({ description: "完整 markdown 正文（整主题替换）" }),
        workspace_scoped: Type.Optional(Type.Boolean({ description: "true 时绑定到当前工作区（仅本工作区会话可见）；缺省为全局记忆" }))
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; topic: string; workspace: string | null } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, topic: "", workspace: null } };
        const bind = params?.workspace_scoped === true;
        if (bind && !workspace) throw new Error("当前会话未打开工作区，无法保存工作区绑定记忆");
        const topic = store.save({
          title: String(params?.topic ?? ""),
          description: String(params?.description ?? ""),
          content: String(params?.content ?? ""),
          ...(bind && workspace ? { bindWorkspace: workspace } : {})
        });
        return {
          content: [{ type: "text" as const, text: `已保存记忆主题「${topic.title}」（${scopeLabel(topic)}），当前共 ${store.list().length} 个主题：\n- ${topic.title} — ${topic.description}` }],
          details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null }
        };
      }
    }),
    defineTool({
      name: "memory_read",
      label: "读取记忆",
      description: "按标题读取一个记忆主题的完整正文（含 frontmatter 元信息）。只能看到全局主题与当前工作区绑定的主题。",
      promptSnippet: "memory_read: 读取记忆主题正文",
      parameters: Type.Object({
        topic: Type.String({ description: "主题标题（索引行中“—”之前的部分）" })
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; topic: string; workspace: string | null } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, topic: "", workspace: null } };
        const topic = readVisible(String(params?.topic ?? ""));
        if (!topic) throw new Error(`未找到记忆主题「${params?.topic}」；先用 memory_list 查看可用主题`);
        return {
          content: [{ type: "text" as const, text: `「${topic.title}」（${scopeLabel(topic)}，更新于 ${topic.updatedAt}）：\n\n${topic.content}` }],
          details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null }
        };
      }
    }),
    defineTool({
      name: "memory_list",
      label: "列出记忆",
      description: "列出当前会话可见的全部记忆主题（全局 + 当前工作区绑定），含标题、索引描述与更新日期。",
      promptSnippet: "memory_list: 列出记忆主题",
      parameters: Type.Object({}),
      execute: async (): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; count: number } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, count: 0 } };
        const topics = store.list().filter((topic) => memoryTopicVisibleIn(topic, workspace));
        const text = topics.length === 0
          ? "当前没有可见的记忆主题。"
          : topics.map((topic) => `- ${topic.title} — ${topic.description}（${scopeLabel(topic)}，更新于 ${topic.updatedAt}）`).join("\n");
        return { content: [{ type: "text" as const, text }], details: { skipped: false, count: topics.length } };
      }
    }),
    defineTool({
      name: "memory_search",
      label: "检索记忆",
      description: "按关键词检索记忆（标题命中优先，正文次之），最多返回 5 条带片段。索引行没提到但怀疑存在相关记忆时使用。",
      promptSnippet: "memory_search: 关键词检索记忆",
      parameters: Type.Object({
        query: Type.String({ description: "检索关键词" })
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; count: number } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, count: 0 } };
        const hits = store.search(String(params?.query ?? ""), workspace);
        const text = hits.length === 0
          ? `未检索到与「${params?.query}」相关的记忆。`
          : hits.map((hit) => `- ${hit.topic.title} — ${hit.topic.description}\n  片段：${hit.snippet}`).join("\n");
        return { content: [{ type: "text" as const, text }], details: { skipped: false, count: hits.length } };
      }
    }),
    defineTool({
      name: "memory_delete",
      label: "删除记忆",
      description: "按标题删除一个记忆主题（不可恢复）。删除前必须已向用户说明并取得确认。",
      promptSnippet: "memory_delete: 删除记忆主题",
      parameters: Type.Object({
        topic: Type.String({ description: "主题标题" })
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; topic: string; removed: boolean } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, topic: "", removed: false } };
        const name = String(params?.topic ?? "");
        if (!readVisible(name)) throw new Error(`未找到记忆主题「${name}」；先用 memory_list 确认标题`);
        store.remove(name);
        return {
          content: [{ type: "text" as const, text: `已删除记忆主题「${name}」，当前共 ${store.list().length} 个主题。` }],
          details: { skipped: false, topic: name, removed: true }
        };
      }
    })
  ];
}
