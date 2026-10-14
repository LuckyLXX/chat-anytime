import { KeyRound, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * SSH 密码输入卡（覆盖在远程终端之上）：主机没有可用密码时的唯一入口。
 *
 * 触发来源两种（主进程推 `password-required` 事件）：
 * - `missing`：从未保存密码，也没有本次运行的临时密码；
 * - `auth-failed`：服务器拒绝了密码认证（密码写错，或该服务器不接受密码登录）。
 *
 * 提交后由父组件拿**同一 terminalId** 重发 connect（带 password/rememberPassword）：
 * 主进程据此继续握手，本卡片随即被「正在连接」覆盖（连接失败再回到这里，并带上
 * 失败原因）。卡片自己只持有草稿状态，不碰 IPC——父组件是唯一的数据出口。
 *
 * 拆成独立组件的原因：`SshTerminalPanel` 里挂着 XtermView（真 xterm 实例），
 * 在 happy-dom 下测不到交互；卡片是纯受控组件，可以单独测。
 */
export interface SshPasswordRequest {
  /** 主机显示名（面板上给用户看的名字）。 */
  hostName: string;
  host: string;
  port: number;
  username: string;
  reason: "missing" | "auth-failed";
  /** safeStorage 不可用（密码将以明文降级保存在本机）：勾选框文案不能再说「加密」。 */
  credentialInsecure?: boolean;
  /** 主进程给的失败原因（auth-failed 时是 ssh2 的原始文案），只作次要说明。 */
  detail?: string;
}

export function SshPasswordCard({
  request,
  onSubmit,
  onCancel
}: {
  request: SshPasswordRequest;
  onSubmit(password: string, remember: boolean): void;
  onCancel(): void;
}): ReactNode {
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 每次重新弹出（换主机、认证失败重弹）都清空草稿并聚焦：错误的旧密码留在框里
  // 只会让人再提交一次同样的错密码。
  useEffect(() => {
    setPassword("");
    setRemember(false);
    inputRef.current?.focus();
  }, [request.hostName, request.host, request.reason]);

  const failed = request.reason === "auth-failed";
  const submit = (): void => {
    if (password.length === 0) return;
    onSubmit(password, remember);
  };

  return (
    <div className="terminal-overlay ssh-password-overlay" data-pane="ssh">
      <form className="ssh-password-card" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <div className="ssh-password-head">
          {failed ? <TriangleAlert size={16} /> : <KeyRound size={16} />}
          <strong>{failed ? "密码认证被拒绝" : "该主机没有保存密码"}</strong>
        </div>
        <p className="ssh-password-target">{request.username}@{request.host}:{request.port}{request.hostName ? `（${request.hostName}）` : ""}</p>
        <label className="ssh-password-field">
          <span>密码</span>
          <input
            ref={inputRef}
            type="password"
            value={password}
            autoComplete="off"
            placeholder="SSH 登录密码"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label className="ssh-password-remember">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>记住密码（{request.credentialInsecure ? "当前环境无法加密，将以明文保存在本机" : "加密保存在本机"}；不勾选则只在本次运行内有效）</span>
        </label>
        {failed ? (
          <p className="ssh-password-hint">
            {request.detail ? `服务器返回：${request.detail}。` : ""}
            请确认密码是否正确；若该服务器只接受密钥登录，密码方式连不上，需要在服务器侧配置后再试。
          </p>
        ) : (
          <p className="ssh-password-hint">密码只发给主进程用于本次连接，不会写入会话记录。</p>
        )}
        <div className="ssh-password-actions">
          <button type="submit" className="primary-button" data-control="ssh-password-submit" disabled={password.length === 0}>
            <KeyRound size={14} />
            连接
          </button>
          <button type="button" className="ghost-button" data-control="ssh-password-cancel" onClick={onCancel}>取消</button>
        </div>
      </form>
    </div>
  );
}
