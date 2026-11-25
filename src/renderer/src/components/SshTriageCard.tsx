import { useEffect, useState, type ReactNode } from "react";
import type { SshHostSummary } from "../../../shared/protocol";
import { SSH_TRIAGE_CARD_LIMITS as limits, sshEndpointKey, type SshTriageCardView } from "../../../shared/ssh-triage";

export interface SshTriageSummarySeed {
  batchId: string;
  title: string;
}

type Edit = { kind: "directory" | "summary"; id?: string; title: string; text: string; batchId?: string };

export function SshTriageCard({ host, seed, onOpenDirectory }: {
  host: SshHostSummary;
  seed?: SshTriageSummarySeed;
  onOpenDirectory(path: string): void;
}): ReactNode {
  const [view, setView] = useState<SshTriageCardView>();
  const [edit, setEdit] = useState<Edit>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = sshEndpointKey(host);
  useEffect(() => {
    let active = true;
    void window.piDesktop.ssh({ type: "triage.card.get", hostId: host.id }).then((result) => {
      if (!active) return;
      if (result.kind === "triage-card") setView(result.view);
      else setError("无法读取主机卡片");
    }).catch((reason: unknown) => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [host.id, endpoint]);
  useEffect(() => {
    if (seed) setEdit({ kind: "summary", title: seed.title.slice(0, limits.titleChars), text: "", batchId: seed.batchId });
  }, [seed]);

  async function save(draft: Edit, remove = false): Promise<void> {
    if (!view || view.card.endpoint !== endpoint || busy) return;
    setBusy(true);
    setError("");
    const { revision, directories, summaries } = view.card;
    const id = draft.id ?? crypto.randomUUID();
    const now = Date.now();
    const updatedDirectories = draft.kind === "directory" ? directories.filter((row) => row.id !== id) : directories;
    const updatedSummaries = draft.kind === "summary" ? summaries.filter((row) => row.id !== id) : summaries;
    if (!remove && draft.kind === "directory") {
      updatedDirectories.push({ id, label: draft.title.trim(), path: draft.text.trim() });
    } else if (!remove && draft.kind === "summary") {
      const original = summaries.find((row) => row.id === id);
      updatedSummaries.unshift({ id, title: draft.title.trim(), body: draft.text.trim(), updatedAt: now, createdAt: original?.createdAt ?? now, ...(draft.batchId ? { batchId: draft.batchId, hostId: host.id } : {}) });
    }
    try {
      const result = await window.piDesktop.ssh({ type: "triage.card.save", hostId: host.id, endpoint, revision, directories: updatedDirectories, summaries: updatedSummaries.slice(0, limits.summaries) });
      if (result.kind === "triage-card-saved") {
        setView(result.view);
        setEdit(undefined);
      } else if (result.kind === "triage-card-conflict") {
        setView(result.view);
        setError(result.message);
      } else setError("无法保存主机卡片");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function adopt(accept: boolean): Promise<void> {
    if (!view?.stale || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.piDesktop.ssh({ type: "triage.card.adopt", hostId: host.id, fromEndpoint: view.stale.endpoint, accept });
      if (result.kind === "triage-card-saved") setView(result.view);
      else setError("无法更新旧端点资料");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <section className="ssh-triage-card" aria-label={`${host.name} 主机卡片`}>
    {error && <p className="ssh-form-error" role="alert">{error}</p>}
    {!view ? (!error && <p>正在读取主机卡片…</p>) : <>
      {view.stale && <div className="ssh-triage-card">
        <p>资料来自旧端点 <code>{view.stale.endpoint}</code></p>
        <div className="ssh-triage-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={() => void adopt(true)}>转用到当前主机</button>
          <button type="button" className="ghost-button" disabled={busy} onClick={() => void adopt(false)}>保留在旧端点</button>
        </div>
      </div>}
      <div className="ssh-triage-heading"><strong>常用排查目录</strong><button type="button" className="ghost-button" disabled={busy || view.card.directories.length >= limits.directories} onClick={() => setEdit({ kind: "directory", title: "", text: "" })}>添加目录</button></div>
      {view.card.directories.length === 0 && <p className="ssh-triage-muted">暂无目录</p>}
      {view.card.directories.map(({ id, label, path }) => <div key={id} className="ssh-triage-item">
        <button type="button" className="ghost-button" disabled={view.card.endpoint !== endpoint} onClick={() => onOpenDirectory(path)}>{label}</button>
        <code>{path}</code>
        <button type="button" className="ghost-button" disabled={busy} aria-label={`编辑目录 ${label}`} onClick={() => setEdit({ kind: "directory", id, title: label, text: path })}>编辑</button>
      </div>)}
      <div className="ssh-triage-heading"><strong>历史排查摘要</strong><button type="button" className="ghost-button" disabled={busy} onClick={() => setEdit({ kind: "summary", title: "", text: "" })}>新增摘要</button></div>
      {view.card.summaries.length === 0 && <p className="ssh-triage-muted">暂无摘要</p>}
      {view.card.summaries.map(({ id, title, body, createdAt, batchId }) => <div key={id} className="ssh-triage-item">
        <strong>{title}</strong><small>{new Date(createdAt).toLocaleDateString("zh-CN")}{batchId ? ` · 批次 ${batchId}` : ""}</small>
        <p>{body}</p>
        <button type="button" className="ghost-button" disabled={busy} aria-label={`编辑摘要 ${title}`} onClick={() => setEdit({ kind: "summary", id, title, text: body, batchId })}>编辑</button>
      </div>)}
      {edit && <form className="ssh-host-form ssh-triage-edit" onSubmit={(event) => { event.preventDefault(); void save(edit); }}>
        <label className="field">{edit.kind === "directory" ? "目录名" : "问题标题"}<input required maxLength={edit.kind === "directory" ? limits.directoryLabelChars : limits.titleChars} value={edit.title} onChange={(event) => setEdit({ ...edit, title: event.target.value })} /></label>
        <label className="field">{edit.kind === "directory" ? "远端绝对路径" : "现象、原因与处理"}
          {edit.kind === "directory" ? <input required pattern="/.*" maxLength={512} value={edit.text} onChange={(event) => setEdit({ ...edit, text: event.target.value })} /> : <textarea required rows={4} maxLength={limits.bodyChars} placeholder="可粘贴 AI 起草的摘要，核对后保存" value={edit.text} onChange={(event) => setEdit({ ...edit, text: event.target.value })} />}
        </label>
        <div className="ssh-triage-actions">
          <button type="submit" className="primary-button" disabled={busy || view.card.endpoint !== endpoint || !edit.title.trim() || !edit.text.trim()}>保存</button>
          <button type="button" className="ghost-button" disabled={busy} onClick={() => setEdit(undefined)}>取消</button>
          {edit.id && <button type="button" className="ghost-button danger" disabled={busy} onClick={() => { if (window.confirm(`删除「${edit.title}」？`)) void save(edit, true); }}>删除</button>}
        </div>
      </form>}
    </>}
  </section>;
}
