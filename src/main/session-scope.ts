import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "../shared/protocol.js";

export function workspaceHash(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 20);
}

export function agentWorkspaceSessionDir(agentRoot: string, agentId: string, workspace: string): string {
  return join(agentRoot, "chatanytime-sessions", agentId, workspaceHash(workspace));
}

export function resolveNewSessionDefaults<TModel>(hasExistingMessages: boolean, agentModel: TModel | undefined, globalModel: TModel | undefined, agentThinking: ThinkingLevel, globalThinking: ThinkingLevel): { model: TModel | undefined; thinkingLevel: ThinkingLevel | undefined } {
  if (hasExistingMessages) return { model: undefined, thinkingLevel: undefined };
  return { model: agentModel ?? globalModel, thinkingLevel: agentThinking ?? globalThinking };
}
