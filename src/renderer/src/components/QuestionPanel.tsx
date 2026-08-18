import { CircleHelp } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { QuestionItem, QuestionRequest } from "../../../shared/protocol";
import { useDesktopStore } from "../store";

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
 * 选择题（single/multiple）提供选项按钮，并始终附带一个自定义输入框；
 * 挂起期间工具执行阻塞，提交/取消经 question.resolve 返回给模型。
 */
export function QuestionPanel({ request }: { request: QuestionRequest }): ReactNode {
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => request.questions.map(() => emptyQuestionDraft()));
  const [submitting, setSubmitting] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | undefined)[]>([]);

  useEffect(() => {
    setDrafts(request.questions.map(() => emptyQuestionDraft()));
    setSubmitting(false);
    inputRefs.current[0]?.focus();
  }, [request.id, request.questions]);

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
    setDrafts((current) => current.map((draft, i) => i === index ? { ...draft, ...patch } : draft));
  }

  function toggleOption(item: QuestionItem, index: number, option: string): void {
    setDrafts((current) => current.map((draft, i) => {
      if (i !== index) return draft;
      if (item.type === "single") {
        return { ...draft, selected: draft.selected[0] === option ? [] : [option] };
      }
      return { ...draft, selected: draft.selected.includes(option) ? draft.selected.filter((value) => value !== option) : [...draft.selected, option] };
    }));
  }

  const allAnswered = request.questions.every((item, index) => isQuestionAnswered(item, drafts[index] ?? emptyQuestionDraft()));

  function handleInputKey(event: KeyboardEvent<HTMLInputElement>, index: number): void {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (index < request.questions.length - 1) {
      inputRefs.current[index + 1]?.focus();
      return;
    }
    if (allAnswered && !submitting) void resolve(request.questions.map((item, index) => serializeAnswer(item, drafts[index] ?? emptyQuestionDraft())));
  }

  return (
    <div className="question-panel" data-pane="question-panel" role="form" aria-label="AI 提问">
      <header>
        <CircleHelp size={16} />
        <strong>AI 想确认 {request.questions.length} 个问题</strong>
        <span>回答后 AI 会继续执行</span>
      </header>
      <div className="question-panel-items">
        {request.questions.map((item, index) => (
          <div className="question-panel-item" key={index}>
            <label htmlFor={`question-${request.id}-${index}`}>{index + 1}. {item.text}</label>
            {item.options.length > 0 && (
              <div
                className="question-options"
                role={item.type === "single" ? "radiogroup" : "group"}
                aria-label={`问题 ${index + 1} 选项`}
              >
                {item.options.map((option) => {
                  const active = (drafts[index] ?? emptyQuestionDraft()).selected.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      className={`question-option${active ? " active" : ""}`}
                      role={item.type === "single" ? "radio" : "checkbox"}
                      aria-checked={active}
                      disabled={submitting}
                      onClick={() => toggleOption(item, index, option)}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            )}
            <input
              ref={(element) => { inputRefs.current[index] = element ?? undefined; }}
              id={`question-${request.id}-${index}`}
              value={drafts[index]?.custom ?? ""}
              disabled={submitting}
              placeholder={item.options.length > 0 ? "或自定义输入，回车跳到下一问" : index === request.questions.length - 1 ? "回答后回车提交" : "输入回答，回车跳到下一问"}
              onChange={(event) => patchDraft(index, { custom: event.target.value })}
              onKeyDown={(event) => handleInputKey(event, index)}
            />
          </div>
        ))}
      </div>
      <footer>
        <button className="secondary-button" type="button" disabled={submitting} onClick={() => void resolve()}>取消提问</button>
        <button className="primary-button" type="button" disabled={!allAnswered || submitting} onClick={() => void resolve(request.questions.map((item, index) => serializeAnswer(item, drafts[index] ?? emptyQuestionDraft())))}>
          {submitting ? "提交中…" : "提交回答"}
        </button>
      </footer>
    </div>
  );
}
