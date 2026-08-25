import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QuestionItem, QuestionRequest } from "../../../shared/protocol";
import { detailPreviewText, detailTitle, emptyQuestionDraft, isQuestionAnswered, QuestionPanel, serializeAnswer, singleSelectionAnswer } from "./QuestionPanel";

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

describe("detailPreviewText", () => {
  it("returns the detail unchanged when within the limit", () => {
    const result = detailPreviewText("# 计划\n\n短文本", 100);
    expect(result.preview).toBe("# 计划\n\n短文本");
    expect(result.truncated).toBe(false);
  });

  it("cuts long details back to the last newline before the limit", () => {
    const long = `# 计划\n\n第一步计划内容……${"篇幅内容".repeat(50)}`;
    const result = detailPreviewText(long, 100);
    expect(result.truncated).toBe(true);
    expect(result.preview.length).toBeLessThanOrEqual(104);
    expect(result.preview.endsWith("…")).toBe(true);
    // 预览不包含截断点之后的内容。
    expect(long.slice(result.preview.length - 1)).toContain("篇幅内容");
  });

  it("hard-cuts when there is no newline before the limit", () => {
    const result = detailPreviewText("无换行内容".repeat(50), 20);
    expect(result.truncated).toBe(true);
    expect(result.preview.length).toBeLessThanOrEqual(24);
  });

  it("uses the default 1600-char limit", () => {
    expect(detailPreviewText("短").truncated).toBe(false);
    expect(detailPreviewText("长".repeat(2000)).truncated).toBe(true);
  });
});

describe("detailTitle", () => {
  it("extracts the first markdown heading", () => {
    expect(detailTitle("# 状态栏时钟实现计划\n\n正文")).toBe("状态栏时钟实现计划");
  });

  it("falls back to 计划 without a heading", () => {
    expect(detailTitle("无标题内容")).toBe("计划");
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
