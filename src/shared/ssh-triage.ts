/**
 * SSH 后台排障（triage）的共享协议：类型、枚举、标签与纯函数。
 *
 * 设计口径（对应计划 docs/plans/2026-11-25-PiDesktop-SSH-后台排障、断线记录与主机卡片.md）：
 * - **采集失败与业务结论分开表达**：`status` 里 `error` = 没采到（连不上、认证、指纹、
 *   工具缺失、权限、超时、断线），`failed` / `warning` = 采到了但业务上不达标（服务没起、
 *   端口没监听、磁盘超阈值、日志里有错误）。两者绝不合并成一个「失败」——否则「日志读到
 *   错误」会被误标成 SSH 故障，用户会去重连一台其实好好的机器。
 * - **只读**：首版只做四种固定检查（systemd 服务、预期监听端口、文件系统用量、近期错误
 *   日志），命令构造、参数校验、结果解释全在主进程，渲染端只提交窄类型化参数。
 * - **有界**：每项检查的输出有字符上限（只保留尾部），批次与日志按最近 40 批 + 总量上限
 *   裁剪；活动任务不裁。渲染端拿到的 payload 也有界（只有选中的主机带日志正文）。
 * - **快照**：批次创建时记录主机展示名与连线身份（host/port/username），排队期间主机被
 *   编辑也不会连到新地址——实际调度前再校验一次端点。
 */

/** 单批最多主机数（主机库可能很大，一次全查既慢又难读）。 */
export const SSH_TRIAGE_MAX_HOSTS = 20;
/** 全局同时运行的主机数上限（一台内按检查项顺序执行）。 */
export const SSH_TRIAGE_HOST_CONCURRENCY = 3;
/** 每项检查的输出保留上限（字符，保留尾部）。 */
export const SSH_TRIAGE_LOG_LIMIT_CHARS = 8_000;
/** 历史批次保留上限（活动批次不裁）。 */
export const SSH_TRIAGE_KEEP_BATCHES = 40;
/** 排查记录目录总量上限（字节）；超出后从最旧的已结束批次开始裁。 */
export const SSH_TRIAGE_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** 单批标题长度上限。 */
export const SSH_TRIAGE_TITLE_LIMIT = 80;
/** 单次检查（一条远端命令）的时间上限。 */
export const SSH_TRIAGE_CHECK_TIMEOUT_MS = 20_000;

/** 首版支持的只读检查项。 */
export type SshTriageCheckKind = "service" | "port" | "disk" | "journal";

export const SSH_TRIAGE_CHECK_KINDS: readonly SshTriageCheckKind[] = ["service", "port", "disk", "journal"];

export const SSH_TRIAGE_CHECK_KIND_LABELS: Record<SshTriageCheckKind, string> = {
  service: "服务状态",
  port: "预期端口监听",
  disk: "磁盘用量",
  journal: "近期错误日志"
};

/**
 * 检查项参数（窄类型化）。
 *
 * 参数只能表达「查哪一类、查什么」，不能带任意 shell 片段：命令由主进程拼装，
 * unit / path 都会做字符白名单校验后再单引号转义。
 */
export type SshTriageCheckRequest =
  /** systemd 单元状态（ActiveState / SubState / UnitFileState）。 */
  | { kind: "service"; unit: string }
  /** 预期监听端口（缺省 tcp；-ltn / -lun 列举，按端口匹配本地地址）。 */
  | { kind: "port"; port: number; protocol?: "tcp" | "udp" }
  /** 文件系统用量（远端绝对路径）；warn/fail 缺省 85 / 95 百分比。 */
  | { kind: "disk"; path: string; warnPercent?: number; failPercent?: number }
  /** journal 近期错误级日志；unit 缺省 = 全系统，minutes 缺省 15（1–1440）。 */
  | { kind: "journal"; unit?: string; minutes?: number };

/** 采集层失败原因（与业务判定无关）：决定 UI 该提示「重连/信任指纹」还是「换个参数重查」。 */
export type SshTriageFailure =
  | "host-missing"
  | "endpoint-changed"
  | "credentials-missing"
  | "fingerprint-unknown"
  | "fingerprint-mismatch"
  | "auth-failed"
  | "connect-failed"
  | "timeout"
  | "disconnected"
  | "channel-failed"
  | "tool-missing"
  | "permission"
  | "stopped"
  | "unknown";

export const SSH_TRIAGE_FAILURE_LABELS: Record<SshTriageFailure, string> = {
  "host-missing": "主机已删除",
  "endpoint-changed": "端点已变更",
  "credentials-missing": "缺少凭据",
  "fingerprint-unknown": "指纹未信任",
  "fingerprint-mismatch": "指纹不一致",
  "auth-failed": "认证被拒",
  "connect-failed": "连接失败",
  timeout: "超时",
  disconnected: "连接中断",
  "channel-failed": "通道失败",
  "tool-missing": "远端缺少工具",
  permission: "权限不足",
  stopped: "已停止",
  unknown: "未知原因"
};

/**
 * 单项检查状态。
 *
 * - `pending` / `running`：还没跑 / 正在跑（渲染端显示进展）。
 * - `pass` / `warning` / `fail`：**采集成功**的三档业务结论。
 * - `error`：采集失败（`failure` 给出层因）。
 * - `skipped`：本次没执行（批次被停止 / 主机已中断 / 连接先失败）。
 */
export type SshTriageCheckStatus = "pending" | "running" | "pass" | "warning" | "fail" | "error" | "skipped";

export const SSH_TRIAGE_CHECK_STATUS_LABELS: Record<SshTriageCheckStatus, string> = {
  pending: "待执行",
  running: "采集中",
  pass: "通过",
  warning: "注意",
  fail: "异常",
  error: "采集失败",
  skipped: "未执行"
};

export interface SshTriageCheckResult {
  kind: SshTriageCheckKind;
  /** 参数摘要（主进程生成：`test-api.service`、`:8080/tcp`、`/srv 用量`、`最近 15 分钟错误`）。 */
  label: string;
  status: SshTriageCheckStatus;
  /** 采集层失败原因；`status === "error"` 时必有。 */
  failure?: SshTriageFailure;
  /** 远端退出码（连接/通道层失败时为 null）。 */
  exitCode: number | null;
  /** 人读的原因/结论摘要（工具缺失、权限不足、服务 failed、端口未监听……）。 */
  reason?: string;
  durationMs?: number;
  /** 输出总字符数（即使被截断也如实给出原长度）。 */
  outputChars: number;
  /** 输出被截断（只保留尾部 SSH_TRIAGE_LOG_LIMIT_CHARS 字符）。 */
  truncated?: boolean;
  /**
   * 采集输出（有界纯文本，证据）。**只有 `triage.detail` 里被选中的主机才带正文**，
   * 其余主机只给 outputChars，避免一次详情把几 MB 文本塞进 IPC。
   */
  output?: string;
}

/** 单台主机在本次批次里的结局。 */
export type SshTriageHostStatus =
  | "queued"
  | "running"
  /** 全部检查采集成功且都通过。 */
  | "passed"
  /** 采集成功、只有提醒级结论（磁盘超预警、服务在切换中）。 */
  | "warning"
  /** 采集成功，但至少一项业务异常（服务未起 / 端口未监听 / 日志有错误 / 磁盘超阈值）。 */
  | "failed"
  /** 采集失败（连不上、认证/指纹、工具缺失、权限、超时、断线）。 */
  | "error"
  /** 用户停止。 */
  | "stopped"
  /** 应用退出或链路线中断。 */
  | "interrupted"
  /** 批次被停止时还在排队，从未执行。 */
  | "not-run";

export const SSH_TRIAGE_HOST_STATUS_LABELS: Record<SshTriageHostStatus, string> = {
  queued: "排队中",
  running: "采集中",
  passed: "检查通过",
  warning: "需要留意",
  failed: "检查异常",
  error: "采集失败",
  stopped: "已停止",
  interrupted: "采集中断",
  "not-run": "未执行"
};

/** 批次创建时记录的主机身份快照（排队期间主机被编辑也不连新地址）。 */
export interface SshTriageHostSnapshot {
  hostId: string;
  displayName: string;
  host: string;
  port: number;
  username: string;
}

/**
 * 端点标识 `username@host:port`。
 *
 * 三种用途同一口径：调度前的快照比对（防误连编辑后的地址）、主机卡片归属键、
 * 历史批次的展示。host 统一小写（主机名不区分大小写）。
 */
export function sshEndpointKey(input: { username: string; host: string; port: number }): string {
  return `${input.username.trim()}@${input.host.trim().toLowerCase()}:${Math.round(input.port)}`;
}

/** 批次列表里的单台主机行（不带检查明细，保持列表 payload 有界）。 */
export interface SshTriageHostSummaryRow {
  hostId: string;
  displayName: string;
  /** `username@host:port`（创建时快照）。 */
  endpoint: string;
  status: SshTriageHostStatus;
  reason?: string;
  startedAt?: number;
  endedAt?: number;
  /** 已完成/总数（进度显示）。 */
  checksDone: number;
  checksTotal: number;
}

/** 批次详情里的单台主机（含逐项检查）。 */
export interface SshTriageHostDetail extends SshTriageHostSummaryRow {
  checks: SshTriageCheckResult[];
  /** 主机库里的当前身份；主机已删除时缺省。 */
  current?: { name: string; endpoint: string };
  /** 主机仍在，但端点（用户名/地址/端口）已与快照不一致：终端入口要用户先确认。 */
  endpointChanged?: boolean;
  /** 主机已从库里删除（历史快照保留，终端入口不可用）。 */
  hostMissing?: boolean;
}

export type SshTriageBatchStatus =
  /** 还有排队/执行中的主机。 */
  | "running"
  /** 全部主机都有了终态。 */
  | "finished"
  /** 用户停止（排队项未执行、在途项中断）。 */
  | "stopped"
  /** 应用退出留下的遗留批次（下次启动归档）。 */
  | "interrupted";

export const SSH_TRIAGE_BATCH_STATUS_LABELS: Record<SshTriageBatchStatus, string> = {
  running: "进行中",
  finished: "已结束",
  stopped: "已停止",
  interrupted: "已中断"
};

/** 批次列表项（`triage.list` / `triage.start` 的返回）。 */
export interface SshTriageBatchSummary {
  id: string;
  title: string;
  status: SshTriageBatchStatus;
  createdAt: number;
  endedAt?: number;
  /** 检查项参数（复查时原样带回）。 */
  checks: SshTriageCheckRequest[];
  /** 检查项人读摘要（与参数一一对应，主进程生成）。 */
  checkLabels: string[];
  hosts: SshTriageHostSummaryRow[];
  /** 本次由哪一批发起的复查（显式关联）。 */
  sourceBatchId?: string;
  /** 采集记录写入失败时的提示（连接本身照常清理）。 */
  storeError?: string;
}

/** 批次详情（`triage.detail`）。 */
export interface SshTriageBatchDetail {
  summary: SshTriageBatchSummary;
  hosts: SshTriageHostDetail[];
  /** 本次带回了日志正文的主机（其余主机只有 outputChars）。 */
  logHostId?: string;
}

// ——— 主机卡片（常用远端目录 + 可编辑的排查摘要） ———

/** 判定：目录名与远端绝对路径。 */
export interface SshTriageCardDirectory {
  id: string;
  label: string;
  /** 远端绝对路径（以 `/` 开头）。 */
  path: string;
}

/** 一条排查摘要：问题标题 + 现象/原因/处理（由用户编辑确认后保存）。 */
export interface SshTriageCardSummary {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  /** 来自哪一批次（可选关联）。 */
  batchId?: string;
  /** 关联批次里的哪台主机。 */
  hostId?: string;
}

/**
 * 一张主机卡片。按 `(hostId, endpoint)` 归属：主机端点变了就是另一张卡，
 * 旧卡留在文件里等用户确认「转用」（见 `triage.card.adopt`）。
 */
export interface SshTriageCard {
  hostId: string;
  endpoint: string;
  /** 乐观并发版本：保存时带上读到的 revision，不一致即冲突（绝不静默覆盖）。 */
  revision: number;
  updatedAt: number;
  directories: SshTriageCardDirectory[];
  summaries: SshTriageCardSummary[];
}

/** 卡片读取/保存的视图：当前卡 + 同一主机旧端点留下的资料。 */
export interface SshTriageCardView {
  card: SshTriageCard;
  /** 主机库里的当前身份（主机改名后卡片仍可读；已删除时缺省）。 */
  host?: { name: string; host: string; port: number; username: string };
  /** 同一 `hostId` 在旧端点下的卡片（需用户确认接续到当前端点）。 */
  stale?: SshTriageCard;
}

export const SSH_TRIAGE_CARD_LIMITS = {
  /** 单卡常用目录条数上限。 */
  directories: 20,
  /** 单卡排查摘要条数上限（超出淘汰最旧）。 */
  summaries: 50,
  /** 摘要标题长度上限。 */
  titleChars: 100,
  /** 摘要正文长度上限。 */
  bodyChars: 1_200,
  /** 目录名长度上限。 */
  directoryLabelChars: 40,
  /** 卡片文件里最多保留多少张（按更新时间淘汰最旧）。 */
  cards: 200
} as const;

/**
 * 主机卡片视图的读取/保存结果形状在 protocol.ts 的 SshCommand / SshCommandResult 里，
 * 这里只放不依赖 IPC 的数据类型与纯函数。
 */

/** 排查命令（渲染端 → 主进程，走现有 `ssh:command` IPC；前缀 `triage.*`）。 */
export type SshTriageCommand =
  /**
   * 建立排查批次并立即返回（后台调度，不抢焦点）。`hostIds` 单批上限
   * SSH_TRIAGE_MAX_HOSTS，按 hostId 去重；`sourceBatchId` 标记复查来源。
   */
  | { type: "triage.start"; hostIds: string[]; title?: string; checks: SshTriageCheckRequest[]; sourceBatchId?: string }
  /** 最近批次列表（新→旧，已按保留上限裁剪）。 */
  | { type: "triage.list" }
  /** 批次详情；`hostId` 给定时该主机的检查输出带正文（其余主机只有 outputChars）。 */
  | { type: "triage.detail"; batchId: string; hostId?: string }
  /** 停止批次：排队项转未执行，在途项立即收尾（保留已采部分输出）。 */
  | { type: "triage.stop"; batchId: string }
  /** 读取主机卡片（主机端点变过时 view.stale 带旧端点资料，等用户确认转用）。 */
  | { type: "triage.card.get"; hostId: string }
  /**
   * 保存整张卡（目录 + 摘要，全量替换）。`revision` 是乐观并发版本：与库里不一致时
   * 返回 `triage-card-conflict`（带最新 view），绝不静默覆盖另一个窗口刚存的内容。
   */
  | { type: "triage.card.save"; hostId: string; endpoint: string; revision: number; directories: SshTriageCardDirectory[]; summaries: SshTriageCardSummary[] }
  /** 端点变化确认：accept=true 把旧端点资料接续到当前端点，false = 不转用（不再提示）。 */
  | { type: "triage.card.adopt"; hostId: string; fromEndpoint: string; accept: boolean };

/** 排查命令的结果（主进程 → 渲染端；验证失败一律 throw，冲突用 conflict 结果表达）。 */
export type SshTriageCommandResult =
  | { kind: "triage-batch"; batch: SshTriageBatchSummary }
  | { kind: "triage-batches"; batches: SshTriageBatchSummary[] }
  | { kind: "triage-detail"; detail: SshTriageBatchDetail }
  | { kind: "triage-card"; view: SshTriageCardView }
  /** 卡片已保存（返回写入后的新 revision）。 */
  | { kind: "triage-card-saved"; view: SshTriageCardView }
  /** 保存冲突：revision 已落后或主机端点已变（`view` 是最新内容，渲染端提示刷新/合并）。 */
  | { kind: "triage-card-conflict"; view: SshTriageCardView; message: string };

/** 检查项参数摘要（主进程与渲染端共用同一口径，界面与回执不会漂移）。 */
export function describeSshTriageCheck(request: SshTriageCheckRequest): string {
  switch (request.kind) {
    case "service":
      return request.unit;
    case "port":
      return `:${request.port}/${request.protocol ?? "tcp"}`;
    case "disk":
      return `${request.path} 用量`;
    case "journal": {
      const minutes = request.minutes ?? 15;
      return request.unit ? `${request.unit} 最近 ${minutes} 分钟错误` : `全系统最近 ${minutes} 分钟错误`;
    }
  }
}

/**
 * 检查项是否合法（主进程做严格校验，渲染端也可先粗筛）。
 * 返回中文错误消息或 undefined。
 */
export function validateSshTriageCheck(request: unknown): string | undefined {
  if (!request || typeof request !== "object") return "检查项无效";
  const check = request as Record<string, unknown>;
  switch (check.kind) {
    case "service": {
      const unit = typeof check.unit === "string" ? check.unit.trim() : "";
      if (!unit) return "服务名不能为空";
      if (!/^[A-Za-z0-9@_.:][A-Za-z0-9@_.:-]{0,159}$/.test(unit)) return `服务名含非法字符：${unit}`;
      return undefined;
    }
    case "port": {
      const port = typeof check.port === "number" ? Math.round(check.port) : Number.NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) return "端口必须在 1–65535 之间";
      if (check.protocol !== undefined && check.protocol !== "tcp" && check.protocol !== "udp") return "协议只能是 tcp 或 udp";
      return undefined;
    }
    case "disk": {
      const path = typeof check.path === "string" ? check.path.trim() : "";
      if (path.length > 512 || !path.startsWith("/")) return "磁盘检查的路径必须是远端绝对路径";
      if (/[\u0000\n\r]/.test(path)) return "磁盘检查的路径含非法字符";
      for (const key of ["warnPercent", "failPercent"] as const) {
        const value = check[key];
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 100) return "百分比阈值必须在 1–100 之间";
      }
      if (typeof check.warnPercent === "number" && typeof check.failPercent === "number" && check.warnPercent > check.failPercent) {
        return "预警阈值不能大于失败阈值";
      }
      return undefined;
    }
    case "journal": {
      if (check.unit !== undefined) {
        const unit = typeof check.unit === "string" ? check.unit.trim() : "";
        if (!unit) return "日志检查的服务名不能为空";
        if (!/^[A-Za-z0-9@_.:][A-Za-z0-9@_.:-]{0,159}$/.test(unit)) return `服务名含非法字符：${unit}`;
      }
      if (check.minutes !== undefined) {
        const minutes = typeof check.minutes === "number" ? Math.round(check.minutes) : Number.NaN;
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return "时间窗口必须在 1–1440 分钟之间";
      }
      return undefined;
    }
    default:
      return "未知的检查项类型";
  }
}
