import { describe, expect, it, vi } from "vitest";
import type { ExecutionPrincipal, PermissionRequest } from "../shared/protocol.js";
import { PermissionBroker } from "./permission-broker.js";

function principal(sessionId: string, toolCallId: string): ExecutionPrincipal {
  return { kind: "root-agent", sessionId, toolCallId };
}

describe("PermissionBroker", () => {
  it("tracks concurrent requests by id and session", async () => {
    const emitted: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => emitted.push(request));

    const first = broker.request({
      accessMode: "ask",
      toolName: "bash",
      summary: "运行测试",
      args: { command: "npm test" },
      risk: "command",
      principal: principal("session-a", "tool-a")
    });
    const second = broker.request({
      accessMode: "ask",
      toolName: "write",
      summary: "写入文件",
      args: { path: "src/a.ts" },
      risk: "write",
      principal: principal("session-b", "tool-b")
    });

    expect(emitted).toHaveLength(2);
    broker.resolve(emitted[1]!.id, "deny");
    broker.resolve(emitted[0]!.id, "allow-once");

    await expect(first).resolves.toBe("allow-once");
    await expect(second).resolves.toBe("deny");
  });

  it("scopes allow-session grants to the originating session", async () => {
    const emitted: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => emitted.push(request));
    const input = {
      accessMode: "ask" as const,
      toolName: "bash",
      summary: "运行测试",
      args: { command: "npm test" },
      risk: "command" as const
    };

    const initial = broker.request({ ...input, principal: principal("session-a", "tool-a") });
    broker.resolve(emitted[0]!.id, "allow-session");
    await expect(initial).resolves.toBe("allow-session");

    await expect(broker.request({ ...input, principal: principal("session-a", "tool-b") })).resolves.toBe("allow-session");
    const otherSession = broker.request({ ...input, principal: principal("session-b", "tool-c") });
    expect(emitted).toHaveLength(2);
    broker.resolve(emitted[1]!.id, "deny");
    await expect(otherSession).resolves.toBe("deny");
  });

  it("denies pending requests when a session is reset", async () => {
    const emitted: PermissionRequest[] = [];
    const dismissed: string[] = [];
    const broker = new PermissionBroker((request) => emitted.push(request), (id) => dismissed.push(id));
    const pending = broker.request({
      accessMode: "ask",
      toolName: "write",
      summary: "写入文件",
      args: { path: "src/a.ts" },
      risk: "write",
      principal: principal("session-a", "tool-a")
    });

    broker.reset("session-a");

    await expect(pending).resolves.toBe("deny");
    expect(dismissed).toEqual([emitted[0]!.id]);
    expect(broker.resolve(emitted[0]!.id, "allow-once")).toBe(false);
  });

  it("cancels pending requests without clearing allow-session grants", async () => {
    const emitted: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => emitted.push(request));
    const input = {
      accessMode: "ask" as const,
      toolName: "bash",
      summary: "运行测试",
      args: { command: "npm test" },
      risk: "command" as const,
      principal: principal("session-a", "tool-a")
    };

    const granted = broker.request(input);
    broker.resolve(emitted[0]!.id, "allow-session");
    await expect(granted).resolves.toBe("allow-session");

    const pending = broker.request({
      ...input,
      toolName: "write",
      summary: "写入文件",
      args: { path: "src/a.ts" },
      risk: "write",
      principal: principal("session-a", "tool-b")
    });
    broker.cancelPending("session-a");
    await expect(pending).resolves.toBe("deny");

    // 授权保留：同一会话同一风险的工具不再弹确认。
    await expect(broker.request({ ...input, principal: principal("session-a", "tool-c") })).resolves.toBe("allow-session");
  });
});

describe("PermissionBroker timeout (IM 会话)", () => {
  it("auto-denies through the same resolve path and emits dismiss exactly once", async () => {
    vi.useFakeTimers();
    try {
      const emitted: PermissionRequest[] = [];
      const dismissed: string[] = [];
      const broker = new PermissionBroker((request) => emitted.push(request), (id) => dismissed.push(id));
      const pending = broker.request({
        accessMode: "ask",
        toolName: "bash",
        summary: "运行测试",
        args: { command: "npm test" },
        risk: "command",
        principal: principal("session-im", "tool-a"),
        timeoutMs: 1_000
      });
      expect(emitted).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toBe("deny");
      expect(dismissed).toEqual([emitted[0]!.id]);
      // 超时之后再点按钮（或桌面端点拒绝）：同一条幂等路径，不重复结算。
      expect(broker.resolve(emitted[0]!.id, "allow-once")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the timer after a normal resolve (no leaked dismiss)", async () => {
    vi.useFakeTimers();
    try {
      const emitted: PermissionRequest[] = [];
      const dismissed: string[] = [];
      const broker = new PermissionBroker((request) => emitted.push(request), (id) => dismissed.push(id));
      const pending = broker.request({
        accessMode: "ask",
        toolName: "bash",
        summary: "运行测试",
        args: { command: "npm test" },
        risk: "command",
        principal: principal("session-im", "tool-b"),
        timeoutMs: 1_000
      });
      broker.resolve(emitted[0]!.id, "allow-once");
      await expect(pending).resolves.toBe("allow-once");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(dismissed).toEqual([emitted[0]!.id]);
      expect(emitted).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("团队成员权限隔离（2026-11-23 团队协作）", () => {
  const leadSession = "lead-session";
  function teamPrincipal(memberId: string, toolCallId: string, memberName = "reviewer"): ExecutionPrincipal {
    return {
      kind: "subagent",
      sessionId: leadSession,
      parentSessionId: leadSession,
      toolCallId,
      team: { leadSessionId: leadSession, memberId, memberName }
    };
  }

  it("keeps allow-session grants isolated per member (a grant never leaks to the Lead or another member)", async () => {
    const emitted: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => emitted.push(request));
    const input = { accessMode: "ask" as const, toolName: "bash", summary: "运行测试", args: { command: "npm test" }, risk: "command" as const };

    const first = broker.request({ ...input, principal: teamPrincipal("member-a", "t1") });
    broker.resolve(emitted[0]!.id, "allow-session");
    await expect(first).resolves.toBe("allow-session");

    // 同一成员再请求：复用授权（不再弹卡）。
    await expect(broker.request({ ...input, principal: teamPrincipal("member-a", "t2") })).resolves.toBe("allow-session");
    // 另一个成员与 Lead 自身都要重新确认。
    const otherMember = broker.request({ ...input, principal: teamPrincipal("member-b", "t3", "builder") });
    const lead = broker.request({ ...input, principal: { kind: "root-agent", sessionId: leadSession, toolCallId: "t4" } });
    expect(emitted).toHaveLength(3);
    broker.resolve(emitted[1]!.id, "deny");
    broker.resolve(emitted[2]!.id, "deny");
    await expect(otherMember).resolves.toBe("deny");
    await expect(lead).resolves.toBe("deny");
  });

  it("cancels only the stopped member's pending requests and its grants", async () => {
    const emitted: PermissionRequest[] = [];
    const dismissed: string[] = [];
    const broker = new PermissionBroker((request) => emitted.push(request), (id) => dismissed.push(id));
    const input = { accessMode: "ask" as const, toolName: "bash", summary: "运行测试", args: {}, risk: "command" as const };

    // member-a 已拿到长期授权；再挂一个待决请求。
    const granted = broker.request({ ...input, principal: teamPrincipal("member-a", "t1") });
    broker.resolve(emitted[0]!.id, "allow-session");
    await expect(granted).resolves.toBe("allow-session");
    const pendingA = broker.request({ ...input, toolName: "write", principal: teamPrincipal("member-a", "t2") });
    const pendingB = broker.request({ ...input, toolName: "write", principal: teamPrincipal("member-b", "t3", "builder") });

    broker.cancelTeamMember("member-a");
    await expect(pendingA).resolves.toBe("deny");
    expect(dismissed).toContain(emitted[1]!.id);
    // member-b 不受影响：它的卡还在。
    expect(dismissed).not.toContain(emitted[2]!.id);
    broker.resolve(emitted[2]!.id, "allow-once");
    await expect(pendingB).resolves.toBe("allow-once");
    // 被停止成员的长期授权也一并清掉：重新唤醒后要重新确认。
    const afterStop = broker.request({ ...input, principal: teamPrincipal("member-a", "t4") });
    expect(emitted).toHaveLength(4);
    broker.resolve(emitted[3]!.id, "deny");
    await expect(afterStop).resolves.toBe("deny");
  });

  it("Lead 停止只收尾自身与同步子代理，团队成员的待决请求由成员停止控制", async () => {
    const emitted: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => emitted.push(request));
    const input = { accessMode: "ask" as const, toolName: "bash", summary: "运行测试", args: {}, risk: "command" as const };
    const own = broker.request({ ...input, principal: { kind: "root-agent", sessionId: leadSession, toolCallId: "own" } });
    const syncChild = broker.request({ ...input, principal: { kind: "subagent", sessionId: leadSession, parentSessionId: leadSession, toolCallId: "sync" } });
    const member = broker.request({ ...input, principal: teamPrincipal("member-a", "member") });

    broker.cancelPendingNonTeam(leadSession);
    await expect(own).resolves.toBe("deny");
    await expect(syncChild).resolves.toBe("deny");
    expect(emitted.some((request) => request.principal.team?.memberId === "member-a")).toBe(true);
    // 成员的请求仍挂着：由「停止成员 / 全部停止」来收尾。
    broker.cancelTeamMember("member-a");
    await expect(member).resolves.toBe("deny");
  });

  it("reports how each request settled (user / mode / grant / timeout / cancel) exactly once", async () => {
    vi.useFakeTimers();
    const emitted: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => emitted.push(request));
    const causes: string[] = [];
    const input = { accessMode: "ask" as const, toolName: "bash", summary: "运行测试", args: {}, risk: "command" as const };

    // 模式直通与模式拦截：不弹卡但也算一次收场。
    await expect(broker.request({ ...input, accessMode: "full", principal: teamPrincipal("m", "a"), onSettled: (s) => causes.push(`mode-allow:${s.decision}`) })).resolves.toBe("allow-once");
    await expect(broker.request({ ...input, accessMode: "read-only", principal: teamPrincipal("m", "b"), onSettled: (s) => causes.push(`mode-deny:${s.decision}`) })).resolves.toBe("deny");

    // 超时：同一条 resolve 路径，cause=timeout。
    const timedOut = broker.request({ ...input, principal: teamPrincipal("m", "c"), timeoutMs: 1_000, onSettled: (s) => causes.push(`timeout:${s.cause}`) });
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(timedOut).resolves.toBe("deny");

    // 用户点击 + 授权复用 + 取消各自一次。
    const clicked = broker.request({ ...input, principal: teamPrincipal("m", "d"), onSettled: (s) => causes.push(`user:${s.cause}:${s.decision}`) });
    // 取最后发出来的那张卡（超时请求也发过一张，早已 resolve，不会再被处理）。
    broker.resolve(emitted.at(-1)!.id, "allow-session");
    await expect(clicked).resolves.toBe("allow-session");
    await expect(broker.request({ ...input, principal: teamPrincipal("m", "e"), onSettled: (s) => causes.push(`grant:${s.cause}`) })).resolves.toBe("allow-session");
    const cancelled = broker.request({ ...input, principal: teamPrincipal("m2", "f"), onSettled: (s) => causes.push(`cancel:${s.cause}`) });
    // 成员请求不跟随 Lead 停止：按成员取消才是「取消」这条路径。
    broker.cancelTeamMember("m2");
    await expect(cancelled).resolves.toBe("deny");

    expect(causes).toEqual([
      "mode-allow:allow-once",
      "mode-deny:deny",
      "timeout:timeout",
      "user:user:allow-session",
      "grant:grant",
      "cancel:cancel"
    ]);
    vi.useRealTimers();
  });

  it("keeps the optional member access-mode cap strict: deny wins over the owner's full mode", async () => {
    const broker = new PermissionBroker(() => undefined);
    // owner 是 full，但成员上限 read-only：逐次取严 → 拦截。
    await expect(broker.request({
      accessMode: "full",
      accessModeCap: "read-only",
      toolName: "bash",
      summary: "运行测试",
      args: {},
      risk: "command",
      principal: teamPrincipal("m", "cap-1")
    })).resolves.toBe("deny");
    // 没有上限的成员继承原会话策略（存量成员零变化）。
    await expect(broker.request({
      accessMode: "ask",
      toolName: "bash",
      summary: "运行测试",
      args: {},
      risk: "command",
      principal: teamPrincipal("m", "cap-2"),
      onSettled: () => undefined
    })).toBeInstanceOf(Promise);
  });
});
