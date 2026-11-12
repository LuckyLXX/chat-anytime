import { ChevronDown, MessageSquare, PlugZap, Save, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AccessMode, ImChannelConfig } from "../../shared/protocol";
import { normalizeImAllowFrom } from "../../shared/im";
import { useDesktopStore } from "./store";

/**
 * 设置页「消息通道」tab（2026-11-12，飞书长连接 P1）。
 *
 * 分工：**主进程独占**配置与密钥（settings.im + credentials.json 的
 * `im.feishu.<id>`），渲染端只发命令、读推送——明文 App Secret 永不进 settings.json，
 * 也不在渲染端持久化（输入框是 password 且保存后即清空）。
 *
 * 状态徽标读 `imStatus`（bootstrap 快照 + im.status 推送）；「测试连接」结果读
 * `imTest`（im.test-result 推送）。
 *
 * 主题钩子：`data-pane="im-channel-settings"`；控件 `im-channel-enable`、
 * `im-feishu-enabled|-appid|-secret|-allowfrom|-access|-workspace|-save|-test`。
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

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `im-${Date.now()}`;
}

function statusLabel(state: string | undefined): { text: string; tone: "off" | "busy" | "ok" | "error" } {
  switch (state) {
    case "connected": return { text: "已连接", tone: "ok" };
    case "connecting": return { text: "连接中…", tone: "busy" };
    case "error": return { text: "连接失败", tone: "error" };
    case "disabled": return { text: "未启用", tone: "off" };
    default: return { text: "未连接", tone: "off" };
  }
}

export function ImChannelSettings(): ReactNode {
  const settings = useDesktopStore((state) => state.settings);
  const imStatus = useDesktopStore((state) => state.imStatus);
  const imTest = useDesktopStore((state) => state.imTest);
  const currentWorkspace = useDesktopStore((state) => state.snapshot.workspace);
  const savedChannel = settings.im?.channels.find((channel) => channel.id === FEISHU_CHANNEL_ID);
  const [masterEnabled, setMasterEnabled] = useState(settings.im?.enabled === true);
  const [draft, setDraft] = useState<DraftState>(() => draftFromChannel(savedChannel));
  const [secret, setSecret] = useState("");
  const [secretConfigured, setSecretConfigured] = useState(savedChannel?.appSecretConfigured === true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);

  // 保存成功后（设置对象/状态变了）重新对齐一次草稿：主进程是唯一事实源。
  useEffect(() => {
    setMasterEnabled(settings.im?.enabled === true);
    setDraft(draftFromChannel(settings.im?.channels.find((channel) => channel.id === FEISHU_CHANNEL_ID)));
    setSecretConfigured(settings.im?.channels.find((channel) => channel.id === FEISHU_CHANNEL_ID)?.appSecretConfigured === true);
  }, [settings.im?.enabled, JSON.stringify(settings.im?.channels ?? [])]);

  // 测试结果的 loading 态：结果推送到达即结束。
  useEffect(() => {
    if (imTest) setTesting(false);
  }, [imTest?.at]);

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
      ...(secretConfigured ? { appSecretConfigured: true } : {})
    };
    setSaving(true);
    setSavedAt(undefined);
    // 本地镜像一份（主进程落盘的就是这份形状）：否则切走再切回本 tab 时组件重挂载
    // 会从 bootstrap 的旧 settings 读回保存前的配置，看起来像「没保存」。
    useDesktopStore.setState((state) => ({
      settings: {
        ...state.settings,
        im: {
          enabled: masterEnabled,
          channels: [...(state.settings.im?.channels ?? []).filter((item) => item.id !== FEISHU_CHANNEL_ID), channel]
        }
      }
    }));
    void window.piDesktop.send({
      type: "im.channel.save",
      requestId: newRequestId(),
      channel,
      enabled: masterEnabled,
      // 明文只在这一次 IPC 里出现，主进程写 safeStorage 后即丢弃。
      ...(secret.trim() ? { appSecret: secret.trim() } : {})
    });
    if (secret.trim()) {
      setSecret("");
      setSecretConfigured(true);
    }
    // 主进程不回执「已保存」，只在状态推送里体现；这里给一个即时的本地反馈。
    setTimeout(() => {
      setSaving(false);
      setSavedAt(Date.now());
    }, 300);
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
    <div className="resource-page im-channel-page" data-pane="im-channel-settings">
      <header className="resource-page-head">
        <span className="resource-page-title">
          <strong>消息通道</strong>
          <small>在飞书私聊里给 PiDesktop 派活：消息进对应话题，答案和审批卡片回到手机。应用没运行时通道离线。</small>
        </span>
        <label className="im-channel-master">
          <input
            type="checkbox"
            data-control="im-channel-enable"
            checked={masterEnabled}
            onChange={(event) => {
              setMasterEnabled(event.target.checked);
            }}
          />
          <span>启用 IM 通道</span>
        </label>
      </header>
      <div className="resource-page-body">
        <section className="resource-card im-channel-card" aria-label="飞书通道">
          <div className="resource-card-head">
            <span className="resource-card-title">
              <MessageSquare size={14} />
              <strong>飞书（长连接）</strong>
            </span>
            <span className={`im-channel-badge im-channel-badge-${badge.tone}`}>
              {badge.tone === "ok" ? <Wifi size={12} /> : <WifiOff size={12} />}
              {badge.text}
              {badge.tone === "ok" && channelStatus?.botName ? ` · ${channelStatus.botName}` : ""}
            </span>
          </div>
          <div className="resource-card-body">
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
              <button className="primary-button compact-button" type="button" data-control="im-feishu-save" disabled={saving} onClick={save}>
                <Save size={13} />
                {saving ? "保存中…" : "保存"}
              </button>
              <button className="secondary-button compact-button" type="button" data-control="im-feishu-test" disabled={testing} onClick={test}>
                <PlugZap size={13} />
                {testing ? "测试中…" : "测试连接"}
              </button>
              {currentWorkspace && !draft.workspace.trim() && (
                <button className="secondary-button compact-button" type="button" onClick={() => patchDraft({ workspace: currentWorkspace })}>
                  使用当前工作区
                </button>
              )}
              {savedAt && <span className="im-channel-saved">已保存（连接会按新配置重建）</span>}
            </div>
            {imTest && (
              <p className={`im-channel-test im-channel-test-${imTest.ok ? "ok" : "error"}`}>
                {imTest.ok ? "✓" : "✕"} {imTest.message}
                {typeof imTest.latencyMs === "number" ? ` · ${imTest.latencyMs}ms` : ""}
              </p>
            )}
            {channelStatus?.state === "error" && channelStatus.message && (
              <p className="im-channel-status-error">{channelStatus.message}</p>
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
          </div>
        </section>
        <section className="resource-card im-channel-card im-channel-safety">
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
    </div>
  );
}
