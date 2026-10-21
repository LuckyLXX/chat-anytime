import { describe, expect, it } from "vitest";
import type { QuestionRequest } from "../shared/protocol.js";
import { PendingQuestionMirror } from "./pending-questions.js";

function request(id: string, sessionId = "session-a"): QuestionRequest {
  return {
    id,
    sessionId,
    toolCallId: `tool-${id}`,
    questions: [{ text: "继续吗？", type: "single", options: ["继续", "停止"] }]
  };
}

describe("PendingQuestionMirror", () => {
  it("按到达顺序记录待决提问", () => {
    const mirror = new PendingQuestionMirror();
    mirror.record(request("question-1"));
    mirror.record(request("question-2", "session-b"));

    expect(mirror.list().map((item) => item.id)).toEqual(["question-1", "question-2"]);
  });

  it("同 id 重复推送只保留最新一份（重连/重发不叠加）", () => {
    const mirror = new PendingQuestionMirror();
    mirror.record(request("question-1"));
    const refreshed = request("question-1");
    refreshed.questions = [{ text: "刷新后的问题？", type: "text", options: [] }];
    mirror.record(refreshed);

    expect(mirror.list()).toHaveLength(1);
    expect(mirror.list()[0]!.questions[0]!.text).toBe("刷新后的问题？");
  });

  it("question.dismiss 后不再回传给渲染端", () => {
    const mirror = new PendingQuestionMirror();
    mirror.record(request("question-1"));
    mirror.record(request("question-2"));
    mirror.dismiss("question-1");

    expect(mirror.list().map((item) => item.id)).toEqual(["question-2"]);
    expect(mirror.list()).not.toBe(mirror.list());
  });

  it("clear 清空全部镜像（utility 退出后不能把死请求恢复出来）", () => {
    const mirror = new PendingQuestionMirror();
    mirror.record(request("question-1"));
    mirror.clear();

    expect(mirror.list()).toEqual([]);
  });
});
