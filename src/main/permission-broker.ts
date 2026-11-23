import type {
  AccessMode,
  ExecutionPrincipal,
  PermissionDecision,
  PermissionRequest
} from "../shared/protocol.js";
import { permissionActionWithCap, permissionScope } from "./permissions.js";

/** 一次权限请求是怎么收场的：mode = 访问模式直接放行/拦截；grant = 复用「本次会话允许」；user = 用户点击；timeout = 无人值守超时；cancel = 中止/停止时按身份取消。 */
export type PermissionSettleCause = "user" | "mode" | "grant" | "timeout" | "cancel";

export interface PermissionSettlement {
  /** 待决请求 id（团队按 id 精确摘除卡片登记；模式/授权直通时为空串）。 */
  id: string;
  decision: PermissionDecision;
  cause: PermissionSettleCause;
}

export interface PermissionBrokerRequest {
  accessMode: AccessMode;
  /** 可选权限上限（团队成员可用）；与 owner 模式分别计算动作后取更严格结果，每次请求实时取。 */
  accessModeCap?: AccessMode;
  toolName: string;
  summary: string;
  args: Record<string, unknown>;
  risk: PermissionRequest["risk"];
  principal: ExecutionPrincipal;
  /**
   * 自动拒绝的超时（毫秒；IM 会话与团队成员缺省 10 分钟）。
   *
   * 为什么放在 broker：无人值守的 IM 会话或等审批的团队成员没人盯着桌面弹窗，
   * 一个挂起的 Promise 会让整个回合永不 settle（工具永久占用、后续消息全部排队）。
   * 超时 → `deny`，与用户自己点「拒绝」同一条路径（幂等：先到先得）。
   */
  timeoutMs?: number;
  /** 卡片已发出的回调（团队运行时用它让等待中的 Lead 知道有成员在等审批）；参数是本次请求 id。 */
  onPending?: (id: string) => void;
  /** 请求收场时恰好回调一次（含 mode 直通与 grant 复用），说明裁决从哪来。 */
  onSettled?: (settlement: PermissionSettlement) => void;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  timer?: ReturnType<typeof setTimeout>;
  onSettled?: (settlement: PermissionSettlement) => void;
}

interface SessionGrant {
  sessionId: string;
  /** 团队成员的长期授权按成员隔离（成员子会话 id 不可复用）；主会话/同步子代理没有这一项。 */
  memberId?: string;
}

export class PermissionBroker {
  private sequence = 0;
  private readonly pending = new Map<string, PendingPermission>();
  private readonly sessionGrants = new Map<string, SessionGrant>();

  constructor(
    private readonly emit: (request: PermissionRequest) => void,
    private readonly dismiss: (id: string) => void = () => undefined
  ) {}

  request(input: PermissionBrokerRequest): Promise<PermissionDecision> {
    const action = permissionActionWithCap(input.accessMode, input.accessModeCap, input.toolName, input.risk);
    if (action === "allow") return this.settled(input, "allow-once", "mode");
    if (action === "deny") return this.settled(input, "deny", "mode");

    const grantKey = this.grantKey(input.principal, input.toolName, input.risk);
    if (this.sessionGrants.has(grantKey)) return this.settled(input, "allow-session", "grant");

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
      const pending: PendingPermission = { request, resolve, ...(input.onSettled ? { onSettled: input.onSettled } : {}) };
      const timeoutMs = input.timeoutMs;
      if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          // 走同一条 resolve 路径：清 pending、emit dismiss、终结 Promise，幂等。
          this.settle(pending, id, "deny", "timeout");
        }, timeoutMs);
        (pending.timer as unknown as { unref?: () => void }).unref?.();
      }
      this.pending.set(id, pending);
      // 登记之后再通知：回调里若立刻取消，pending 已在表里，不会漏掉。
      // id 必须交给调用方：团队把审批登记进 `pendingApprovals`，收场时只能按同一个
      // id 精确摘除（拿工具调用 id 去登记会留一张永远不清的卡）。
      input.onPending?.(id);
    });
  }

  resolve(id: string, decision: PermissionDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.settle(pending, id, decision, "user");
    if (decision === "allow-session") {
      const { principal, toolName, risk } = pending.request;
      this.sessionGrants.set(this.grantKey(principal, toolName, risk), {
        sessionId: principal.sessionId,
        ...(principal.team ? { memberId: principal.team.memberId } : {})
      });
    }
    return true;
  }

  reset(sessionId?: string): void {
    this.cancelPending(sessionId);

    if (!sessionId) {
      this.sessionGrants.clear();
      return;
    }

    for (const [key, grant] of this.sessionGrants) {
      if (grant.sessionId === sessionId) this.sessionGrants.delete(key);
    }
  }

  /**
   * 只取消挂起中的确认请求（按会话），保留 allow-session 授权。
   * 会话中止时用：阻塞在 broker Promise 上的工具必须收场，否则
   * session.abort() 只停模型流、工具永久挂起，运行永远不 settle。
   */
  cancelPending(sessionId?: string): void {
    this.cancelMatching((request) => sessionId === undefined || request.principal.sessionId === sessionId);
  }

  /**
   * Lead 会话中止时只收尾自身与同步子代理（delegate_agent）的请求；团队成员的
   * 请求归属 owner 会话但不跟随 Lead 的停止——它们由成员停止或「全部停止」控制。
   */
  cancelPendingNonTeam(sessionId: string): void {
    this.cancelMatching((request) => request.principal.sessionId === sessionId && !request.principal.team);
  }

  /** 停止某成员时只取消它的待决请求，并清掉它的会话授权（重新唤醒后需重新确认）。 */
  cancelTeamMember(memberId: string): void {
    this.cancelMatching((request) => request.principal.team?.memberId === memberId);
    for (const [key, grant] of this.sessionGrants) if (grant.memberId === memberId) this.sessionGrants.delete(key);
  }

  cancelMatching(matches: (request: PermissionRequest) => boolean): void {
    for (const [id, pending] of [...this.pending]) {
      if (!matches(pending.request)) continue;
      this.settle(pending, id, "deny", "cancel");
    }
  }

  private settle(pending: PendingPermission, id: string, decision: PermissionDecision, cause: PermissionSettleCause): void {
    if (!this.pending.delete(id)) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.dismiss(id);
    pending.onSettled?.({ id, decision, cause });
    pending.resolve(decision);
  }

  private settled(input: PermissionBrokerRequest, decision: PermissionDecision, cause: PermissionSettleCause): Promise<PermissionDecision> {
    // 模式直通 / 授权复用没有请求 id（从来没有挂起过），用空串表达「不针对某张卡」。
    input.onSettled?.({ id: "", decision, cause });
    return Promise.resolve(decision);
  }

  private grantKey(principal: ExecutionPrincipal, toolName: string, risk: PermissionRequest["risk"]): string {
    return JSON.stringify([principal.sessionId, principal.team?.memberId ?? null, permissionScope(toolName, risk)]);
  }
}
