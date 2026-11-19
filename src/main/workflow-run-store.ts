import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ChatMessage, MessageBlock } from "../shared/protocol.js";
import {
  MAX_WORKFLOW_ARTIFACT_BYTES,
  MAX_WORKFLOW_ATTEMPTS,
  normalizeWorkflowDraft,
  type WorkflowDefinition,
  type WorkflowExecution,
  type WorkflowExecutionStatus,
  type WorkflowRun,
  type WorkflowRunStatus
} from "../shared/workflow.js";
import { processLiveness, workspaceLockKey, type WorkflowProcessLiveness } from "./workflow-coordinator.js";
import { messageUuid } from "./message-identity.js";
import { transcriptMessagesFromEntries, type PersistedSessionEntry } from "./session-history.js";

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TERMINAL_STATES: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>(["completed", "rejected", "stopped", "failed", "interrupted"]);
const ACTIVE_STATES: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>(["starting", "running", "stopping"]);
const EXECUTION_STATES: ReadonlySet<WorkflowExecutionStatus> = new Set<WorkflowExecutionStatus>(["pending", "starting", "running", "waiting_permission", "completed", "failed", "stopped", "skipped"]);
const RUN_STATES: ReadonlySet<WorkflowRunStatus> = new Set<WorkflowRunStatus>([...ACTIVE_STATES, ...TERMINAL_STATES]);
const EXECUTION_SOURCES = new Set<string>(["agent", "subagent"]);
export const MAX_RETAINED_WORKFLOW_RUNS = 200;
export const MAX_TRANSCRIPT_PAGE_SIZE = 200;
/** 单页消息的 UTF-8 预算：分页响应（IPC）按字节有界，而不是只看条数。 */
export const MAX_TRANSCRIPT_PAGE_BYTES = 256 * 1024;
/** 单条消息内联上限：超出部分显式截断并在消息末尾标注（绝不改原文件）。 */
export const MAX_TRANSCRIPT_MESSAGE_BYTES = 64 * 1024;
/** 单行 JSONL 读取上限：超过就拒绝整次读取（不猜这条消息是否可见，避免游标错位）。 */
export const MAX_TRANSCRIPT_LINE_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;
/** 截断说明自身的预算（正文块先扣掉它，保证说明块总能放下）。 */
const TRANSCRIPT_TRUNCATION_RESERVE_BYTES = 512;

function component(value: string, label: string): string {
  if (!SAFE_COMPONENT.test(value)) throw new Error(`${label} 不是合法的路径标识`);
  return value;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", flag: "wx" });
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** 创建目录后逐级解析，避免链接把内部运行产物指向允许根之外。 */
function safeDirectory(root: string, parts: string[], create: boolean): string {
  if (create) mkdirSync(root, { recursive: true });
  const realRoot = realpathSync.native(root);
  let current = realRoot;
  for (const part of parts) {
    component(part, "路径分量");
    current = join(current, part);
    if (create) {
      try { mkdirSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const real = realpathSync.native(current);
    if (!isWithin(realRoot, real) || !statSync(real).isDirectory()) throw new Error("运行目录越过允许的根目录");
    current = real;
  }
  return current;
}

function safeExistingFile(root: string, expectedDirectory: string, target: string): string {
  if (!isAbsolute(target) || !isWithin(expectedDirectory, target)) throw new Error("记录中的文件路径不属于该节点运行");
  const rootReal = realpathSync.native(root);
  const directoryReal = realpathSync.native(expectedDirectory);
  const targetReal = realpathSync.native(target);
  if (!isWithin(rootReal, directoryReal) || !isWithin(directoryReal, targetReal) || !statSync(targetReal).isFile()) {
    throw new Error("记录中的文件实际路径越过允许范围");
  }
  return targetReal;
}

function assertRunShape(value: unknown, runId: string): asserts value is WorkflowRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("运行记录不是对象");
  const run = value as Record<string, unknown>;
  if (run.runId !== runId) fail("运行记录的 runId 与所在目录不一致");
  component(runId, "runId");
  for (const key of ["workflowId", "workflowName", "workspace", "agentId", "ownerSessionId", "definitionHash", "runnerInstanceId"] as const) {
    requireText(run[key], key);
  }
  component(run.agentId as string, "agentId");
  component(run.ownerSessionId as string, "ownerSessionId");
  requireInteger(run.runnerPid, "runnerPid", 1, Number.MAX_SAFE_INTEGER);
  if (typeof run.status !== "string" || !RUN_STATES.has(run.status as WorkflowRunStatus)) fail(`运行状态非法：${String(run.status)}`);
  if (typeof run.startedAt !== "number" || !Number.isFinite(run.startedAt) || run.startedAt <= 0) fail("startedAt 字段缺失或非法");
  optionalNumber(run.endedAt, "endedAt");
  optionalText(run.ownerSessionFile, "ownerSessionFile");
  optionalText(run.currentExecutionId, "currentExecutionId");
  optionalText(run.error, "error");
  const maxAttempts = requireInteger(run.maxAttempts, "maxAttempts", 1, MAX_WORKFLOW_ATTEMPTS);
  const currentAttempt = requireInteger(run.currentAttempt, "currentAttempt", 1, maxAttempts);
  if (!Array.isArray(run.executions)) fail("executions 字段缺失或不是数组");
  assertExecutions(run.executions, maxAttempts, currentAttempt);
  if (!Array.isArray(run.resolvedNodes)) fail("resolvedNodes 字段缺失或不是数组");
  assertResolvedNodes(run.resolvedNodes);
}

function fail(message: string): never {
  throw new Error(message);
}

function requireText(value: unknown, label: string, options: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== "string" || (!options.allowEmpty && !value.trim())) fail(`${label} 字段缺失或非法`);
  return value as string;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireText(value, label, { allowEmpty: true });
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} 字段必须是有限数字`);
  return value;
}

function requireInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${label} 字段必须是 ${min}–${max} 的整数`);
  }
  return value as number;
}

function assertExecutions(executions: readonly unknown[], maxAttempts: number, currentAttempt: number): void {
  const executionIds = new Set<string>();
  for (const raw of executions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("节点执行记录非法");
    const execution = raw as Record<string, unknown>;
    const executionId = requireText(execution.executionId, "executionId");
    const nodeId = requireText(execution.nodeId, "nodeId");
    component(executionId, "executionId");
    component(nodeId, "nodeId");
    if (executionIds.has(executionId)) fail("节点 executionId 重复");
    executionIds.add(executionId);
    requireText(execution.nodeTitle, "nodeTitle", { allowEmpty: true });
    const attempt = requireInteger(execution.attempt, "attempt", 1, maxAttempts);
    if (attempt > currentAttempt) fail(`节点执行轮次 ${attempt} 超过运行当前轮次 ${currentAttempt}`);
    if (typeof execution.status !== "string" || !EXECUTION_STATES.has(execution.status as WorkflowExecutionStatus)) {
      fail(`节点执行状态非法：${String(execution.status)}`);
    }
    optionalNumber(execution.startedAt, "execution.startedAt");
    optionalNumber(execution.endedAt, "execution.endedAt");
    optionalText(execution.sessionId, "execution.sessionId");
    optionalText(execution.sessionFile, "execution.sessionFile");
    optionalText(execution.artifactPath, "execution.artifactPath");
    optionalText(execution.error, "execution.error");
    if (execution.decision !== undefined) {
      if (!execution.decision || typeof execution.decision !== "object" || Array.isArray(execution.decision)) fail("节点验收结论非法");
      const decision = execution.decision as Record<string, unknown>;
      if (decision.verdict !== "pass" && decision.verdict !== "retry") fail(`节点验收结论 verdict 非法：${String(decision.verdict)}`);
      requireText(decision.reason, "decision.reason", { allowEmpty: true });
    }
  }
}

function assertResolvedNodes(nodes: readonly unknown[]): void {
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("节点解析配置非法");
    const node = raw as Record<string, unknown>;
    component(requireText(node.nodeId, "resolvedNodes.nodeId"), "resolvedNodes.nodeId");
    if (typeof node.source !== "string" || !EXECUTION_SOURCES.has(node.source)) fail(`节点来源非法：${String(node.source)}`);
    if (node.subagent !== undefined) requireText(node.subagent, "resolvedNodes.subagent");
    const model = node.model;
    if (!model || typeof model !== "object" || Array.isArray(model)) fail("节点模型配置缺失或非法");
    const modelRef = model as Record<string, unknown>;
    requireText(modelRef.provider, "resolvedNodes.model.provider");
    requireText(modelRef.id, "resolvedNodes.model.id");
    requireText(node.thinkingLevel, "resolvedNodes.thinkingLevel");
    if (!Array.isArray(node.tools) || node.tools.some((tool) => typeof tool !== "string")) fail("resolvedNodes.tools 必须是字符串数组");
    if (node.accessModeCap !== undefined) requireText(node.accessModeCap, "resolvedNodes.accessModeCap");
    if (node.browserTools !== undefined && typeof node.browserTools !== "boolean") fail("resolvedNodes.browserTools 必须是布尔");
    if (node.injectAgentsMd !== undefined && typeof node.injectAgentsMd !== "boolean") fail("resolvedNodes.injectAgentsMd 必须是布尔");
  }
}

export interface WorkflowRunListOptions {
  workspace?: string;
  agentId?: string;
  ownerSessionId?: string;
  cursor?: string;
  limit?: number;
}

export interface WorkflowRunStoreOptions {
  agentDir: string;
  liveness?: (pid: number) => WorkflowProcessLiveness;
  now?: () => number;
}

export interface WorkflowTranscriptPage {
  messages: ChatMessage[];
  nextCursor?: string;
  /** 还有下一页，或有消息被截断（截断原因附在消息末尾的标记块里）。 */
  truncated: boolean;
}

/* ── 会话记录读取（头部核验 + 字节有界分页） ─────────────────────────── */

interface WorkflowSessionHeader {
  id: string;
  cwd?: string;
  parentSession?: string;
}

/** 有界读首行（header 永远是第一行；8KB 足够，不扫整文件）。 */
function readSessionHeader(file: string): WorkflowSessionHeader | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(8192);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0]?.trim() ?? "";
    if (!firstLine) return undefined;
    let parsed: unknown;
    try { parsed = JSON.parse(firstLine); } catch { return undefined; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const header = parsed as Record<string, unknown>;
    if (header.type !== "session" || typeof header.id !== "string" || !header.id) return undefined;
    return {
      id: header.id,
      ...(typeof header.cwd === "string" ? { cwd: header.cwd } : {}),
      ...(typeof header.parentSession === "string" ? { parentSession: header.parentSession } : {})
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeQuietly(fd);
  }
}

/** 工作区比较：先 realpath 归一（大小写不敏感仅 win32，由 workspaceLockKey 决定），失败时回退纯路径归一。 */
function sameWorkspacePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const key = (value: string): string => {
    try { return workspaceLockKey(realpathSync.native(value)); }
    catch { return workspaceLockKey(resolve(value)); }
  };
  return key(a) === key(b);
}

/**
 * 核验会话文件真的属于这条执行：header.id = execution.sessionId、cwd = 运行工作区、
 * parentSession = 运行 owner。记录里写了 sessionId 就必须能在文件里对得上；
 * 没有 header 的手工/历史文件只在记录也没写 sessionId 时放行（路径仍受运行目录约束）。
 */
function verifyTranscriptHeader(file: string, run: WorkflowRun, execution: WorkflowExecution): void {
  const header = readSessionHeader(file);
  if (!header) {
    if (execution.sessionId) throw new Error(`会话文件缺少 session 头部，无法核验执行归属：${file}`);
    return;
  }
  if (execution.sessionId && header.id !== execution.sessionId) {
    throw new Error(`会话文件的 header.id 与执行记录不一致（文件 ${header.id} / 记录 ${execution.sessionId}）`);
  }
  if (!header.cwd) throw new Error(`会话文件的 header 缺少 cwd，无法核验工作区：${file}`);
  if (!sameWorkspacePath(header.cwd, run.workspace)) {
    throw new Error(`会话文件的 header.cwd 不属于该运行的工作区（${header.cwd}）：${file}`);
  }
  if (header.parentSession !== run.ownerSessionId) {
    throw new Error(`会话文件的 header.parentSession 与运行 owner 不一致（${header.parentSession ?? "缺失"}）：${file}`);
  }
}

/** 与 `message-normalize` 的可见消息口径一致（user/assistant + 可展示的 custom）。 */
function visibleTranscriptMessage(entry: unknown): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const message = (entry as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  if (typeof record.role !== "string") return undefined;
  if (record.role === "user" || record.role === "assistant") return record;
  if (record.role === "custom" && record.display === true) return record;
  return undefined;
}

/**
 * 逐块读 JSONL（内存只看当前行 + 当前页），只收 [cursor, cursor+limit) 的可见消息，
 * 并多读一条判断是否还有下一页：即使文件很大也不会整篇进内存。
 */
function readTranscriptWindow(file: string, cursor: number, limit: number): { messages: Record<string, unknown>[]; hasMore: boolean } {
  const messages: Record<string, unknown>[] = [];
  let index = 0;
  let hasMore = false;
  scanJsonLines(file, MAX_TRANSCRIPT_LINE_BYTES, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    let entry: unknown;
    try { entry = JSON.parse(trimmed); }
    catch { return true; } // 单行损坏只跳过这行（与旧行为一致），不让整篇不可读
    const message = visibleTranscriptMessage(entry);
    if (!message) return true;
    if (index < cursor) { index += 1; return true; }
    if (messages.length >= limit) { hasMore = true; return false; }
    messages.push(message);
    index += 1;
    return true;
  });
  return { messages, hasMore };
}

/** 分块扫描 JSONL；单行超上限直接报错（无法安全判断它是否一条可见消息，不猜）。 */
function scanJsonLines(file: string, maxLineBytes: number, visit: (line: string, lineNumber: number) => boolean): void {
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(TRANSCRIPT_CHUNK_BYTES);
    let parts: Buffer[] = [];
    let pending = 0;
    let lineNumber = 0;
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read <= 0) break;
      let start = 0;
      while (start < read) {
        const newline = chunk.indexOf(10, start);
        const end = newline >= 0 && newline < read ? newline : read;
        const slice = Buffer.from(chunk.subarray(start, end));
        parts.push(slice);
        pending += slice.length;
        if (pending > maxLineBytes) {
          throw new Error(`会话记录存在超过 ${maxLineBytes} 字节的单行（第 ${lineNumber + 1} 行），无法按页读取；原文件未修改：${file}`);
        }
        const complete = newline >= 0 && newline < read;
        start = end + 1;
        if (!complete) continue;
        const line = Buffer.concat(parts, pending).toString("utf8").replace(/\r$/u, "");
        parts = [];
        pending = 0;
        lineNumber += 1;
        if (!visit(line, lineNumber)) return;
      }
    }
    if (pending > 0) {
      lineNumber += 1;
      visit(Buffer.concat(parts, pending).toString("utf8").replace(/\r$/u, ""), lineNumber);
    }
  } finally {
    closeQuietly(fd);
  }
}

function jsonByteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"); }
  catch { return Number.MAX_SAFE_INTEGER; }
}

function transcriptMessageBytes(message: ChatMessage): number {
  return jsonByteLength(message);
}

/** 按 UTF-8 字节截断，不切断多字节字符（截断点落在字符中间时丢掉残尾）。 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

/**
 * 单条消息内联上限：超出时按块贪心保留，其余用标记占位，并在末尾追加一条截断说明。
 * 只改响应里的副本，原会话文件不动；游标照常前进到下一条。
 */
function clipTranscriptMessage(message: ChatMessage, maxBytes: number): { message: ChatMessage; clipped: boolean } {
  if (transcriptMessageBytes(message) <= maxBytes) return { message, clipped: false };
  let remaining = Math.max(256, maxBytes - TRANSCRIPT_TRUNCATION_RESERVE_BYTES);
  const blocks: MessageBlock[] = [];
  const omitted: string[] = [];
  for (const block of message.blocks) {
    if (block.type === "text" || block.type === "thinking") {
      const size = Buffer.byteLength(block.text, "utf8");
      if (size <= remaining) { blocks.push(block); remaining -= size; continue; }
      const clippedText = truncateUtf8(block.text, remaining);
      if (clippedText) blocks.push({ ...block, text: clippedText });
      omitted.push(`${block.type === "text" ? "文本" : "思考"} ${size} 字节`);
      remaining = 0;
      continue;
    }
    if (block.type === "image") {
      omitted.push(`图片 ${Buffer.byteLength(block.data ?? "", "utf8")} 字节`);
      continue;
    }
    const argsSize = jsonByteLength(block.arguments);
    if (argsSize <= remaining) { blocks.push(block); remaining -= argsSize; continue; }
    blocks.push({ ...block, arguments: { truncated: true, bytes: argsSize, note: "工具参数过大，已省略（原记录未修改）" } });
    omitted.push(`工具参数 ${argsSize} 字节`);
    remaining = 0;
  }
  let extension = message.extension;
  if (extension) {
    const detailsSize = jsonByteLength(extension.details);
    if (detailsSize > remaining) {
      extension = { ...extension, details: { truncated: true, bytes: detailsSize, note: "扩展详情过大，已省略（原记录未修改）" } };
      omitted.push(`扩展详情 ${detailsSize} 字节`);
      remaining = 0;
    } else {
      remaining -= detailsSize;
    }
  }
  let error = message.error;
  if (typeof error === "string") {
    const size = Buffer.byteLength(error, "utf8");
    if (size > remaining) {
      error = truncateUtf8(error, remaining);
      omitted.push(`错误信息 ${size} 字节`);
      remaining = 0;
    } else {
      remaining -= size;
    }
  }
  const note: MessageBlock = {
    type: "text",
    text: `…[消息过大已截断${omitted.length > 0 ? `：省略 ${omitted.join("、")}` : ""}；原始会话文件未修改，继续翻页用 nextCursor]`
  };
  const clipped: ChatMessage = {
    ...message,
    blocks: [...blocks, note],
    ...(extension ? { extension } : {}),
    ...(error !== undefined ? { error } : {})
  };
  if (transcriptMessageBytes(clipped) <= maxBytes) return { message: clipped, clipped: true };
  // 极端情况（结构本身很大）：只留说明块，保证单条消息一定在预算内。
  return {
    message: {
      ...message,
      blocks: [note],
      ...(message.extension
        ? { extension: { ...message.extension, details: { truncated: true, note: "详情过大，已省略（原记录未修改）" } } }
        : {})
    },
    clipped: true
  };
}

/** 空目录清理的体量上限（防脏数据把同步路径拖死；正常 run 只有几层）。 */
const SESSION_TREE_MAX_DEPTH = 8;
const SESSION_TREE_MAX_ENTRIES = 2_000;

/**
 * 递归删除空目录：只用 rmdir（文件/符号链接一律视为非空，绝不删除、绝不跟随）。
 * 返回 true 表示该目录最终被删掉。
 */
function removeEmptyDirectoryTree(directory: string, budget: { entries: number }, errors: string[], depth = 0): boolean {
  if (depth > SESSION_TREE_MAX_DEPTH || budget.entries <= 0) return false;
  let entries: Dirent[];
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") errors.push(`${directory}：无法枚举关联目录：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  let empty = true;
  for (const entry of entries) {
    if (budget.entries <= 0) return false;
    budget.entries -= 1;
    if (!entry.isDirectory()) { empty = false; continue; }
    if (!removeEmptyDirectoryTree(join(directory, entry.name), budget, errors, depth + 1)) empty = false;
  }
  if (!empty) return false;
  try { rmdirSync(directory); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTEMPTY/EEXIST = 刚又多了东西（并发），ENOENT = 已经被别人删了；都不是失败。
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
      errors.push(`${directory}：关联空目录未清理：${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }
}

/**
 * 清掉运行结束后变空的 owner/run 目录：只在本 run 自己的目录子树里 rmdir 空目录，
 * 非空一律保留——因此绝不会删到其他 run/owner 的文件。返回非致命诊断。
 */
function pruneEmptySessionDirectories(workflowRoot: string, run: WorkflowRun): string[] {
  const errors: string[] = [];
  let root: string;
  try { root = realpathSync.native(workflowRoot); } catch { return errors; }
  if (![run.ownerSessionId, run.runId].every((part) => SAFE_COMPONENT.test(part))) return errors;
  const ownerDirectory = join(root, run.ownerSessionId);
  const runDirectory = join(ownerDirectory, run.runId);
  let runReal: string;
  try { runReal = realpathSync.native(runDirectory); } catch { return errors; }
  if (!isWithin(root, runReal)) return errors;
  if (!removeEmptyDirectoryTree(runReal, { entries: SESSION_TREE_MAX_ENTRIES }, errors)) return errors;
  let ownerReal: string;
  try { ownerReal = realpathSync.native(ownerDirectory); } catch { return errors; }
  if (!isWithin(root, ownerReal)) return errors;
  // 同 owner 下还有别的 run 时 rmdir 会 ENOTEMPTY：保留，不动别的 run。
  try { rmdirSync(ownerReal); } catch { /* 非空/被占用：保留 */ }
  return errors;
}

function closeQuietly(fd: number): void {
  try { closeSync(fd); } catch { /* 已关闭 */ }
}

/** 同步读写使单个 utility 内的状态保存天然串行；所有写入均以唯一临时文件替换。 */
export class WorkflowRunStore {
  readonly agentDir: string;
  readonly runsRoot: string;
  private readonly liveness: (pid: number) => WorkflowProcessLiveness;
  private readonly now: () => number;

  constructor(options: WorkflowRunStoreOptions) {
    this.agentDir = options.agentDir;
    this.runsRoot = join(options.agentDir, "pidesktop-workflows", "runs");
    this.liveness = options.liveness ?? processLiveness;
    this.now = options.now ?? Date.now;
  }

  create(run: WorkflowRun, definition: WorkflowDefinition): void {
    assertRunShape(run, run.runId);
    const check = normalizeWorkflowDraft(definition);
    if (!check.ok || !check.definition || definition.id !== run.workflowId) throw new Error("运行的工作流定义快照非法或不匹配");
    mkdirSync(this.runsRoot, { recursive: true });
    const root = realpathSync.native(this.runsRoot);
    const directory = join(root, component(run.runId, "runId"));
    mkdirSync(directory); // create-if-absent
    try {
      atomicWrite(join(directory, "definition.json"), `${JSON.stringify(check.definition, null, 2)}\n`);
      atomicWrite(join(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  save(run: WorkflowRun): void {
    assertRunShape(run, run.runId);
    const directory = safeDirectory(this.runsRoot, [run.runId], false);
    const old = this.get(run.runId);
    if (old.runnerInstanceId !== run.runnerInstanceId || old.runnerPid !== run.runnerPid || old.workflowId !== run.workflowId ||
        old.agentId !== run.agentId || old.ownerSessionId !== run.ownerSessionId) throw new Error("运行记录归属不匹配");
    if (TERMINAL_STATES.has(old.status) && run.status !== old.status) throw new Error("终态运行不能被旧状态覆盖");
    if (run.currentAttempt < old.currentAttempt) throw new Error("运行轮次不能回退");
    atomicWrite(join(directory, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  }

  get(runId: string): WorkflowRun {
    const directory = safeDirectory(this.runsRoot, [component(runId, "runId")], false);
    const file = safeExistingFile(this.runsRoot, directory, join(directory, "run.json"));
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    assertRunShape(value, runId);
    return value;
  }

  getDefinition(runId: string): WorkflowDefinition {
    const run = this.get(runId);
    const directory = safeDirectory(this.runsRoot, [runId], false);
    const file = safeExistingFile(this.runsRoot, directory, join(directory, "definition.json"));
    const result = normalizeWorkflowDraft(JSON.parse(readFileSync(file, "utf8")) as unknown);
    if (!result.ok || !result.definition || result.definition.id !== run.workflowId) throw new Error("运行定义快照非法或不匹配");
    return result.definition;
  }

  list(options: WorkflowRunListOptions = {}): { runs: WorkflowRun[]; nextCursor?: string; diagnostics: string[] } {
    let ids: string[];
    try { ids = readdirSync(this.runsRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runs: [], diagnostics: [] }; throw error; }
    const runs: WorkflowRun[] = [];
    const diagnostics: string[] = [];
    for (const id of ids) {
      if (!SAFE_COMPONENT.test(id)) continue;
      try {
        const run = this.get(id);
        if (options.workspace && run.workspace !== options.workspace) continue;
        if (options.agentId && run.agentId !== options.agentId) continue;
        if (options.ownerSessionId && run.ownerSessionId !== options.ownerSessionId) continue;
        runs.push(run);
      } catch (error) { diagnostics.push(`${id}：${error instanceof Error ? error.message : String(error)}`); }
    }
    runs.sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId));
    // 游标不存在（记录已被 prune / 磁盘变更）→ 空页 + 诊断，绝不静默回到第一页。
    const cursorIndex = options.cursor ? runs.findIndex((run) => run.runId === options.cursor) : -1;
    if (options.cursor && cursorIndex < 0) {
      return {
        runs: [],
        diagnostics: [...diagnostics, `游标 ${options.cursor} 已失效（对应运行记录不存在或已被清理），请从第一页重新读取`]
      };
    }
    const start = cursorIndex + 1;
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const page = runs.slice(start, start + limit);
    return { runs: page, ...(start + limit < runs.length ? { nextCursor: page.at(-1)?.runId } : {}), diagnostics };
  }

  writeArtifact(runId: string, executionId: string, text: string): string {
    const run = this.get(runId);
    const execution = this.execution(run, executionId);
    if (Buffer.byteLength(text, "utf8") > MAX_WORKFLOW_ARTIFACT_BYTES) throw new Error(`节点产物超过 ${MAX_WORKFLOW_ARTIFACT_BYTES} 字节`);
    const directory = safeDirectory(this.runsRoot, [runId, "artifacts", `a${execution.attempt}`], true);
    const path = join(directory, `${component(execution.nodeId, "nodeId")}.txt`);
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("产物文件不能是符号链接");
    atomicWrite(path, text);
    return path;
  }

  readArtifact(runId: string, executionId: string): string {
    const run = this.get(runId);
    const execution = this.execution(run, executionId);
    const directory = safeDirectory(this.runsRoot, [runId, "artifacts", `a${execution.attempt}`], false);
    const expected = join(directory, `${component(execution.nodeId, "nodeId")}.txt`);
    if (execution.artifactPath && execution.artifactPath !== expected) throw new Error("产物路径与节点记录不匹配");
    const file = safeExistingFile(this.runsRoot, directory, expected);
    const bytes = readFileSync(file);
    if (bytes.byteLength > MAX_WORKFLOW_ARTIFACT_BYTES) throw new Error("节点产物超过读取上限");
    return bytes.toString("utf8");
  }

  /**
   * 读取节点会话记录：先核验 file 内的 session 头部，再按「可见消息序号」分页。
   * 响应按字节有界（单页 {@link MAX_TRANSCRIPT_PAGE_BYTES}、单条 {@link MAX_TRANSCRIPT_MESSAGE_BYTES}）：
   * 超大消息在响应里显式截断并附带标记块（原文件不动），游标照常指向下一条。
   */
  readTranscript(runId: string, executionId: string, cursor = 0, limit = 100): WorkflowTranscriptPage {
    const run = this.get(runId);
    const execution = this.execution(run, executionId);
    if (!execution.sessionFile || !execution.sessionFile.toLowerCase().endsWith(".jsonl")) throw new Error("节点尚无可读取的会话记录");
    if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error("记录游标必须是非负整数");
    const root = join(this.agentDir, "chatanytime-sessions", component(run.agentId, "agentId"), "delegations", "workflows");
    const directory = safeDirectory(root, [run.ownerSessionId, run.runId, `a${execution.attempt}`, execution.nodeId], false);
    const file = safeExistingFile(root, directory, execution.sessionFile);
    verifyTranscriptHeader(file, run, execution);

    const pageSize = Math.min(MAX_TRANSCRIPT_PAGE_SIZE, Math.max(1, Number.isSafeInteger(limit) ? limit : 100));
    const window = readTranscriptWindow(file, cursor, pageSize);
    const entries = window.messages.map((message) => ({ id: "", type: "message", message }) as PersistedSessionEntry);
    // 用全文件序号重算 id/uuid：分页时不同页的消息不会撞渲染键（与整篇归一化的全局序号一致）。
    const messages = transcriptMessagesFromEntries(entries).map((message, index) => {
      const raw = window.messages[index] as Parameters<typeof messageUuid>[0];
      const globalIndex = cursor + index;
      const uuid = messageUuid(raw, globalIndex);
      return { ...message, id: uuid, uuid };
    });

    const page: ChatMessage[] = [];
    let bytes = 0;
    let clipped = false;
    for (const message of messages) {
      const result = clipTranscriptMessage(message, MAX_TRANSCRIPT_MESSAGE_BYTES);
      clipped ||= result.clipped;
      const size = transcriptMessageBytes(result.message);
      // 至少放一条：否则 nextCursor 不前进，客户端会无限重试同一条超大消息。
      if (page.length > 0 && bytes + size > MAX_TRANSCRIPT_PAGE_BYTES) break;
      page.push(result.message);
      bytes += size;
      if (bytes >= MAX_TRANSCRIPT_PAGE_BYTES) break;
    }
    const hasMore = window.hasMore || page.length < messages.length;
    return {
      messages: page,
      ...(hasMore ? { nextCursor: String(cursor + page.length) } : {}),
      truncated: hasMore || clipped
    };
  }

  /** 启动对账只更新确认已退出的执行进程，活着或无法判断时不改终态。 */
  reconcile(): string[] {
    const diagnostics: string[] = [];
    for (const run of this.allRuns(diagnostics)) {
      if (!ACTIVE_STATES.has(run.status) || this.liveness(run.runnerPid) !== "dead") continue;
      try {
        this.save({ ...run, status: "interrupted", endedAt: this.now(), error: "运行进程已退出，工作流未能可靠结束" });
      } catch (error) { diagnostics.push(`${run.runId}：对账失败：${error instanceof Error ? error.message : String(error)}`); }
    }
    return diagnostics;
  }

  /**
   * 先清关联 JSONL，成功后再清派生产物/记录；失败保留 run.json 供追查。
   * 返回值是非致命的清理诊断（关联目录的 rmdir 失败）；致命失败仍抛错（索引保留）。
   */
  delete(runId: string): string[] {
    const run = this.get(runId);
    if (!TERMINAL_STATES.has(run.status)) throw new Error("活跃运行不能删除");
    const workflowRoot = join(this.agentDir, "chatanytime-sessions", component(run.agentId, "agentId"), "delegations", "workflows");
    for (const execution of run.executions) {
      if (!execution.sessionFile || !existsSync(execution.sessionFile)) continue;
      const directory = safeDirectory(workflowRoot, [run.ownerSessionId, run.runId, `a${execution.attempt}`, execution.nodeId], false);
      const file = safeExistingFile(workflowRoot, directory, execution.sessionFile);
      if (!file.toLowerCase().endsWith(".jsonl")) throw new Error("节点会话不是 JSONL 文件");
      unlinkSync(file);
    }
    const diagnostics = pruneEmptySessionDirectories(workflowRoot, run);
    const directory = safeDirectory(this.runsRoot, [runId], false);
    rmSync(directory, { recursive: true });
    return diagnostics;
  }

  prune(maxRetained = MAX_RETAINED_WORKFLOW_RUNS): string[] {
    const diagnostics: string[] = [];
    const terminal = this.allRuns(diagnostics).filter((run) => TERMINAL_STATES.has(run.status));
    terminal.sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId));
    for (const run of terminal.slice(Math.max(0, maxRetained))) {
      try { diagnostics.push(...this.delete(run.runId)); }
      catch (error) { diagnostics.push(`${run.runId}：清理失败：${error instanceof Error ? error.message : String(error)}`); }
    }
    return diagnostics;
  }

  private execution(run: WorkflowRun, executionId: string): WorkflowExecution {
    const execution = run.executions.find((candidate) => candidate.executionId === executionId);
    if (!execution) throw new Error("节点执行记录不存在");
    return execution;
  }

  private allRuns(diagnostics: string[]): WorkflowRun[] {
    const result: WorkflowRun[] = [];
    let cursor: string | undefined;
    do {
      const page = this.list({ cursor, limit: 200 });
      result.push(...page.runs);
      diagnostics.push(...page.diagnostics);
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  }
}
