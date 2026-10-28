import { describe, expect, it } from "vitest";
import type { AgentProfile } from "../../../shared/protocol";
import { pickTopicAgentId } from "./topic-agent";

function agent(id: string, archived = false): AgentProfile {
  return {
    id,
    name: id,
    description: "",
    systemPrompt: "",
    divMode: "auto",
    defaultThinkingLevel: "medium",
    tools: {} as AgentProfile["tools"],
    ...(archived ? { archived: true } : {})
  };
}

function settings(agents: AgentProfile[], currentAgentId = "default"): { agents: AgentProfile[]; currentAgentId: string } {
  return { agents, currentAgentId };
}

describe("pickTopicAgentId（新建话题共用判定）", () => {
  it("沿用当前激活会话的助手", () => {
    expect(pickTopicAgentId(settings([agent("default"), agent("reviewer")]), "reviewer")).toBe("reviewer");
  });

  it("激活助手已归档时回落到第一个未归档助手（`session.new` 会拒绝归档助手）", () => {
    expect(pickTopicAgentId(settings([agent("default"), agent("old", true)]), "old")).toBe("default");
    // 靠前的归档助手被跳过
    expect(pickTopicAgentId(settings([agent("old", true), agent("reviewer")]), "missing")).toBe("reviewer");
  });

  it("全归档时回落到 currentAgentId（保持既有行为，不在渲染端凭空拒绝）", () => {
    expect(pickTopicAgentId(settings([agent("old", true)], "old"), "old")).toBe("old");
  });
});
