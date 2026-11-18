/**
 * 前台会话打开的请求合并（2026-11-18 P0 冷开优化，第二批）。
 *
 * 为什么需要：`SessionManager.open` 是同步整文件解析（44 MB 会话几百毫秒），而
 * utility 的命令主体是**串行队列**。快速连点 A→B→C 时队列会把三次冷恢复全做完
 * ——用户只想看 C，前两次解析纯属浪费，还把事件循环按住不放。这里只登记
 * 「序号 + 批次 + 是否被取代 + 是否在跑」，不保存消息正文、不进 desktop protocol、
 * 不新增取消消息。
 *
 * 合并规则刻意保守（宁可多解析一次，也不破坏一次真实操作）：
 *
 * 1. 只有**普通前台** `session.open` 之间可以互相取代。`activate:false`（分屏
 *    背景格）、自动化 / IM 内部恢复、递归 `handleCommand` 的恢复都不参与。
 * 2. 新请求必须在**消息入口**登记（不能等到执行时）——否则一个正在等待/执行的
 *    旧恢复无从得知用户已经切走。
 * 3. **任何其他入队命令都是屏障**：`open A → prompt → open B` 里 B 不能越过 A，
 *    A 必须完成并收到消息；`session.new`、切助手、切工作区、删除、watch 同理。
 *    屏障只关闭「当前连续批次」，不影响已经在跑的请求有序完成。
 * 4. 目标会话已在分屏（`session.watch` 登记过）、或身份无法确认时，**保守执行**，
 *    绝不淘汰。分屏入口必须先发 watch 再发 open（见 App.tsx），否则这里只能按
 *    「身份不明」处理。
 * 5. 同一目标的重复打开不淘汰旧的：两者的结果等价（第二个会走 live 快路径），
 *    淘汰只会多一次激活竞态。
 *
 * 「被取代」的语义只有两种落点：还没开始就跳过；已经开始则在下一次阶段边界
 * 退出（阶段边界由 pi-runtime 的 `session.open` 显式检查）。**不承诺中断正在
 * 执行的同步 `SessionManager.open`**。
 */

/** 登记一次前台打开的输入。 */
export interface SessionOpenIntentInput {
  /** 归一化路径键（调用方用 resolve + 正斜杠 + 小写；本模块不做 fs 访问）。 */
  pathKey: string;
  /**
   * 目标会话 id（能从 live 记录或侧栏摘要解析出来时给出）。缺省视为身份不明，
   * 这种请求不会被更晚的打开淘汰。
   */
  sessionId?: string;
  /**
   * 是否参与「前台请求淘汰」。缺省 true；`activate:false` 与内部恢复传 false。
   * 不参与淘汰的请求同时充当批次屏障（它必须按原顺序执行）。
   */
  supersedable?: boolean;
}

/** 交给命令执行体（`session.open` 分支）的票根。 */
export interface SessionOpenIntentTicket {
  readonly seq: number;
  /** 已被更晚的前台打开取代：未开始就跳过，已开始就在下一个阶段边界退出。 */
  isSuperseded(): boolean;
}

interface IntentRecord {
  seq: number;
  pathKey: string;
  sessionId?: string;
  batch: number;
  supersedable: boolean;
  superseded: boolean;
  running: boolean;
}

/** 票根只持协调器与序号：状态永远从登记表现读（不会拿到过期副本）。 */
class Ticket implements SessionOpenIntentTicket {
  constructor(private readonly owner: SessionOpenCoordinator, readonly seq: number) {}

  isSuperseded(): boolean {
    return this.owner.isSuperseded(this.seq);
  }
}

export class SessionOpenCoordinator {
  private sequence = 0;
  private batch = 0;
  private readonly intents = new Map<number, IntentRecord>();
  /** 已被渲染端登记为分屏格子的会话（session.watch）：它们的加载不得被跳过。 */
  private readonly protectedSessions = new Set<string>();

  /**
   * 登记一次前台打开。返回票根；调用方负责在命令结束时 `finish(ticket.seq)`。
   */
  register(input: SessionOpenIntentInput): SessionOpenIntentTicket {
    const supersedable = input.supersedable !== false;
    // 不参与淘汰的请求本身就是屏障：它之前/之后的普通打开不跨过它合并。
    if (!supersedable) this.batch += 1;
    const record: IntentRecord = {
      seq: ++this.sequence,
      // 调用方给的是展示路径（大小写/分隔符随平台），这里统一归一再比较。
      pathKey: sessionOpenPathKey(input.pathKey),
      ...(input.sessionId ? { sessionId: input.sessionId.toLowerCase() } : {}),
      batch: this.batch,
      supersedable,
      superseded: false,
      running: false
    };
    if (supersedable) {
      for (const intent of this.intents.values()) {
        if (!intent.supersedable || intent.superseded) continue;
        if (intent.batch !== record.batch) continue;
        // 同一目标：保留（结果等价）。
        if (intent.pathKey === record.pathKey) continue;
        // 分屏 / 身份不明：保留（保守执行）。
        if (this.isProtected(intent)) continue;
        intent.superseded = true;
      }
    }
    this.intents.set(record.seq, record);
    return new Ticket(this, record.seq);
  }

  /**
   * 任何其他**入队**命令到达（消息入口调用）：关闭当前连续批次。
   * RPC 结果与停止旁路（browser/ssh/design/cancel-new/abort/killExecution）
   * 不算屏障——它们不占串行队列，也不改变用户的操作顺序。
   */
  barrier(): void {
    this.batch += 1;
  }

  /** 渲染端登记了分屏格子（session.watch watch:true，含 hidden）：受保护。 */
  protectSession(sessionId: string): void {
    if (sessionId) this.protectedSessions.add(sessionId.toLowerCase());
  }

  /** 格子关闭（session.watch watch:false）：解除保护。 */
  unprotectSession(sessionId: string): void {
    if (sessionId) this.protectedSessions.delete(sessionId.toLowerCase());
  }

  /** 开始执行：已经过期就直接返回 false（调用方跳过整条命令）。 */
  begin(seq: number): boolean {
    const intent = this.intents.get(seq);
    if (!intent) return true; // 未知票根：保守执行。
    intent.running = true;
    return !intent.superseded;
  }

  /** 阶段边界检查（不含「是否已开始」的语义，纯查询）。 */
  isSuperseded(seq: number): boolean {
    return this.intents.get(seq)?.superseded === true;
  }

  /** 命令结束（成功/失败/跳过都要调用）：释放登记，避免无界增长。 */
  finish(seq: number): void {
    this.intents.delete(seq);
  }

  /** 未结束的登记数（测试与泄漏断言用）。 */
  pending(): number {
    return this.intents.size;
  }

  /** 受保护会话数（测试用）。 */
  protectedCount(): number {
    return this.protectedSessions.size;
  }

  private isProtected(intent: IntentRecord): boolean {
    // 身份不明 = 无法证明它不受保护 → 保守执行。
    if (!intent.sessionId) return true;
    return this.protectedSessions.has(intent.sessionId);
  }
}

export function sessionOpenPathKey(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}
