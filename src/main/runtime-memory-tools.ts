// 记忆能力簇（照 runtime-todo-tools 的形态）：memory_* customTools、静态
// 治理块、会话级索引快照块。dsh 缓存哲学：动态状态不进系统提示词——快照在
// createSession 时取一次、整个会话字节冻结（与会话历史同前缀稳定）；会话内
// 的新鲜度由 memory_write / memory_append / memory_list 的工具结果承担（追加
// 在对话尾部，纯追加不破坏前缀 KV cache）。没有每轮注入，也不建
// before_agent_start 扩展。
//
// v3（2026-10-18）：read 支持按节读取（大主题先回目录）；append 按节追加，
// 不再整篇重写；search 返回节标题与短片段；snapshot 改成预算索引。
//
// v4（2026-11-05）：分层只解决三件事——召回准确率、召回体积、重复召回。
// - 主题分三层（core / standard / archive），索引按层分账；archive 不进索引。
// - 默认读取只给「要点 + 目录」（≤1,300 字），正文按节取；`section="*"` 封顶
//   12,000 字并显式截断，避免整篇主题把上下文撑爆。
// - 检索结果单条 ≤260 字、单次 ≤1,200 字；会话内已读表（TTL 20 分钟）对重复
//   读取只回一行提示，`refresh=true` 强制重看。
// - 任何截断都写明原因与续读路径，绝不静默给残片。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MemoryTopic, MemoryTopicSummary } from "../shared/protocol.js";
import type { MemoryLayer } from "../shared/memory.js";
import {
  MEMORY_DEDUPE_MAX_ENTRIES,
  MEMORY_DEDUPE_TTL_MS,
  MEMORY_LAYERS,
  MEMORY_LIST_LIMIT,
  MEMORY_LIST_LIMIT_MAX,
  MEMORY_READ_DEFAULT_MAX_CHARS,
  MEMORY_READ_FULL_CAP_CHARS,
  MEMORY_READ_OUTLINE_SECTIONS,
  MEMORY_READ_SECTION_MAX_CHARS,
  MEMORY_READ_SMALL_TOPIC_CHARS,
  MEMORY_SEARCH_HIT_MAX_CHARS,
  MEMORY_SEARCH_LIMIT,
  MEMORY_SEARCH_LIMIT_MAX,
  MEMORY_SEARCH_TOTAL_MAX_CHARS,
  MEMORY_SNAPSHOT_CORE_CHARS,
  MEMORY_SUMMARY_MAX_CHARS,
  MEMORY_TOPIC_INDEX_DEGRADE_CHARS,
  MEMORY_TOPIC_WARN_CHARS,
  MEMORY_TRIGGER_MAX_CHARS,
  MEMORY_TRIGGER_MAX_COUNT
} from "../shared/memory.js";
import { deriveMemoryDigest, findMemorySection, outlineMemorySections, splitMemorySections, truncateMemoryText } from "./memory-sections.js";
import { memoryTopicVisibleIn, type MemorySearchHit, type MemoryStore } from "./memory-store.js";
import { Type } from "typebox";

/** 引导模型正确使用记忆工具的治理块：静态字节，enabled 时拼进 systemPromptOverride。 */
export function buildMemorySystemPromptBlock(): string {
  return [
    "【长期记忆（memory_* 工具）】",
    "索引是「存在性索引」：只列标题、触发词与核心主题要点，不承载细节——不要凭索引猜内容，需要事实先 memory_search 定位，再 memory_read 读目标节。",
    "读取顺序：search → read(主题) 拿要点+目录（≤1300 字）→ read(主题, section) 读正文（≤4000 字）；同一会话读过的节不要重复读（工具会回「已读过」），确需重看传 refresh=true；只有确需全文才传 section=\"*\"（封顶 12000 字，超出会截断）。",
    "何时记：用户明确说“记住/以后都这样”；重复出现的稳定偏好；明确纠错；影响未来判断的决策理由；本项目中已验证过的协作约定。",
    "何时不记：随时间变化的临时状态（任务进度用 todo_write）；模型可自行推理的常识；从单次行为的推断；密钥等敏感凭证。",
    "写入前自检（无行动不记忆）：这条信息是否来自成功的工具调用结果或用户明确陈述？推理猜测、未验证的假设、未执行的计划一律不写。",
    "怎么分：core 只放每会话都该在场的偏好/纪律/会变状态（要点 ≤120 字）；standard 放项目知识与踩坑；archive 放已解历史。一主题一件事，正文 >8000 字考虑拆分或下沉归档；summary 写 3–8 行结论（≤400 字），triggers 只放反直觉词（≤3 个）。",
    "怎么改：整主题替换用 memory_write（改前先 memory_read 读全文，不得丢失既有要点）；追加/下沉用 memory_append 按节追加，不需要先读全文。",
    "确认边界：普通写入直接做、完成后一句话告知；删除主题或大段改写先向用户说明并取得确认。",
    "索引预算：主题总数超过约 15 个时，主动把相近主题合并重写为一个。",
    "维护：定期自检——core 必须有点要；正文 >8000 拆分、>12000 下沉归档；90 天未更新的项目知识考虑归档（用 memory_layer 改层，不必重写正文）；标题相近的主题合并重写。"
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
    "以下索引按层组织：核心（每会话在场的偏好/纪律/状态）、项目知识（标题即索引，细节按需读）、归档（不列条目，可检索）。索引只给存在性，正文用 memory_read 读取；索引没列出的主题用 memory_search 检索；大主题先看目录再按节读：",
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

function layerLabel(layer: MemoryLayer | undefined): string {
  if (layer === "core") return "核心";
  if (layer === "archive") return "归档";
  return "标准";
}

function largeTopicNote(topic: MemoryTopicSummary): string {
  if (topic.contentChars <= MEMORY_TOPIC_WARN_CHARS) return "";
  const degrade = topic.contentChars > MEMORY_TOPIC_INDEX_DEGRADE_CHARS
    ? "索引里已降级为只有标题"
    : "建议拆分或把已解细节下沉到归档主题";
  return `\n注意：正文 ${chars(topic.contentChars)} 字偏大（${degrade}）；用 memory_append 分节维护，或建子主题。`;
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

  // 会话内已读表：只用来把「重复读同一节」压成一行提示，不承担正确性
  // （压缩/编辑后内容可能已不在上下文，所以有 TTL、revision 校验与 refresh）。
  const readRegistry = new Map<string, { at: number; revision: number }>();
  const registryKey = (topicId: string, section: string): string => `${topicId}#${section}`;
  function pruneRegistry(now: number): void {
    for (const [key, entry] of readRegistry) {
      if (now - entry.at > MEMORY_DEDUPE_TTL_MS) readRegistry.delete(key);
    }
    while (readRegistry.size > MEMORY_DEDUPE_MAX_ENTRIES) {
      const oldest = readRegistry.keys().next().value;
      if (oldest === undefined) break;
      readRegistry.delete(oldest);
    }
  }
  function wasRead(topicId: string, section: string, revision: number): boolean {
    pruneRegistry(Date.now());
    const entry = readRegistry.get(registryKey(topicId, section));
    return Boolean(entry && entry.revision === revision);
  }
  function markRead(topic: MemoryTopic, section: string): void {
    pruneRegistry(Date.now());
    readRegistry.set(registryKey(topic.id, section), { at: Date.now(), revision: topic.contentRevision });
  }
  function alreadyReadNotice(topic: MemoryTopic, section: string, label: string, size: number): string | undefined {
    if (!wasRead(topic.id, section, topic.contentRevision)) return undefined;
    return `「${topic.title}」${label} 本会话已读过（${chars(size)} 字，内容未变）；需要重看请传 refresh=true。`;
  }

  return [
    defineTool({
      name: "memory_write",
      label: "写入记忆",
      description: [
        "写入或更新一条长期记忆主题（按标题定位，整主题替换：topic+description+content 一起发送，没有部分更新）。",
        "整主题替换会消耗与正文等量的 token：只用于纠正/合并；新增内容或下沉归档请用 memory_append 按节追加。",
        "改写既有主题前必须先 memory_read 读出全文（大主题用 section=\"*\"），替换时不得丢失既有要点。",
        "分层：layer=core 只放每会话都该在场的偏好/纪律/会变状态（索引里会带要点）；standard 放项目知识；archive 放已解历史（不进索引、仍可检索）。",
        "summary 是 3–8 行结论要点（≤400 字，会进默认读取与 core 索引）；triggers 是反直觉检索词（≤3 个，每个 ≤12 字）。"
      ].join(""),
      promptSnippet: "memory_write: 整主题写入/更新长期记忆",
      parameters: Type.Object({
        topic: Type.String({ description: "主题标题（既有主题重写时保持原标题）" }),
        description: Type.String({ description: "一句话索引描述（≤45 字；不承载正文）" }),
        content: Type.String({ description: "完整 markdown 正文（整主题替换）" }),
        layer: Type.Optional(Type.String({ description: "core / standard / archive；缺省保留既有层，新主题 standard" })),
        summary: Type.Optional(Type.String({ description: "要点层：3–8 行结论，≤400 字（多行会压成一行）" })),
        triggers: Type.Optional(Type.Array(Type.String(), { description: `反直觉触发词（≤${MEMORY_TRIGGER_MAX_COUNT} 个，每个 ≤${MEMORY_TRIGGER_MAX_CHARS} 字）` })),
        workspace_scoped: Type.Optional(Type.Boolean({ description: "true 时绑定到当前工作区（仅本工作区会话可见）；缺省为全局记忆" }))
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; topic: string; workspace: string | null } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, topic: "", workspace: null } };
        const bind = params?.workspace_scoped === true;
        if (bind && !workspace) throw new Error("当前会话未打开工作区，无法保存工作区绑定记忆");
        const layer = params?.layer === undefined ? undefined : String(params.layer).trim().toLowerCase() as MemoryLayer;
        if (layer !== undefined && !MEMORY_LAYERS.includes(layer)) throw new Error("layer 只能是 core / standard / archive");
        const summary = params?.summary === undefined ? undefined : String(params.summary);
        const summaryNote = summary && summary.length > MEMORY_SUMMARY_MAX_CHARS
          ? `\n（summary ${chars(summary.length)} 字超过 ${MEMORY_SUMMARY_MAX_CHARS} 字上限，已截断）`
          : "";
        const triggers = Array.isArray(params?.triggers) ? params.triggers.map((item) => String(item)) : undefined;
        const topic = store.save({
          title: String(params?.topic ?? ""),
          description: String(params?.description ?? ""),
          content: String(params?.content ?? ""),
          ...(layer ? { layer } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(triggers ? { triggers } : {}),
          ...(bind && workspace ? { bindWorkspace: workspace } : {})
        });
        const text = [
          `已保存记忆主题「${topic.title}」（${layerLabel(topic.layer)}，${scopeLabel(topic)}，正文 ${chars(topic.contentChars)} 字 / ${sectionCount(topic)} 节）；当前共 ${store.list().length} 个主题：`,
          `- ${topic.title} — ${topic.description}`,
          topic.summary ? `要点：${truncateMemoryText(topic.summary, MEMORY_SNAPSHOT_CORE_CHARS)}` : "要点：未维护（读取时由正文自动提取）",
          summaryNote,
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
        `默认返回「要点 + 目录」（≤${chars(MEMORY_READ_DEFAULT_MAX_CHARS)} 字）：正文 ≤${chars(MEMORY_READ_SMALL_TOPIC_CHARS)} 字的主题直接给全文，更大的主题给要点与分节目录。`,
        `按节读取：section 传目录里的编号（如 "2"）或标题片段（如 "超时口径"），单节 ≤${chars(MEMORY_READ_SECTION_MAX_CHARS)} 字；确需全文传 section="*"（封顶 ${chars(MEMORY_READ_FULL_CAP_CHARS)} 字，超出会截断并提示续读）。`,
        "同一会话读过的节重复读取只回一行提示；需要重看传 refresh=true。"
      ].join(""),
      promptSnippet: "memory_read: 读取记忆主题（要点+目录 / 按节 / 全文）",
      parameters: Type.Object({
        topic: Type.String({ description: "主题标题（索引行中“—”之前的部分）" }),
        section: Type.Optional(Type.String({ description: "节编号/标题片段；传 \"*\" 读全文；缺省返回要点+目录" })),
        refresh: Type.Optional(Type.Boolean({ description: "true 时忽略会话内已读表，重新返回正文" }))
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; topic: string; workspace: string | null; layer: MemoryLayer; section?: string; full: boolean; chars: number; cached: boolean } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, topic: "", workspace: null, layer: "standard", full: true, chars: 0, cached: false } };
        const topic = readVisible(String(params?.topic ?? ""));
        if (!topic) throw new Error(`未找到记忆主题「${params?.topic}」；先用 memory_list 查看可用主题`);
        const layer = (topic.layer ?? "standard") as MemoryLayer;
        const sections = splitMemorySections(topic.content);
        const header = `「${topic.title}」（${layerLabel(layer)}，${scopeLabel(topic)}，更新于 ${topic.updatedAt}，正文 ${chars(topic.contentChars)} 字 / ${sections.length} 节）`;
        const archivedNote = layer === "archive" ? "\n（此主题已归档：仍可检索与读取，不再进入常驻索引）" : "";
        const selector = String(params?.section ?? "").trim();
        const refresh = params?.refresh === true;

        const emit = (body: string, detail: { section?: string; full: boolean }): { content: { type: "text"; text: string }[]; details: { skipped: boolean; topic: string; workspace: string | null; layer: MemoryLayer; section?: string; full: boolean; chars: number; cached: boolean } } => {
          markRead(topic, detail.section ?? "default");
          return {
            content: [{ type: "text" as const, text: `${header}${archivedNote}\n${body}` }],
            details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, layer, ...(detail.section ? { section: detail.section } : {}), full: detail.full, chars: body.length, cached: false }
          };
        };

        if (selector === "*") {
          const cached = refresh ? undefined : alreadyReadNotice(topic, "*", "全文", topic.contentChars);
          if (cached) {
            return { content: [{ type: "text" as const, text: `${header}\n${cached}` }], details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, layer, section: "*", full: true, chars: 0, cached: true } };
          }
          const truncated = topic.contentChars > MEMORY_READ_FULL_CAP_CHARS;
          const body = truncated
            ? `${truncateMemoryText(topic.content, MEMORY_READ_FULL_CAP_CHARS)}\n\n…（已截断：全文 ${chars(topic.contentChars)} 字，仅返回前 ${chars(MEMORY_READ_FULL_CAP_CHARS)} 字；其余用 memory_read(topic, section) 按节读）`
            : topic.content;
          return emit(body, { section: "*", full: true });
        }

        if (selector) {
          const target = findMemorySection(sections, selector);
          if (!target) {
            const available = sections.slice(0, 12).map((section) => section.label).join("、");
            throw new Error(`未找到节「${selector}」；可用节：${available || "（该主题没有分节）"}${sections.length > 12 ? "…" : ""}`);
          }
          const cached = refresh ? undefined : alreadyReadNotice(topic, target.label, `§${target.label}`, target.chars);
          if (cached) {
            return { content: [{ type: "text" as const, text: `${header}\n${cached}` }], details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, layer, section: target.label, full: false, chars: 0, cached: true } };
          }
          const raw = topic.content.slice(target.start, target.end).trim();
          const truncated = raw.length > MEMORY_READ_SECTION_MAX_CHARS;
          const body = truncated
            ? `${truncateMemoryText(raw, MEMORY_READ_SECTION_MAX_CHARS)}\n\n…（本节 ${chars(raw.length)} 字，已截断到 ${chars(MEMORY_READ_SECTION_MAX_CHARS)} 字；用子节标题继续读）`
            : raw;
          const children = target.childCount > 0 ? `，含 ${target.childCount} 个子节` : "";
          const remaining = Math.max(0, sections.length - 1);
          markRead(topic, target.label);
          return {
            content: [{ type: "text" as const, text: `${header}${archivedNote}\n§${target.label}（${chars(target.chars)} 字${children}；其余 ${remaining} 节未显示）：\n\n${body}` }],
            details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, layer, section: target.label, full: false, chars: body.length, cached: false }
          };
        }

        if (topic.contentChars <= MEMORY_READ_SMALL_TOPIC_CHARS) {
          const cached = refresh ? undefined : alreadyReadNotice(topic, "default", "正文", topic.contentChars);
          if (cached) {
            return { content: [{ type: "text" as const, text: `${header}\n${cached}` }], details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, layer, full: true, chars: 0, cached: true } };
          }
          return emit(topic.content, { full: true });
        }

        // 无标题/单节主题：没有目录可列，给「前 N 字 + 截断提示」而不是静默整篇。
        if (sections.length <= 1) {
          const cached = refresh ? undefined : alreadyReadNotice(topic, "default", "正文", topic.contentChars);
          if (cached) {
            return { content: [{ type: "text" as const, text: `${header}\n${cached}` }], details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, layer, full: false, chars: 0, cached: true } };
          }
          const truncated = topic.contentChars > MEMORY_READ_DEFAULT_MAX_CHARS;
          const body = truncated
            ? `${truncateMemoryText(topic.content, MEMORY_READ_DEFAULT_MAX_CHARS)}\n\n…（已截断：全文 ${chars(topic.contentChars)} 字；用 section="*" 或 memory_read(section=…) 读剩余）`
            : topic.content;
          return emit(body, { full: false });
        }

        const cached = refresh ? undefined : alreadyReadNotice(topic, "default", "要点+目录", topic.contentChars);
        if (cached) {
          return { content: [{ type: "text" as const, text: `${header}\n${cached}` }], details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, layer, full: false, chars: 0, cached: true } };
        }

        const summary = (topic.summary ?? "").trim() || deriveMemoryDigest(topic.content, MEMORY_SUMMARY_MAX_CHARS);
        const outline = outlineMemorySections(sections, MEMORY_READ_OUTLINE_SECTIONS);
        const footer = [
          outline.omitted > 0 ? `（另有 ${outline.omitted} 节未列出，用 memory_search 定位）` : "",
          `读正文：memory_read(topic="${topic.title}", section="节编号/标题") 按节读取；确需全文才传 section="*"。`
        ].filter(Boolean).join("\n");
        const head = `${header}${archivedNote}\n要点${topic.summary ? "" : "（自动提取，未维护 summary）"}：${truncateMemoryText(summary, MEMORY_SUMMARY_MAX_CHARS)}\n目录：`;
        const lines: string[] = [];
        let used = head.length + footer.length + 8;
        for (const line of outline.lines) {
          if (used + line.length + 1 > MEMORY_READ_DEFAULT_MAX_CHARS) break;
          lines.push(line);
          used += line.length + 1;
        }
        const omittedLines = outline.lines.length - lines.length;
        const omittedNote = omittedLines > 0 ? `\n（目录还有 ${omittedLines} 节未列出，用 memory_search 定位）` : "";
        const body = `${head}\n${lines.join("\n")}${omittedNote}\n${footer}`;
        markRead(topic, "default");
        return {
          content: [{ type: "text" as const, text: body }],
          details: { skipped: false, topic: topic.title, workspace: topic.workspace ?? null, layer, full: false, chars: body.length, cached: false }
        };
      }
    }),
    defineTool({
      name: "memory_list",
      label: "列出记忆",
      description: "列出当前会话可见的记忆主题（全局 + 当前工作区绑定），按层标注并含标题、索引描述、更新日期与正文体积；默认 30 条，可用 limit/offset 翻页。",
      promptSnippet: "memory_list: 列出记忆主题",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: `最多返回多少条，默认 ${MEMORY_LIST_LIMIT}` })),
        offset: Type.Optional(Type.Number({ description: "跳过前 N 条，默认 0" }))
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; count: number; total: number } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, count: 0, total: 0 } };
        const all = visibleSummaries();
        const limit = Math.max(1, Math.min(MEMORY_LIST_LIMIT_MAX, Math.round(params?.limit ?? MEMORY_LIST_LIMIT)));
        const offset = Math.max(0, Math.round(params?.offset ?? 0));
        const topics = all.slice(offset, offset + limit);
        if (all.length === 0) {
          return { content: [{ type: "text" as const, text: "当前没有可见的记忆主题。" }], details: { skipped: false, count: 0, total: 0 } };
        }
        if (topics.length === 0 && offset > 0) {
          return { content: [{ type: "text" as const, text: `offset=${offset} 超出范围：当前可见 ${all.length} 个主题。` }], details: { skipped: false, count: 0, total: all.length } };
        }
        const byLayer = { core: 0, standard: 0, archive: 0 } as Record<MemoryLayer, number>;
        for (const topic of all) byLayer[(topic.layer ?? "standard") as MemoryLayer] += 1;
        const range = offset + topics.length >= all.length ? "" : `，显示 ${offset + 1}–${offset + topics.length}`;
        const lines = topics.map((topic) => {
          const layer = (topic.layer ?? "standard") as MemoryLayer;
          return `- [${layerLabel(layer)}] ${topic.title} — ${topic.description}（${scopeLabel(topic)}，更新于 ${topic.updatedAt}，${chars(topic.contentChars)} 字）`;
        });
        const footer = offset + topics.length < all.length
          ? `\n（还有 ${all.length - offset - topics.length} 个，用 offset=${offset + topics.length} 继续；或 memory_search 检索）`
          : "";
        const text = `可见 ${all.length} 个主题（核心 ${byLayer.core} / 标准 ${byLayer.standard} / 归档 ${byLayer.archive}${range}）：\n${lines.join("\n")}${footer}`;
        return { content: [{ type: "text" as const, text }], details: { skipped: false, count: topics.length, total: all.length } };
      }
    }),
    defineTool({
      name: "memory_search",
      label: "检索记忆",
      description: `按关键词检索记忆（中文按二字词、英文按单词；标题/触发词/描述/节标题加权，正文按分节命中），返回节标题与短片段（单条 ≤${MEMORY_SEARCH_HIT_MAX_CHARS} 字、单次 ≤${MEMORY_SEARCH_TOTAL_MAX_CHARS} 字）。索引没列出的主题也能搜到；先用它定位，再用 memory_read(topic, section) 读该节。`,
      promptSnippet: "memory_search: 关键词检索记忆（返回分节）",
      parameters: Type.Object({
        query: Type.String({ description: "检索关键词（中文二字词或英文单词效果最好）" }),
        limit: Type.Optional(Type.Number({ description: `返回条数，默认 ${MEMORY_SEARCH_LIMIT}，最多 ${MEMORY_SEARCH_LIMIT_MAX}` })),
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

        const header = `检索「${query}」命中 ${hits.length} 条：`;
        const lines: string[] = [];
        let used = header.length + 40;
        let shown = 0;
        for (const hit of hits) {
          const layer = (hit.topic.layer ?? "standard") as MemoryLayer;
          const section = hit.section ?? "主题";
          const read = wasRead(hit.topic.id, section, hit.topic.contentRevision);
          const target = hit.section
            ? `§${hit.section} · ${chars(hit.sectionChars)} 字`
            : `主题命中 · ${chars(hit.sectionChars)} 字`;
          const marker = [layer === "archive" ? "已归档" : "", read ? "已读" : ""].filter(Boolean).join(" · ");
          const head = `- ${hit.topic.title}${marker ? `（${marker}）` : ""} ${target}`;
          const snippet = read ? "  片段：本会话已读过（需要重看用 memory_read refresh=true）" : `  片段：${truncateMemoryText(hit.snippet, MEMORY_SEARCH_HIT_MAX_CHARS - head.length)}`;
          const cost = head.length + snippet.length + 2;
          if (used + cost > MEMORY_SEARCH_TOTAL_MAX_CHARS && shown > 0) break;
          lines.push(head, snippet);
          used += cost;
          shown += 1;
        }
        const omitted = hits.length - shown;
        const text = [
          header,
          ...lines,
          omitted > 0 ? `（另有 ${omitted} 条未显示：缩小关键词或指定 topic）` : "",
          "读命中节：memory_read(topic=\"…\", section=\"…\")；索引没列出的主题也能搜到。"
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text" as const, text }], details: { skipped: false, count: shown } };
      }
    }),
    defineTool({
      name: "memory_layer",
      label: "调整记忆分层",
      description: "只改主题的分层（core / standard / archive），不重写正文：core 进索引并带要点，standard 按需查，archive 不进索引但仍可检索。整理记忆时用它替代整篇重写。",
      promptSnippet: "memory_layer: 调整主题分层（不重写正文）",
      parameters: Type.Object({
        topic: Type.String({ description: "主题标题" }),
        layer: Type.String({ description: "core / standard / archive" })
      }),
      execute: async (_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { skipped: boolean; topic: string; layer: MemoryLayer } }> => {
        if (disabled()) return { content: [{ type: "text" as const, text: DISABLED_REPLY }], details: { skipped: true, topic: "", layer: "standard" } };
        const name = String(params?.topic ?? "");
        const target = String(params?.layer ?? "").trim().toLowerCase() as MemoryLayer;
        if (!MEMORY_LAYERS.includes(target)) throw new Error("layer 只能是 core / standard / archive");
        const topic = readVisible(name);
        if (!topic) throw new Error(`未找到记忆主题「${name}」；先用 memory_list 确认标题`);
        const updated = store.update(topic.title, { layer: target });
        return {
          content: [{ type: "text" as const, text: `已把「${updated.title}」调整为${layerLabel(updated.layer)}层（正文 ${chars(updated.contentChars)} 字未改写）。` }],
          details: { skipped: false, topic: updated.title, layer: (updated.layer ?? "standard") as MemoryLayer }
        };
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
