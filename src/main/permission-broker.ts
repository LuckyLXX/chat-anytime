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
  /**
   * 自动拒绝的超时（毫秒；IM 会话缺省 10 分钟）。
   *
   * 为什么放在 broker：无人值守的 IM 会话里没人盯着桌面弹窗，一个挂起的
   * Promise 会让整个回合永不 settle（工具永久占用、后续消息全部排队）。
   * 超时 → `deny`，与用户自己点「拒绝」同一条路径（幂等：先到先得）。
   */
  timeoutMs?: number;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  timer?: ReturnType<typeof setTimeout>;
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
      const pending: PendingPermission = { request, resolve };
      const timeoutMs = input.timeoutMs;
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          // 走同一条 resolve 路径：清 pending、emit dismiss、终结 Promise，幂等。
          this.resolve(id, "deny");
        }, timeoutMs);
        (pending.timer as unknown as { unref?: () => void }).unref?.();
      }
      this.pending.set(id, pending);
    });
  }

  resolve(id: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;

    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    this.dismiss(id);
    if (decision === "allow-session") {
      const { principal, toolName, risk } = pending.request;
      this.sessionGrants.add(this.grantKey(principal.sessionId, toolName, risk));
    }
    pending.resolve(decision);
    return true;
  }

  reset(sessionId?: string): void {
    this.cancelPending(sessionId);

    if (!sessionId) {
      this.sessionGrants.clear();
      return;
    }

    const prefix = `${sessionId}:`;
    for (const key of this.sessionGrants) {
      if (key.startsWith(prefix)) this.sessionGrants.delete(key);
    }
  }

  /**
   * 只取消挂起中的确认请求（按会话），保留 allow-session 授权。
   * 会话中止时用：阻塞在 broker Promise 上的工具必须收场，否则
   * session.abort() 只停模型流、工具永久挂起，运行永远不 settle。
   */
  cancelPending(sessionId?: string): void {
    for (const [id, pending] of this.pending) {
      if (sessionId && pending.request.principal.sessionId !== sessionId) continue;
      this.pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      this.dismiss(id);
      pending.resolve("deny");
    }
  }

  private grantKey(sessionId: string, toolName: string, risk: PermissionRequest["risk"]): string {
    return `${sessionId}:${permissionScope(toolName, risk)}`;
  }
}
