import { describe, expect, it } from "vitest";
import type { QuestionItem } from "../../../shared/protocol";
import { emptyQuestionDraft, isQuestionAnswered, serializeAnswer } from "./QuestionPanel";

function item(input: Partial<QuestionItem> & { text: string }): QuestionItem {
  return { type: "text", options: [], ...input };
}

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
