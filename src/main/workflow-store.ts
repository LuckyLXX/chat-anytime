import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  MAX_WORKFLOW_FILE_BYTES,
  MAX_WORKFLOWS_PER_WORKSPACE,
  normalizeWorkflowDraft,
  validateWorkflowForRun,
  type WorkflowDefinition,
  type WorkflowDiagnostic,
  type WorkflowRunValidationContext
} from "../shared/workflow.js";
import { processLiveness, type WorkflowProcessLiveness } from "./workflow-coordinator.js";

const WORKFLOW_FILE_ID = /^wf-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type WorkflowStoreErrorCode = "invalid-workspace" | "invalid-id" | "not-found" | "conflict" | "invalid-draft" | "limit" | "busy" | "io";

export class WorkflowStoreError extends Error {
  constructor(readonly code: WorkflowStoreErrorCode, message: string, readonly errors?: WorkflowDiagnostic[]) {
    super(message);
    this.name = "WorkflowStoreError";
  }
}

export interface StoredWorkflow {
  definition: WorkflowDefinition;
  baseHash: string;
}

export interface WorkflowCatalogEntry {
  id: string;
  name: string;
  description?: string;
  whenToUse?: string;
  nodeCount: number;
  updatedAt: number;
  runnable: boolean;
  issueCount: number;
}

export interface WorkflowCatalog {
  workspace: string;
  workflows: WorkflowCatalogEntry[];
  diagnostics: string[];
}

export interface SaveWorkflowOptions {
  /** 不传时为新定义，id 由 utility 生成；更新必须同时提供 baseHash。 */
  workflowId?: string;
  baseHash?: string;
}

export function workflowDefinitionHash(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalWorkspace(workspace: string): string {
  if (!workspace || !isAbsolute(workspace)) throw new WorkflowStoreError("invalid-workspace", "工作区必须是存在的绝对目录");
  try {
    const canonical = realpathSync.native(workspace);
    if (!statSync(canonical).isDirectory()) throw new Error("不是目录");
    return canonical;
  } catch (error) {
    throw new WorkflowStoreError("invalid-workspace", `无法读取工作区：${error instanceof Error ? error.message : String(error)}`);
  }
}

function definitionsDirectory(workspace: string, create: boolean): { workspace: string; directory: string } {
  const canonical = canonicalWorkspace(workspace);
  const directory = join(canonical, ".pidesktop", "workflows");
  if (create) {
    // 逐段检查，避免从工作区内的链接写到工作区外。
    for (const part of [join(canonical, ".pidesktop"), directory]) {
      try {
        mkdirSync(part);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const real = realpathSync.native(part);
      if (!isWithin(canonical, real) || !statSync(real).isDirectory()) {
        throw new WorkflowStoreError("invalid-workspace", `工作流目录位于工作区之外：${part}`);
      }
    }
  } else {
    try {
      const real = realpathSync.native(directory);
      if (!isWithin(canonical, real) || !statSync(real).isDirectory()) {
        throw new WorkflowStoreError("invalid-workspace", `工作流目录位于工作区之外：${directory}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { workspace: canonical, directory };
}

function definitionPath(directory: string, id: string): string {
  if (!WORKFLOW_FILE_ID.test(id)) throw new WorkflowStoreError("invalid-id", "工作流 id 必须是 wf-UUID");
  return join(directory, `${id}.json`);
}

function readWorkflowFile(directory: string, id: string): StoredWorkflow {
  const path = definitionPath(directory, id);
  let bytes: Buffer;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new WorkflowStoreError("io", `工作流定义不是普通文件：${path}`);
    if (entry.size > MAX_WORKFLOW_FILE_BYTES) throw new WorkflowStoreError("invalid-draft", `工作流定义超过 ${MAX_WORKFLOW_FILE_BYTES} 字节`);
    bytes = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkflowStoreError("not-found", `工作流不存在：${id}`);
    throw error;
  }
  if (bytes.byteLength > MAX_WORKFLOW_FILE_BYTES) throw new WorkflowStoreError("invalid-draft", `工作流定义超过 ${MAX_WORKFLOW_FILE_BYTES} 字节`);
  let input: unknown;
  try { input = JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { throw new WorkflowStoreError("invalid-draft", `工作流 JSON 无法解析：${id}`); }
  const result = normalizeWorkflowDraft(input, { serializedBytes: bytes.byteLength });
  if (!result.ok || !result.definition) throw new WorkflowStoreError("invalid-draft", `工作流结构非法：${id}`, result.errors);
  if (result.definition.id !== id) throw new WorkflowStoreError("invalid-draft", `工作流 id 与文件名不一致：${id}`);
  return { definition: result.definition, baseHash: workflowDefinitionHash(bytes) };
}

/** 同目录唯一临时文件；创建使用硬链接实现 create-if-absent，更新以 rename 原子替换。 */
function atomicWrite(path: string, contents: string, create: boolean): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    if (create) linkSync(temporary, path);
    else renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/* ── 工作区定义写入短锁 ───────────────────────────────────────────────────
 * 目录锁 + owner 记录：`<definitions>/.<target>.write-lock/owner.json`（mkdir 原子占位）。
 * 锁内完成「读盘 → 比较 baseHash → 原子替换」，hash 比较与 rename 在同一个跨实例临界区
 * 里，两个实例才不会用各自的旧基准互相覆盖。
 *
 * 崩溃残留回收复用 workflow-coordinator 的口径（见其文件头）：
 * - 只有 owner 记录完整、且持有 PID 被判定 **dead**（ESRCH）才回收；
 * - 回收在 `<lock>.reclaim.lock` 一次性互斥下复核 owner 与存活，避免两个回收者互删；
 * - 记录缺失/损坏、PID 存活或判不出来（unknown）、回收互斥被占 → 保守拒绝，绝不删别人的锁。
 * 重试有界（{@link WRITE_LOCK_ATTEMPTS} 轮）：正常路径 1–3 轮，不 sleep、不异步，不堵 UI。
 */

const WRITE_LOCK_RECORD_VERSION = 1;
/** 抢锁循环上限：正常路径只需要 1–3 轮（EEXIST → 读 → 抢/回收）。 */
const WRITE_LOCK_ATTEMPTS = 4;
/** 同目录唯一临时文件名（`<id>.json.<pid>.<uuid>.tmp`），只清这种形状的残留。 */
const DEFINITION_TEMP_FILE = /^[^\\/]+\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/iu;

export interface WorkflowStoreLockOptions {
  /** 进程存活探测（缺省 workflow-coordinator 的 {@link processLiveness}；测试注入）。 */
  liveness?: (pid: number) => WorkflowProcessLiveness;
  /** 持有进程 PID（缺省 `process.pid`；测试注入）。 */
  pid?: number;
  /** 本实例标识（缺省随机 UUID）：只用于归属校验与诊断。 */
  instanceId?: string;
}

interface WriteLockContext {
  instanceId: string;
  pid: number;
  liveness: (pid: number) => WorkflowProcessLiveness;
  now: () => number;
}

/** 写进 `owner.json` 的归属凭证：字段严格校验，缺一即视为损坏。 */
interface WriteLockRecord {
  version: typeof WRITE_LOCK_RECORD_VERSION;
  instanceId: string;
  pid: number;
  target: string;
  startedAt: number;
}

interface WriteLockPaths {
  lockDir: string;
  ownerFile: string;
  mutexFile: string;
}

type WriteLockRead = { state: "missing" } | { state: "corrupt"; message: string } | { state: "ok"; owner: WriteLockRecord };
type WriteLockClaim = "claimed" | "exists" | { code: WorkflowStoreErrorCode; message: string };
type WriteLockReclaim = "claimed" | "retry" | { code: WorkflowStoreErrorCode; message: string };

function writeLockPaths(directory: string, target: string): WriteLockPaths {
  const lockDir = join(directory, `.${target}.write-lock`);
  return { lockDir, ownerFile: join(lockDir, "owner.json"), mutexFile: `${lockDir}.reclaim.lock` };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function describeIoError(error: unknown): string {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}: ${message}` : message;
}

function closeQuietly(fd: number): void {
  try { closeSync(fd); } catch { /* 已关闭 */ }
}

function readWriteLockRecord(ownerFile: string, target: string): WriteLockRead {
  let raw: string;
  try { raw = readFileSync(ownerFile, "utf8"); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "missing" };
    return { state: "corrupt", message: describeIoError(error) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return { state: "corrupt", message: "内容不是合法 JSON" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "corrupt", message: "记录不是对象" };
  const value = parsed as Record<string, unknown>;
  if (value.version !== WRITE_LOCK_RECORD_VERSION) return { state: "corrupt", message: "记录版本不符" };
  if (typeof value.instanceId !== "string" || !value.instanceId.trim()) return { state: "corrupt", message: "instanceId 缺失" };
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return { state: "corrupt", message: "pid 非法" };
  if (value.target !== target) return { state: "corrupt", message: "target 不符" };
  if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) return { state: "corrupt", message: "startedAt 非法" };
  return {
    state: "ok",
    owner: {
      version: WRITE_LOCK_RECORD_VERSION,
      instanceId: value.instanceId,
      pid: value.pid as number,
      target,
      startedAt: value.startedAt
    }
  };
}

/** 以原子 mkdir 占位，再写入 owner 记录；失败保留可诊断的锁目录（不删别人的东西）。 */
function claimWriteLock(paths: WriteLockPaths, owner: WriteLockRecord): WriteLockClaim {
  try { mkdirSync(paths.lockDir); }
  catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST") return "exists";
    if (code === "ENOENT") return { code: "not-found", message: `工作流目录不存在：${dirname(paths.lockDir)}` };
    return { code: "io", message: `无法创建工作流写锁目录（${describeIoError(error)}）：${paths.lockDir}` };
  }
  let fd: number;
  try { fd = openSync(paths.ownerFile, "wx"); }
  catch (error) {
    try { rmdirSync(paths.lockDir); } catch { /* 留下可诊断的锁目录 */ }
    return { code: "io", message: `无法创建写锁记录（${describeIoError(error)}）：${paths.ownerFile}` };
  }
  try { writeFileSync(fd, JSON.stringify(owner), "utf8"); }
  catch (error) {
    closeQuietly(fd);
    // 半成品记录会被后来者判成「损坏」并卡住：刚才是自己独占创建的，删掉是安全的。
    try { unlinkSync(paths.ownerFile); rmdirSync(paths.lockDir); } catch { /* 尽力清理 */ }
    return { code: "io", message: `无法写入写锁记录（${describeIoError(error)}）：${paths.ownerFile}` };
  }
  closeQuietly(fd);
  return "claimed";
}

/** 只删自己那份记录。返回非空字符串 = 没删掉且需要上报的原因（归属不符/损坏/IO）。 */
function releaseWriteLock(paths: WriteLockPaths, owner: WriteLockRecord): string | undefined {
  const read = readWriteLockRecord(paths.ownerFile, owner.target);
  // 记录已不在：别人回收过，按已释放处理。
  if (read.state === "missing") return undefined;
  if (read.state === "corrupt") return `工作区定义写锁记录损坏（${read.message}），无法确认归属，未删除：${paths.ownerFile}`;
  if (read.owner.instanceId !== owner.instanceId || read.owner.pid !== owner.pid || read.owner.target !== owner.target) {
    return `工作区定义写锁已不属于本实例（现持有：${lockHolderSummary(read.owner)}），未删除：${paths.ownerFile}`;
  }
  try { unlinkSync(paths.ownerFile); }
  catch (error) { if (errorCode(error) !== "ENOENT") return `无法删除工作区定义写锁（${describeIoError(error)}）：${paths.ownerFile}`; }
  // 只清空目录：回收互斥还在里面时留着（ENOTEMPTY 直接忽略）。
  try { rmdirSync(paths.lockDir); } catch { /* 目录非空或被占用：不影响锁的语义 */ }
  return undefined;
}

/** 持锁执行：先把崩溃实例的临时文件清掉，action 成功/失败都要归还锁。 */
function runLocked<T>(directory: string, paths: WriteLockPaths, owner: WriteLockRecord, action: () => T): T {
  sweepTemporaryFiles(directory);
  let result: T;
  try { result = action(); }
  catch (error) {
    // 原始错误优先：释放失败不能盖掉 action 的失败原因（残留会被后续存活判定报出来）。
    releaseWriteLock(paths, owner);
    throw error;
  }
  const releaseError = releaseWriteLock(paths, owner);
  if (releaseError) throw new WorkflowStoreError("io", releaseError);
  return result;
}

/**
 * 回收「确定已死」的旧锁并立刻抢锁。互斥内重新读盘并复核存活，是防「误删别人的新锁」的关键：
 * 窗口里可能被释放、被别的回收者换掉、或持有者又活了——任一情况都放弃本轮（retry）。
 */
function reclaimDeadWriteLock(paths: WriteLockPaths, owner: WriteLockRecord, context: WriteLockContext): WriteLockReclaim {
  let fd: number;
  try { fd = openSync(paths.mutexFile, "wx"); }
  catch (error) {
    if (errorCode(error) !== "EEXIST") return { code: "io", message: `无法创建写锁回收互斥（${describeIoError(error)}）：${paths.mutexFile}` };
    return {
      code: "busy",
      message: `另一个实例正在回收工作区定义写锁（互斥文件 ${paths.mutexFile}）。本次未做任何修改；确认没有实例在写后可删除该文件重试`
    };
  }
  try { writeFileSync(fd, JSON.stringify({ instanceId: context.instanceId, pid: context.pid, startedAt: context.now() }), "utf8"); }
  catch (error) {
    closeQuietly(fd);
    try { unlinkSync(paths.mutexFile); } catch { /* 尽力清理 */ }
    return { code: "io", message: `无法写入写锁回收互斥（${describeIoError(error)}）：${paths.mutexFile}` };
  }
  closeQuietly(fd);
  try {
    const current = readWriteLockRecord(paths.ownerFile, owner.target);
    if (current.state !== "ok") return "retry";
    if (current.owner.instanceId === context.instanceId && current.owner.pid === context.pid) return "retry";
    if (context.liveness(current.owner.pid) !== "dead") return "retry";
    try { unlinkSync(paths.ownerFile); rmdirSync(paths.lockDir); }
    catch (error) {
      if (errorCode(error) !== "ENOENT") return { code: "io", message: `无法回收陈旧工作区定义写锁（${describeIoError(error)}）：${paths.lockDir}` };
    }
    // 持着互斥立刻抢：普通抢锁者可能抢先（它不删任何东西），抢先就重试。
    const claim = claimWriteLock(paths, owner);
    if (claim === "claimed") return "claimed";
    if (claim === "exists") return "retry";
    return claim;
  } finally {
    try { unlinkSync(paths.mutexFile); } catch { /* 残留会让下次回收保守失败并给出路径 */ }
  }
}

/** 清理崩溃实例留下的唯一临时文件：只在持锁期间做，此时目录里不可能有别的写入者。 */
function sweepTemporaryFiles(directory: string): void {
  let names: string[];
  try { names = readdirSync(directory); }
  catch { return; }
  for (const name of names) {
    if (!DEFINITION_TEMP_FILE.test(name)) continue;
    const path = join(directory, name);
    try {
      const entry = lstatSync(path);
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      unlinkSync(path);
    } catch { /* 留给下一次持锁重试 */ }
  }
}

/**
 * 旧版本把锁写成普通文件 `.catalog.write-lock`（`{pid, at}`）：只按「确定已退出」回收，
 * 存活/未知/损坏一律拒绝。这是升级后第一次保存能自我恢复的关键（否则旧残留会永远 busy）。
 */
function reclaimLegacyLockFile(paths: WriteLockPaths, context: WriteLockContext): { code: WorkflowStoreErrorCode; message: string } | undefined {
  let entry: ReturnType<typeof lstatSync>;
  try { entry = lstatSync(paths.lockDir); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    return { code: "io", message: `无法读取工作区定义写锁路径（${describeIoError(error)}）：${paths.lockDir}` };
  }
  if (entry.isDirectory()) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink()) {
    return { code: "io", message: `工作区定义写锁路径不是普通文件或目录：${paths.lockDir}。本次未做修改` };
  }
  let pid: number | undefined;
  try {
    const parsed = JSON.parse(readFileSync(paths.lockDir, "utf8")) as Record<string, unknown>;
    if (Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0) pid = parsed.pid as number;
  } catch { /* 落到损坏分支 */ }
  if (pid === undefined) {
    return {
      code: "io",
      message: `旧版工作区定义写锁文件损坏，无法判断持有进程：${paths.lockDir}。为避免覆盖其他实例的写入，本次未做修改；确认无实例在写后可删除该文件重试`
    };
  }
  const liveness = context.liveness(pid);
  if (liveness !== "dead") {
    return {
      code: "busy",
      message: `旧版工作区定义写锁仍由 PID ${pid} 持有（存活判定：${liveness}）：${paths.lockDir}。本次未做修改`
    };
  }
  try { unlinkSync(paths.lockDir); }
  catch (error) { if (errorCode(error) !== "ENOENT") return { code: "io", message: `无法回收旧版工作区定义写锁（${describeIoError(error)}）：${paths.lockDir}` }; }
  return undefined;
}

function lockHolderSummary(owner: WriteLockRecord): string {
  return `实例 ${owner.instanceId}、PID ${owner.pid}、开始于 ${new Date(owner.startedAt).toISOString()}`;
}

/**
 * 工作区定义写入跨实例互斥：校验 hash 与原子替换处于同一临界区。
 * 锁被存活/未知进程持有、记录损坏或回收互斥被占时保守拒绝（busy/io），绝不抢占。
 */
function withWriteLock<T>(directory: string, target: string, context: WriteLockContext, action: () => T): T {
  const paths = writeLockPaths(directory, target);
  for (let attempt = 0; attempt < WRITE_LOCK_ATTEMPTS; attempt += 1) {
    // 旧版本遗留的文件锁：只在持有者确定已退出时回收。
    const legacy = reclaimLegacyLockFile(paths, context);
    if (legacy) throw new WorkflowStoreError(legacy.code, legacy.message);
    const owner: WriteLockRecord = {
      version: WRITE_LOCK_RECORD_VERSION,
      instanceId: context.instanceId,
      pid: context.pid,
      target,
      startedAt: context.now()
    };
    const claim = claimWriteLock(paths, owner);
    if (claim === "claimed") return runLocked(directory, paths, owner, action);
    if (claim !== "exists") throw new WorkflowStoreError(claim.code, claim.message);

    // 有人占着：先判定它是活的、死了、还是判不出来。
    const read = readWriteLockRecord(paths.ownerFile, target);
    if (read.state === "missing") {
      // 目录刚被创建、owner 还没落盘，或上次崩在两个动作之间：下一轮再看。
      // 用尽重试后保守拒绝（可能正是别的实例在创建自己的锁）。
      continue;
    }
    if (read.state === "corrupt") {
      throw new WorkflowStoreError(
        "io",
        `工作区定义写锁记录损坏或不可读（${read.message}）：${paths.ownerFile}。为避免抢占其他实例的写入，本次未做任何修改；确认没有实例在写后可删除该目录重试`
      );
    }
    const holder = read.owner;
    const liveness = context.liveness(holder.pid);
    if (liveness === "alive") {
      throw new WorkflowStoreError("busy", `工作流正在被其他实例保存：${target}（${lockHolderSummary(holder)}，锁目录 ${paths.lockDir}）`);
    }
    if (liveness === "unknown") {
      throw new WorkflowStoreError(
        "busy",
        `无法确定工作区定义写锁的持有进程 PID ${holder.pid} 是否存活（锁目录 ${paths.lockDir}）。为避免覆盖其他实例的写入，本次未做修改；确认该进程已退出后可删除该目录重试`
      );
    }
    const reclaim = reclaimDeadWriteLock(paths, owner, context);
    if (reclaim === "claimed") return runLocked(directory, paths, owner, action);
    if (reclaim !== "retry") throw new WorkflowStoreError(reclaim.code, reclaim.message);
    // reclaim === "retry"：状态在窗口里变了，重新判定。
  }
  throw new WorkflowStoreError(
    "busy",
    `回收工作区定义写锁时状态持续变化，重试 ${WRITE_LOCK_ATTEMPTS} 次仍未收敛：${paths.lockDir}`
  );
}

export class WorkflowStore {
  private readonly lock: WriteLockContext;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => `wf-${randomUUID()}`,
    options: WorkflowStoreLockOptions = {}
  ) {
    this.lock = {
      instanceId: options.instanceId?.trim() || `store-${randomUUID()}`,
      pid: options.pid ?? process.pid,
      liveness: options.liveness ?? processLiveness,
      now: this.now
    };
  }

  get(workspace: string, workflowId: string): StoredWorkflow {
    return readWorkflowFile(definitionsDirectory(workspace, false).directory, workflowId);
  }

  list(workspace: string, validation: WorkflowRunValidationContext = {}): WorkflowCatalog {
    const { workspace: canonical, directory } = definitionsDirectory(workspace, false);
    let files: string[];
    try { files = readdirSync(directory).filter((name) => name.toLowerCase().endsWith(".json")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { workspace: canonical, workflows: [], diagnostics: [] };
      throw error;
    }
    const workflows: WorkflowCatalogEntry[] = [];
    const diagnostics: string[] = [];
    for (const file of files.sort()) {
      const id = file.slice(0, -5);
      try {
        const { definition } = readWorkflowFile(directory, id);
        const result = validateWorkflowForRun(definition, validation);
        workflows.push({
          id: definition.id,
          name: definition.name,
          ...(definition.description !== undefined ? { description: definition.description } : {}),
          ...(definition.whenToUse !== undefined ? { whenToUse: definition.whenToUse } : {}),
          nodeCount: definition.nodes.length,
          updatedAt: definition.updatedAt,
          runnable: result.ok,
          issueCount: result.errors.length
        });
      } catch (error) {
        diagnostics.push(`${file}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    workflows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    return { workspace: canonical, workflows, diagnostics };
  }

  save(workspace: string, draft: unknown, options: SaveWorkflowOptions = {}): StoredWorkflow {
    const { directory } = definitionsDirectory(workspace, true);
    const id = options.workflowId ?? this.createId();
    const path = definitionPath(directory, id);
    return withWriteLock(directory, "catalog", this.lock, () => {
      let existing: StoredWorkflow | undefined;
      if (options.workflowId) {
        if (!options.baseHash) throw new WorkflowStoreError("conflict", "更新工作流必须提供读取时的 baseHash");
        existing = readWorkflowFile(directory, id);
        if (existing.baseHash !== options.baseHash) throw new WorkflowStoreError("conflict", "工作流已被其他操作修改，请重新读取后再保存");
      } else {
        const count = readdirSync(directory).filter((file) => file.toLowerCase().endsWith(".json")).length;
        if (count >= MAX_WORKFLOWS_PER_WORKSPACE) throw new WorkflowStoreError("limit", `工作区最多保存 ${MAX_WORKFLOWS_PER_WORKSPACE} 个工作流`);
      }
      if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new WorkflowStoreError("invalid-draft", "工作流草稿必须是对象");
      const timestamp = this.now();
      const proposed = {
        ...draft,
        id,
        revision: existing ? existing.definition.revision + 1 : 1,
        createdAt: existing?.definition.createdAt ?? timestamp,
        updatedAt: timestamp
      };
      const checked = normalizeWorkflowDraft(proposed);
      if (!checked.ok || !checked.definition) throw new WorkflowStoreError("invalid-draft", "工作流草稿结构非法", checked.errors);
      const contents = `${JSON.stringify(checked.definition, null, 2)}\n`;
      if (Buffer.byteLength(contents, "utf8") > MAX_WORKFLOW_FILE_BYTES) throw new WorkflowStoreError("invalid-draft", `工作流文件不能超过 ${MAX_WORKFLOW_FILE_BYTES} 字节`);
      try { atomicWrite(path, contents, !existing); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkflowStoreError("conflict", "生成的工作流 id 已存在，请重试");
        throw error;
      }
      return { definition: checked.definition, baseHash: workflowDefinitionHash(contents) };
    });
  }

  delete(workspace: string, workflowId: string, baseHash: string): void {
    const { directory } = definitionsDirectory(workspace, false);
    const path = definitionPath(directory, workflowId);
    withWriteLock(directory, "catalog", this.lock, () => {
      const existing = readWorkflowFile(directory, workflowId);
      if (!baseHash || existing.baseHash !== baseHash) throw new WorkflowStoreError("conflict", "工作流已被其他操作修改，请重新读取后再删除");
      unlinkSync(path);
    });
  }
}
