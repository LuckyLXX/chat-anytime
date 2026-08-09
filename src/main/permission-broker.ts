import type {
  AccessMode,
  ExecutionPrincipal,
  PermissionDecision,
  PermissionRequest
} from "../shared/protocol.js";
import { permissionAction, permissionScope } from "./permissions.js";

export interface PermissionBrokerRequest {
  accessMode: AccessMode;
  toolName: string;
  summary: string;
  args: Record<string, unknown>;
  risk: PermissionRequest["risk"];
  principal: ExecutionPrincipal;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

export class PermissionBroker {
  private sequence = 0;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly sessionGrants = new Set<string>();

  constructor(
    private readonly emit: (request: PermissionRequest) => void,
    private readonly dismiss: (id: string) => void = () => undefined
  ) {}

  request(input: PermissionBrokerRequest): Promise<PermissionDecision> {
    const action = permissionAction(input.accessMode, input.toolName, input.risk);
    if (action === "allow") return Promise.resolve("allow-once");
    if (action === "deny") return Promise.resolve("deny");

    const grantKey = this.grantKey(input.principal.sessionId, input.toolName, input.risk);
    if (this.sessionGrants.has(grantKey)) return Promise.resolve("allow-session");

    const id = `permission-${++this.sequence}`;
    const request: PermissionRequest = {
      id,
      toolName: input.toolName,
      summary: input.summary,
      args: input.args,
      risk: input.risk,
      principal: input.principal
    };
    this.emit(request);

    return new Promise((resolve) => {
      this.pending.set(id, { request, resolve });
    });
  }

  resolve(id: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;

    this.pending.delete(id);
    this.dismiss(id);
    if (decision === "allow-session") {
      const { principal, toolName, risk } = pending.request;
      this.sessionGrants.add(this.grantKey(principal.sessionId, toolName, risk));
    }
    pending.resolve(decision);
    return true;
  }

  reset(sessionId?: string): void {
    for (const [id, pending] of this.pending) {
      if (sessionId && pending.request.principal.sessionId !== sessionId) continue;
      this.pending.delete(id);
      this.dismiss(id);
      pending.resolve("deny");
    }

    if (!sessionId) {
      this.sessionGrants.clear();
      return;
    }

    const prefix = `${sessionId}:`;
    for (const key of this.sessionGrants) {
      if (key.startsWith(prefix)) this.sessionGrants.delete(key);
    }
  }

  private grantKey(sessionId: string, toolName: string, risk: PermissionRequest["risk"]): string {
    return `${sessionId}:${permissionScope(toolName, risk)}`;
  }
}
