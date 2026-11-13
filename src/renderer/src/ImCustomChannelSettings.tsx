import { ChevronDown, PlugZap, Save, Trash2, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AccessMode, ImChannelConfig, ImCustomHost } from "../../shared/protocol";
import { IM_CUSTOM_DEFAULT_PORT, normalizeImAllowFrom } from "../../shared/im";
import { useDesktopStore } from "./store";

/**
 * 设置页「消息通道」→ 右栏详情：自定义通道（2026-11-12 引入，2026-11-13 随两段式布局改为详情面板）。
 *
 * 左栏列表（飞书 + 自定义通道）由父级 `ImChannelSettings` 渲染，这里只负责**当前选中**
 * 那条通道的编辑表单：
 * - `channelId` 变化时按 store 里的权威配置重置草稿；切到飞书再切回来（id 不变）时草稿保留；
 * - 新建草稿由父级生成 id + Token 传进来（此时 `channel` 为 undefined，表单显示「取消」）；
 * - 保存成功后**不关表单**：两段式布局里详情常驻，左栏列表由主进程的 `im.settings` 快照刷新；
 * - 删除走父级回调 `onDeleted`，由它把选中项挪回飞书（本组件随即被隐藏/清空）。
 *
 * 与飞书卡片的差别（不是缺陷，是设计）：
 * - 没有卡片 ⇒ 网关自动走纯文本（回执卡被跳过、审批用一行 `/allow 码`）；
 * - 令牌（Token）与飞书 App Secret 走同一条 safeStorage 通道，永不进 settings.json；
 * - 不需要公网、不需要开放平台，**应用没运行 = 端点不存在**（脚本会拿到连接拒绝）。
 *
 * 主题钩子：控件 `im-custom-enabled` / `im-custom-save` / `im-custom-delete`
 * （`im-custom-add` 在父级的左栏底部）；样式前缀 `.im-custom-*`。
 */

const ACCESS_MODE_OPTIONS: { value: AccessMode; label: string }[] = [
  { value: "read-only", label: "只读（不能改文件）" },
  { value: "workspace", label: "工作区（推荐：写工作区自动放行）" },
  { value: "ask", label: "每次询问" },
  { value: "full", label: "完全访问（谨慎）" }
];

const DEFAULT_APPROVAL_MINUTES = 10;

interface Draft {
  id: string;
  label: string;
  enabled: boolean;
  host: ImCustomHost;
  port: string;
  allowFrom: string;
  accessMode: AccessMode;
  workspace: string;
  approvalMinutes: string;
}

function draftFromChannel(channel: ImChannelConfig | undefined, id: string): Draft {
  return {
    id: channel?.id ?? id,
    label: channel?.label ?? "",
    enabled: channel?.enabled === true,
    host: channel?.host ?? "127.0.0.1",
    port: String(channel?.port ?? IM_CUSTOM_DEFAULT_PORT),
    allowFrom: (channel?.allowFrom ?? []).join("\n"),
    accessMode: channel?.accessMode ?? "workspace",
    workspace: channel?.workspace ?? "",
    approvalMinutes: String(Math.round((channel?.approvalTimeoutMs ?? DEFAULT_APPROVAL_MINUTES * 60_000) / 60_000))
  };
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `im-${Date.now()}`;
}

function newToken(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().replace(/-/gu, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function parseAllowFromInput(text: string): string[] {
  return normalizeImAllowFrom(text.split(/[\s,;，；]+/u));
}

/** 自定义通道状态文案（父级左栏与详情头共用；飞书那套在 ImChannelSettings 里）。 */
export function customChannelStatus(state: string | undefined): { text: string; tone: "off" | "busy" | "ok" | "error" } {
  switch (state) {
    case "connected": return { text: "运行中", tone: "ok" };
    case "connecting": return { text: "启动中…", tone: "busy" };
    case "error": return { text: "启动失败", tone: "error" };
    case "disabled": return { text: "未启用", tone: "off" };
    default: return { text: "未运行", tone: "off" };
  }
}

interface Props {
  /** 当前选中的通道 id（新建草稿也有 id，只是还没落盘）。 */
  channelId?: string;
  /** store 里已落盘的那条通道；undefined = 新建草稿。 */
  channel?: ImChannelConfig;
  /** 新建草稿的初始 Token（父级生成一次，切走再切回来还能恢复）。 */
  initialToken?: string;
  masterEnabled: boolean;
  /** 删除完成：父级负责把选中项挪走。 */
  onDeleted(channelId: string): void;
  /** 取消新建：父级丢掉草稿。 */
  onCancelCreate(channelId: string): void;
}

export function ImCustomChannelSettings({ channelId, channel, initialToken, masterEnabled, onDeleted, onCancelCreate }: Props): ReactNode {
  const imStatus = useDesktopStore((state) => state.imStatus);
  const imSave = useDesktopStore((state) => state.imSave);
  const imTest = useDesktopStore((state) => state.imTest);
  const currentWorkspace = useDesktopStore((state) => state.snapshot.workspace);

  const [draft, setDraft] = useState<Draft | null>(channelId ? draftFromChannel(channel, channelId) : null);
  const [token, setToken] = useState(initialToken ?? "");
  const [tokenConfigured, setTokenConfigured] = useState(channel?.appSecretConfigured === true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const pendingSaveRef = useRef<string | undefined>(undefined);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * 只跟「选中项切换」重置草稿：`channel` 在每次保存回执后会换引用，跟着它重置会把
   * 用户正在编辑的字段打回旧值（与飞书详情的 channels 依赖同一类坑）。
   */
  useEffect(() => {
    if (!channelId) {
      setDraft(null);
      setToken("");
      setTokenConfigured(false);
      setSavedAt(undefined);
      setSaveError(undefined);
      return;
    }
    setDraft(draftFromChannel(channel, channelId));
    setToken(initialToken ?? "");
    setTokenConfigured(channel?.appSecretConfigured === true);
    setSavedAt(undefined);
    setSaveError(undefined);
  }, [channelId]);

  // 保存回执：只认 requestId 对得上的那一条（主进程是唯一事实源）。
  useEffect(() => {
    if (!imSave) return;
    if (pendingSaveRef.current !== imSave.requestId) return;
    pendingSaveRef.current = undefined;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    setSaving(false);
    if (imSave.ok) {
      setSaveError(undefined);
      setSavedAt(imSave.at);
      setToken("");
      setTokenConfigured(true);
      // 不关表单：两段式布局里详情常驻，左栏列表由 im.settings 快照刷新。
    } else {
      setSaveError(imSave.message);
    }
  }, [imSave?.requestId, imSave?.at]);

  useEffect(() => {
    if (imTest) setTesting(false);
  }, [imTest?.at]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  function patch(patchValue: Partial<Draft>): void {
    setDraft((current) => (current ? { ...current, ...patchValue } : current));
  }

  function save(): void {
    if (!draft) return;
    const minutes = Number(draft.approvalMinutes);
    const approvalTimeoutMs = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : undefined;
    const portNumber = Number(draft.port);
    const pendingToken = token.trim();
    const nextTokenConfigured = tokenConfigured || Boolean(pendingToken) || channel?.appSecretConfigured === true;
    const nextChannel: ImChannelConfig = {
      id: draft.id,
      kind: "custom",
      enabled: draft.enabled,
      label: draft.label.trim() || "自定义通道",
      appId: "",
      host: draft.host,
      port: Number.isFinite(portNumber) && portNumber >= 0 ? Math.round(portNumber) : IM_CUSTOM_DEFAULT_PORT,
      allowFrom: parseAllowFromInput(draft.allowFrom),
      accessMode: draft.accessMode,
      ...(draft.workspace.trim() ? { workspace: draft.workspace.trim() } : {}),
      ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
      ack: false,
      ...(nextTokenConfigured ? { appSecretConfigured: true } : {})
    };
    const requestId = newRequestId();
    pendingSaveRef.current = requestId;
    setSaving(true);
    setSavedAt(undefined);
    setSaveError(undefined);
    void window.piDesktop.send({
      type: "im.channel.save",
      requestId,
      channel: nextChannel,
      enabled: masterEnabled,
      ...(pendingToken ? { appSecret: pendingToken } : {})
    });
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = undefined;
      if (pendingSaveRef.current !== requestId) return;
      pendingSaveRef.current = undefined;
      setSaving(false);
      setSaveError("主进程没有回应保存请求（可能仍在加载新版本，请重启应用后重试）");
    }, 5_000);
  }

  function remove(): void {
    if (!channel) return;
    const name = channel.label || channel.id;
    if (!window.confirm(`删除自定义通道「${name}」？它的 Token 会一起删掉，已绑定的话题保留。`)) return;
    void window.piDesktop.send({ type: "im.channel.delete", requestId: newRequestId(), channelId: channel.id });
    onDeleted(channel.id);
  }

  function test(): void {
    if (!channel) return;
    setTesting(true);
    void window.piDesktop.send({ type: "im.channel.test", requestId: newRequestId(), channelId: channel.id });
  }

  if (!channelId || !draft) {
    return (
      <div className="im-channel-detail-empty">
        <PlugZap size={20} />
        <strong>还没有选中通道</strong>
        <small>在左侧选一条自定义通道，或点「添加自定义通道」按 HTTP 规则接进来。</small>
      </div>
    );
  }

  const isDraft = !channel;
  const status = imStatus?.channels.find((item) => item.channelId === channelId);
  const badge = customChannelStatus(masterEnabled ? status?.state : "disabled");
  const endpoint = status?.endpoint ?? (isDraft ? undefined : `http://${channel?.host ?? "127.0.0.1"}:${channel?.port || "?"}/v1`);

  return (
    <>
      <header className="im-channel-detail-bar">
        <span className={`im-channel-badge im-channel-badge-${badge.tone}`}>
          {badge.tone === "ok" ? <Wifi size={12} /> : <WifiOff size={12} />}
          {badge.text}
        </span>
        <span className="im-channel-detail-title">
          <strong>{draft.label.trim() || (isDraft ? "新自定义通道" : draft.id)}</strong>
          <small>{isDraft ? `尚未保存 · id ${draft.id}` : endpoint}</small>
        </span>
        <span className="im-channel-detail-actions">
          <button className="secondary-button compact-button" type="button" onClick={test} disabled={isDraft || testing}>
            <PlugZap size={13} />
            {testing ? "检查中…" : "检查"}
          </button>
          {!isDraft && (
            <button className="secondary-button compact-button" type="button" data-control="im-custom-delete" onClick={remove}>
              <Trash2 size={13} />
              删除
            </button>
          )}
        </span>
      </header>
      <div className="im-channel-detail-body">
        <p className="im-custom-hint">
          给内网工作软件用：本机起一个 HTTP 端点，脚本把消息 <code>POST</code> 进来，答案按 <code>replyUrl</code> 回调或从 <code>/v1/replies</code> 轮询取。
          只监听本机（可选 0.0.0.0），必须带 Token。<strong>应用没运行 = 端点不存在。</strong>
        </p>

        <div className="im-channel-grid">
          <label>
            <span>名称</span>
            <input
              type="text"
              data-control="im-custom-label"
              placeholder="内网工作软件"
              value={draft.label}
              onChange={(event) => patch({ label: event.target.value })}
            />
          </label>
          <label>
            <span>接入 Token{tokenConfigured ? "（已保存）" : ""}</span>
            <span className="im-custom-token-row">
              <input
                type="password"
                data-control="im-custom-token"
                placeholder={tokenConfigured ? "已保存，留空表示不修改" : "脚本请求时要带的令牌"}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="new-password"
              />
              <button className="secondary-button compact-button" type="button" onClick={() => setToken(newToken())}>
                生成
              </button>
            </span>
          </label>
          <label>
            <span>监听地址</span>
            <select
              data-control="im-custom-host"
              value={draft.host}
              onChange={(event) => patch({ host: event.target.value as ImCustomHost })}
            >
              <option value="127.0.0.1">127.0.0.1（只本机，推荐）</option>
              <option value="0.0.0.0">0.0.0.0（允许内网其他机器直连，需自行确认网络边界）</option>
            </select>
          </label>
          <label>
            <span>端口（0 = 随机；不要与脚本回调端口相同）</span>
            <input
              type="number"
              min={0}
              max={65_535}
              step={1}
              data-control="im-custom-port"
              value={draft.port}
              onChange={(event) => patch({ port: event.target.value })}
            />
          </label>
          <label>
            <span>会话权限</span>
            <select
              data-control="im-custom-access"
              value={draft.accessMode}
              onChange={(event) => patch({ accessMode: event.target.value as AccessMode })}
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
              placeholder="留空 = 跟随默认/最近工作区"
              value={draft.workspace}
              onChange={(event) => patch({ workspace: event.target.value })}
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
              onChange={(event) => patch({ approvalMinutes: event.target.value })}
            />
          </label>
          <label className="im-channel-wide">
            <span>白名单（每行一个 peerId，空 = 不服务任何人）</span>
            <textarea
              data-control="im-custom-allowfrom"
              rows={2}
              placeholder={"zhangsan\n脚本里的 peerId，通常用发送人账号/工号"}
              value={draft.allowFrom}
              onChange={(event) => patch({ allowFrom: event.target.value })}
            />
          </label>
        </div>
        <label className="im-channel-switch">
          <input
            type="checkbox"
            data-control="im-custom-enabled"
            checked={draft.enabled}
            onChange={(event) => patch({ enabled: event.target.checked })}
          />
          <span>启用这个通道（总开关 + 通道开关都打开才会监听）</span>
        </label>
        <div className="im-channel-actions">
          <button className="primary-button compact-button" type="button" data-control="im-custom-save" disabled={saving} onClick={save}>
            <Save size={13} />
            {saving ? "保存中…" : "保存"}
          </button>
          {isDraft && (
            <button className="secondary-button compact-button" type="button" onClick={() => onCancelCreate(draft.id)}>
              取消
            </button>
          )}
          {currentWorkspace && !draft.workspace.trim() && (
            <button className="secondary-button compact-button" type="button" onClick={() => patch({ workspace: currentWorkspace })}>
              使用当前工作区
            </button>
          )}
          <span className="im-custom-id">通道 id：<code>{draft.id}</code></span>
          {savedAt && <span className="im-channel-saved">已保存</span>}
        </div>
        {saveError && <p className="im-channel-save-error">{saveError}</p>}
        {!masterEnabled && (
          <p className="im-channel-warning">总开关没开：保存后也不会监听。先把页面右上角的「启用 IM 通道」打开。</p>
        )}
        {imTest && (
          <p className={`im-channel-test im-channel-test-${imTest.ok ? "ok" : "error"}`}>
            {imTest.ok ? "✓" : "✕"} {imTest.message}
          </p>
        )}
        {status?.state === "error" && status.message && <p className="im-channel-status-error">{status.message}</p>}
        {status?.lastError && <p className="im-channel-diag-line im-channel-diag-error">发送失败：{status.lastError}</p>}

        <details className="im-channel-help im-custom-help">
          <summary>
            <ChevronDown size={13} />
            对接说明（脚本怎么接？）
          </summary>
          <div className="im-custom-protocol">
            <p>完整文档：<code>docs/im-channel-protocol.md</code>（仓库里，含示例脚本 <code>docs/im-channel-bridge-example.mjs</code>）。速查：</p>
            <ol>
              <li>
                <strong>推消息</strong>：<code>POST {`{endpoint}`}/messages</code>，头 <code>Authorization: Bearer &lt;Token&gt;</code>，
                体 <code>{`{"peerId":"zhangsan","text":"帮我看下发布记录","messageId":"可选","replyUrl":"可选"}`}</code>。返回 <code>202</code> 表示已收下。
              </li>
              <li><strong>收答案（回调）</strong>：消息里带 <code>replyUrl</code>，我们把 <code>{`{"peerId","text","messageId","at"}`}</code> POST 回去（超时 8 秒，失败不影响下一条）。</li>
              <li><strong>收答案（轮询）</strong>：<code>GET {`{endpoint}`}/replies?since=&lt;游标&gt;&amp;token=&lt;Token&gt;</code>，返回 <code>{`{"items":[…],"next":n}`}</code>，下次把 <code>next</code> 当 <code>since</code>。</li>
              <li><strong>探活</strong>：<code>GET {`{endpoint}`}/health?token=&lt;Token&gt;</code>。</li>
              <li>指令同样可用：消息文本发 <code>/status</code>、<code>/stop</code>、<code>/new</code>、<code>/help</code>；需要确认工具时我们会回一行 <code>/allow 8位码</code> 让你批复。</li>
            </ol>
            <p className="im-custom-note">
              只支持文本；图片/文件请脚本先存盘，再把路径写进 <code>text</code>。同一条消息重投（同 <code>messageId</code>）不会跑第二次。
            </p>
          </div>
        </details>
      </div>
    </>
  );
}
