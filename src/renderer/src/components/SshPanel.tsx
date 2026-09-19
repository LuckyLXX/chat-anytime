import { LoaderCircle, Pencil, Plus, Server, Trash2, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { SshHostSummary } from "../../../shared/protocol";

/**
 * SSH 主机管理（预览面板的一种 tab，data-pane="ssh"）：主机清单（名称/
 * 地址/端口/用户名，密码只存主进程）+ 新建/编辑/删除 + 连接。密码编辑
 * 「留空 = 保留原密码」；credentialInsecure（safeStorage 不可用的明文
 * 降级）置顶警告。连接动作通过 onConnect 回调交给 App 开终端 tab。
 */
type DraftState =
  | { mode: "idle" }
  | { mode: "editing"; source?: SshHostSummary; name: string; address: string; port: string; username: string; password: string; error?: string; saving: boolean };

const EMPTY_DRAFT: Omit<Extract<DraftState, { mode: "editing" }>, "mode"> = { name: "", address: "", port: "22", username: "root", password: "", saving: false };

export function SshPanel({ onConnect }: { onConnect(host: SshHostSummary): void }): ReactNode {
  const [hosts, setHosts] = useState<SshHostSummary[] | undefined>(undefined);
  const [connectedIds, setConnectedIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<DraftState>({ mode: "idle" });
  const [listError, setListError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await window.piDesktop.ssh({ type: "hosts" });
      if (result.kind === "hosts") {
        setHosts(result.hosts);
        setConnectedIds(result.connectedHostIds);
      }
      setListError(undefined);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
      setHosts([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const beginCreate = (): void => setDraft({ mode: "editing", ...EMPTY_DRAFT });
  const beginEdit = (host: SshHostSummary): void => setDraft({ mode: "editing", source: host, name: host.name, address: host.host, port: String(host.port), username: host.username, password: "", saving: false });

  const saveDraft = async (): Promise<void> => {
    if (draft.mode !== "editing") return;
    const portValue = Number.parseInt(draft.port.trim() || "22", 10);
    setDraft({ ...draft, saving: true, error: undefined });
    try {
      const result = await window.piDesktop.ssh({
        type: "host.save",
        host: {
          ...(draft.source ? { id: draft.source.id } : {}),
          name: draft.name,
          host: draft.address,
          port: Number.isFinite(portValue) ? portValue : 22,
          username: draft.username
        },
        ...(draft.password.length > 0 ? { password: draft.password } : {})
      });
      if (result.kind === "host-saved") {
        setDraft({ mode: "idle" });
        await refresh();
      }
    } catch (error) {
      setDraft({ ...draft, saving: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const removeHost = async (host: SshHostSummary): Promise<void> => {
    if (!window.confirm(`删除主机「${host.name}」（${host.username}@${host.host}）？已保存的密码将一并清除。`)) return;
    try {
      await window.piDesktop.ssh({ type: "host.delete", hostId: host.id });
      await refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const insecure = hosts?.some((host) => host.credentialInsecure) ?? false;

  return (
    <div className="preview-scroll ssh-panel" data-pane="ssh">
      <div className="ssh-panel-head">
        <h2><Server size={16} /> SSH 主机</h2>
        <button type="button" className="primary-button" data-control="ssh-host-create" onClick={beginCreate} disabled={draft.mode === "editing"}>
          <Plus size={14} />新建主机
        </button>
      </div>
      {insecure && (
        <div className="ssh-insecure-warning">
          <TriangleAlert size={14} />
          <span>当前环境不支持凭据加密（safeStorage 不可用），已保存的密码以明文降级存储在本地，请注意文件访问安全。</span>
        </div>
      )}
      {listError && <div className="ssh-list-error">{listError}</div>}
      {draft.mode === "editing" ? (
        <form className="ssh-host-form" onSubmit={(event) => { event.preventDefault(); void saveDraft(); }}>
          <div className="ssh-form-title">{draft.source ? `编辑主机：${draft.source.name}` : "新建主机"}</div>
          <label className="field">
            <span>名称</span>
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：生产服务器" autoFocus />
          </label>
          <label className="field">
            <span>主机地址</span>
            <input value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} placeholder="IP 或域名" />
          </label>
          <div className="ssh-form-row">
            <label className="field">
              <span>端口</span>
              <input value={draft.port} onChange={(event) => setDraft({ ...draft, port: event.target.value })} inputMode="numeric" />
            </label>
            <label className="field">
              <span>用户名</span>
              <input value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>密码</span>
            <input type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} placeholder={draft.source?.hasPassword ? "已保存（留空 = 不修改）" : "SSH 登录密码"} />
          </label>
          {draft.error && <div className="ssh-form-error">{draft.error}</div>}
          <div className="ssh-form-actions">
            <button type="submit" className="primary-button" data-control="ssh-host-save" disabled={draft.saving}>
              {draft.saving ? <LoaderCircle className="spinning" size={14} /> : null}
              保存
            </button>
            <button type="button" className="ghost-button" onClick={() => setDraft({ mode: "idle" })}><X size={14} />取消</button>
          </div>
        </form>
      ) : hosts === undefined ? (
        <div className="ssh-panel-loading"><LoaderCircle className="spinning" size={16} /><span>正在读取主机配置…</span></div>
      ) : hosts.length === 0 ? (
        <div className="ssh-panel-empty">
          <Server size={28} />
          <p>还没有 SSH 主机。新建一台主机（地址 / 端口 / 用户名 / 密码），即可在预览面板里打开远程终端；AI 也能通过 ssh_* 工具操作同一终端。</p>
        </div>
      ) : (
        <ul className="ssh-host-list">
          {hosts.map((host) => {
            const connected = connectedIds.includes(host.id);
            return (
              <li key={host.id} className="ssh-host-row">
                <span className={`ssh-host-dot ${connected ? "connected" : ""}`} title={connected ? "已连接" : "未连接"} />
                <div className="ssh-host-meta">
                  <strong>{host.name}</strong>
                  <span>{host.username}@{host.host}:{host.port}{host.hasPassword ? "" : " · 未存密码"}</span>
                </div>
                <div className="ssh-host-actions">
                  <button type="button" className="primary-button" data-control="ssh-host-connect" onClick={() => onConnect(host)}>连接</button>
                  <button type="button" className="ghost-button" title="编辑" aria-label={`编辑 ${host.name}`} onClick={() => beginEdit(host)}><Pencil size={14} /></button>
                  <button type="button" className="ghost-button danger" title="删除" aria-label={`删除 ${host.name}`} onClick={() => void removeHost(host)}><Trash2 size={14} /></button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
