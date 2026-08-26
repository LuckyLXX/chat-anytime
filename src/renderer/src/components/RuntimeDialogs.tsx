import { TerminalSquare } from "lucide-react";
import type { ReactNode } from "react";
import type { ExecutionPrincipal, PermissionDecision, PermissionRequest } from "../../../shared/protocol.js";
import { toolLabel } from "../../../shared/locale.js";
import { useDesktopStore } from "../store.js";

function permissionPrincipalLabel(kind: ExecutionPrincipal["kind"]): string {
  switch (kind) {
    case "root-agent": return "主会话";
    case "subagent": return "子代理";
  }
}

interface PermissionDialogProps {
  request: PermissionRequest;
  /** 分屏/多会话并发时标注来源会话标题（渲染端从会话列表解析）。 */
  sessionTitle?: string;
}

export function PermissionDialog({ request, sessionTitle }: PermissionDialogProps): ReactNode {
  const principalLabel = permissionPrincipalLabel(request.principal.kind);
  const contextLabel = [principalLabel, sessionTitle, request.summary].filter(Boolean).join(" · ");

  async function resolve(decision: PermissionDecision): Promise<void> {
    await window.piDesktop.send({ type: "permission.resolve", id: request.id, decision });
    useDesktopStore.setState((state) => ({
      permissions: state.permissions.filter((item) => item.id !== request.id)
    }));
  }

  return (
    <div className="modal-backdrop permission-backdrop">
      <div className="permission-dialog" data-pane="permission-dialog" role="alertdialog" aria-modal="true" aria-label="工具权限确认">
        <header>
          <div className={`risk-icon ${request.risk}`}><TerminalSquare size={20} /></div>
          <div><h2>允许{toolLabel(request.toolName)}？</h2><p>{contextLabel}</p></div>
        </header>
        <pre>{JSON.stringify(request.args, null, 2)}</pre>
        <footer>
          <button className="danger-button" type="button" onClick={() => void resolve("deny")}>拒绝</button>
          <button className="secondary-button" type="button" onClick={() => void resolve("allow-once")}>仅允许一次</button>
          <button className="primary-button" type="button" onClick={() => void resolve("allow-session")}>本次会话允许</button>
        </footer>
      </div>
    </div>
  );
}
