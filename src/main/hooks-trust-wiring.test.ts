import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./pi-runtime.ts", import.meta.url), "utf8").replace(/\r\n/gu, "\n");

function commandBranch(name: string, nextName: string): string {
  const start = source.indexOf(`case "${name}":`);
  const end = source.indexOf(`case "${nextName}":`, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("project hook trust wiring", () => {
  it("checks trust before executing hooks.run test commands", () => {
    const branch = commandBranch("hooks.run", "skill.toggle");
    const trustCheck = branch.indexOf("evaluateHookTrust({ scope: entry.scope");
    const execution = branch.indexOf("runtimeHooks.testHook(");
    expect(trustCheck).toBeGreaterThanOrEqual(0);
    expect(execution).toBeGreaterThan(trustCheck);
    expect(branch.slice(trustCheck, execution)).toContain('throw new Error("项目级钩子尚未批准');
  });

  it("trusts the saved project rule before refreshing the catalog", () => {
    const branch = commandBranch("hooks.save", "hooks.toggle");
    const apply = branch.indexOf("applyHookSaveTrust(");
    const write = branch.indexOf("writeHookTrust(");
    const refresh = branch.indexOf("refreshHooksConfig();");
    expect(apply).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(apply);
    expect(refresh).toBeGreaterThan(write);
  });

  it("prunes project trust after successful deletion", () => {
    const branch = commandBranch("hooks.delete", "hooks.trust");
    const remove = branch.indexOf("removeHookConfig(");
    const prune = branch.indexOf("pruneTrust(");
    const write = branch.indexOf("writeHookTrust(");
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(prune).toBeGreaterThan(remove);
    expect(write).toBeGreaterThan(prune);
  });

  it("persists trust changes before reloading summaries", () => {
    const branch = commandBranch("hooks.trust", "hooks.settings");
    const trust = branch.indexOf("trustRule(");
    const revoke = branch.indexOf("revokeRule(");
    const write = branch.indexOf("writeHookTrust(");
    const refresh = branch.indexOf("refreshHooksConfig();");
    expect(trust).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeGreaterThan(trust);
    expect(write).toBeGreaterThan(revoke);
    expect(refresh).toBeGreaterThan(write);
  });

  it("reloads hook rules after live activation switches workspace", () => {
    const start = source.indexOf("function activate(record: SessionRuntimeRecord): void {");
    const end = source.indexOf("\nfunction workspaceSessionDir()", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const activation = source.slice(start, end);
    const setWorkspace = activation.indexOf("workspace = record.workspace;");
    const refresh = activation.indexOf("if (workspaceChanged) refreshHooksConfig();");
    const emitCatalog = activation.indexOf("emitResourceCatalog();");
    expect(refresh).toBeGreaterThan(setWorkspace);
    expect(emitCatalog).toBeGreaterThan(refresh);
  });
});
