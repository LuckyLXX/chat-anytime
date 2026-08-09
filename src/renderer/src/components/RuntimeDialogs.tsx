import { PlugZap, TerminalSquare } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import type {
  ExecutionPrincipal,
  ExtensionUiDialogRequest,
  ExtensionUiResponse,
  PermissionDecision,
  PermissionRequest
} from "../../../shared/protocol.js";
import { toolLabel } from "../../../shared/locale.js";
import { useDesktopStore } from "../store.js";

function permissionPrincipalLabel(kind: ExecutionPrincipal["kind"]): string {
  switch (kind) {
    case "root-agent": return "主会话";
    case "subagent": return "子代理";
    case "native-extension": return "原生扩展";
    case "restricted-extension": return "受限扩展";
  }
}

interface PermissionDialogProps {
  request: PermissionRequest;
}

export function PermissionDialog({ request }: PermissionDialogProps): ReactNode {
  const principalLabel = permissionPrincipalLabel(request.principal.kind);

  async function resolve(decision: PermissionDecision): Promise<void> {
    await window.piDesktop.send({ type: "permission.resolve", id: request.id, decision });
    useDesktopStore.setState((state) => ({
      permissions: state.permissions.filter((item) => item.id !== request.id)
    }));
  }

  return (
    <div className="modal-backdrop permission-backdrop">
      <div className="permission-dialog" role="alertdialog" aria-modal="true" aria-label="工具权限确认">
        <header>
          <div className={`risk-icon ${request.risk}`}><TerminalSquare size={20} /></div>
          <div><h2>允许{toolLabel(request.toolName)}？</h2><p>{principalLabel} · {request.summary}</p></div>
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

interface ExtensionUiDialogProps {
  request: ExtensionUiDialogRequest;
}

export function ExtensionUiDialog({ request }: ExtensionUiDialogProps): ReactNode {
  const initialValue = request.method === "editor" ? request.prefill ?? "" : "";
  const [value, setValue] = useState(initialValue);

  async function resolve(response: Omit<ExtensionUiResponse, "id">): Promise<void> {
    await window.piDesktop.send({ type: "extension-ui.resolve", response: { id: request.id, ...response } });
    useDesktopStore.setState((state) => ({
      extensionUiDialogs: state.extensionUiDialogs.filter((item) => item.id !== request.id)
    }));
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    void resolve({ value });
  }

  return (
    <div className="modal-backdrop permission-backdrop">
      <div className="permission-dialog extension-ui-dialog" role="dialog" aria-modal="true" aria-label={request.title}>
        <header>
          <div className="risk-icon command"><PlugZap size={20} /></div>
          <div><h2>{request.title}</h2>{request.method === "confirm" && <p>{request.message}</p>}</div>
        </header>

        {request.method === "select" && (
          <div className="extension-ui-options">
            {request.options.map((option) => (
              <button className="secondary-button" type="button" key={option} onClick={() => void resolve({ value: option })}>
                {option}
              </button>
            ))}
          </div>
        )}

        {(request.method === "input" || request.method === "editor") && (
          <form onSubmit={submit}>
            <div className="field">
              <label>{request.method === "input" ? request.placeholder ?? "请输入" : "内容"}</label>
              {request.method === "editor" ? (
                <textarea rows={8} value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
              ) : (
                <input value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} autoFocus />
              )}
            </div>
            <footer>
              <button className="secondary-button" type="button" onClick={() => void resolve({ cancelled: true })}>取消</button>
              <button className="primary-button" type="submit">确定</button>
            </footer>
          </form>
        )}

        {request.method === "confirm" && (
          <footer>
            <button className="secondary-button" type="button" onClick={() => void resolve({ confirmed: false })}>取消</button>
            <button className="primary-button" type="button" onClick={() => void resolve({ confirmed: true })}>确认</button>
          </footer>
        )}

        {request.method === "select" && (
          <footer><button className="secondary-button" type="button" onClick={() => void resolve({ cancelled: true })}>取消</button></footer>
        )}
      </div>
    </div>
  );
}
