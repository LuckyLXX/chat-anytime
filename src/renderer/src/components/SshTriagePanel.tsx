import { useEffect, useState, type ReactNode } from "react";
import type { SshGroupSummary, SshHostSummary } from "../../../shared/protocol";
import {
  SSH_TRIAGE_BATCH_STATUS_LABELS, SSH_TRIAGE_CHECK_KIND_LABELS, SSH_TRIAGE_CHECK_STATUS_LABELS,
  SSH_TRIAGE_FAILURE_LABELS, SSH_TRIAGE_HOST_STATUS_LABELS, SSH_TRIAGE_MAX_HOSTS, SSH_TRIAGE_TITLE_LIMIT,
  sshEndpointKey, validateSshTriageCheck, type SshTriageBatchDetail, type SshTriageBatchSummary,
  type SshTriageCheckKind, type SshTriageCheckRequest
} from "../../../shared/ssh-triage";
import type { SshTriageSummarySeed } from "./SshTriageCard";

const DEFAULT_CHECKS: SshTriageCheckRequest[] = [{ kind: "service", unit: "" }, { kind: "port", port: 8080 }, { kind: "disk", path: "/" }, { kind: "journal", minutes: 15 }];
const formatTime = (timestamp: number): string => new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

function CheckFields({ check, change }: { check: SshTriageCheckRequest; change(value: SshTriageCheckRequest): void }): ReactNode {
  switch (check.kind) {
    case "service": return <label className="field">systemd 服务名<input required value={check.unit} maxLength={160} placeholder="test-api.service" onChange={(e) => change({ ...check, unit: e.target.value })} /></label>;
    case "port": return <div className="ssh-triage-actions"><label className="field">端口<input type="number" required min={1} max={65535} value={check.port || ""} onChange={(e) => change({ ...check, port: Number(e.target.value) })} /></label><label className="field">协议<select value={check.protocol ?? "tcp"} onChange={(e) => change({ ...check, protocol: e.target.value === "udp" ? "udp" : "tcp" })}><option value="tcp">TCP</option><option value="udp">UDP</option></select></label></div>;
    case "disk": return <label className="field">远端绝对路径<input required value={check.path} maxLength={512} onChange={(e) => change({ ...check, path: e.target.value })} /></label>;
    case "journal": return <div className="ssh-triage-config"><label className="field">日志所属服务<input required value={check.unit ?? ""} maxLength={160} placeholder="test-api.service" onChange={(e) => change({ ...check, unit: e.target.value })} /></label><label className="field">最近几分钟<input type="number" required min={1} max={1440} value={check.minutes ?? 15} onChange={(e) => change({ ...check, minutes: Number(e.target.value) })} /></label></div>;
  }
}

export function SshTriagePanel({ hosts, groups, onConnect, onSummary }: {
  hosts: SshHostSummary[];
  groups: SshGroupSummary[];
  onConnect(host: SshHostSummary): void;
  onSummary(host: SshHostSummary, seed: SshTriageSummarySeed): void;
}): ReactNode {
  const [batches, setBatches] = useState<SshTriageBatchSummary[]>();
  const [batchId, setBatchId] = useState("");
  const [hostId, setHostId] = useState("");
  const [checkKind, setCheckKind] = useState<SshTriageCheckKind>();
  const [detail, setDetail] = useState<SshTriageBatchDetail>();
  const [draft, setDraft] = useState<{ hostIds: string[]; title: string; enabled: SshTriageCheckKind[]; checks: SshTriageCheckRequest[]; sourceBatchId?: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const batch = batches?.find((item) => item.id === batchId) ?? batches?.[0];
  const pickedId = batch?.hosts.some((item) => item.hostId === hostId) ? hostId : batch?.hosts[0]?.hostId;
  const matchingDetail = detail?.summary.id === batch?.id && detail?.logHostId === pickedId ? detail : undefined;
  const selected = matchingDetail?.hosts.find((item) => item.hostId === pickedId);
  const current = selected && hosts.find((item) => item.id === selected.hostId && sshEndpointKey(item) === selected.endpoint);
  const check = selected?.checks.find((item) => item.kind === checkKind) ?? selected?.checks[0];
  const activeBatchId = batch?.id;

  useEffect(() => {
    let live = true;
    let running = false;
    let pending = false;
    const refresh = async (): Promise<void> => {
      if (running) { pending = true; return; }
      running = true;
      try {
        const result = await window.piDesktop.ssh({ type: "triage.list" });
        if (live && result.kind === "triage-batches") { setBatches(result.batches); setLoadError(""); }
      } catch (reason) { if (live) setLoadError(errorMessage(reason)); }
      finally {
        running = false;
        if (live && pending) { pending = false; void refresh(); }
      }
    };
    void refresh();
    const unsubscribe = window.piDesktop.onSshTriageChanged?.(() => void refresh());
    return () => { live = false; unsubscribe?.(); };
  }, []);

  useEffect(() => {
    if (!activeBatchId || !pickedId) return;
    let live = true;
    let running = false;
    let pending = false;
    const refresh = async (): Promise<void> => {
      if (running) { pending = true; return; }
      running = true;
      try {
        const result = await window.piDesktop.ssh({ type: "triage.detail", batchId: activeBatchId, hostId: pickedId });
        if (live && result.kind === "triage-detail") setDetail(result.detail);
      } catch (reason) { if (live) setLoadError(errorMessage(reason)); }
      finally {
        running = false;
        if (live && pending) { pending = false; void refresh(); }
      }
    };
    void refresh();
    const unsubscribe = window.piDesktop.onSshTriageChanged?.(() => void refresh());
    return () => { live = false; unsubscribe?.(); };
  }, [activeBatchId, pickedId]);

  function startDraft(retry?: SshTriageBatchSummary, targetHostId?: string): void {
    const checks = retry ? DEFAULT_CHECKS.map((item) => retry.checks.find((prior) => prior.kind === item.kind) ?? item) : DEFAULT_CHECKS;
    const endpointById = new Map(hosts.map((host) => [host.id, sshEndpointKey(host)]));
    setError("");
    setDraft({ hostIds: targetHostId ? [targetHostId] : (retry?.hosts.filter((row) => !["passed", "queued", "running"].includes(row.status) && endpointById.get(row.hostId) === row.endpoint).map((row) => row.hostId) ?? []), title: retry ? `复查 · ${retry.title}`.slice(0, SSH_TRIAGE_TITLE_LIMIT) : "", enabled: retry ? retry.checks.map((item) => item.kind) : ["disk"], checks, sourceBatchId: retry?.id });
  }

  async function submit(): Promise<void> {
    if (!draft || busy) return;
    const hostIds = draft.hostIds.filter((id) => hosts.some((host) => host.id === id));
    const checks = draft.checks.filter((item) => draft.enabled.includes(item.kind));
    const invalid = checks.map(validateSshTriageCheck).find(Boolean);
    if (invalid || !checks.length || hostIds.length < 1 || hostIds.length > SSH_TRIAGE_MAX_HOSTS) {
      setError(invalid ?? `请选择检查项和 1–${SSH_TRIAGE_MAX_HOSTS} 台主机`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await window.piDesktop.ssh({ type: "triage.start", hostIds, title: draft.title.trim(), checks, sourceBatchId: draft.sourceBatchId });
      if (result.kind !== "triage-batch") throw new Error("未收到任务记录");
      setBatches((previous) => previous?.some((row) => row.id === result.batch.id) ? previous : [result.batch, ...(previous ?? [])]);
      setBatchId(result.batch.id);
      setHostId("");
      setCheckKind(undefined);
      setDraft(undefined);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function stop(): Promise<void> {
    if (!batch || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.piDesktop.ssh({ type: "triage.stop", batchId: batch.id });
      if (result.kind === "triage-batch") setBatches((previous) => previous?.map((row) => row.id === result.batch.id ? result.batch : row));
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }

  function copyEvidence(): void {
    if (!check?.output || !selected || !batch) return;
    const evidence = `${batch.title}\n${selected.displayName} · ${selected.endpoint}\n${check.label}\n${check.reason ?? ""}\n\n${check.output}`;
    void navigator.clipboard.writeText(evidence).then(() => setNotice("已复制当前检查的输出，可在对话中粘贴并请 AI 起草摘要。")).catch(() => setNotice("无法访问剪贴板，可选中日志手动复制。"));
  }

  return <section className="ssh-triage" aria-label="SSH 后台排查">
    <div className="ssh-triage-heading"><strong>后台任务</strong><button type="button" className="primary-button" disabled={!hosts.length || busy} onClick={() => startDraft()}>新建排查</button></div>
    {(error || loadError) && <p role="alert" className="ssh-form-error">{error || loadError}</p>}
    {draft && <form className="ssh-host-form ssh-triage-edit" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="field">任务名称<input maxLength={SSH_TRIAGE_TITLE_LIMIT} value={draft.title} placeholder="例如 测试 API 启动异常" onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
      <label className="field">添加分组<select value="" onChange={(e) => { const members = hosts.filter((host) => e.target.value === (host.groupId || "ungrouped")); setDraft({ ...draft, hostIds: Array.from(new Set([...draft.hostIds, ...members.map((host) => host.id)])) }); }}><option value="">选择分组</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}<option value="ungrouped">未分组</option></select></label>
      <fieldset className="ssh-triage-targets"><legend>目标主机 · 已选 {draft.hostIds.length} 台</legend>
        {hosts.map((host) => <label key={host.id}><input type="checkbox" checked={draft.hostIds.includes(host.id)} onChange={(e) => setDraft({ ...draft, hostIds: e.target.checked ? [...draft.hostIds, host.id] : draft.hostIds.filter((id) => id !== host.id) })} /><span>{host.name}<small>{sshEndpointKey(host)}</small></span></label>)}
      </fieldset>
      <fieldset><legend>检查项</legend>
        {draft.checks.map((item, index) => <div key={item.kind} className="ssh-triage-config">
          <label><input type="checkbox" checked={draft.enabled.includes(item.kind)} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked ? [...draft.enabled, item.kind] : draft.enabled.filter((kind) => kind !== item.kind) })} /> {SSH_TRIAGE_CHECK_KIND_LABELS[item.kind]}</label>
          {draft.enabled.includes(item.kind) && <CheckFields check={item} change={(value) => setDraft({ ...draft, checks: draft.checks.map((old, offset) => offset === index ? value : old) })} />}
        </div>)}
      </fieldset>
      <div className="ssh-triage-actions"><button type="submit" className="primary-button" disabled={busy}>后台运行</button><button type="button" className="ghost-button" disabled={busy} onClick={() => setDraft(undefined)}>取消</button></div>
    </form>}
    {!batch && <p className="ssh-triage-muted">{batches ? "暂无排查任务" : "正在读取任务…"}</p>}
    {batch && <div className="ssh-triage-card">
      <label className="field">排查批次<select value={batch.id} onChange={(e) => { setBatchId(e.target.value); setHostId(""); setCheckKind(undefined); setNotice(""); }}>{batches?.map((row) => <option value={row.id} key={row.id}>{SSH_TRIAGE_BATCH_STATUS_LABELS[row.status]} · {row.title} · {formatTime(row.createdAt)}</option>)}</select></label>
      {batch.storeError && <p role="alert" className="ssh-form-error">现场持久化失败 · {batch.storeError}</p>}
      <div className="ssh-triage-actions"><small>{batch.hosts.length} 台主机 · {SSH_TRIAGE_BATCH_STATUS_LABELS[batch.status]}</small>
        {batch.status === "running" ? <button type="button" className="ghost-button danger" disabled={busy} onClick={() => void stop()}>停止采集</button> : <button type="button" className="ghost-button" disabled={busy || !hosts.length} onClick={() => startDraft(batch)}>复查所选主机</button>}
      </div>
      <div className="ssh-triage-hosts">{batch.hosts.map((row) => <button type="button" className="ghost-button" key={row.hostId} aria-pressed={row.hostId === pickedId} onClick={() => { setHostId(row.hostId); setCheckKind(undefined); setNotice(""); }}>
        <strong>{row.displayName}</strong><span>{SSH_TRIAGE_HOST_STATUS_LABELS[row.status]} · {row.checksDone}/{row.checksTotal}</span>
        <small>{row.reason || row.endpoint}</small>
      </button>)}</div>
      {!selected && <p className="ssh-triage-muted">正在读取主机现场…</p>}
      {selected && <section className="ssh-triage-evidence" aria-label={`${selected.displayName} 现场`}>
        <strong>{selected.displayName}</strong><small className="ssh-triage-muted"> · {selected.endpoint}</small>
        {selected.endedAt && <p className="ssh-triage-muted">采集结束于 {formatTime(selected.endedAt)}</p>}
        <div className="ssh-triage-actions" aria-label="检查项">{selected.checks.map((row) => <button type="button" className="ghost-button" key={row.kind} aria-pressed={row.kind === check?.kind} onClick={() => { setCheckKind(row.kind); setNotice(""); }}>{SSH_TRIAGE_CHECK_KIND_LABELS[row.kind]} · {SSH_TRIAGE_CHECK_STATUS_LABELS[row.status]}</button>)}</div>
        {check && <>
          <p>{check.label}{check.failure ? ` · ${SSH_TRIAGE_FAILURE_LABELS[check.failure]}` : ""}{check.exitCode !== null ? ` · 退出码 ${check.exitCode}` : ""}</p>
          {check.reason && <p>{check.reason}</p>}
          {check.truncated && <p className="ssh-triage-muted">输出较长，显示末尾内容。</p>}
          <pre tabIndex={0} aria-label="采集输出">{check.output || (check.status === "running" ? "正在采集…" : "该项没有输出")}</pre>
        </>}
        <div className="ssh-triage-actions">
          <button type="button" className="ghost-button" disabled={!current} onClick={() => { if (current) onConnect(current); }}>打开终端</button>
          <button type="button" className="ghost-button" disabled={!current || batch.status === "running"} onClick={() => { if (current) startDraft(batch, current.id); }}>复查该主机</button>
          <button type="button" className="ghost-button" disabled={!current} onClick={() => { if (current) onSummary(current, { batchId: batch.id, title: batch.title }); }}>记入排查摘要</button>
          <button type="button" className="ghost-button" disabled={!check?.output} onClick={copyEvidence}>复制给 AI</button>
        </div>
        {!current && <p className="ssh-triage-muted">历史主机已删除或端点已变更。请从主机清单确认当前连接配置。</p>}
        {notice && <p role="status" className="ssh-triage-muted">{notice}</p>}
      </section>}
    </div>}
  </section>;
}
