import { CircleHelp } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { QuestionItem, QuestionRequest } from "../../../shared/protocol";
import { useDesktopStore } from "../store";
import { RichContent } from "./RichContent";

/** 每题的作答草稿：选项勾选 + 自定义输入（文本题只用 custom）。 */
export interface QuestionDraft {
  custom: string;
  selected: string[];
}

export function emptyQuestionDraft(): QuestionDraft {
  return { custom: "", selected: [] };
}

/** 该题是否已作答：选择题勾选或自定义输入任一即可。 */
export function isQuestionAnswered(item: QuestionItem, draft: QuestionDraft): boolean {
  if (draft.selected.length > 0) return true;
  return draft.custom.trim().length > 0;
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
export function QuestionPanel({ request }: { request: QuestionRequest }): ReactNode {
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => request.questions.map(() => emptyQuestionDraft()));
  const [current, setCurrent] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const optionRefs = useRef<(HTMLButtonElement | undefined)[]>([]);
  const inputRef = useRef<HTMLInputElement | undefined>(undefined);

  useEffect(() => {
    setDrafts(request.questions.map(() => emptyQuestionDraft()));
    setCurrent(0);
    setSubmitting(false);
  }, [request.id, request.questions]);

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

  async function resolve(answers?: string[]): Promise<void> {
    setSubmitting(true);
    try {
      await window.piDesktop.send({ type: "question.resolve", id: request.id, ...(answers ? { answers } : {}) });
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

  /** 选项切换：单选任意点选（含回车/空格）都选中并立即推进（点选即走，重选直接换项）；多选切换勾选、由「继续」或输入框回车推进。 */
  function toggleOption(item: QuestionItem, index: number, option: string): void {
    const currentDraft = drafts[index] ?? emptyQuestionDraft();
    const single = item.type === "single";
    const nextSelected = single
      ? [option]
      : currentDraft.selected.includes(option)
        ? currentDraft.selected.filter((value) => value !== option)
        : [...currentDraft.selected, option];
    setDrafts((currentDrafts) => currentDrafts.map((draft, i) => i === index ? { ...draft, selected: nextSelected } : draft));
    if (single) advance();
  }

  const item = request.questions[current] ?? request.questions[0]!;
  const isLast = current === request.questions.length - 1;
  const answered = isQuestionAnswered(item, drafts[current] ?? emptyQuestionDraft());

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
          <button type="button" aria-label="上一题" disabled={current === 0 || submitting} onClick={() => setCurrent((value) => Math.max(0, value - 1))}>◀</button>
          <button type="button" aria-label="下一题" disabled={isLast || submitting} onClick={() => setCurrent((value) => Math.min(request.questions.length - 1, value + 1))}>▶</button>
        </div>
      </header>
      {item.detail && (
        <div className="question-detail" aria-label="问题详情">
          <RichContent artifactPrefix="question-detail" onOpenArtifact={() => undefined}>{item.detail}</RichContent>
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
                  disabled={submitting}
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
      <div className="question-custom-row">
        <span className="question-custom-index">{item.options.length + 1}</span>
        <input
          ref={(element) => { inputRef.current = element ?? undefined; }}
          value={drafts[current]?.custom ?? ""}
          disabled={submitting}
          placeholder="输入你的回答..."
          onChange={(event) => patchDraft(current, { custom: event.target.value })}
          onKeyDown={(event) => handleInputKey(event, current)}
        />
      </div>
      <footer className="question-panel-footer">
        <span className="question-hint"><CircleHelp size={12} /> 使用 Tab / 上下键选择，回车或空格选中</span>
        <div className="question-footer-actions">
          <button className="secondary-button" type="button" disabled={submitting} onClick={() => void resolve()}>忽略</button>
          <button className="primary-button" type="button" disabled={!answered || submitting} onClick={continueToNext}>
            {submitting ? "提交中…" : "继续"}
          </button>
        </div>
      </footer>
    </div>
  );
}
