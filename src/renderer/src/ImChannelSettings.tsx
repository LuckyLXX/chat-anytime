import { ChevronDown, MessageSquare, PlugZap, Save, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AccessMode, ImChannelConfig } from "../../shared/protocol";
import { normalizeImAllowFrom } from "../../shared/im";
import { ImCustomChannelSettings, customChannelStatus } from "./ImCustomChannelSettings";
import { useDesktopStore } from "./store";

/**
 * 设置页「消息通道」tab（2026-11-12，飞书长连接 P1；2026-11-13 改两段式布局）。
 *
 * 布局对齐「Agent 角色」页：左栏是通道列表（官方通道 · 飞书 + 自定义通道 + 新建），
 * 右栏是选中通道的详情/编辑器。页面头只留总闸开关——它是两类通道共用的总开关。
 * 之前四张卡片竖排时，飞书的长表单把自定义通道挤到很下面，接内网脚本时要来回滚；
 * 两段式之后切换通道不再滚动，保存条也留在详情顶部。
 *
 * 分工（没变）：**主进程独占**配置与密钥（settings.im + credentials.json），渲染端只发
 * 命令、读推送——明文 App Secret / 接入 Token 永不进 settings.json，也不在渲染端持久化。
 *
 * 主题钩子：`data-pane="im-channel-settings"`；控件 `im-channel-enable`、
 * `im-feishu-enabled|-appid|-secret|-allowfrom|-access|-workspace|-save|-test`、
 * `im-custom-add|-enabled|-save|-delete`；样式前缀 `.im-channel-*` / `.im-custom-*`。
 */

const FEISHU_CHANNEL_ID = "feishu";

const ACCESS_MODE_OPTIONS: { value: AccessMode; label: string }[] = [
  { value: "read-only", label: "只读（不能改文件）" },
  { value: "workspace", label: "工作区（推荐：写工作区自动放行）" },
  { value: "ask", label: "每次询问" },
  { value: "full", label: "完全访问（谨慎）" }
];

const DEFAULT_APPROVAL_MINUTES = 10;

/** 白名单解析：逗号/分号/换行/空格分隔，去重去空。 */
export function parseAllowFromInput(text: string): string[] {
  return normalizeImAllowFrom(text.split(/[\s,;，；]+/u));
}

interface DraftState {
  enabled: boolean;
  appId: string;
  allowFrom: string;
  accessMode: AccessMode;
  workspace: string;
  approvalMinutes: string;
  ack: boolean;
}

function draftFromChannel(channel: ImChannelConfig | undefined): DraftState {
  return {
    enabled: channel?.enabled === true,
    appId: channel?.appId ?? "",
    allowFrom: (channel?.allowFrom ?? []).join("\n"),
    accessMode: channel?.accessMode ?? "workspace",
    workspace: channel?.workspace ?? "",
    approvalMinutes: String(Math.round((channel?.approvalTimeoutMs ?? DEFAULT_APPROVAL_MINUTES * 60_000) / 60_000)),
    ack: channel?.ack !== false
  };
}

/** 诊断用的相对时间（「刚刚 / 3 分钟前 / 从未」）。 */
function relativeTime(at: number | undefined, now: number = Date.now()): string {
  if (at === undefined) return "从未";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
  return `${Math.round(seconds / 3600)} 小时前`;
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `im-${Date.now()}`;
}

/** 通道状态文案（左栏徽标与详情头共用）。 */
function statusLabel(state: string | undefined): { text: string; tone: "off" | "busy" | "ok" | "error" } {
  switch (state) {
    case "connected": return { text: "已连接", tone: "ok" };
    case "connecting": return { text: "连接中…", tone: "busy" };
    case "error": return { text: "连接失败", tone: "error" };
    case "disabled": return { text: "未启用", tone: "off" };
    default: return { text: "未连接", tone: "off" };
  }
}

/** 通道类型图标（左栏条目前面）。 */
function ChannelIcon({ kind }: { kind: "feishu" | "custom" }): ReactNode {
  return kind === "feishu" ? <MessageSquare size={13} /> : <PlugZap size={13} />;
}

/** 左栏的一条通道（飞书 / 自定义共用同一形态）。 */
function ChannelRailItem({
  kind,
  label,
  status,
  detail,
  active,
  onClick
}: {
  kind: "feishu" | "custom";
  label: string;
  status: { text: string; tone: "off" | "busy" | "ok" | "error" };
  detail?: string;
  active: boolean;
  onClick(): void;
}): ReactNode {
  return (
    <button type="button" className={`im-channel-rail-item${active ? " active" : ""}`} onClick={onClick} aria-pressed={active}>
      <span className={`im-channel-rail-icon im-channel-rail-icon-${status.tone}`}><ChannelIcon kind={kind} /></span>
      <span className="im-channel-rail-copy">
        <strong>
          <span className="im-channel-rail-name">{label}</span>
          <em className={`im-channel-rail-dot im-channel-rail-dot-${status.tone}`} />
        </strong>
        <small>{detail ? `${status.text} · ${detail}` : status.text}</small>
      </span>
    </button>
  );
}

/* —————————————————————————— 官方通道 · 飞书（右栏详情） —————————————————————————— */

function FeishuChannelDetail({ masterEnabled }: { masterEnabled: boolean }): ReactNode {
  const settings = useDesktopStore((state) => state.settings);
  const imStatus = useDesktopStore((state) => state.imStatus);
  const imTest = useDesktopStore((state) => state.imTest);
  const imSave = useDesktopStore((state) => state.imSave);
  const currentWorkspace = useDesktopStore((state) => state.snapshot.workspace);
  const savedChannel = settings.im?.channels.find((channel) => channel.id === FEISHU_CHANNEL_ID);
  const [draft, setDraft] = useState<DraftState>(() => draftFromChannel(savedChannel));
  const [secret, setSecret] = useState("");
  const [secretConfigured, setSecretConfigured] = useState(savedChannel?.appSecretConfigured === true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  /** 本次保存的 requestId + 兜底计时器（主进程不回应时不能让按钮永远转圈）。 */
  const pendingSaveRef = useRef<string | undefined>(undefined);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // 保存成功后（设置对象/状态变了）重新对齐一次草稿：主进程是唯一事实源。
  useEffect(() => {
    setDraft(draftFromChannel(settings.im?.channels.find((channel) => channel.id === FEISHU_CHANNEL_ID)));
    setSecretConfigured(settings.im?.channels.find((channel) => channel.id === FEISHU_CHANNEL_ID)?.appSecretConfigured === true);
  }, [JSON.stringify(settings.im?.channels ?? [])]);

  // 测试结果的 loading 态：结果推送到达即结束。
  useEffect(() => {
    if (imTest) setTesting(false);
  }, [imTest?.at]);

  // 保存回执：只有主进程的 im.save-result（且 requestId 对得上）才算成功。
  useEffect(() => {
    if (!imSave) return;
    const pending = pendingSaveRef.current;
    if (pending !== imSave.requestId) return;
    pendingSaveRef.current = undefined;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    setSaving(false);
    if (imSave.ok) {
      setSaveError(undefined);
      setSavedAt(imSave.at);
    } else {
      setSavedAt(undefined);
      setSaveError(imSave.message);
    }
  }, [imSave?.requestId, imSave?.at]);

  // 卸载时清掉兜底计时器（别在已卸载的组件上 setState）。
  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  const channelStatus = useMemo(
    () => imStatus?.channels.find((item) => item.channelId === FEISHU_CHANNEL_ID),
    [imStatus?.channels]
  );
  const badge = statusLabel(masterEnabled ? channelStatus?.state : "disabled");

  function patchDraft(patch: Partial<DraftState>): void {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function save(): void {
    const minutes = Number(draft.approvalMinutes);
    const approvalTimeoutMs = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : undefined;
    const pendingSecret = secret.trim();
    // 「密钥已保存」在本轮的表态必须包含**刚输入的**那份：否则回执到达前面板会
    // 先把「已保存」标记抹掉（就是「保存了却显示没保存」的原始症状）。
    const nextSecretConfigured = secretConfigured || Boolean(pendingSecret) || savedChannel?.appSecretConfigured === true;
    const channel: ImChannelConfig = {
      id: FEISHU_CHANNEL_ID,
      kind: "feishu",
      enabled: draft.enabled,
      appId: draft.appId.trim(),
      allowFrom: parseAllowFromInput(draft.allowFrom),
      accessMode: draft.accessMode,
      ...(draft.workspace.trim() ? { workspace: draft.workspace.trim() } : {}),
      ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
      ...(draft.ack ? {} : { ack: false }),
      ...(nextSecretConfigured ? { appSecretConfigured: true } : {})
    };
    const requestId = newRequestId();
    pendingSaveRef.current = requestId;
    setSaving(true);
    setSavedAt(undefined);
    setSaveError(undefined);
    void window.piDesktop.send({
      type: "im.channel.save",
      requestId,
      channel,
      enabled: masterEnabled,
      // 明文只在这一次 IPC 里出现，主进程写 safeStorage 后即丢弃。
      ...(pendingSecret ? { appSecret: pendingSecret } : {})
    });
    if (pendingSecret) {
      setSecret("");
      setSecretConfigured(true);
    }
    // 主进程不回应时如实报错（例如跑的还是旧主进程），不要假装保存成功。
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = undefined;
      if (pendingSaveRef.current !== requestId) return;
      pendingSaveRef.current = undefined;
      setSaving(false);
      setSaveError("主进程没有回应保存请求（可能仍在加载新版本，请重启应用后重试）");
    }, 5_000);
  }

  function test(): void {
    setTesting(true);
    void window.piDesktop.send({
      type: "im.channel.test",
      requestId: newRequestId(),
      channelId: FEISHU_CHANNEL_ID,
      ...(draft.appId.trim() ? { appId: draft.appId.trim() } : {}),
      ...(secret.trim() ? { appSecret: secret.trim() } : {})
    });
  }

  return (
    <>
      <header className="im-channel-detail-bar">
        <span className={`im-channel-badge im-channel-badge-${badge.tone}`}>
          {badge.tone === "ok" ? <Wifi size={12} /> : <WifiOff size={12} />}
          {badge.text}
          {badge.tone === "ok" && channelStatus?.botName ? ` · ${channelStatus.botName}` : ""}
        </span>
        <span className="im-channel-detail-title">
          <strong>官方通道 · 飞书（长连接）</strong>
          <small>飞书开放平台长连接；应用没运行时通道离线。</small>
        </span>
        <span className="im-channel-detail-actions">
          <button className="secondary-button compact-button" type="button" data-control="im-feishu-test" disabled={testing} onClick={test}>
            <PlugZap size={13} />
            {testing ? "测试中…" : "测试连接"}
          </button>
          <button className="primary-button compact-button" type="button" data-control="im-feishu-save" disabled={saving} onClick={save}>
            <Save size={13} />
            {saving ? "保存中…" : "保存"}
          </button>
        </span>
      </header>
      <div className="im-channel-detail-body">
        <label className="im-channel-switch">
          <input
            type="checkbox"
            data-control="im-feishu-enabled"
            checked={draft.enabled}
            onChange={(event) => patchDraft({ enabled: event.target.checked })}
          />
          <span>启用这个通道（总开关 + 通道开关都打开才会连）</span>
        </label>
        <div className="im-channel-grid">
          <label>
            <span>App ID</span>
            <input
              type="text"
              data-control="im-feishu-appid"
              placeholder="cli_xxxxxxxxxxxxxxxx"
              value={draft.appId}
              onChange={(event) => patchDraft({ appId: event.target.value })}
            />
          </label>
          <label>
            <span>App Secret{secretConfigured ? "（已保存）" : ""}</span>
            <input
              type="password"
              data-control="im-feishu-secret"
              placeholder={secretConfigured ? "已保存，留空表示不修改" : "在飞书开放平台「应用凭证」里复制"}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label>
            <span>IM 会话权限</span>
            <select
              data-control="im-feishu-access"
              value={draft.accessMode}
              onChange={(event) => patchDraft({ accessMode: event.target.value as AccessMode })}
            >
              {ACCESS_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>工作区</span>
            <input
              type="text"
              data-control="im-feishu-workspace"
              placeholder="留空 = 跟随默认/最近工作区"
              value={draft.workspace}
              onChange={(event) => patchDraft({ workspace: event.target.value })}
            />
          </label>
          <label>
            <span>审批超时（分钟）</span>
            <input
              type="number"
              min={1}
              max={60}
              step={1}
              placeholder={String(DEFAULT_APPROVAL_MINUTES)}
              value={draft.approvalMinutes}
              onChange={(event) => patchDraft({ approvalMinutes: event.target.value })}
            />
          </label>
          <label className="im-channel-wide">
            <span>授权白名单（每行一个 open_id，空 = 不服务任何人）</span>
            <textarea
              data-control="im-feishu-allowfrom"
              rows={3}
              placeholder={"ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n支持逗号或换行分隔"}
              value={draft.allowFrom}
              onChange={(event) => patchDraft({ allowFrom: event.target.value })}
            />
          </label>
        </div>
        <label className="im-channel-switch">
          <input
            type="checkbox"
            checked={draft.ack}
            onChange={(event) => patchDraft({ ack: event.target.checked })}
          />
          <span>收到消息先回一条「已收到，正在处理…」（同一条卡片会持续更新成最终答案）</span>
        </label>
        <div className="im-channel-actions">
          {currentWorkspace && !draft.workspace.trim() && (
            <button className="secondary-button compact-button" type="button" onClick={() => patchDraft({ workspace: currentWorkspace })}>
              使用当前工作区
            </button>
          )}
          {savedAt && <span className="im-channel-saved">已保存（连接会按新配置重建）</span>}
        </div>
        {saveError && <p className="im-channel-save-error">{saveError}</p>}
        {(savedChannel?.allowFrom.length ?? 0) === 0 && savedChannel?.enabled && (
          <p className="im-channel-warning">
            白名单还空着：机器人不会执行任何指令。先给机器人发一条消息，把它回复的 open_id 填进上面的白名单再保存。
          </p>
        )}
        {imTest && (
          <p className={`im-channel-test im-channel-test-${imTest.ok ? "ok" : "error"}`}>
            {imTest.ok ? "✓" : "✕"} {imTest.message}
            {typeof imTest.latencyMs === "number" ? ` · ${imTest.latencyMs}ms` : ""}
          </p>
        )}
        {channelStatus?.state === "error" && channelStatus.message && (
          <p className="im-channel-status-error">{channelStatus.message}</p>
        )}
        {channelStatus && (
          <div className="im-channel-diag">
            <div className="im-channel-diag-row">
              <span>最近入站帧</span>
              <b>{relativeTime(channelStatus.lastFrameAt)}</b>
              <span>最近消息事件</span>
              <b>{relativeTime(channelStatus.lastEventAt)}</b>
            </div>
            {channelStatus.lastEventSummary && <div className="im-channel-diag-line">收到：{channelStatus.lastEventSummary}</div>}
            {channelStatus.lastIgnored && <div className="im-channel-diag-line">已过滤：{channelStatus.lastIgnored}</div>}
            {channelStatus.lastError && <div className="im-channel-diag-line im-channel-diag-error">发送失败：{channelStatus.lastError}</div>}
            {channelStatus.state === "connected" && channelStatus.lastEventAt === undefined && (
              <div className="im-channel-diag-hint">
                连接是好的，但还<strong>从未收到任何消息事件</strong>。按顺序核对：① 开放平台「事件与回调 → 事件配置」订阅方式选<strong>长连接</strong>并添加 <code>im.message.receive_v1</code>；② 「权限管理」开通 <code>im:message</code> 与 <code>im:message:send_as_bot</code>；③ 「版本管理与发布」创建版本并发布（改完配置要发新版本才生效）。
              </div>
            )}
            {channelStatus.state === "connected" && channelStatus.lastFrameAt === undefined && (
              <div className="im-channel-diag-hint">连上了但连心跳都没收到，链路可能刚建立：等 1–2 分钟或重启应用再看。</div>
            )}
          </div>
        )}
        <details className="im-channel-help">
          <summary>
            <ChevronDown size={13} />
            飞书后台怎么配？
          </summary>
          <ol>
            <li>在 <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书开放平台</a> 创建企业自建应用，拿到 App ID / App Secret（本页第二步填入）。</li>
            <li>「添加应用能力」→ 机器人：启用机器人。否则私聊里找不到它。</li>
            <li>「权限管理」开通：<code>im:message</code>（读消息）、<code>im:message:send_as_bot</code>（发消息）、<code>im:chat:readonly</code>（读会话信息）。</li>
            <li>「事件与回调 → 事件配置」订阅方式选 <strong>使用长连接接收事件</strong>（不需要公网地址），添加事件 <code>im.message.receive_v1</code>。</li>
            <li>「事件与回调 → 回调配置」同样选长连接，添加回调 <code>card.action.trigger</code>（审批按钮靠它）。少了这一步按钮点不动，但卡片正文里的 <code>/allow 码</code> 仍可用。</li>
            <li>「版本管理与发布」创建版本并发布，等管理员审核通过。</li>
            <li>把机器人拉进私聊，发一条消息；它会回复你的 open_id —— 填进本页白名单即可。</li>
          </ol>
        </details>
        <section className="resource-card im-channel-card im-channel-safety" aria-label="安全边界">
          <div className="resource-card-head">
            <span className="resource-card-title">
              <ShieldCheck size={14} />
              <strong>安全边界</strong>
            </span>
          </div>
          <div className="resource-card-body">
            <ul>
              <li>总开关缺省关闭；白名单为空时不服务任何消息（拒绝优先）。</li>
              <li>本批只处理私聊；群聊消息记日志后丢弃。</li>
              <li>工具需要确认时在飞书发审批卡片，{DEFAULT_APPROVAL_MINUTES} 分钟（可改）内未处理自动拒绝。</li>
              <li>App Secret 只进系统加密存储（<code>credentials.json</code>），永不写进设置文件、永不进日志。</li>
              <li>桌面软件的现实：<strong>应用没运行 = 通道离线</strong>，重启后按绑定路径自动重开话题。</li>
            </ul>
          </div>
        </section>
      </div>
    </>
  );
}

/* —————————————————————————— 页面：左栏列表 + 右栏详情 —————————————————————————— */

type Selection = { kind: "feishu" } | { kind: "custom"; id: string };

export function ImChannelSettings(): ReactNode {
  const settings = useDesktopStore((state) => state.settings);
  const imStatus = useDesktopStore((state) => state.imStatus);
  const customChannels = useMemo(
    () => (settings.im?.channels ?? []).filter((channel) => channel.kind === "custom"),
    [settings.im?.channels]
  );
  const [masterEnabled, setMasterEnabled] = useState(settings.im?.enabled === true);
  const [selection, setSelection] = useState<Selection>({ kind: "feishu" });
  /** 详情面板最近一次选中的自定义通道：切到飞书再切回来时草稿不丢。 */
  const [customDetailId, setCustomDetailId] = useState<string | undefined>(undefined);
  /** 新建草稿（id + 一次性生成的 Token）：保存后由 customChannels 接管，不再单列。 */
  const [newDraft, setNewDraft] = useState<{ id: string; token: string } | undefined>(undefined);

  // 保存/删除后总闸以主进程为准（store 里的 settings.im 由 im.settings 推送保持最新）。
  useEffect(() => {
    setMasterEnabled(settings.im?.enabled === true);
  }, [settings.im?.enabled]);

  // 连接可能在渲染端订阅之前就完成了，只靠推送会让徽标停在 bootstrap 那一刻。
  useEffect(() => {
    void window.piDesktop.send({ type: "im.status" });
  }, []);

  // 选中的自定义通道被删掉（自己删或别处删）→ 回到飞书详情，不留一个指向空气的表单。
  useEffect(() => {
    if (selection.kind !== "custom") return;
    if (customChannels.some((channel) => channel.id === selection.id)) return;
    if (newDraft?.id === selection.id) return;
    setSelection({ kind: "feishu" });
    setCustomDetailId(undefined);
  }, [selection, customChannels, newDraft]);

  // 新建草稿已经落盘（customChannels 里出现同 id）→ 丢掉一次性 Token 的引用。
  useEffect(() => {
    if (!newDraft) return;
    if (!customChannels.some((channel) => channel.id === newDraft.id)) return;
    setNewDraft(undefined);
  }, [customChannels, newDraft]);

  const feishuStatus = imStatus?.channels.find((item) => item.channelId === FEISHU_CHANNEL_ID);
  const feishuBadge = statusLabel(masterEnabled ? feishuStatus?.state : "disabled");
  const detailChannel = customDetailId ? customChannels.find((channel) => channel.id === customDetailId) : undefined;

  function newChannelId(): string {
    const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/gu, "").slice(0, 6)
      : String(Date.now()).slice(-6);
    return `custom-${suffix}`;
  }

  function newToken(): string {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/gu, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }

  function startCreate(): void {
    const id = newChannelId();
    setNewDraft({ id, token: newToken() });
    setCustomDetailId(id);
    setSelection({ kind: "custom", id });
  }

  function handleDeleted(id: string): void {
    if (newDraft?.id === id) setNewDraft(undefined);
    if (customDetailId === id) setCustomDetailId(undefined);
    if (selection.kind === "custom" && selection.id === id) setSelection({ kind: "feishu" });
  }

  function handleCancelCreate(id: string): void {
    if (newDraft?.id === id) setNewDraft(undefined);
    if (customDetailId === id) setCustomDetailId(undefined);
    if (selection.kind === "custom" && selection.id === id) setSelection({ kind: "feishu" });
  }

  const draftVisible = Boolean(newDraft && !customChannels.some((channel) => channel.id === newDraft.id));

  return (
    <div className="resource-page im-channel-page" data-pane="im-channel-settings">
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>消息通道</strong>
          <small>飞书是官方通道（长连接）；内网工作软件用自定义通道（本机 HTTP，脚本接入）。应用没运行时通道离线。</small>
        </span>
        <label className="im-channel-master">
          <input
            type="checkbox"
            data-control="im-channel-enable"
            checked={masterEnabled}
            onChange={(event) => setMasterEnabled(event.target.checked)}
          />
          <span>启用 IM 通道</span>
        </label>
      </header>

      <div className="im-channel-layout">
        <aside className="im-channel-rail" aria-label="通道列表">
          <div className="im-channel-rail-head">
            <strong>通道</strong>
            <span>{1 + customChannels.length + (draftVisible ? 1 : 0)}</span>
          </div>
          <div className="im-channel-rail-list">
            <ChannelRailItem
              kind="feishu"
              label="飞书"
              status={feishuBadge}
              detail={feishuStatus?.botName}
              active={selection.kind === "feishu"}
              onClick={() => setSelection({ kind: "feishu" })}
            />
            {customChannels.map((channel) => {
              const status = imStatus?.channels.find((item) => item.channelId === channel.id);
              const badge = customChannelStatus(masterEnabled ? status?.state : "disabled");
              // 端口 0 = 随机：运行中时以实际监听地址为准，否则显示配置里的 host:port。
              const where = status?.endpoint
                ? status.endpoint.replace(/^https?:\/\//u, "").replace(/\/v1$/u, "")
                : `${channel.host ?? "127.0.0.1"}${channel.port ? `:${channel.port}` : ""}`;
              return (
                <ChannelRailItem
                  key={channel.id}
                  kind="custom"
                  label={channel.label || channel.id}
                  status={badge}
                  detail={channel.appSecretConfigured === true ? where : "未设置 Token"}
                  active={selection.kind === "custom" && selection.id === channel.id}
                  onClick={() => {
                    setCustomDetailId(channel.id);
                    setSelection({ kind: "custom", id: channel.id });
                  }}
                />
              );
            })}
            {draftVisible && newDraft && (
              <ChannelRailItem
                kind="custom"
                label="新自定义通道"
                status={{ text: "草稿", tone: "off" }}
                detail="尚未保存"
                active={selection.kind === "custom" && selection.id === newDraft.id}
                onClick={() => {
                  setCustomDetailId(newDraft.id);
                  setSelection({ kind: "custom", id: newDraft.id });
                }}
              />
            )}
          </div>
          <button type="button" className="im-channel-rail-new" data-control="im-custom-add" onClick={startCreate}>
            + 添加自定义通道
          </button>
        </aside>

        <section className="im-channel-detail" aria-label="通道详情">
          <div className="im-channel-detail-pane" hidden={selection.kind !== "feishu"}>
            <FeishuChannelDetail masterEnabled={masterEnabled} />
          </div>
          <div className="im-channel-detail-pane" hidden={selection.kind !== "custom"}>
            <ImCustomChannelSettings
              channelId={customDetailId}
              channel={detailChannel}
              initialToken={newDraft && newDraft.id === customDetailId ? newDraft.token : undefined}
              masterEnabled={masterEnabled}
              onDeleted={handleDeleted}
              onCancelCreate={handleCancelCreate}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
