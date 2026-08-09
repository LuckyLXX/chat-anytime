import { describe, expect, it } from "vitest";
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
});
