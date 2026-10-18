// 记忆能力簇（照 runtime-todo-tools 的形态）：memory_* customTools、静态
// 治理块、会话级索引快照块。dsh 缓存哲学：动态状态不进系统提示词——快照在
// createSession 时取一次、整个会话字节冻结（与会话历史同前缀稳定）；会话内
// 的新鲜度由 memory_write / memory_append / memory_list 的工具结果承担（追加
// 在对话尾部，纯追加不破坏前缀 KV cache）。没有每轮注入，也不建
// before_agent_start 扩展。
//
// v3（2026-10-18）：read 支持按节读取（大主题先回目录）；append 按节追加，
// 不再整篇重写；search 返回节标题与短片段；snapshot 改成预算索引。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryTopic, MemoryTopicSummary } from "../shared/protocol.js";
import {
  MEMORY_LIST_LIMIT,
  MEMORY_OUTLINE_MAX_SECTIONS,
  MEMORY_READ_FULL_MAX_CHARS,
  MEMORY_SEARCH_LIMIT,
  MEMORY_SEARCH_LIMIT_MAX,
  MEMORY_SNAPSHOT_DESC_MAX,
  MEMORY_TOPIC_WARN_CHARS
} from "../shared/memory.js";
import { findMemorySection, outlineMemorySections, splitMemorySections } from "./memory-sections.js";
import { memoryTopicVisibleIn, type MemorySearchHit, type MemoryStore } from "./memory-store.js";
import { Type } from "typebox";

/** 引导模型正确使用记忆工具的治理块：静态字节，enabled 时拼进 systemPromptOverride。 */
export function buildMemorySystemPromptBlock(): string {
  return [
    "【长期记忆（memory_* 工具）】",
    "何时记：用户明确说“记住/以后都这样”；重复出现的稳定偏好；明确纠错；影响未来判断的决策理由；本项目中已验证过的协作约定。",
    "何时不记：随时间变化的临时状态（任务进度用 todo_write）；模型可自行推理的常识；从单次行为的推断；密钥等敏感凭证。",
    "写入前自检：这条信息是否来自成功的工具调用结果或用户明确陈述？推理猜测、未验证的假设、未执行的计划一律不写——无行动不记忆。",
    "怎么写：写前先 memory_read 既有主题；整主题替换用 memory_write（替换前必须读全文，不得丢失既有要点）；追加/下沉用 memory_append 按节追加，不需要先读全文；description 保持一句话（≤45 字）；时间敏感的内容在正文标注日期（至少到日）。",
    "怎么读：索引只列标题与一句话；大主题（>6000 字）memory_read 不传 section 会返回目录，按节读；确需全文才传 section=\"*\"；索引没列出的主题、或不确定标题时用 memory_search。",
    "确认边界：普通写入直接做、完成后一句话告知；删除主题或大段改写先向用户说明并取得确认。",
    "索引预算：主题总数超过约 15 个时，主动把相近主题合并重写为一个。"
  ].join("\n");
}

/**
 * 会话创建时调用一次，返回值拼进 systemPromptOverride 后整个会话不再变化
 * （记忆库为空时返回 undefined）。索引预算由 store.snapshotMarkdown 负责，
 * 这里不再按行二次截断——静默截断会让旧主题在模型眼里凭空消失。
 */
export function buildMemorySnapshotBlock(indexMarkdown: string): string | undefined {
  const body = indexMarkdown.trim();
  if (!body) return undefined;
  return [
    "【长期记忆索引】",
    "以下是本会话开始时可用的记忆主题（只列标题与一句话描述；索引超预算时会省略部分主题，用 memory_search 检索，memory_list 看全量）。正文用 memory_read 读取；大主题先看目录再按节读：",
    body
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

function scopeLabel(topic: MemoryTopicSummary): string {
  return topic.workspace ? `绑定工作区 ${topic.workspace}` : "全局";
}

function chars(value: number): string {
  return value.toLocaleString("en-US");
}

function sectionCount(topic: MemoryTopic): number {
  return splitMemorySections(topic.content).length;
}

function largeTopicNote(topic: MemoryTopicSummary): string {
  if (topic.contentChars <= MEMORY_TOPIC_WARN_CHARS) return "";
  return `\n注意：正文 ${chars(topic.contentChars)} 字偏大，建议把已解细节下沉到归档主题，或用 memory_append 分节维护。`;
}

function descriptionNote(description: string): string {
  if (description.length <= MEMORY_SNAPSHOT_DESC_MAX) return "";
  return `\n（索引描述 ${chars(description.length)} 字，建议 ≤${MEMORY_SNAPSHOT_DESC_MAX} 字，以免撑大每会话索引）`;
}

/** Build the memory customTools (write/append/read/list/search/delete). */
export function buildMemoryTools({ store, workspace, enabled }: MemoryToolContext): ToolDefinition[] {
  const disabled = () => !enabled();
  /** 模型侧读取按工作区隔离：其他工作区绑定的主题视为不存在。 */
  const readVisible = (name: string): MemoryTopic | undefined => {
    const topic = store.read(name);
    return topic && memoryTopicVisibleIn(topic, workspace) ? topic : undefined;
  };
  const visibleSummaries = (): MemoryTopicSummary[] => store.summaries().filter((topic) => memoryTopicVisibleIn(topic, workspace));

  return [
    defineTool({
      name: "memory_write",
      label: "写入记忆",
      description: [
        "写入或更新一条长期记忆主题（按标题定位，整主题替换：topic+description+content 一起发送，没有部分更新）。",
        "整主题替换会消耗与正文等量的 token：只用于纠正/合并；新增内容或下沉归档请用 memory_append 按节追加。",
        "改写既有主题前必须先 memory_read 读出全文（大主题用 section=\"*\"），替换时不得丢失既有要点。",
        "topic 是稳定的主题名（如“用户偏好”“<项目名>协作约定”），description 是索引用的一句话（建议 ≤45 字），content 是 markdown 正文。"
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
        const text = [
          `已保存记忆主题「${topic.title}」（${scopeLabel(topic)}，正文 ${chars(topic.contentChars)} 字 / ${sectionCount(topic)} 节），当前共 ${store.list().length} 个主题：`,
          `- ${topic.title} — ${topic.description}`,
          descriptionNote(topic.description),
          largeTopicNote(topic)
        ].filter(Boolean).join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null }
        };
      }
    }),
    defineTool({
      name: "memory_append",
      label: "追加记忆",
      description: [
        "向既有记忆主题追加内容，不会覆盖既有正文，参数只包含新增片段（适合沉淀新结论、下沉归档、补一条踩坑）。",
        "不需要先读全文：section 传目录里的节标题/编号即可追加到该节末尾；section 不存在时会在文末新建 `## section`；省略 section 追加到文末。",
        "新主题、纠正既有结论、合并主题请用 memory_write。"
      ].join(""),
      promptSnippet: "memory_append: 按节/文末追加长期记忆",
      parameters: Type.Object({
        topic: Type.String({ description: "既有主题标题（不存在时先用 memory_write 创建）" }),
        section: Type.Optional(Type.String({ description: "目标节（标题片段或编号）；缺省追加到文末；不存在则新建该节" })),
        content: Type.String({ description: "要追加的 markdown 片段（只写新增内容）" })
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; topic: string; workspace: string | null; section: string; created: boolean; chars: number } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, topic: "", workspace: null, section: "", created: false, chars: 0 } };
        const topic = readVisible(String(params?.topic ?? ""));
        if (!topic) throw new Error(`未找到记忆主题「${params?.topic}」；先用 memory_list 查看可用主题`);
        const outcome = store.append({
          topic: topic.title,
          section: params?.section === undefined ? undefined : String(params.section),
          content: String(params?.content ?? "")
        });
        const target = outcome.label === "末尾" ? "末尾" : `§${outcome.label}`;
        const verb = outcome.created ? "已新建节并追加到" : "已追加到";
        const text = [
          `${verb}「${outcome.topic.title}」${target}（+${chars(outcome.addedChars)} 字；主题现 ${chars(outcome.topic.contentChars)} 字 / ${sectionCount(outcome.topic)} 节）。`,
          largeTopicNote(outcome.topic)
        ].filter(Boolean).join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { skipped: false, topic: outcome.topic.title, workspace: outcome.topic.workspace ?? null, section: outcome.label, created: outcome.created, chars: outcome.addedChars }
        };
      }
    }),
    defineTool({
      name: "memory_read",
      label: "读取记忆",
      description: [
        "按标题读取一个记忆主题；只能看到全局主题与当前工作区绑定的主题。",
        "大主题（>6000 字）不传 section 时只返回目录（节标题、字数、首行预览），按 section 读取具体节；确实需要全文时传 section=\"*\"。",
        "section 可传目录里的编号（如 \"2\"）或标题片段（如 \"超时口径\"）。"
      ].join(""),
      promptSnippet: "memory_read: 读取记忆主题正文（大主题按节读）",
      parameters: Type.Object({
        topic: Type.String({ description: "主题标题（索引行中“—”之前的部分）" }),
        section: Type.Optional(Type.String({ description: "节编号/标题片段；传 \"*\" 读全文" }))
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; topic: string; workspace: string | null; section?: string; full: boolean; chars: number } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, topic: "", workspace: null, full: true, chars: 0 } };
        const topic = readVisible(String(params?.topic ?? ""));
        if (!topic) throw new Error(`未找到记忆主题「${params?.topic}」；先用 memory_list 查看可用主题`);
        const sections = splitMemorySections(topic.content);
        const header = `「${topic.title}」（${scopeLabel(topic)}，更新于 ${topic.updatedAt}，正文 ${chars(topic.contentChars)} 字 / ${sections.length} 节）`;
        const selector = String(params?.section ?? "").trim();

        if (selector === "*") {
          return {
            content: [{ type: "text" as const, text: `${header}：\n\n${topic.content}` }],
            details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, section: "*", full: true, chars: topic.contentChars }
          };
        }

        if (selector) {
          const target = findMemorySection(sections, selector);
          if (!target) {
            const available = sections.slice(0, 12).map((section) => section.label).join("、");
            throw new Error(`未找到节「${selector}」；可用节：${available || "（该主题没有分节）"}${sections.length > 12 ? "…" : ""}`);
          }
          const body = topic.content.slice(target.start, target.end).trim();
          const children = target.childCount > 0 ? `，含 ${target.childCount} 个子节` : "";
          const remaining = Math.max(0, sections.length - 1);
          return {
            content: [{ type: "text" as const, text: `${header}\n§${target.label}（${chars(target.chars)} 字${children}；其余 ${remaining} 节未显示）：\n\n${body}` }],
            details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, section: target.label, full: false, chars: target.chars }
          };
        }

        if (topic.contentChars <= MEMORY_READ_FULL_MAX_CHARS || sections.length <= 1) {
          return {
            content: [{ type: "text" as const, text: `${header}：\n\n${topic.content}` }],
            details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, full: true, chars: topic.contentChars }
          };
        }

        const outline = outlineMemorySections(sections, MEMORY_OUTLINE_MAX_SECTIONS);
        const omitted = outline.omitted > 0 ? `\n（另有 ${outline.omitted} 节，用 memory_search 定位）` : "";
        return {
          content: [{
            type: "text" as const,
            text: `${header}\n正文 ${chars(topic.contentChars)} 字，共 ${sections.length} 节。按节读取（section 传编号或标题片段）：\n${outline.lines.join("\n")}${omitted}\n\n需要全文请传 section="*"；或先用 memory_search 定位具体段落。`
          }],
          details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, full: false, chars: topic.contentChars }
        };
      }
    }),
    defineTool({
      name: "memory_list",
      label: "列出记忆",
      description: "列出当前会话可见的记忆主题（全局 + 当前工作区绑定），含标题、索引描述、更新日期与正文体积；默认 50 条，可用 limit/offset 翻页。",
      promptSnippet: "memory_list: 列出记忆主题",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "最多返回多少条，默认 50" })),
        offset: Type.Optional(Type.Number({ description: "跳过前 N 条，默认 0" }))
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; count: number; total: number } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, count: 0, total: 0 } };
        const all = visibleSummaries();
        const limit = Math.max(1, Math.min(200, Math.round(params?.limit ?? MEMORY_LIST_LIMIT)));
        const offset = Math.max(0, Math.round(params?.offset ?? 0));
        const topics = all.slice(offset, offset + limit);
        if (all.length === 0) {
          return { content: [{ type: "text" as const, text: "当前没有可见的记忆主题。" }], details: { skipped: false, count: 0, total: 0 } };
        }
        if (topics.length === 0 && offset > 0) {
          return { content: [{ type: "text" as const, text: `offset=${offset} 超出范围：当前可见 ${all.length} 个主题。` }], details: { skipped: false, count: 0, total: all.length } };
        }
        const globalCount = all.filter((topic) => !topic.workspace).length;
        const range = offset + topics.length >= all.length ? "" : `，显示 ${offset + 1}–${offset + topics.length}`;
        const lines = topics.map((topic) => `- ${topic.title} — ${topic.description}（${scopeLabel(topic)}，更新于 ${topic.updatedAt}，${chars(topic.contentChars)} 字）`);
        const footer = offset + topics.length < all.length
          ? `\n（还有 ${all.length - offset - topics.length} 个，用 offset=${offset + topics.length} 继续；或 memory_search 检索）`
          : "";
        const text = `可见 ${all.length} 个主题（全局 ${globalCount}${range}）：\n${lines.join("\n")}${footer}`;
        return { content: [{ type: "text" as const, text }], details: { skipped: false, count: topics.length, total: all.length } };
      }
    }),
    defineTool({
      name: "memory_search",
      label: "检索记忆",
      description: "按关键词检索记忆（中文按二字词、英文按单词；标题/描述命中优先，正文按分节命中），返回节标题与短片段。索引没列出的主题也能搜到；先用它定位，再用 memory_read(topic, section) 读该节。",
      promptSnippet: "memory_search: 关键词检索记忆（返回分节）",
      parameters: Type.Object({
        query: Type.String({ description: "检索关键词（中文二字词或英文单词效果最好）" }),
        limit: Type.Optional(Type.Number({ description: "返回条数，默认 5，最多 10" })),
        topic: Type.Optional(Type.String({ description: "只在这个主题内检索（标题或 id）" }))
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; count: number } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, count: 0 } };
        const query = String(params?.query ?? "");
        const limit = Math.max(1, Math.min(MEMORY_SEARCH_LIMIT_MAX, Math.round(params?.limit ?? MEMORY_SEARCH_LIMIT)));
        const hits: MemorySearchHit[] = store.search(query, workspace, { limit, ...(params?.topic ? { topic: String(params.topic) } : {}) });
        if (hits.length === 0) {
          return {
            content: [{ type: "text" as const, text: `未检索到与「${query}」相关的记忆。可换更短的关键词（中文二字词、英文单词）再试，或用 memory_list 看全部主题。` }],
            details: { skipped: false, count: 0 }
          };
        }
        const lines = hits.map((hit) => {
          const target = hit.section ? `§${hit.section} · ${chars(hit.sectionChars)} 字` : `主题命中 · ${chars(hit.sectionChars)} 字`;
          return `- ${hit.topic.title} — ${hit.topic.description}\n  ${target}\n  片段：${hit.snippet}`;
        });
        const text = [
          `检索「${query}」命中 ${hits.length} 条：`,
          ...lines,
          "读命中节：memory_read(topic=\"…\", section=\"…\")；未列在索引里的主题也能搜到。"
        ].join("\n");
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
