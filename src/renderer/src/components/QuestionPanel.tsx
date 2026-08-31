import { CircleHelp, Maximize2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DesktopSettings, QuestionItem, QuestionRequest } from "../../../shared/protocol";
import { useDesktopStore } from "../store";
import { groupModelsByProvider, selectableCatalogModels } from "../lib/model-list";
import { RichContent } from "./RichContent";

/** 每题的作答草稿：选项勾选 + 自定义输入（文本题只用 custom）。 */
export interface QuestionDraft {
  custom: string;
  selected: string[];
}

/** 详情预览的默认截断长度（字符）；超出后展示预览 + 「查看完整」按钮。 */
export const DETAIL_PREVIEW_MAX_CHARS = 1600;

/** 从 markdown 详情提取标题（首个 `# ` 行），无标题回落为「计划」。 */
export function detailTitle(detail: string): string {
  const heading = /^#\s+(.+?)\s*$/mu.exec(detail.trim());
  return heading?.[1]?.trim() || "计划";
}

/**
 * 详情预览文本：截断到 {@link DETAIL_PREVIEW_MAX_CHARS} 字符，并回退到最近的
 * 换行边界（没有换行则硬截）；返回截断后的预览与是否截断标记。
 */
export function detailPreviewText(detail: string, maxChars = DETAIL_PREVIEW_MAX_CHARS): { preview: string; truncated: boolean } {
  if (detail.length <= maxChars) return { preview: detail, truncated: false };
  let cut = detail.lastIndexOf("\n", maxChars);
  if (cut <= 0) cut = maxChars;
  return { preview: `${detail.slice(0, cut).trimEnd()}\n…`, truncated: true };
}

export function emptyQuestionDraft(): QuestionDraft {
  return { custom: "", selected: [] };
}

/** 该题是否已作答：选择题勾选或自定义输入任一即可。 */
export function isQuestionAnswered(item: QuestionItem, draft: QuestionDraft): boolean {
  if (draft.selected.length > 0) return true;
  return draft.custom.trim().length > 0;
}

/** 单选点选即提交时的答案：自定义输入优先（与 serializeAnswer 语义一致），否则为所点选项。 */
export function singleSelectionAnswer(custom: string, option: string): string {
  return custom.trim() || option;
}

/** 把草稿序列化为返回给模型的字符串；多选时自定义输入追加在末尾。 */
export function serializeAnswer(item: QuestionItem, draft: QuestionDraft): string {
  const custom = draft.custom.trim();
  if (item.type === "multiple") {
    return [...draft.selected, ...(custom ? [custom] : [])].join("、");
  }
  if (item.type === "single") return custom || draft.selected.join("、");
  return custom;
}

/**
 * ask_question 的应答面板：从输入栏上方向上展开，逐条回答 AI 的提问。
 * 分页式：一次展示一个问题，右上角页码/箭头切换（草稿跨页保留），底部
 * 「忽略」取消整个提问、「继续」翻页或提交；快捷键 ↑↓/Tab 移动选择、
 * 回车或空格选中。选择题第一个选项自动标注「（推荐）」——与 ask_question
 * 工具描述的约定一致：模型把最推荐的选项放在第一位。
 */
export function QuestionPanel({ request, onOpenDetail }: { request: QuestionRequest; onOpenDetail?: (detail: string) => void }): ReactNode {
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => request.questions.map(() => emptyQuestionDraft()));
  const [current, setCurrent] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // 移交出口（handoffOption）的两段式状态：展开实施模型选择行；选中模型存
  // 「provider/id」字符串（下拉 value），提交时再拆回引用。
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffModel, setHandoffModel] = useState("");
  const optionRefs = useRef<(HTMLButtonElement | undefined)[]>([]);
  const inputRef = useRef<HTMLInputElement | undefined>(undefined);
  const handoffSelectRef = useRef<HTMLSelectElement | undefined>(undefined);
  const settings = useDesktopStore((state) => state.settings);
  const models = useDesktopStore((state) => state.models);
  const providers = useDesktopStore((state) => state.providers);
  // 与 composer 模型菜单同口径：只保留已勾选（enabled !== false）且已配置的模型。
  const handoffGroups = useMemo(
    () => groupModelsByProvider(selectableCatalogModels(models).filter((model) => model.configured), (providerId) => providers.find((item) => item.id === providerId)?.name),
    [models, providers]
  );

  useEffect(() => {
    setDrafts(request.questions.map(() => emptyQuestionDraft()));
    setCurrent(0);
    setSubmitting(false);
    setHandoffOpen(false);
    setHandoffModel("");
  }, [request.id, request.questions]);

  // 选择行展开时聚焦模型下拉（键盘路径：Enter 确认移交、Esc 返回）。
  useEffect(() => {
    if (handoffOpen) handoffSelectRef.current?.focus();
  }, [handoffOpen]);

  // 翻页/挂载后聚焦当前题第一个可交互元素（选择题聚焦首选项，文本题聚焦输入框）。
  useEffect(() => {
    const item = request.questions[current];
    if (!item) return;
    if (item.options.length > 0) {
      optionRefs.current[0]?.focus();
    } else {
      inputRef.current?.focus();
    }
  }, [current, request.questions]);

  async function resolve(answers?: string[], model?: { provider: string; id: string }): Promise<void> {
    setSubmitting(true);
    try {
      await window.piDesktop.send({ type: "question.resolve", id: request.id, ...(answers ? { answers } : {}), ...(model ? { model } : {}) });
      useDesktopStore.setState((state) => ({ questions: state.questions.filter((item) => item.id !== request.id) }));
    } catch {
      setSubmitting(false);
    }
  }

  function patchDraft(index: number, patch: Partial<QuestionDraft>): void {
    setDrafts((currentDrafts) => currentDrafts.map((draft, i) => i === index ? { ...draft, ...patch } : draft));
  }

  /** 推进到下一题；末题提交全部答案（未答的前置题以空串计入，用户可用页码翻回补答）。 */
  function advance(): void {
    if (submitting) return;
    if (isLast) {
      void resolve(request.questions.map((question, index) => serializeAnswer(question, drafts[index] ?? emptyQuestionDraft())));
    } else {
      setCurrent(current + 1);
    }
  }

  /** 移交出口预选模型：当前 Agent 的默认模型，无则回落全局默认；命中下拉列表才预选。 */
  function presetHandoffModel(): string {
    const ref = settings.agents.find((item) => item.id === settings.currentAgentId)?.defaultModel ?? settings.model;
    if (!ref) return "";
    const found = handoffGroups.some((group) => group.models.some((model) => model.provider === ref.provider && model.id === ref.id));
    return found ? `${ref.provider}/${ref.id}` : "";
  }

  /** 展开模型选择行：清空自定义输入（与移交互斥，防残留文本被误判为拒绝反馈）。 */
  function openHandoff(): void {
    setHandoffModel(presetHandoffModel());
    setHandoffOpen(true);
  }

  /** 返回：收起选择行并回到未选状态（问题仍挂起，可改选其它选项或以「忽略」取消）。 */
  function cancelHandoff(): void {
    setHandoffOpen(false);
    setHandoffModel("");
    patchDraft(current, { selected: [], custom: "" });
  }

  /** 确认移交：答案恒为移交选项原文（保证 parsePlanReview 精确匹配），携带所选实施模型。 */
  function confirmHandoff(): void {
    if (!handoffModel || submitting) return;
    const slash = handoffModel.lastIndexOf("/");
    if (slash <= 0) return;
    const model = { provider: handoffModel.slice(0, slash), id: handoffModel.slice(slash + 1) };
    const answers = request.questions.map((question, index) => {
      if (index === current && question.handoffOption) return question.handoffOption;
      return serializeAnswer(question, drafts[index] ?? emptyQuestionDraft());
    });
    void resolve(answers, model);
  }

  /** 选择行键盘：Enter 确认移交（已选模型时）、Esc 返回。 */
  function handleHandoffKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelHandoff();
      return;
    }
    if (event.key === "Enter" && handoffModel && !submitting) {
      event.preventDefault();
      confirmHandoff();
    }
  }

  /** 选项切换：单选任意点选（含回车/空格）都选中并立即推进（点选即走，重选直接换项）；多选切换勾选、由「继续」或输入框回车推进。移交选项（单选）走两段式：不立即提交。 */
  function toggleOption(item: QuestionItem, index: number, option: string): void {
    const currentDraft = drafts[index] ?? emptyQuestionDraft();
    const single = item.type === "single";
    if (single && option === item.handoffOption) {
      patchDraft(index, { selected: [option], custom: "" });
      openHandoff();
      return;
    }
    const nextSelected = single
      ? [option]
      : currentDraft.selected.includes(option)
        ? currentDraft.selected.filter((value) => value !== option)
        : [...currentDraft.selected, option];
    setDrafts((currentDrafts) => currentDrafts.map((draft, i) => i === index ? { ...draft, selected: nextSelected } : draft));
    setHandoffOpen(false);
    if (single) {
      if (index === request.questions.length - 1) {
        // 单选点选即提交：答案必须基于本次点击的选项。setDrafts 是异步的，
        // 闭包里的 drafts 还是点击前的旧状态——走 advance() 会提交空选/旧选
        // （serializeAnswer 单选无自定义输入时返回空串，审查批准被误判拒绝）。
        void resolve([singleSelectionAnswer(currentDraft.custom, option)]);
      } else {
        setCurrent(index + 1);
      }
    }
  }

  const item = request.questions[current] ?? request.questions[0]!;
  const isLast = current === request.questions.length - 1;
  const answered = isQuestionAnswered(item, drafts[current] ?? emptyQuestionDraft());
  const detailPreview = item.detail ? detailPreviewText(item.detail) : undefined;

  /** 忽略 = 取消整个提问；继续 = 手动推进（多选勾选后、或想停留再确认时用）。 */
  function continueToNext(): void {
    if (!answered || submitting) return;
    advance();
  }

  /** 选项键盘：↑↓ 移动焦点（单选同步移动选中），回车/空格选中（阻止默认滚动）。 */
  function handleOptionKey(event: KeyboardEvent<HTMLButtonElement>, question: QuestionItem, optionIndex: number): void {
    const options = question.options;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = (optionIndex + delta + options.length) % options.length;
      if (question.type === "single") {
        patchDraft(current, { selected: [options[next]!] });
      }
      optionRefs.current[next]?.focus();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && !event.nativeEvent.isComposing) {
      event.preventDefault();
      toggleOption(question, current, options[optionIndex]!);
    }
  }

  /** 自定义输入回车：翻到下一题，最后一题作答后提交。 */
  function handleInputKey(event: KeyboardEvent<HTMLInputElement>, index: number): void {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (index < request.questions.length - 1) {
      setCurrent(index + 1);
      return;
    }
    if (answered && !submitting) {
      void resolve(request.questions.map((question, i) => serializeAnswer(question, drafts[i] ?? emptyQuestionDraft())));
    }
  }

  return (
    <div className="question-panel" data-pane="question-panel" role="form" aria-label="AI 提问">
      <header className="question-panel-header">
        <span className="question-step-tag">{isLast ? "最后一步" : "下一步"}</span>
        <h2 className="question-title">{item.text}</h2>
        <div className="question-pager">
          <span>{current + 1} / {request.questions.length}</span>
          <button type="button" aria-label="上一题" disabled={current === 0 || submitting || handoffOpen} onClick={() => setCurrent((value) => Math.max(0, value - 1))}>◀</button>
          <button type="button" aria-label="下一题" disabled={isLast || submitting || handoffOpen} onClick={() => setCurrent((value) => Math.min(request.questions.length - 1, value + 1))}>▶</button>
        </div>
      </header>
      {detailPreview && (
        <div className="question-detail" aria-label="问题详情">
          <RichContent artifactPrefix="question-detail" onOpenArtifact={() => undefined}>{detailPreview.preview}</RichContent>
          {detailPreview.truncated && (
            <div className="question-detail-actions">
              <button type="button" className="question-detail-open" onClick={() => onOpenDetail?.(item.detail!)}><Maximize2 size={12} />查看完整</button>
            </div>
          )}
        </div>
      )}
      {item.options.length > 0 && (
        <ol
          className="question-options"
          role={item.type === "single" ? "radiogroup" : "group"}
          aria-label={`问题 ${current + 1} 选项`}
        >
          {item.options.map((option, optionIndex) => {
            const active = (drafts[current] ?? emptyQuestionDraft()).selected.includes(option);
            return (
              <li key={option}>
                <button
                  ref={(element) => { optionRefs.current[optionIndex] = element ?? undefined; }}
                  type="button"
                  className={`question-option${active ? " active" : ""}`}
                  role={item.type === "single" ? "radio" : "checkbox"}
                  aria-checked={active}
                  disabled={submitting || handoffOpen}
                  onClick={() => toggleOption(item, current, option)}
                  onKeyDown={(event) => handleOptionKey(event, item, optionIndex)}
                >
                  <span className="question-option-index">{optionIndex + 1}</span>
                  <span className="question-option-label">{option}</span>
                  {optionIndex === 0 && <span className="question-recommended">（推荐）</span>}
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {handoffOpen && item.handoffOption && (
        <div className="question-handoff-row" onKeyDown={handleHandoffKey}>
          <label className="question-handoff-label" htmlFor="question-handoff-select">实施模型</label>
          <select
            id="question-handoff-select"
            ref={(element) => { handoffSelectRef.current = element ?? undefined; }}
            className="question-handoff-select"
            value={handoffModel}
            disabled={submitting}
            onChange={(event) => setHandoffModel(event.target.value)}
          >
            {!handoffModel && <option value="">选择模型…</option>}
            {handoffGroups.map((group) => (
              <optgroup key={group.provider} label={group.providerName}>
                {group.models.map((model) => (
                  <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name}（{model.id}）</option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="question-handoff-hint">新会话将以所选模型严格按计划文档实施</p>
          <div className="question-handoff-actions">
            <button className="secondary-button" type="button" disabled={submitting} onClick={cancelHandoff}>返回</button>
            <button className="primary-button" type="button" disabled={!handoffModel || submitting} onClick={confirmHandoff}>
              {submitting ? "提交中…" : "移交实施"}
            </button>
          </div>
        </div>
      )}
      <div className="question-custom-row">
        <span className="question-custom-index">{item.options.length + 1}</span>
        <input
          ref={(element) => { inputRef.current = element ?? undefined; }}
          value={drafts[current]?.custom ?? ""}
          disabled={submitting || handoffOpen}
          placeholder="输入你的回答..."
          onChange={(event) => patchDraft(current, { custom: event.target.value })}
          onKeyDown={(event) => handleInputKey(event, current)}
        />
      </div>
      <footer className="question-panel-footer">
        <span className="question-hint"><CircleHelp size={12} /> 使用 Tab / 上下键选择，回车或空格选中</span>
        <div className="question-footer-actions">
          <button className="secondary-button" type="button" disabled={submitting} onClick={() => void resolve()}>忽略</button>
          <button className="primary-button" type="button" disabled={!answered || submitting || handoffOpen} onClick={continueToNext}>
            {submitting ? "提交中…" : "继续"}
          </button>
        </div>
      </footer>
    </div>
  );
}
