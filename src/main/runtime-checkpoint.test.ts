import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetCheckpointState } from "./checkpoint-store.js";
import { createCheckpointExtension, rollbackPlan, snapshotTargetsFor, snapshotTarget, type CheckpointExtensionDeps } from "./runtime-checkpoint.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  resetCheckpointState();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-desktop-cpx-"));
  temporaryDirectories.push(dir);
  return dir;
}

interface FakePi {
  handlers: Map<string, (event: Record<string, unknown>) => unknown>;
  on(event: string, handler: (event: Record<string, unknown>) => unknown): void;
}

function bind(extension: unknown): FakePi {
  const pi: FakePi = {
    handlers: new Map(),
    on(event, handler) {
      this.handlers.set(event, handler);
    }
  };
  (extension as { factory: (pi: FakePi) => void }).factory(pi);
  return pi;
}

function makeDeps(workspace: string, root: string, enabled = true): CheckpointExtensionDeps {
  return {
    workspace: () => workspace,
    sessionId: () => "session-1",
    agentSessionRoot: () => root,
    enabled: () => enabled,
    warn: (message) => {
      throw new Error(`不应产生 warn：${message}`);
    }
  };
}

describe("snapshotTargetsFor", () => {
  it("maps write/edit to their path argument and bash to explicit output candidates", () => {
    const workspace = "D:\\ws";
    expect(snapshotTargetsFor(workspace, "write", { path: "src/a.ts" })).toEqual([{ relativePath: "src/a.ts", requireExisting: false }]);
    expect(snapshotTargetsFor(workspace, "edit", { file_path: "src/b.ts" })).toEqual([{ relativePath: "src/b.ts", requireExisting: false }]);
    // 越界/绝对路径逃逸不产生目标。
    expect(snapshotTargetsFor(workspace, "write", { path: "../outside.txt" })).toEqual([]);
    // bash 只认显式输出路径，且一律 requireExisting。
    const bashTargets = snapshotTargetsFor(workspace, "bash", { command: "node gen.js -o out.png" });
    expect(bashTargets).toEqual([{ relativePath: "out.png", requireExisting: true }]);
    expect(snapshotTargetsFor(workspace, "read", { path: "src/a.ts" })).toEqual([]);
  });
});

describe("checkpoint extension", () => {
  it("snapshots a file's prior content before write executes", async () => {
    const workspace = await makeWorkspace();
    const root = await makeWorkspace();
    await writeFile(join(workspace, "a.txt"), "before", "utf8");
    const deps = makeDeps(workspace, root);
    const pi = bind(createCheckpointExtension(deps));
    await pi.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "call-1", toolName: "write", args: { path: "a.txt" } });
    const entries = await import("./checkpoint-store.js").then((store) => store.readCheckpoints(store.checkpointPathFor(root, "session-1")));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ toolCallId: "call-1", toolName: "write", relativePath: "a.txt", existed: true, content: "before" });
  });

  it("records existed=false for brand-new files and skips absent bash candidates", async () => {
    const workspace = await makeWorkspace();
    const root = await makeWorkspace();
    const deps = makeDeps(workspace, root);
    const pi = bind(createCheckpointExtension(deps));
    await pi.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "call-new", toolName: "write", args: { path: "created.txt" } });
    // bash 候选不存在（requireExisting）：不记录，防止回滚误删用户文件。
    await pi.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "node gen.js -o missing.png" } });
    const store = await import("./checkpoint-store.js");
    const entries = await store.readCheckpoints(store.checkpointPathFor(root, "session-1"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.toolCallId).toBe("call-new");
    expect(entries[0]!.existed).toBe(false);
    expect(entries[0]!.content).toBeUndefined();
  });

  it("marks oversized files truncated and honors the enabled switch", async () => {
    const workspace = await makeWorkspace();
    const root = await makeWorkspace();
    await writeFile(join(workspace, "big.txt"), "x".repeat(6 * 1024 * 1024), "utf8");
    await writeFile(join(workspace, "normal.txt"), "content", "utf8");
    const deps = makeDeps(workspace, root);
    const pi = bind(createCheckpointExtension(deps));
    await pi.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "call-big", toolName: "write", args: { path: "big.txt" } });
    const disabled = bind(createCheckpointExtension({ ...makeDeps(workspace, root), enabled: () => false }));
    await disabled.handlers.get("tool_execution_start")!({ type: "tool_execution_start", toolCallId: "call-off", toolName: "write", args: { path: "normal.txt" } });
    const store = await import("./checkpoint-store.js");
    const entries = await store.readCheckpoints(store.checkpointPathFor(root, "session-1"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.toolCallId).toBe("call-big");
    expect(entries[0]!.truncated).toBe(true);
    expect(entries[0]!.content).toBeUndefined();
    expect(entries[0]!.existed).toBe(true);
  });

  it("snapshotTarget warns and skips on unreadable targets instead of throwing", async () => {
    const workspace = await makeWorkspace();
    const root = await makeWorkspace();
    // 把目录当文件读：readFile 抛 EISDIR（非 ENOENT）。
    await mkdir(join(workspace, "adirectory"), { recursive: true });
    const warnings: string[] = [];
    const happened = await snapshotTarget({ ...makeDeps(workspace, root), warn: (message) => warnings.push(message) }, new Date().toISOString(), "call-x", "write", { relativePath: "adirectory", requireExisting: false });
    expect(happened).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});

describe("rollbackPlan", () => {
  it("restores prior content, deletes created files, and skips truncated entries", async () => {
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, "edited.txt"), "AI 改过的内容", "utf8");
    await writeFile(join(workspace, "created.txt"), "AI 新建", "utf8");
    const entries = [
      { ts: "2026-08-29T00:00:00.000Z", toolCallId: "c1", toolName: "edit", relativePath: "edited.txt", existed: true, content: "原始内容" },
      { ts: "2026-08-29T00:00:01.000Z", toolCallId: "c2", toolName: "write", relativePath: "created.txt", existed: false },
      { ts: "2026-08-29T00:00:02.000Z", toolCallId: "c3", toolName: "write", relativePath: "huge.txt", existed: true, truncated: true }
    ];
    const results = await rollbackPlan(workspace, ["c1", "c2", "c3"], entries);
    expect(results).toEqual([
      { relativePath: "edited.txt", action: "restored" },
      { relativePath: "created.txt", action: "deleted" },
      { relativePath: "huge.txt", action: "skipped", detail: "文件超出快照大小上限，未保存原始内容" }
    ]);
    await expect(readFile(join(workspace, "edited.txt"), "utf8")).resolves.toBe("原始内容");
    await expect(stat(join(workspace, "created.txt"))).rejects.toThrow();
  });

  it("restores nested paths (creating missing directories) and reports escape attempts as skipped", async () => {
    const workspace = await makeWorkspace();
    const entries = [
      { ts: "2026-08-29T00:00:00.000Z", toolCallId: "c1", toolName: "write", relativePath: "deep/nested/file.txt", existed: true, content: "restored" },
      { ts: "2026-08-29T00:00:01.000Z", toolCallId: "c2", toolName: "write", relativePath: "../escaped.txt", existed: true, content: "evil" }
    ];
    const results = await rollbackPlan(workspace, ["c1", "c2"], entries);
    expect(results[0]).toMatchObject({ relativePath: "deep/nested/file.txt", action: "restored" });
    await expect(readFile(join(workspace, "deep", "nested", "file.txt"), "utf8")).resolves.toBe("restored");
    expect(results[1]).toMatchObject({ relativePath: "../escaped.txt", action: "skipped" });
  });
});
