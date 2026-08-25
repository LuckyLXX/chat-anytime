import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QuestionItem, QuestionRequest } from "../../../shared/protocol";
import { emptyQuestionDraft, isQuestionAnswered, QuestionPanel, serializeAnswer, singleSelectionAnswer } from "./QuestionPanel";

function item(input: Partial<QuestionItem> & { text: string }): QuestionItem {
  return { type: "text", options: [], ...input };
}

describe("QuestionPanel detail block", () => {
  function request(detail?: string): QuestionRequest {
    return {
      id: "q1",
      sessionId: "s1",
      toolCallId: "t1",
      questions: [{ text: "审查", type: "single", options: ["批准"], ...(detail !== undefined ? { detail } : {}) }]
    };
  }

  it("renders the markdown detail above the options when present", () => {
    const markup = renderToStaticMarkup(<QuestionPanel request={request("# 计划\n\n步骤清单")} />);
    expect(markup).toContain("question-detail");
    expect(markup).toContain("计划");
    expect(markup).toContain("步骤清单");
  });

  it("omits the detail block when absent (legacy questions unchanged)", () => {
    const markup = renderToStaticMarkup(<QuestionPanel request={request()} />);
    expect(markup).not.toContain("question-detail");
    expect(markup).toContain("批准");
  });
});

describe("isQuestionAnswered", () => {
  it("requires non-empty custom input for text questions", () => {
    const text = item({ text: "版本？" });
    expect(isQuestionAnswered(text, emptyQuestionDraft())).toBe(false);
    expect(isQuestionAnswered(text, { custom: "  ", selected: [] })).toBe(false);
    expect(isQuestionAnswered(text, { custom: "1.0", selected: [] })).toBe(true);
  });

  it("accepts either an option or custom input for choice questions", () => {
    const single = item({ text: "框架？", type: "single", options: ["React", "Vue"] });
    expect(isQuestionAnswered(single, { custom: "", selected: ["React"] })).toBe(true);
    expect(isQuestionAnswered(single, { custom: "Svelte", selected: [] })).toBe(true);
    expect(isQuestionAnswered(single, emptyQuestionDraft())).toBe(false);
  });
});

describe("singleSelectionAnswer", () => {
  it("prefers trimmed custom input over the clicked option", () => {
    expect(singleSelectionAnswer("", "批准计划，开始实施")).toBe("批准计划，开始实施");
    expect(singleSelectionAnswer("   ", "批准计划，开始实施")).toBe("批准计划，开始实施");
    expect(singleSelectionAnswer("步骤太少", "批准计划，开始实施")).toBe("步骤太少");
  });
});

describe("serializeAnswer", () => {
  it("returns the trimmed custom text for text questions", () => {
    expect(serializeAnswer(item({ text: "版本？" }), { custom: " 1.0 ", selected: [] })).toBe("1.0");
  });

  it("prefers custom input over the selected option for single choice", () => {
    const single = item({ text: "框架？", type: "single", options: ["React", "Vue"] });
    expect(serializeAnswer(single, { custom: "", selected: ["Vue"] })).toBe("Vue");
    expect(serializeAnswer(single, { custom: "Svelte", selected: ["Vue"] })).toBe("Svelte");
  });

  it("joins multiple selections with custom input appended last", () => {
    const multiple = item({ text: "功能？", type: "multiple", options: ["A", "B", "C"] });
    expect(serializeAnswer(multiple, { custom: "", selected: ["A", "C"] })).toBe("A、C");
    expect(serializeAnswer(multiple, { custom: "其它：D", selected: ["A"] })).toBe("A、其它：D");
    expect(serializeAnswer(multiple, { custom: "只要 D", selected: [] })).toBe("只要 D");
  });
});
