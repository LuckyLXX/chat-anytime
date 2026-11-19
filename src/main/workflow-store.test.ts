import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkflowDraft } from "../shared/workflow.js";
import { WorkflowStore, WorkflowStoreError } from "./workflow-store.js";
import { WorkflowCatalogCache } from "./workflow-catalog-cache.js";

let root: string;
let workspace: string;
const fixedId = `wf-${randomUUID()}`;

/** 目录锁：`<workspace>/.pidesktop/workflows/.catalog.write-lock/owner.json`。 */
function definitionsDirectory(): string {
  return join(workspace, ".pidesktop", "workflows");
}

function seedLock(options: { pid: number; instanceId?: string; record?: unknown }): { lockDir: string; ownerFile: string } {
  const directory = definitionsDirectory();
  mkdirSync(directory, { recursive: true });
  const lockDir = join(directory, ".catalog.write-lock");
  mkdirSync(lockDir, { recursive: true });
  const ownerFile = join(lockDir, "owner.json");
  writeFileSync(ownerFile, typeof options.record === "string"
    ? options.record
    : JSON.stringify({ version: 1, instanceId: options.instanceId ?? "other-instance", pid: options.pid, target: "catalog", startedAt: 1 }));
  return { lockDir, ownerFile };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "workflow-store-"));
  workspace = join(root, "workspace");
  mkdirSync(workspace);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("WorkflowStore", () => {
  it("creates, reads, updates and deletes a draft with a content hash", () => {
    let now = 10;
    const store = new WorkflowStore(() => now, () => fixedId);
    const first = store.save(workspace, createWorkflowDraft());
    expect(first.definition.id).toBe(fixedId);
    expect(first.definition.revision).toBe(1);
    expect(store.get(workspace, fixedId)).toEqual(first);
    now = 20;
    const second = store.save(workspace, { ...first.definition, name: "更新" }, { workflowId: fixedId, baseHash: first.baseHash });
    expect(second.definition).toMatchObject({ id: fixedId, name: "更新", revision: 2, createdAt: 10, updatedAt: 20 });
    expect(second.baseHash).not.toBe(first.baseHash);
    expect(store.list(workspace).workflows).toMatchObject([{ id: fixedId, runnable: false }]);
    store.delete(workspace, fixedId, second.baseHash);
    expect(store.list(workspace).workflows).toHaveLength(0);
  });

  it("refuses to overwrite an externally edited definition", () => {
    const store = new WorkflowStore(() => 10, () => fixedId);
    const first = store.save(workspace, createWorkflowDraft());
    const file = join(workspace, ".pidesktop", "workflows", `${fixedId}.json`);
    writeFileSync(file, `${JSON.stringify({ ...first.definition, name: "外部修改" })}\n`);
    expect(() => store.save(workspace, first.definition, { workflowId: fixedId, baseHash: first.baseHash }))
      .toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() => store.delete(workspace, fixedId, first.baseHash))
      .toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(store.get(workspace, fixedId).definition.name).toBe("外部修改");
  });

  it("never overwrites a generated id collision and cleans up temporary files", () => {
    const store = new WorkflowStore(() => 10, () => fixedId);
    const first = store.save(workspace, createWorkflowDraft());
    expect(() => store.save(workspace, { ...first.definition, name: "collision" }))
      .toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(store.get(workspace, fixedId)).toEqual(first);
    expect(readdirSync(join(workspace, ".pidesktop", "workflows"))).toEqual([`${fixedId}.json`]);
  });

  it("reports corrupt files without changing their bytes", () => {
    const directory = join(workspace, ".pidesktop", "workflows");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${fixedId}.json`);
    writeFileSync(file, "not json");
    const result = new WorkflowStore().list(workspace);
    expect(result.workflows).toHaveLength(0);
    expect(result.diagnostics.join(" ")).toContain("JSON");
    expect(readFileSync(file, "utf8")).toBe("not json");
  });

  it("rejects traversal identifiers and symlinked definition files", () => {
    const store = new WorkflowStore();
    expect(() => store.get(workspace, "../escape")).toThrowError(expect.objectContaining({ code: "invalid-id" }));
    const dir = join(workspace, ".pidesktop", "workflows");
    mkdirSync(dir, { recursive: true });
    const outside = join(root, "outside.json");
    writeFileSync(outside, "secret");
    try { symlinkSync(outside, join(dir, `${fixedId}.json`), "file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    expect(() => store.get(workspace, fixedId)).toThrowError(WorkflowStoreError);
    expect(readFileSync(outside, "utf8")).toBe("secret");
  });

  it("invalidates the lightweight workspace catalog after save and delete", () => {
    let now = 100;
    const store = new WorkflowStore(() => now, () => fixedId);
    const cache = new WorkflowCatalogCache(store, () => now, 5_000);
    const empty = cache.list(workspace);
    expect(cache.list(workspace)).toBe(empty);
    const saved = cache.save(workspace, createWorkflowDraft());
    const populated = cache.list(workspace);
    expect(populated).not.toBe(empty);
    expect(populated.workflows).toHaveLength(1);
    now += 5_001;
    expect(cache.list(workspace)).not.toBe(populated);
    cache.delete(workspace, fixedId, saved.baseHash);
    expect(cache.list(workspace).workflows).toHaveLength(0);
  });

  it("rejects a definition directory redirected outside the workspace", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    try { symlinkSync(outside, join(workspace, ".pidesktop"), "junction"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    const store = new WorkflowStore();
    expect(() => store.save(workspace, createWorkflowDraft())).toThrowError(expect.objectContaining({ code: "invalid-workspace" }));
  });
});

describe("WorkflowStore 写锁（崩溃残留与并发）", () => {
  it("回收确定已退出的实例残留的写锁并完成保存", () => {
    const store = new WorkflowStore(() => 10, () => fixedId, {
      instanceId: "store-self",
      pid: 1111,
      liveness: (pid) => (pid === 4242 ? "dead" : "unknown")
    });
    const { lockDir } = seedLock({ pid: 4242, instanceId: "crashed-instance" });
    const saved = store.save(workspace, createWorkflowDraft());
    expect(saved.definition.id).toBe(fixedId);
    expect(existsSync(lockDir)).toBe(false);
    expect(readdirSync(definitionsDirectory())).toEqual([`${fixedId}.json`]);
  });

  it("持有者存活时拒绝保存，且一个字节都不改它的锁", () => {
    const store = new WorkflowStore(() => 10, () => fixedId, { instanceId: "store-self", pid: 1111, liveness: () => "alive" });
    const { lockDir, ownerFile } = seedLock({ pid: 4242, instanceId: "live-instance" });
    const before = readFileSync(ownerFile, "utf8");
    expect(() => store.save(workspace, createWorkflowDraft())).toThrowError(expect.objectContaining({ code: "busy" }));
    expect(readFileSync(ownerFile, "utf8")).toBe(before);
    expect(existsSync(lockDir)).toBe(true);
    expect(readdirSync(definitionsDirectory())).toEqual([".catalog.write-lock"]);
  });

  it("存活判定未知时保守拒绝（绝不按死实例回收）", () => {
    const store = new WorkflowStore(() => 10, () => fixedId, { instanceId: "store-self", pid: 1111, liveness: () => "unknown" });
    const { lockDir, ownerFile } = seedLock({ pid: 4242, instanceId: "unknown-instance" });
    const before = readFileSync(ownerFile, "utf8");
    expect(() => store.save(workspace, createWorkflowDraft())).toThrowError(expect.objectContaining({ code: "busy" }));
    expect(readFileSync(ownerFile, "utf8")).toBe(before);
    expect(existsSync(lockDir)).toBe(true);
  });

  it("锁记录损坏时拒绝并保留现场，不猜测是否可以回收", () => {
    const store = new WorkflowStore(() => 10, () => fixedId, { instanceId: "store-self", pid: 1111, liveness: () => "dead" });
    const { lockDir, ownerFile } = seedLock({ pid: 4242, record: "not json" });
    expect(() => store.save(workspace, createWorkflowDraft())).toThrowError(expect.objectContaining({ code: "io" }));
    expect(readFileSync(ownerFile, "utf8")).toBe("not json");
    expect(existsSync(lockDir)).toBe(true);
    expect(readdirSync(definitionsDirectory())).toEqual([".catalog.write-lock"]);
  });

  it("回收互斥被占时保守拒绝，不删死实例的锁", () => {
    const store = new WorkflowStore(() => 10, () => fixedId, { instanceId: "store-self", pid: 1111, liveness: () => "dead" });
    const { lockDir, ownerFile } = seedLock({ pid: 4242, instanceId: "crashed-instance" });
    const mutexFile = `${lockDir}.reclaim.lock`;
    writeFileSync(mutexFile, JSON.stringify({ instanceId: "another-reclaimer", pid: 9999 }));
    const before = readFileSync(ownerFile, "utf8");
    expect(() => store.save(workspace, createWorkflowDraft())).toThrowError(expect.objectContaining({ code: "busy" }));
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(ownerFile, "utf8")).toBe(before);
    expect(existsSync(mutexFile)).toBe(true);
  });

  it("并发实例持锁期间不允许用旧 baseHash 覆盖，释放后同一基准必须冲突", () => {
    const writer = new WorkflowStore(() => 10, () => fixedId, { instanceId: "instance-b", pid: 2222, liveness: () => "alive" });
    const first = writer.save(workspace, createWorkflowDraft());
    const { ownerFile } = seedLock({ pid: 3333, instanceId: "instance-c" });
    expect(() => writer.save(workspace, { ...first.definition, name: "并发写入" }, { workflowId: fixedId, baseHash: first.baseHash }))
      .toThrowError(expect.objectContaining({ code: "busy" }));
    expect(writer.get(workspace, fixedId)).toEqual(first);

    // 另一个实例在临界区里写入了新版本（模拟它先拿到锁并 rename 完成），本实例随后释放/重试。
    unlinkSync(ownerFile);
    rmdirSync(dirname(ownerFile));
    writeFileSync(join(definitionsDirectory(), `${fixedId}.json`), `${JSON.stringify({ ...first.definition, name: "外部实例写入" })}\n`);
    expect(() => writer.save(workspace, { ...first.definition, name: "过期基准" }, { workflowId: fixedId, baseHash: first.baseHash }))
      .toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(writer.get(workspace, fixedId).definition.name).toBe("外部实例写入");
  });

  it("持锁时清理崩溃实例留下的唯一临时文件，不匹配的文件原样保留", () => {
    const store = new WorkflowStore(() => 10, () => fixedId);
    const first = store.save(workspace, createWorkflowDraft());
    const directory = definitionsDirectory();
    const orphan = join(directory, `${fixedId}.json.777.${randomUUID()}.tmp`);
    writeFileSync(orphan, "{不是定义}");
    const keeper = join(directory, "notes.tmp");
    writeFileSync(keeper, "keep");
    store.save(workspace, { ...first.definition, name: "第二次" }, { workflowId: fixedId, baseHash: first.baseHash });
    expect(existsSync(orphan)).toBe(false);
    expect(readFileSync(keeper, "utf8")).toBe("keep");
    expect(readdirSync(directory).sort()).toEqual([`${fixedId}.json`, "notes.tmp"].sort());
  });

  it("失败路径也释放写锁，后续保存不被自己的残留卡住", () => {
    const store = new WorkflowStore(() => 10, () => fixedId);
    expect(() => store.save(workspace, {})).toThrowError(expect.objectContaining({ code: "invalid-draft" }));
    expect(existsSync(join(definitionsDirectory(), ".catalog.write-lock"))).toBe(false);
    expect(readdirSync(definitionsDirectory())).toEqual([]);
    expect(store.save(workspace, createWorkflowDraft()).definition.id).toBe(fixedId);
  });

  it("删除也走同一把写锁：死实例残留可回收，活实例持锁时拒绝", () => {
    const store = new WorkflowStore(() => 10, () => fixedId);
    const first = store.save(workspace, createWorkflowDraft());
    const live = new WorkflowStore(() => 10, () => fixedId, { instanceId: "store-live", pid: 2222, liveness: () => "alive" });
    const { lockDir, ownerFile } = seedLock({ pid: 4242, instanceId: "live-instance" });
    expect(() => live.delete(workspace, fixedId, first.baseHash)).toThrowError(expect.objectContaining({ code: "busy" }));
    expect(store.get(workspace, fixedId)).toEqual(first);

    unlinkSync(ownerFile);
    rmdirSync(lockDir);
    const reclaimer = new WorkflowStore(() => 10, () => fixedId, { instanceId: "store-self", pid: 1111, liveness: () => "dead" });
    const { lockDir: deadLock } = seedLock({ pid: 4242, instanceId: "crashed-instance" });
    reclaimer.delete(workspace, fixedId, first.baseHash);
    expect(existsSync(deadLock)).toBe(false);
    expect(readdirSync(definitionsDirectory())).toEqual([]);
  });

  it("回收旧版文件锁的死实例残留（升级后第一次保存能自我恢复）", () => {
    const directory = definitionsDirectory();
    mkdirSync(directory, { recursive: true });
    const legacy = join(directory, ".catalog.write-lock");
    writeFileSync(legacy, JSON.stringify({ pid: 4242, at: 1 }));
    const store = new WorkflowStore(() => 10, () => fixedId, {
      instanceId: "store-self",
      pid: 1111,
      liveness: (pid) => (pid === 4242 ? "dead" : "unknown")
    });
    expect(store.save(workspace, createWorkflowDraft()).definition.id).toBe(fixedId);
    expect(existsSync(legacy)).toBe(false);
    expect(readdirSync(directory)).toEqual([`${fixedId}.json`]);
  });

  it("旧版文件锁的持有者存活或内容损坏时保守拒绝", () => {
    const directory = definitionsDirectory();
    mkdirSync(directory, { recursive: true });
    const legacy = join(directory, ".catalog.write-lock");
    writeFileSync(legacy, JSON.stringify({ pid: 4242, at: 1 }));
    const alive = new WorkflowStore(() => 10, () => fixedId, { instanceId: "store-live", pid: 2222, liveness: () => "alive" });
    expect(() => alive.save(workspace, createWorkflowDraft())).toThrowError(expect.objectContaining({ code: "busy" }));
    expect(readFileSync(legacy, "utf8")).toContain("4242");

    writeFileSync(legacy, "半个锁");
    const dead = new WorkflowStore(() => 10, () => fixedId, { instanceId: "store-self", pid: 1111, liveness: () => "dead" });
    expect(() => dead.save(workspace, createWorkflowDraft())).toThrowError(expect.objectContaining({ code: "io" }));
    expect(readFileSync(legacy, "utf8")).toBe("半个锁");
    expect(readdirSync(directory)).toEqual([".catalog.write-lock"]);
  });
});
