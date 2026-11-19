import { describe, expect, it } from "vitest";
import type { PermissionRequest } from "../shared/protocol.js";
import { MAX_PERMISSION_PREVIEW_BYTES, PendingPermissionMirror } from "./pending-permissions.js";

function request(id: string, args: unknown = { command: "npm test" }): PermissionRequest {
  return { id, toolName: "bash", summary: "运行测试", args, risk: "command", principal: { kind: "root-agent", sessionId: "owner" } };
}

describe("PendingPermissionMirror", () => {
  it("restores pending requests, dismisses resolved entries and clears on exit", () => {
    const mirror = new PendingPermissionMirror();
    mirror.record(request("one"));
    mirror.record(request("two"));
    expect(mirror.list().map((item) => item.id)).toEqual(["one", "two"]);
    mirror.dismiss("one");
    expect(mirror.list().map((item) => item.id)).toEqual(["two"]);
    mirror.clear();
    expect(mirror.list()).toEqual([]);
  });

  it("bounds a large preview without altering broker-owned arguments", () => {
    const mirror = new PendingPermissionMirror();
    const original = request("one", { command: "测".repeat(MAX_PERMISSION_PREVIEW_BYTES) });
    mirror.record(original);
    expect(String(mirror.list()[0]!.args)).toContain("参数预览已截断");
    expect((original.args as { command: string }).command).toHaveLength(MAX_PERMISSION_PREVIEW_BYTES);
    const first = mirror.list();
    first[0]!.summary = "changed";
    expect(mirror.list()[0]!.summary).toBe("运行测试");
  });
});
