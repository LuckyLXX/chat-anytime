import { PlugZap, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ExtensionSummary, ResourceScope } from "../../../shared/protocol.js";

interface ExtensionResourceListProps {
  extensions: ExtensionSummary[];
  scopeLabels: Record<ResourceScope, string>;
  onApprove?(id: string): void;
  onSetEnabled?(id: string, enabled: boolean): void;
  onRevoke?(id: string): void;
  busy?: boolean;
}

function isSubagentExtension(extension: ExtensionSummary): boolean {
  const identity = `${extension.name} ${extension.source} ${extension.tools.join(" ")}`.toLowerCase();
  return identity.includes("pi-subagents") || extension.tools.includes("subagent");
}

function displayName(extension: ExtensionSummary): string {
  if (isSubagentExtension(extension)) return "子代理（pi-subagents）";
  if (extension.name === "index.ts" && extension.source.startsWith("npm:")) return extension.source.slice(4);
  return extension.name;
}

function sourceLabel(extension: ExtensionSummary, scopeLabels: Record<ResourceScope, string>): string {
  const source = extension.source.startsWith("npm:") ? `${extension.source.slice(4)}（npm）` : extension.source;
  return `${scopeLabels[extension.scope]} · ${source}`;
}

function capabilityLabel(extension: ExtensionSummary): string {
  if (extension.error) return `加载失败：${extension.error}`;
  if (!extension.loaded) {
    if (extension.approvalChanged) return "扩展代码已变更，需要重新批准后才能运行";
    if (extension.trust === "trusted" && !extension.enabled) return "扩展已停用，保留授权但不会加载代码";
    return isSubagentExtension(extension)
      ? "启用后可以把独立任务交给子代理处理"
      : "启用后会在本机运行该扩展";
  }
  if (isSubagentExtension(extension)) return "可用能力：创建子代理、等待子代理完成";
  if (extension.tools.length > 0) return `可用工具：${extension.tools.join("、")}`;
  if (extension.commands.length > 0) return "扩展命令已可用";
  return "扩展已加载";
}

export function ExtensionResourceList({ extensions, scopeLabels, onApprove, onSetEnabled, onRevoke, busy = false }: ExtensionResourceListProps): ReactNode {
  const manageableExtensions = extensions.filter((extension) => extension.origin !== "bundled");
  if (manageableExtensions.length === 0) return null;

  return (
    <section className="resource-section">
      <div className="resource-section-heading">
        <span><PlugZap size={14} />扩展工具</span>
        <small>{manageableExtensions.length} 个可管理</small>
      </div>
      <p className="resource-form-help resource-extension-help">第三方扩展需要手动启用，并会在本机运行代码。只启用你信任的来源。</p>
      <div className="resource-list">
        {manageableExtensions.map((extension) => (
          <div className="resource-item" key={extension.id}>
            <div className={`resource-item-icon ${extension.loaded ? "" : extension.error ? "resource-item-error" : "not-connected"}`}>
              <PlugZap size={14} />
            </div>
            <div className="resource-item-copy">
              <strong>{displayName(extension)}</strong>
              <small>{sourceLabel(extension, scopeLabels)} · {extension.loaded ? "已启用" : extension.error ? "不可用" : extension.trust === "trusted" ? "已停用" : "尚未启用"}</small>
              <em>{capabilityLabel(extension)}</em>
            </div>
            <div className="resource-extension-actions">
              {!extension.loaded && !extension.error && extension.trust === "undecided" && onApprove && (
                <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => onApprove(extension.id)}>
                  {extension.approvalChanged ? "重新批准" : isSubagentExtension(extension) ? "启用子代理" : "启用扩展"}
                </button>
              )}
              {extension.trust === "trusted" && onSetEnabled && <label className="resource-toggle"><input type="checkbox" checked={extension.enabled} disabled={busy} onChange={(event) => onSetEnabled(extension.id, event.target.checked)} /><span>启用</span></label>}
              {extension.trust === "trusted" && onRevoke && <button className="icon-button resource-remove" type="button" title={`撤销 ${displayName(extension)} 的授权`} aria-label={`撤销 ${displayName(extension)} 的授权`} disabled={busy} onClick={() => onRevoke(extension.id)}><Trash2 size={14} /></button>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
