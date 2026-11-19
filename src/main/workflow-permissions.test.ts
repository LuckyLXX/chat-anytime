import { describe, expect, it } from "vitest";
import type { ExecutionPrincipal, PermissionRequest } from "../shared/protocol.js";
import { PermissionBroker } from "./permission-broker.js";
import { permissionActionWithCap } from "./permissions.js";

function principal(runId?: string): ExecutionPrincipal {
  return {
    kind: runId ? "subagent" : "root-agent",
    sessionId: "owner",
    ...(runId ? { parentSessionId: "owner", workflow: { runId, nodeId: "n1", attempt: 1, nodeTitle: "实施" } } : {})
  };
}

const base = { accessMode: "ask" as const, toolName: "bash", summary: "测试", args: { command: "npm test" }, risk: "command" as const };

describe("workflow permission scope", () => {
  it("cancels a workflow without denying the owner's unrelated request", async () => {
    const requests: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => requests.push(request));
    const owner = broker.request({ ...base, principal: principal() });
    const workflow = broker.request({ ...base, principal: principal("run-a") });
    broker.cancelWorkflow("run-a");
    await expect(workflow).resolves.toBe("deny");
    expect(broker.resolve(requests[0]!.id, "allow-once")).toBe(true);
    await expect(owner).resolves.toBe("allow-once");
  });

  it("cancels main and ordinary subagent requests without touching a workflow", async () => {
    const requests: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => requests.push(request));
    const owner = broker.request({ ...base, principal: principal() });
    const workflow = broker.request({ ...base, principal: principal("run-a") });
    broker.cancelPendingNonWorkflow("owner");
    await expect(owner).resolves.toBe("deny");
    expect(broker.resolve(requests[1]!.id, "allow-once")).toBe(true);
    await expect(workflow).resolves.toBe("allow-once");
  });

  it("keeps allow-session grants inside the originating workflow and clears on stop", async () => {
    const requests: PermissionRequest[] = [];
    const broker = new PermissionBroker((request) => requests.push(request));
    const first = broker.request({ ...base, principal: principal("run-a") });
    broker.resolve(requests[0]!.id, "allow-session");
    await expect(first).resolves.toBe("allow-session");
    await expect(broker.request({ ...base, principal: principal("run-a") })).resolves.toBe("allow-session");
    const other = broker.request({ ...base, principal: principal("run-b") });
    const owner = broker.request({ ...base, principal: principal() });
    expect(requests).toHaveLength(3);
    broker.resolve(requests[1]!.id, "deny");
    broker.resolve(requests[2]!.id, "deny");
    await Promise.all([other, owner]);
    broker.cancelWorkflow("run-a");
    const next = broker.request({ ...base, principal: principal("run-a") });
    expect(requests).toHaveLength(4);
    broker.resolve(requests[3]!.id, "deny");
    await expect(next).resolves.toBe("deny");
  });

  it("combines owner and node permissions per risk without granting extra access", async () => {
    expect(permissionActionWithCap("read-only", "full", "bash", "command")).toBe("deny");
    expect(permissionActionWithCap("full", "ask", "bash", "command")).toBe("ask");
    expect(permissionActionWithCap("read-only", "workspace", "read", "outside-workspace")).toBe("ask");
    const broker = new PermissionBroker(() => { throw new Error("deny must not ask"); });
    await expect(broker.request({ ...base, accessMode: "read-only", accessModeCap: "full", principal: principal("run-a") })).resolves.toBe("deny");
  });
});
