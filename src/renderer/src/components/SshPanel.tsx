import { ChevronDown, ChevronRight, Folder, LoaderCircle, Pencil, Plus, Server, Trash2, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { SshGroupSummary, SshHostSummary } from "../../../shared/protocol";

/**
 * SSH 主机管理（预览面板的一种 tab，data-pane="ssh"）：分组化主机清单——
 * 分组可新建/重命名/删除（删除只把组内主机回落「未分组」，不动主机与密码）；
 * 主机条目归属分组（编辑表单可改归属），未分组主机归入固定尾节。密码只存
 * 主进程，编辑「留空 = 保留原密码」；credentialInsecure（safeStorage 不可用
 * 的明文降级）置顶警告。连接动作经 onConnect 回调交给 App 开终端 tab。
 */
type HostDraftState =
  | { mode: "idle" }
  | { mode: "editing"; source?: SshHostSummary; name: string; address: string; port: string; username: string; password: string; groupId: string; error?: string; saving: boolean };

type GroupDraftState =
  | { mode: "idle" }
  | { mode: "editing"; id?: string; name: string; error?: string; saving: boolean };

const EMPTY_HOST_DRAFT: Omit<Extract<HostDraftState, { mode: "editing" }>, "mode"> = { name: "", address: "", port: "22", username: "root", password: "", groupId: "", saving: false };

/** 未分组的 bucket 键（真实分组用其 id）。 */
const UNGROUPED_KEY = "__ungrouped__";

export function SshPanel({ onConnect }: { onConnect(host: SshHostSummary): void }): ReactNode {
  const [hosts, setHosts] = useState<SshHostSummary[] | undefined>(undefined);
  const [groups, setGroups] = useState<SshGroupSummary[]>([]);
  const [connectedIds, setConnectedIds] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<HostDraftState>({ mode: "idle" });
  const [groupDraft, setGroupDraft] = useState<GroupDraftState>({ mode: "idle" });
  const [listError, setListError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await window.piDesktop.ssh({ type: "hosts" });
      if (result.kind === "hosts") {
        setHosts(result.hosts);
        setGroups(result.groups);
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

  const beginCreateHost = (groupId = ""): void => setDraft({ mode: "editing", ...EMPTY_HOST_DRAFT, groupId });
  const beginEditHost = (host: SshHostSummary): void => setDraft({ mode: "editing", source: host, name: host.name, address: host.host, port: String(host.port), username: host.username, password: "", groupId: host.groupId ?? "", saving: false });

  const saveHostDraft = async (): Promise<void> => {
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
          username: draft.username,
          // 空串 = 显式移出分组（undefined 会保留原值，仅新建时等价未分组）。
          ...(draft.groupId ? { groupId: draft.groupId } : draft.source ? { groupId: "" } : {})
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

  const saveGroupDraft = async (): Promise<void> => {
    if (groupDraft.mode !== "editing") return;
    setGroupDraft({ ...groupDraft, saving: true, error: undefined });
    try {
      const result = await window.piDesktop.ssh({
        type: "group.save",
        group: { ...(groupDraft.id ? { id: groupDraft.id } : {}), name: groupDraft.name }
      });
      if (result.kind === "group-saved") {
        setGroupDraft({ mode: "idle" });
        await refresh();
      }
    } catch (error) {
      setGroupDraft({ ...groupDraft, saving: false, error: error instanceof Error ? error.message : String(error) });
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

  const removeGroup = async (group: SshGroupSummary, memberCount: number): Promise<void> => {
    const suffix = memberCount > 0 ? `组内 ${memberCount} 台主机将移入「未分组」，不会被删除。` : "分组内没有主机。";
    if (!window.confirm(`删除分组「${group.name}”？${suffix}`)) return;
    try {
      await window.piDesktop.ssh({ type: "group.delete", groupId: group.id });
      await refresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleGroup = (key: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const insecure = hosts?.some((host) => host.credentialInsecure) ?? false;
  const hostDraftOpen = draft.mode === "editing";
  const groupNameOf = (id: string): string | undefined => groups.find((group) => group.id === id)?.name;
  const renderHostRow = (host: SshHostSummary): ReactNode => {
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
          <button type="button" className="ghost-button" title="编辑" aria-label={`编辑 ${host.name}`} onClick={() => beginEditHost(host)}><Pencil size={14} /></button>
          <button type="button" className="ghost-button danger" title="删除" aria-label={`删除 ${host.name}`} onClick={() => void removeHost(host)}><Trash2 size={14} /></button>
        </div>
      </li>
    );
  };

  // 主机按分桶渲染：声明的分组（各自可折叠）→ 未分组尾节。
  const buckets: Array<{ key: string; label: string; hosts: SshHostSummary[]; group?: SshGroupSummary }> = [];
  for (const group of groups) {
    const members = hosts?.filter((host) => host.groupId === group.id) ?? [];
    buckets.push({ key: group.id, label: group.name, hosts: members, group });
  }
  const ungrouped = hosts?.filter((host) => !host.groupId || !groupNameOf(host.groupId)) ?? [];
  if (ungrouped.length > 0 || groups.length === 0) {
    buckets.push({ key: UNGROUPED_KEY, label: groups.length > 0 ? "未分组" : "主机", hosts: ungrouped });
  }

  return (
    <div className="preview-scroll ssh-panel" data-pane="ssh">
      <div className="ssh-panel-head">
        <h2><Server size={16} /> SSH 主机</h2>
        <div className="ssh-panel-head-actions">
          <button type="button" className="ghost-button" data-control="ssh-group-create" onClick={() => setGroupDraft({ mode: "editing", name: "", saving: false })} disabled={groupDraft.mode === "editing"}>
            <Plus size={14} />新建分组
          </button>
          <button type="button" className="primary-button" data-control="ssh-host-create" onClick={() => beginCreateHost()} disabled={hostDraftOpen}>
            <Plus size={14} />新建主机
          </button>
        </div>
      </div>
      {insecure && (
        <div className="ssh-insecure-warning">
          <TriangleAlert size={14} />
          <span>当前环境不支持凭据加密（safeStorage 不可用），已保存的密码以明文降级存储在本地，请注意文件访问安全。</span>
        </div>
      )}
      {listError && <div className="ssh-list-error">{listError}</div>}
      {groupDraft.mode === "editing" && (
        <form className="ssh-host-form ssh-group-form" onSubmit={(event) => { event.preventDefault(); void saveGroupDraft(); }}>
          <div className="ssh-form-title">{groupDraft.id ? `重命名分组：${groupNameOf(groupDraft.id) ?? ""}` : "新建分组"}</div>
          <label className="field">
            <span>分组名称</span>
            <input value={groupDraft.name} onChange={(event) => setGroupDraft({ ...groupDraft, name: event.target.value })} placeholder="例如：生产环境" autoFocus />
          </label>
          {groupDraft.error && <div className="ssh-form-error">{groupDraft.error}</div>}
          <div className="ssh-form-actions">
            <button type="submit" className="primary-button" data-control="ssh-group-save" disabled={groupDraft.saving}>
              {groupDraft.saving ? <LoaderCircle className="spinning" size={14} /> : null}
              保存
            </button>
            <button type="button" className="ghost-button" onClick={() => setGroupDraft({ mode: "idle" })}><X size={14} />取消</button>
          </div>
        </form>
      )}
      {hostDraftOpen && draft.mode === "editing" && (
        <form className="ssh-host-form" onSubmit={(event) => { event.preventDefault(); void saveHostDraft(); }}>
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
          <div className="ssh-form-row">
            <label className="field">
              <span>分组</span>
              <select value={draft.groupId} onChange={(event) => setDraft({ ...draft, groupId: event.target.value })}>
                <option value="">未分组</option>
                {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>密码</span>
              <input type="password" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} placeholder={draft.source?.hasPassword ? "已保存（留空 = 不修改）" : "SSH 登录密码"} />
            </label>
          </div>
          {draft.error && <div className="ssh-form-error">{draft.error}</div>}
          <div className="ssh-form-actions">
            <button type="submit" className="primary-button" data-control="ssh-host-save" disabled={draft.saving}>
              {draft.saving ? <LoaderCircle className="spinning" size={14} /> : null}
              保存
            </button>
            <button type="button" className="ghost-button" onClick={() => setDraft({ mode: "idle" })}><X size={14} />取消</button>
          </div>
        </form>
      )}
      {hosts === undefined ? (
        <div className="ssh-panel-loading"><LoaderCircle className="spinning" size={16} /><span>正在读取主机配置…</span></div>
      ) : buckets.length === 0 || buckets.every((bucket) => bucket.hosts.length === 0 && bucket.group) ? (
        <div className="ssh-panel-empty">
          <Server size={28} />
          <p>还没有 SSH 主机。新建一台主机（地址 / 端口 / 用户名 / 密码），即可在预览面板里打开远程终端；AI 也能通过 ssh_* 工具操作同一终端。可用「新建分组」按环境归类管理。</p>
        </div>
      ) : (
        <div className="ssh-group-list">
          {buckets.map((bucket) => {
            const isCollapsed = collapsed.has(bucket.key);
            return (
              <section key={bucket.key} className="ssh-group">
                <header className="ssh-group-head" onClick={() => toggleGroup(bucket.key)}>
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  {bucket.group ? <Folder size={14} /> : null}
                  <strong className="ssh-group-name">{bucket.label}</strong>
                  <span className="ssh-group-count">{bucket.hosts.length}</span>
                  {bucket.group && (
                    <span className="ssh-group-actions" onClick={(event) => event.stopPropagation()}>
                      <button type="button" className="ghost-button" title="重命名分组" aria-label={`重命名分组 ${bucket.label}`} onClick={() => setGroupDraft({ mode: "editing", id: bucket.group!.id, name: bucket.group!.name, saving: false })}><Pencil size={13} /></button>
                      <button type="button" className="ghost-button danger" title="删除分组" aria-label={`删除分组 ${bucket.label}`} onClick={() => void removeGroup(bucket.group!, bucket.hosts.length)}><Trash2 size={13} /></button>
                    </span>
                  )}
                  {!bucket.group && (
                    <button type="button" className="ghost-button ssh-group-add" title="在未分组中新建主机" aria-label="新建主机" onClick={(event) => { event.stopPropagation(); beginCreateHost(); }}><Plus size={13} /></button>
                  )}
                </header>
                {!isCollapsed && (
                  <ul className="ssh-host-list">
                    {bucket.hosts.map(renderHostRow)}
                    {bucket.hosts.length === 0 && <li className="ssh-group-empty">暂无主机，点击右上 + 新建</li>}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
