import { resolve } from "node:path";
import type { WorkflowRunValidationContext } from "../shared/workflow.js";
import { WorkflowStore, type SaveWorkflowOptions, type StoredWorkflow, type WorkflowCatalog } from "./workflow-store.js";

/** 按工作区缓存轻目录；角色/模型变化用校验上下文指纹区分，避免跨角色误判可运行状态。 */
export class WorkflowCatalogCache {
  private readonly entries = new Map<string, { loadedAt: number; fingerprint: string; catalog: WorkflowCatalog }>();

  constructor(
    private readonly store: WorkflowStore,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5_000
  ) {}

  list(workspace: string, context: WorkflowRunValidationContext = {}): WorkflowCatalog {
    const key = this.key(workspace);
    const fingerprint = JSON.stringify({
      subagents: context.subagents?.map((item) => [item.id, item.name]),
      models: context.availableModels?.map((item) => [item.provider, item.id]),
      tools: context.sourceTools,
      access: context.ownerAccessMode
    });
    const cached = this.entries.get(key);
    const now = this.now();
    if (cached && cached.fingerprint === fingerprint && now - cached.loadedAt < this.ttlMs) return cached.catalog;
    const catalog = this.store.list(workspace, context);
    this.entries.set(key, { loadedAt: now, fingerprint, catalog });
    return catalog;
  }

  save(workspace: string, draft: unknown, options: SaveWorkflowOptions = {}): StoredWorkflow {
    const saved = this.store.save(workspace, draft, options);
    this.invalidate(workspace);
    return saved;
  }

  delete(workspace: string, workflowId: string, baseHash: string): void {
    this.store.delete(workspace, workflowId, baseHash);
    this.invalidate(workspace);
  }

  invalidate(workspace?: string): void {
    if (workspace === undefined) this.entries.clear();
    else this.entries.delete(this.key(workspace));
  }

  private key(workspace: string): string {
    const resolved = resolve(workspace);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }
}
