import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverExtensionCandidates, ExtensionPolicy } from "./extension-policy.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ExtensionPolicy", () => {
  it("discovers candidates without importing or executing their files", () => {
    const candidates = discoverExtensionCandidates([
      { path: "C:/Users/test/.pi/agent/extensions/subagent/index.ts", enabled: true, metadata: { source: "auto", scope: "user", origin: "top-level" } },
      { path: "C:/Users/test/.pi/agent/npm/node_modules/pi-subagents/index.ts", enabled: true, metadata: { source: "npm:pi-subagents", scope: "user", origin: "package" } },
      { path: "C:/Users/test/.pi/agent/extensions/disabled.ts", enabled: false, metadata: { source: "auto", scope: "user", origin: "top-level" } }
    ], "C:/app/pi-mcp-adapter/index.js");

    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.summary).toMatchObject({ name: "index.ts", scope: "global", trust: "undecided", loaded: false });
    expect(candidates[1]!.summary).toMatchObject({ name: "pi-subagents", source: "npm:pi-subagents", scope: "package", origin: "package" });
  });

  it("persists an approval and exposes only approved candidate paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-extension-policy-"));
    tempDirs.push(root);
    const extensionPath = join(root, "extension.ts");
    await writeFile(extensionPath, "export default () => undefined;", "utf8");

    const [candidate] = discoverExtensionCandidates([{ path: extensionPath, enabled: true, metadata: { source: "auto", scope: "user", origin: "top-level" } }], join(root, "other.js"));
    const policy = new ExtensionPolicy(root);
    await policy.load();
    policy.setCandidates([candidate!]);
    expect(policy.approvedPaths()).toEqual([]);
    await expect(policy.approve(candidate!.summary.id)).resolves.toBe(true);
    expect(policy.approvedPaths()).toEqual([extensionPath]);

    const restored = new ExtensionPolicy(root);
    await restored.load();
    restored.setCandidates([candidate!]);
    expect(restored.candidateSummaries()[0]).toMatchObject({ trust: "trusted", enabled: true });
    expect(restored.approvedIds()).toEqual([candidate!.summary.id]);
  });

  it("invalidates approval when extension contents change", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-extension-fingerprint-"));
    tempDirs.push(root);
    const extensionPath = join(root, "extension.ts");
    await writeFile(extensionPath, "export default () => 'v1';", "utf8");
    const [candidate] = discoverExtensionCandidates([{ path: extensionPath, enabled: true, metadata: { source: "auto", scope: "user", origin: "top-level" } }], join(root, "other.js"));
    const policy = new ExtensionPolicy(root);
    policy.setCandidates([candidate!]);
    await policy.refreshFingerprints();
    await policy.approve(candidate!.summary.id);

    await writeFile(extensionPath, "export default () => 'v2';", "utf8");
    await policy.refreshFingerprints();

    expect(policy.approvedPaths()).toEqual([]);
    expect(policy.candidateSummaries()[0]).toMatchObject({ trust: "undecided", enabled: false, approvalChanged: true });
  });

  it("supports disabling, re-enabling and revoking a valid approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-extension-toggle-"));
    tempDirs.push(root);
    const extensionPath = join(root, "extension.ts");
    await writeFile(extensionPath, "export default () => undefined;", "utf8");
    const [candidate] = discoverExtensionCandidates([{ path: extensionPath, enabled: true, metadata: { source: "auto", scope: "user", origin: "top-level" } }], join(root, "other.js"));
    const policy = new ExtensionPolicy(root);
    policy.setCandidates([candidate!]);
    await policy.refreshFingerprints();
    await policy.approve(candidate!.summary.id);

    await expect(policy.setEnabled(candidate!.summary.id, false)).resolves.toBe(true);
    expect(policy.approvedPaths()).toEqual([]);
    expect(policy.candidateSummaries()[0]).toMatchObject({ trust: "trusted", enabled: false });
    await expect(policy.setEnabled(candidate!.summary.id, true)).resolves.toBe(true);
    expect(policy.approvedPaths()).toEqual([extensionPath]);
    await expect(policy.revoke(candidate!.summary.id)).resolves.toBe(true);
    expect(policy.candidateSummaries()[0]).toMatchObject({ trust: "undecided", enabled: false });
  });
});
