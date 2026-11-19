import type { ChatMessage } from "./protocol.js";
import type { WorkflowDefinition, WorkflowDiagnostic, WorkflowExecutionStatus, WorkflowResolvedNodeConfig, WorkflowRun, WorkflowRunStatus } from "./workflow.js";

export interface WorkflowSummary {
  id: string; name: string; description?: string; whenToUse?: string;
  nodeCount: number; updatedAt: number; runnable: boolean; issueCount: number;
}
export interface WorkflowRunSummary {
  runId: string; workflowId: string; workflowName: string; workspace: string; agentId: string; ownerSessionId: string;
  status: WorkflowRunStatus; currentAttempt: number; maxAttempts: number; currentNodeId?: string; currentNodeTitle?: string;
  nodeStates: Record<string, WorkflowExecutionStatus>; pendingPermissionIds: string[];
  startedAt: number; endedAt?: number; error?: string; external?: boolean;
}
export interface WorkflowRunsSnapshot { epoch: string; revision: number; runs: WorkflowRunSummary[] }

export type WorkflowCommand =
  | { type: "workflow.get"; requestId: string; workspace: string; workflowId: string }
  | { type: "workflow.save"; requestId: string; workspace: string; workflowId?: string; baseHash?: string; draft: WorkflowDefinition }
  | { type: "workflow.delete"; requestId: string; workspace: string; workflowId: string; baseHash: string }
  | { type: "workflow.run"; requestId: string; workspace: string; ownerSessionId: string; workflowId: string; input: string }
  | { type: "workflow.stop"; requestId: string; runId: string }
  | { type: "workflow.runs.list"; requestId: string; workspace: string; agentId?: string; ownerSessionId?: string; cursor?: string; limit?: number }
  | { type: "workflow.run.get"; requestId: string; runId: string }
  | { type: "workflow.node.get"; requestId: string; runId: string; executionId: string; content: "artifact" | "transcript"; cursor?: string; limit?: number }
  | { type: "workflow.sync"; requestId: string; workspace?: string };

type ResultPayload =
  | { op: "workflow.get" | "workflow.save"; result: { definition: WorkflowDefinition; baseHash: string; issues: WorkflowDiagnostic[]; resolvedNodes?: WorkflowResolvedNodeConfig[] } }
  | { op: "workflow.delete"; result: { workflowId: string } }
  | { op: "workflow.run"; result: { runId: string; status: WorkflowRunStatus } }
  | { op: "workflow.stop"; result: { runId: string; status: WorkflowRunStatus } }
  | { op: "workflow.runs.list"; result: { runs: WorkflowRunSummary[]; nextCursor?: string; diagnostics: string[] } }
  | { op: "workflow.run.get"; result: { run: WorkflowRun; definition: WorkflowDefinition } }
  | { op: "workflow.node.get"; result: { executionId: string; artifact?: string; messages?: ChatMessage[]; nextCursor?: string; truncated?: boolean } }
  | { op: "workflow.sync"; result: { workspace?: string; workflows: WorkflowSummary[]; diagnostics: string[] } };
export type WorkflowResult = ({ requestId: string; ok: true } & ResultPayload)
  | { requestId: string; op: WorkflowCommand["type"]; ok: false; code: string; errors: WorkflowDiagnostic[] };

export function summarizeWorkflowRun(run: WorkflowRun, pendingPermissionIds: string[] = [], external = false): WorkflowRunSummary {
  const current = run.executions.find((execution) => execution.executionId === run.currentExecutionId);
  const nodeStates: Record<string, WorkflowExecutionStatus> = {};
  for (const execution of run.executions) nodeStates[execution.nodeId] = execution.status;
  return { runId: run.runId, workflowId: run.workflowId, workflowName: run.workflowName, workspace: run.workspace,
    agentId: run.agentId, ownerSessionId: run.ownerSessionId, status: run.status, currentAttempt: run.currentAttempt, maxAttempts: run.maxAttempts,
    ...(current ? { currentNodeId: current.nodeId, currentNodeTitle: current.nodeTitle } : {}), nodeStates, pendingPermissionIds,
    startedAt: run.startedAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}), ...(run.error ? { error: run.error.slice(0, 400) } : {}), ...(external ? { external } : {}) };
}
