import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowCoordinator,
  processLiveness,
  WORKFLOW_LOCK_FILE_NAME,
  WORKFLOW_RECLAIM_FILE_NAME,
  workflowLockDir,
  workspaceLockKey,
  type WorkflowCoordinator,
  type WorkflowCoordinatorOptions,
  type WorkflowLockAcquireResult,
  type WorkflowLockLease,
  type WorkflowLockOwner,
  type WorkflowProcessLiveness
} from "./workflow-coordinator.js";

/**
 * 工作区运行锁的回归网（方案 §5.2）。
 *
 * 这一层错了不是「慢一点」而是**两个运行同时改同一个工作区**，所以每条保守分支都要
 * 有反例钉住：活实例冲突、未知存活、记录损坏、回收互斥被占、以及最危险的
 * 「回收时误删别人的新锁」。进程存活、时间、PID 全部注入，测试不依赖真实 PID 复用。
 */

const FIXED_NOW = 1_700_000_000_000;
const OWN_PID = 4200;
const OTHER_PID = 4300;
const GHOST_PID = 9999;

let root: string;
let agentDir: string;
let workspace: string;
/** 当前测试里「活着的」PID 集合：其余一律判 dead，保证回收分支可确定性触发。 */
let livePids: Set<number>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-wf-lock-"));
  agentDir = join(root, "agent");
  workspace = join(root, "ws");
  mkdirSync(workspace, { recursive: true });
  livePids = new Set([OWN_PID, OTHER_PID]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function liveness(pid: number): WorkflowProcessLiveness {
  return livePids.has(pid) ? "alive" : "dead";
}

function makeCoordinator(overrides: Partial<WorkflowCoordinatorOptions> = {}): WorkflowCoordinator {
  return createWorkflowCoordinator({
    agentDir,
    instanceId: "inst-a",
    pid: OWN_PID,
    now: () => FIXED_NOW,
    liveness,
    ...overrides
  });
}

function canonical(path: string): string {
  return realpathSync.native(path);
}

function lockFileFor(path: string): string {
  const key = workspaceLockKey(canonical(path));
  return join(workflowLockDir(agentDir, key), WORKFLOW_LOCK_FILE_NAME);
}

function lockDirFor(path: string): string {
  return dirname(lockFileFor(path));
}

/** 手写一份「上次运行留下的」锁记录（持有进程 GHOST_PID，默认判定已死）。 */
function seedLock(path: string, overrides: Partial<WorkflowLockOwner> = {}): string {
  const file = lockFileFor(path);
  mkdirSync(dirname(file), { recursive: true });
  const owner: WorkflowLockOwner = {
    version: 1,
    instanceId: "inst-ghost",
    pid: GHOST_PID,
    runId: "run-ghost",
    startedAt: FIXED_NOW - 60_000,
    workspace: canonical(path),
    ...overrides
  };
  writeFileSync(file, JSON.stringify(owner), "utf8");
  return file;
}

function readRaw(file: string): string {
  return readFileSync(file, "utf8");
}

function readRecord(file: string): WorkflowLockOwner {
  return JSON.parse(readRaw(file)) as WorkflowLockOwner;
}

/** `toMatchObject` 不会收窄联合类型，而分支测试恰恰要读 `summary` / `message`。 */
function expectConflict(result: WorkflowLockAcquireResult) {
  expect(result).toMatchObject({ ok: false, reason: "conflict" });
  if (result.ok || result.reason !== "conflict") throw new Error(`期望 conflict，实际：${JSON.stringify(result)}`);
  return result;
}

function expectDenied(result: WorkflowLockAcquireResult, reason: "indeterminate" | "corrupt" | "error") {
  expect(result).toMatchObject({ ok: false, reason });
  if (result.ok || result.reason !== reason) throw new Error(`期望 ${reason}，实际：${JSON.stringify(result)}`);
  return result;
}

function expectLease(result: WorkflowLockAcquireResult): WorkflowLockLease {
  if (!result.ok) throw new Error(`期望拿到锁，实际：${JSON.stringify(result)}`);
  return result.lease;
}

describe("workspaceLockKey", () => {
  it("lowercases and normalizes separators on Windows", () => {
    expect(workspaceLockKey("C:\\Work\\Demo\\", "win32")).toBe("c:/work/demo");
    expect(workspaceLockKey("C:/Work/Demo", "win32")).toBe("c:/work/demo");
    // 盘符根目录两种写法收敛到同一个 key
    expect(workspaceLockKey("C:\\", "win32")).toBe("c:/");
    expect(workspaceLockKey("C:/", "win32")).toBe("c:/");
  });

  it("keeps case on POSIX (case-sensitive filesystems) and strips trailing slashes", () => {
    expect(workspaceLockKey("/Work/Demo/", "linux")).toBe("/Work/Demo");
    expect(workspaceLockKey("/Work/Demo", "darwin")).toBe("/Work/Demo");
    expect(workspaceLockKey("/", "linux")).toBe("/");
  });
});

describe("workflowLockDir", () => {
  it("puts each workspace under locks/<32 hex>", () => {
    const dir = workflowLockDir(agentDir, "c:/work/demo");
    expect(dir).toBe(join(agentDir, "pidesktop-workflows", "locks", "38830859fba14c7801134404a737a84f"));
    expect(dir.split(/[\\/]/u).at(-1)).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("is stable for the same key and distinct across workspaces", () => {
    expect(workflowLockDir(agentDir, "c:/a")).toBe(workflowLockDir(agentDir, "c:/a"));
    expect(workflowLockDir(agentDir, "c:/a")).not.toBe(workflowLockDir(agentDir, "c:/b"));
  });
});

describe("acquire / release", () => {
  it("writes the owner record and removes it (and the empty dir) on release", () => {
    const coordinator = makeCoordinator();
    const lease = expectLease(coordinator.acquire({ workspace, runId: "run-1" }));

    const file = lockFileFor(workspace);
    expect(lease.key).toBe(workspaceLockKey(canonical(workspace)));
    expect(readRecord(file)).toEqual({
      version: 1,
      instanceId: "inst-a",
      pid: OWN_PID,
      runId: "run-1",
      startedAt: FIXED_NOW,
      workspace: canonical(workspace)
    });
    expect(coordinator.inspect(workspace)).toMatchObject({ state: "held", key: lease.key });

    expect(lease.release()).toEqual({ ok: true, released: true });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(lockDirFor(workspace))).toBe(false);
    expect(coordinator.inspect(workspace)).toMatchObject({ state: "free" });
  });

  it("normalizes the workspace through realpath (trailing slash, .., case)", () => {
    const coordinator = makeCoordinator();
    const alias = join(workspace, "..", "ws", "");
    expectLease(coordinator.acquire({ workspace: alias, runId: "run-1" }));
    // 记录里存的是真实路径，而不是调用方给的原样字符串
    expect(readRecord(lockFileFor(workspace)).workspace).toBe(canonical(workspace));
  });

  it("rejects a second run of the same coordinator on the same workspace", () => {
    const coordinator = makeCoordinator();
    expect(coordinator.acquire({ workspace, runId: "run-1" }).ok).toBe(true);
    const second = expectConflict(coordinator.acquire({ workspace, runId: "run-2" }));
    expect(second.summary).toContain("run-1");
    expect(second.summary).toContain("本实例");
    // 第一条记录没被覆盖
    expect(readRecord(lockFileFor(workspace)).runId).toBe("run-1");
  });

  it("returns the live holder summary to another instance instead of queuing", () => {
    const owner = makeCoordinator({ instanceId: "inst-a", pid: OWN_PID });
    expect(owner.acquire({ workspace, runId: "run-1" }).ok).toBe(true);
    const other = makeCoordinator({ instanceId: "inst-b", pid: OTHER_PID });
    const denied = expectConflict(other.acquire({ workspace, runId: "run-2" }));
    expect(denied.holder.runId).toBe("run-1");
    expect(denied.holder.instanceId).toBe("inst-a");
    expect(denied.summary).toContain("其他实例");
    expect(denied.summary).toContain(`PID ${OWN_PID}`);
    expect(readRecord(lockFileFor(workspace)).instanceId).toBe("inst-a");
  });

  it("treats aliased spellings of one workspace as the same lock", () => {
    const upperCased = process.platform === "win32" ? workspace.toUpperCase() : undefined;
    const linked = join(root, "ws-link");
    try {
      symlinkSync(workspace, linked, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // 没有建链权限（POSIX 沙箱）：只用大小写别名验证 Windows 归一化。
      if (!upperCased) return;
    }
    const owner = makeCoordinator({ instanceId: "inst-a", pid: OWN_PID });
    expect(owner.acquire({ workspace, runId: "run-1" }).ok).toBe(true);
    const other = makeCoordinator({ instanceId: "inst-b", pid: OTHER_PID });
    if (upperCased) expect(other.acquire({ workspace: upperCased, runId: "run-2" })).toMatchObject({ ok: false, reason: "conflict" });
    if (existsSync(linked)) expect(other.acquire({ workspace: linked, runId: "run-3" })).toMatchObject({ ok: false, reason: "conflict" });
    expect(owner.inspect(workspace).state).toBe("held");
  });

  it("keeps different workspaces independent", () => {
    const second = join(root, "ws2");
    mkdirSync(second);
    const coordinator = makeCoordinator();
    expect(coordinator.acquire({ workspace, runId: "run-1" }).ok).toBe(true);
    expect(coordinator.acquire({ workspace: second, runId: "run-2" }).ok).toBe(true);
    expect(coordinator.releaseAll()).toBe(2);
    expect(coordinator.inspect(workspace).state).toBe("free");
    expect(coordinator.inspect(second).state).toBe("free");
  });

  it("refuses to delete a record owned by another instance", () => {
    const owner = makeCoordinator({ instanceId: "inst-a", pid: OWN_PID });
    expect(owner.acquire({ workspace, runId: "run-1" }).ok).toBe(true);
    const other = makeCoordinator({ instanceId: "inst-b", pid: OTHER_PID });
    const denied = other.release({ workspace, runId: "run-1" });
    expect(denied).toMatchObject({ ok: false, reason: "not-owner" });
    if (!denied.ok) expect(denied.message).toContain("inst-a");
    // 记录还在，真正的持有者仍能释放
    expect(readRecord(lockFileFor(workspace)).instanceId).toBe("inst-a");
    expect(owner.release({ workspace, runId: "run-1" })).toEqual({ ok: true, released: true });
  });

  it("refuses a runId mismatch on release (same instance)", () => {
    const coordinator = makeCoordinator();
    expectLease(coordinator.acquire({ workspace, runId: "run-1" }));
    expect(coordinator.release({ workspace, runId: "run-2" })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(readRecord(lockFileFor(workspace)).runId).toBe("run-1");
    expect(coordinator.release({ workspace, runId: "run-1" })).toEqual({ ok: true, released: true });
  });

  it("does not let a stale lease delete the next owner's lock", () => {
    const first = makeCoordinator({ instanceId: "inst-a", pid: OWN_PID });
    const staleLease = expectLease(first.acquire({ workspace, runId: "run-1" }));
    expect(staleLease.release()).toEqual({ ok: true, released: true });

    const second = makeCoordinator({ instanceId: "inst-b", pid: OTHER_PID });
    expectLease(second.acquire({ workspace, runId: "run-2" }));

    // 旧 lease 再释放一次：记录已换人 → 保守拒绝，绝不删
    expect(staleLease.release()).toMatchObject({ ok: false, reason: "not-owner" });
    expect(readRecord(lockFileFor(workspace)).instanceId).toBe("inst-b");
    expect(second.inspect(workspace).state).toBe("held");
  });

  it("is idempotent when the record is already gone", () => {
    const coordinator = makeCoordinator();
    const lease = expectLease(coordinator.acquire({ workspace, runId: "run-1" }));
    expect(lease.release()).toEqual({ ok: true, released: true });
    expect(lease.release()).toEqual({ ok: true, released: false });
  });

  it("rejects relative workspaces and empty run ids without touching disk", () => {
    const coordinator = makeCoordinator();
    expect(coordinator.acquire({ workspace: "ws", runId: "run-1" })).toMatchObject({ ok: false, reason: "error" });
    expect(coordinator.acquire({ workspace, runId: "  " })).toMatchObject({ ok: false, reason: "error" });
    expect(coordinator.acquire({ workspace: join(root, "missing-dir"), runId: "run-1" })).toMatchObject({ ok: false, reason: "error" });
    expect(existsSync(lockDirFor(workspace))).toBe(false);
  });

  it("keeps the lock directory when it holds foreign files", () => {
    const coordinator = makeCoordinator();
    const lease = expectLease(coordinator.acquire({ workspace, runId: "run-1" }));
    // 别的实例留下的回收互斥（或任何外来文件）不能被连带删除
    writeFileSync(join(lockDirFor(workspace), "foreign.txt"), "x", "utf8");
    expect(lease.release()).toEqual({ ok: true, released: true });
    expect(existsSync(lockDirFor(workspace))).toBe(true);
    expect(readdirSync(lockDirFor(workspace))).toEqual(["foreign.txt"]);
  });
});

describe("dead-owner reclaim", () => {
  it("takes over a lock whose owner is definitely gone", () => {
    const file = seedLock(workspace);
    const coordinator = makeCoordinator();
    const result = coordinator.acquire({ workspace, runId: "run-new" });
    expect(result.ok).toBe(true);
    expect(readRecord(file)).toMatchObject({ instanceId: "inst-a", runId: "run-new", pid: OWN_PID });
    // 回收互斥不能留下
    expect(readdirSync(lockDirFor(workspace))).toEqual([WORKFLOW_LOCK_FILE_NAME]);
  });

  it("reports a stale lock through inspect without deleting it", () => {
    const file = seedLock(workspace);
    const before = readRaw(file);
    const coordinator = makeCoordinator();
    expect(coordinator.inspect(workspace)).toMatchObject({ state: "stale" });
    expect(readRaw(file)).toBe(before);
  });

  it("refuses when liveness is indeterminate (conservative)", () => {
    const file = seedLock(workspace);
    const before = readRaw(file);
    const coordinator = makeCoordinator({ liveness: () => "unknown" });
    const result = expectDenied(coordinator.acquire({ workspace, runId: "run-new" }), "indeterminate");
    expect(result.message).toContain(String(GHOST_PID));
    expect(readRaw(file)).toBe(before);
    expect(coordinator.inspect(workspace).state).toBe("indeterminate");
  });

  it("refuses on a corrupt record instead of overwriting it", () => {
    const file = lockFileFor(workspace);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{ not json", "utf8");
    const coordinator = makeCoordinator();
    const result = expectDenied(coordinator.acquire({ workspace, runId: "run-new" }), "corrupt");
    expect(result.message).toContain(file);
    expect(readRaw(file)).toBe("{ not json");
    expect(coordinator.inspect(workspace)).toMatchObject({ state: "corrupt" });
    // 损坏记录也不能被「释放」删掉（无法确认归属）
    expect(coordinator.release({ workspace, runId: "run-new" })).toMatchObject({ ok: false, reason: "corrupt" });
    expect(readRaw(file)).toBe("{ not json");
  });

  it("treats records with a wrong shape or version as corrupt", () => {
    const coordinator = makeCoordinator();
    const file = lockFileFor(workspace);
    mkdirSync(dirname(file), { recursive: true });
    const broken: unknown[] = [
      { version: 2, instanceId: "i", pid: 1, runId: "r", startedAt: 1, workspace: "/w" },
      { version: 1, instanceId: "", pid: 1, runId: "r", startedAt: 1, workspace: "/w" },
      { version: 1, instanceId: "i", pid: -1, runId: "r", startedAt: 1, workspace: "/w" },
      { version: 1, instanceId: "i", pid: 1, runId: "r", startedAt: 0, workspace: "/w" },
      { version: 1, instanceId: "i", pid: 1, runId: "r", startedAt: 1 }
    ];
    for (const record of broken) {
      writeFileSync(file, JSON.stringify(record), "utf8");
      expect(coordinator.acquire({ workspace, runId: "run-new" })).toMatchObject({ ok: false, reason: "corrupt" });
    }
  });

  it("refuses to reclaim while another instance holds the reclaim mutex", () => {
    const file = seedLock(workspace);
    const before = readRaw(file);
    const mutexFile = join(dirname(lockDirFor(workspace)), `${basename(lockDirFor(workspace))}.${WORKFLOW_RECLAIM_FILE_NAME}`);
    writeFileSync(mutexFile, JSON.stringify({ instanceId: "inst-b", pid: OTHER_PID, startedAt: FIXED_NOW }), "utf8");
    const coordinator = makeCoordinator();
    const result = expectDenied(coordinator.acquire({ workspace, runId: "run-new" }), "indeterminate");
    expect(result.message).toContain(mutexFile);
    expect(result.message).toContain(String(OTHER_PID));
    // 陈旧记录与互斥都原样保留（不自动清理可能有人在用的互斥）
    expect(readRaw(file)).toBe(before);
    expect(existsSync(mutexFile)).toBe(true);
  });

  it("never deletes a fresh owner acquired concurrently during the decision window", () => {
    const file = seedLock(workspace);
    // 模拟另一个实例在我们「判定该死」之后完成回收并重新抢到锁：
    // 注入的存活检查在返回 dead 之前把记录换成新持有者的。
    let swapped = false;
    const racing = (pid: number): WorkflowProcessLiveness => {
      if (pid !== GHOST_PID) return "alive";
      if (!swapped) {
        swapped = true;
        writeFileSync(
          file,
          JSON.stringify({ version: 1, instanceId: "inst-b", pid: OTHER_PID, runId: "run-b", startedAt: FIXED_NOW, workspace: canonical(workspace) }),
          "utf8"
        );
        return "dead";
      }
      return "alive";
    };
    const coordinator = makeCoordinator({ liveness: racing });
    const result = expectConflict(coordinator.acquire({ workspace, runId: "run-a" }));
    expect(result.holder.instanceId).toBe("inst-b");
    // 关键断言：别人的新锁必须完好无损
    expect(readRecord(file)).toMatchObject({ instanceId: "inst-b", runId: "run-b" });
    expect(existsSync(join(dirname(lockDirFor(workspace)), `${basename(lockDirFor(workspace))}.${WORKFLOW_RECLAIM_FILE_NAME}`))).toBe(false);
  });

  it("retries and wins when the stale record disappears during the decision window", () => {
    const file = seedLock(workspace);
    let removed = false;
    const racing = (pid: number): WorkflowProcessLiveness => {
      if (pid !== GHOST_PID) return "alive";
      if (!removed) {
        removed = true;
        // 另一个回收者已经收完了（文件消失且没有重新抢）
        unlinkSync(file);
        rmdirSync(dirname(file));
      }
      return "dead";
    };
    const coordinator = makeCoordinator({ liveness: racing });
    expectLease(coordinator.acquire({ workspace, runId: "run-a" }));
    expect(readRecord(file)).toMatchObject({ instanceId: "inst-a", runId: "run-a" });
  });

  it("does not reclaim when the owner turned out alive", () => {
    const file = seedLock(workspace, { pid: OTHER_PID });
    const before = readRaw(file);
    // 第一次判定 dead（触发回收流程），互斥内复核时又变成 alive
    let calls = 0;
    const flaky = (pid: number): WorkflowProcessLiveness => {
      if (pid !== OTHER_PID) return "alive";
      calls += 1;
      return calls === 1 ? "dead" : "alive";
    };
    const coordinator = makeCoordinator({ liveness: flaky });
    const result = coordinator.acquire({ workspace, runId: "run-a" });
    expect(result).toMatchObject({ ok: false, reason: "conflict" });
    expect(readRaw(file)).toBe(before);
  });
});

describe("releaseAll", () => {
  it("releases only the instance's own locks and reports the count", () => {
    const other = join(root, "ws2");
    mkdirSync(other);
    const mine = makeCoordinator({ instanceId: "inst-a", pid: OWN_PID });
    expect(mine.acquire({ workspace, runId: "run-1" }).ok).toBe(true);
    expect(mine.acquire({ workspace: other, runId: "run-2" }).ok).toBe(true);
    expect(mine.releaseAll()).toBe(2);
    expect(mine.releaseAll()).toBe(0);
    expect(mine.inspect(workspace).state).toBe("free");
    expect(mine.inspect(other).state).toBe("free");
  });
});

describe("processLiveness", () => {
  it("reports the current process as alive", () => {
    expect(processLiveness(process.pid)).toBe("alive");
  });

  it("reports an exited child as dead", async () => {
    const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(child.pid).toBeTypeOf("number");
    expect(processLiveness(child.pid ?? 0)).toBe("dead");
  });

  it("treats EPERM / EACCES as alive and other errors as unknown (never as dead)", () => {
    const eperm = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    try {
      expect(processLiveness(123456)).toBe("alive");
    } finally {
      eperm.mockRestore();
    }

    // Windows 上受保护进程给的是 EACCES（存在但碰不得）：同样算活着。
    const eacces = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      throw error;
    });
    try {
      expect(processLiveness(123456)).toBe("alive");
    } finally {
      eacces.mockRestore();
    }

    const weird = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("boom") as NodeJS.ErrnoException;
      error.code = "EINVAL";
      throw error;
    });
    try {
      expect(processLiveness(123456)).toBe("unknown");
    } finally {
      weird.mockRestore();
    }
  });

  it("treats invalid pids as unknown", () => {
    expect(processLiveness(0)).toBe("unknown");
    expect(processLiveness(-1)).toBe("unknown");
    expect(processLiveness(1.5)).toBe("unknown");
    expect(processLiveness(Number.NaN)).toBe("unknown");
  });
});

/**
 * 真正跨进程：磁盘锁的全部意义就是「别的进程看得见、抢不到」。两个子进程（各自不同 PID）
 * 同时抢一把**死锁遗留**的工作区锁，并通过共享日志记录临界区进出。
 *
 * 断言形式是「严格交替 enter/exit」：无论它们怎么错开，只要有任何一瞬间两个进程都认为
 * 自己持有锁，日志里就会出现连续的两次 enter。子进程用 Node 的类型抹除直接 import 本模块
 * （不需要构建），因此跑的是真实现，不是复制品。
 */
describe("cross-process exclusion", () => {
  it("serializes two real processes competing for the same workspace lock", async () => {
    // 拿一个「确定已退出」的真 PID 当上次运行的持有者，让两个子进程都走回收路径。
    const deadChild = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    await new Promise<void>((resolve) => deadChild.once("exit", () => resolve()));
    seedLock(workspace, { pid: deadChild.pid ?? GHOST_PID });

    const logFile = join(root, "section.log");
    const script = join(root, "workflow-lock-child.mjs");
    writeFileSync(script, CHILD_SCRIPT, "utf8");
    const moduleUrl = pathToFileURL(fileURLToPath(new URL("./workflow-coordinator.ts", import.meta.url))).href;

    const runChild = (id: string) =>
      new Promise<{ code: number | null; output: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", "--no-warnings", script, moduleUrl, agentDir, workspace, logFile, id],
          { stdio: ["ignore", "pipe", "pipe"] }
        );
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.once("exit", (code) => resolve({ code, output }));
      });

    const [a, b] = await Promise.all([runChild("a"), runChild("b")]);
    expect(a.output).toContain("acquired");
    expect(b.output).toContain("acquired");
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);

    const lines = readFileSync(logFile, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    const firstEnter = lines[0] ?? "";
    const firstExit = lines[1] ?? "";
    const secondEnter = lines[2] ?? "";
    const secondExit = lines[3] ?? "";
    expect(firstEnter).toMatch(/^enter-[ab]$/u);
    expect(firstExit).toBe(`exit-${firstEnter.slice("enter-".length)}`);
    expect(secondEnter).toMatch(/^enter-[ab]$/u);
    expect(secondExit).toBe(`exit-${secondEnter.slice("enter-".length)}`);
    // 两个进程各自真的进去过一次（不是其中一个拿到了就全跑完）
    expect(firstEnter).not.toBe(secondEnter);
    // 临界区结束后锁被释放，谁都能抢
    expect(makeCoordinator({ instanceId: "inst-after", liveness: () => "dead" }).inspect(workspace).state).toBe("free");
  }, 30_000);
});

/**
 * 子进程脚本（临时目录生成，不经构建直接 import 本模块）：
 *   argv = [moduleUrl, agentDir, workspace, logFile, id]
 * 抢不到就重试（真实并发下另一个进程可能正持有），拿到锁就进临界区、记日志、释放退出。
 */
const CHILD_SCRIPT = `
const [moduleUrl, agentDir, workspace, logFile, id] = process.argv.slice(2);
const { createWorkflowCoordinator } = await import(moduleUrl);
const { appendFileSync } = await import("node:fs");
const coordinator = createWorkflowCoordinator({ agentDir, instanceId: "inst-" + id });
const deadline = Date.now() + 15000;
let lease;
while (!lease && Date.now() < deadline) {
  const result = coordinator.acquire({ workspace, runId: "run-" + id });
  if (result.ok) lease = result.lease;
  else await new Promise((resolve) => setTimeout(resolve, 15));
}
if (!lease) {
  console.log("gave-up");
  process.exitCode = 1;
} else {
  appendFileSync(logFile, "enter-" + id + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 80));
  appendFileSync(logFile, "exit-" + id + "\\n");
  const released = lease.release();
  console.log(released.ok ? "acquired" : "release-failed");
  process.exitCode = released.ok ? 0 : 2;
}
`;

/**
 * 接线契约：这条路径**永远不能结束进程**（只允许 signal 0 的存在性探测）。
 * 纯函数用例证明不了这一点，所以直接对源码断言。
 */
describe("safety wiring", () => {
  it("never sends a terminating signal", () => {
    const source = readFileSync(fileURLToPath(new URL("./workflow-coordinator.ts", import.meta.url)), "utf8").replace(/\r\n/gu, "\n");
    expect(source).toContain("process.kill(pid, 0)");
    expect(source).not.toMatch(/SIGTERM|SIGKILL|SIGINT/u);
    expect(source).not.toMatch(/process\.kill\([^)]*,\s*["'`]/u);
    // 存活判定必须是三态，不能退化成布尔（布尔会把「未知」当成「已退出」）
    expect(source).toContain('return "unknown"');
  });
});
