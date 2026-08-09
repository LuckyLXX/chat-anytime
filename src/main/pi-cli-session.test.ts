import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCliSessionManager } from "./pi-cli-session.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Pi CLI session persistence", () => {
  it("uses the exact session file requested by pi-subagents", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-pi-cli-session-"));
    tempDirs.push(root);
    const sessionFile = join(root, "run-0", "session.jsonl");
    const manager = createCliSessionManager({ mode: "json", sessionFile }, root, "child-id");

    expect(manager.isPersisted()).toBe(true);
    expect(manager.getSessionFile()).toBe(resolve(sessionFile));
    expect(manager.getSessionId()).not.toBe("");
  });

  it("creates a persistent session inside --session-dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-pi-cli-session-"));
    tempDirs.push(root);
    const sessionDir = join(root, "sessions");
    const manager = createCliSessionManager({ mode: "json", sessionDir }, root, "child-id");

    expect(manager.isPersisted()).toBe(true);
    expect(manager.getSessionDir()).toBe(resolve(sessionDir));
    expect(manager.getSessionId()).toBe("child-id");
  });

  it("keeps --no-session runs in memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pidesktop-pi-cli-session-"));
    tempDirs.push(root);
    const manager = createCliSessionManager({ mode: "json", noSession: true }, root, "child-id");

    expect(manager.isPersisted()).toBe(false);
    expect(manager.getSessionFile()).toBeUndefined();
    expect(manager.getSessionId()).toBe("child-id");
  });
});
