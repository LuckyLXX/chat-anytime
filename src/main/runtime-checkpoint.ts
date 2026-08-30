import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { appendCheckpoint, CHECKPOINT_FILE_LIMIT, checkpointPathFor, selectRollbackPlan, type CheckpointEntry } from "./checkpoint-store.js";
import { artifactCandidatesFromBashCommand, changedWorkspaceFile, writeWorkspaceFile } from "./workspace-preview.js";
import type { CheckpointRollbackResult, CheckpointRollbackTarget } from "../shared/protocol.js";

/**
 * 第五个 app-owned 内联扩展（pidesktop-checkpoint）：在 write/edit（及 bash
 * 显式输出路径）动手前把目标文件的「改之前」状态快照进会话级 JSONL。
 * Pi 的 agent-loop 会 await tool_execution_start 的全部 handler，因此这里的
 * 异步读盘完成后工具才开始执行——快照内容不存在竞态。快照是 best-effort：
 * 任何失败只 warn，绝不阻塞或破坏工具执行。
 */

export interface SnapshotTarget {
  relativePath: string;
  /** true（bash 候选）= 只快照已存在的文件，不存在则跳过（防误删用户文件）。 */
  requireExisting: boolean;
}

/** 从工具调用参数解析值得快照的目标；write/edit 精确一个，bash/powershell 取显式输出路径候选。 */
export function snapshotTargetsFor(workspace: string, toolName: string, args: unknown): SnapshotTarget[] {
  if (toolName === "write" || toolName === "edit") {
    const changed = changedWorkspaceFile(workspace, toolName, args);
    return changed ? [{ relativePath: changed.relativePath, requireExisting: false }] : [];
  }
  if ((toolName === "bash" || toolName === "powershell") && args && typeof args === "object") {
    const command = (args as Record<string, unknown>).command;
    if (typeof command !== "string") return [];
    return artifactCandidatesFromBashCommand(workspace, command)
      .map((relativePath) => ({ relativePath, requireExisting: true }));
  }
  return [];
}

export interface CheckpointExtensionDeps {
  workspace: () => string | undefined;
  sessionId: () => string;
  agentSessionRoot: () => string | undefined;
  enabled: () => boolean;
  warn: (message: string) => void;
}

/** 单个目标的快照：读「改之前」内容并追加；返回追加是否发生。 */
export async function snapshotTarget(deps: CheckpointExtensionDeps, ts: string, toolCallId: string, toolName: string, target: SnapshotTarget): Promise<boolean> {
  const workspace = deps.workspace();
  const root = deps.agentSessionRoot();
  if (!workspace || !root) return false;
  const absolutePath = resolve(workspace, ...target.relativePath.split("/"));
  let content: string | undefined;
  let existed = true;
  try {
    content = await readFile(absolutePath, "utf8");
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
    if (code === "ENOENT") {
      if (target.requireExisting) return false;
      existed = false;
    } else {
      deps.warn(`checkpoint 快照读取失败（${target.relativePath}）：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }
  const entry: CheckpointEntry = {
    ts,
    toolCallId,
    toolName,
    relativePath: target.relativePath,
    existed,
    ...(content !== undefined
      ? (Buffer.byteLength(content, "utf8") > CHECKPOINT_FILE_LIMIT ? { truncated: true } : { content })
      : {})
  };
  await appendCheckpoint({
    filePath: checkpointPathFor(root, deps.sessionId()),
    entry,
    warn: deps.warn
  });
  return true;
}

/**
 * 回滚单条回复内指定文件的改动：每文件取最早快照恢复；AI 新建的文件删除；
 * 超限未存内容的跳过并报告。恢复走 writeWorkspaceFile（realpath 越界校验），
 * 单项失败记 skipped 不中断整体。
 */
export async function rollbackPlan(workspace: string, targets: readonly CheckpointRollbackTarget[], entries: readonly CheckpointEntry[]): Promise<CheckpointRollbackResult[]> {
  const plan = selectRollbackPlan(entries, targets);
  const results: CheckpointRollbackResult[] = [];
  for (const item of plan) {
    try {
      if (!item.existed) {
        // AI 新建的文件：删除（已不存在时静默成功）。
        await rm(resolve(workspace, ...item.relativePath.split("/")), { force: true });
        results.push({ relativePath: item.relativePath, action: "deleted" });
        continue;
      }
      if (item.truncated || item.content === undefined) {
        results.push({ relativePath: item.relativePath, action: "skipped", detail: "文件超出快照大小上限，未保存原始内容" });
        continue;
      }
      await writeWorkspaceFile(workspace, item.relativePath, item.content);
      results.push({ relativePath: item.relativePath, action: "restored" });
    } catch (error: unknown) {
      results.push({ relativePath: item.relativePath, action: "skipped", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export function createCheckpointExtension(deps: CheckpointExtensionDeps): InlineExtension {
  return {
    name: "pidesktop-checkpoint",
    hidden: true,
    factory(pi) {
      pi.on("tool_execution_start", (event) => {
        if (!deps.enabled()) return;
        const workspace = deps.workspace();
        if (!workspace) return;
        const targets = snapshotTargetsFor(workspace, event.toolName, event.args);
        if (targets.length === 0) return;
        const ts = new Date().toISOString();
        // 并行快照各目标后整体落定；Pi 等待本 handler 完成才执行工具。
        return Promise.all(targets.map((target) => snapshotTarget(deps, ts, event.toolCallId, event.toolName, target)))
          .then(() => undefined);
      });
    }
  };
}
