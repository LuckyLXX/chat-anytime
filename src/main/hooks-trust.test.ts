import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookRule } from "../shared/protocol.js";
import { applyHookSaveTrust, evaluateHookTrust, hookRuleDigest, pruneTrust, readHookTrust, revokeRule, trustRule, workspaceTrustKey, writeHookTrust } from "./hooks-trust.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-hook-trust-"));
  temporaryDirectories.push(directory);
  return join(directory, "pidesktop-hook-trust.json");
}

const rule: HookRule = { name: "格式化", event: "tool_execution_end", matcher: "write", action: { kind: "command", command: "npx prettier --write src/" } };

describe("hook trust", () => {
  it("hashes canonical rule JSON independent of object key order", () => {
    const left: HookRule = { name: "n", event: "agent_end", action: { kind: "notify", body: "done", title: "title" } };
    const right: HookRule = { name: "n", event: "agent_end", action: { title: "title", kind: "notify", body: "done" } };
    expect(hookRuleDigest(left)).toBe(hookRuleDigest(right));
  });

  it("changes the fingerprint when any execution-relevant rule field changes", () => {
    expect(hookRuleDigest(rule)).not.toBe(hookRuleDigest({ ...rule, matcher: "edit" }));
    expect(hookRuleDigest(rule)).not.toBe(hookRuleDigest({ ...rule, timeoutMs: 20_000 }));
    expect(hookRuleDigest(rule)).not.toBe(hookRuleDigest({ ...rule, action: { kind: "command", command: "npm test" } }));
  });

  it("round-trips valid data through the atomic store", async () => {
    const file = await temporaryFile();
    const data = trustRule(readHookTrust(file), "c:/repo", rule, "2026-09-28T00:00:00.000Z");
    expect(writeHookTrust(file, data)).toBe(true);
    expect(readHookTrust(file).workspaces["c:/repo"]?.[rule.name]).toEqual({ digest: hookRuleDigest(rule), trustedAt: "2026-09-28T00:00:00.000Z" });
  });

  it("degrades corrupt and unsupported-version files without overwriting them", async () => {
    const file = await temporaryFile();
    const original = '{"version":2,"workspaces":{}}';
    await writeFile(file, original, "utf8");
    const invalid = readHookTrust(file);
    expect(invalid.workspaces).toEqual({});
    expect(invalid.writable).toBe(false);
    expect(writeHookTrust(file, trustRule(invalid, "c:/repo", rule))).toBe(false);
    expect(await readFile(file, "utf8")).toBe(original);

    await writeFile(file, "{bad json", "utf8");
    expect(readHookTrust(file).writable).toBe(false);
  });

  it("normalizes workspace keys like the session scope code", () => {
    const workspace = resolve("C:/Projects/PiDesktop/../PiDesktop");
    expect(workspaceTrustKey(workspace.toUpperCase())).toBe(workspace.replaceAll("\\", "/").toLowerCase());
  });

  it("evaluates trusted state by workspace, rule name, and content digest", () => {
    const key = workspaceTrustKey("C:/repo");
    const data = trustRule(readHookTrust(join(tmpdir(), "not-created-hook-trust.json")), key, rule, "now");
    expect(evaluateHookTrust({ scope: "project", workspace: "C:/repo", rule, data })).toBe("trusted");
    expect(evaluateHookTrust({ scope: "project", workspace: "C:/other", rule, data })).toBe("pending");
    expect(evaluateHookTrust({ scope: "project", workspace: "C:/repo", rule: { ...rule, matcher: "edit" }, data })).toBe("pending");
    expect(evaluateHookTrust({ scope: "global", rule, data })).toBe("global");
  });

  it("supports revoke and pruning after rule deletion", () => {
    const key = "c:/repo";
    const withTwo = trustRule(trustRule(readHookTrust(join(tmpdir(), "none.json")), key, rule), key, { ...rule, name: "通知" });
    const revoked = revokeRule(withTwo, key, rule.name);
    expect(revoked.workspaces[key]).not.toHaveProperty(rule.name);
    expect(pruneTrust(withTwo, key, ["通知"]).workspaces[key]).toHaveProperty("通知");
    expect(pruneTrust(withTwo, key, []).workspaces).toEqual({});
  });

  it("trusts a project rule immediately after it is saved", () => {
    const key = "c:/repo";
    const saved = applyHookSaveTrust(readHookTrust(join(tmpdir(), "none.json")), key, rule, "now");
    expect(evaluateHookTrust({ scope: "project", workspace: "C:/repo", rule, data: saved })).toBe("trusted");
  });
});
