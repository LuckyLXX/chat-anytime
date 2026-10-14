import { ChevronDown, FolderTree, LoaderCircle, RotateCw, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SshFilesPanel } from "./SshFilesPanel";
import { SshPasswordCard, type SshPasswordRequest } from "./SshPasswordCard";
import { XtermView, type XtermApi } from "./XtermView";

type ConnectionState =
  | { status: "connecting"; detail?: string }
  | { status: "confirming"; fingerprint: string }
  /** 主机没有可用密码（或密码被拒）：卡在终端之上等用户输入。 */
  | { status: "password"; request: SshPasswordRequest }
  | { status: "connected" }
  | { status: "closed"; detail?: string; error?: string };

/**
 * SSH 远程终端视图：xterm.js 渲染主进程 ssh2 shell channel（与本地 PTY
 * 终端同一通道形状）。连接生命周期：
 * - mount 时发 connect（同 id 重连时主进程重放 scrollback——AI 建立的
 *   连接经 ssh:reveal 自动开 tab 也走这条路径）；
 * - 首次连接（指纹未记录）返回 fingerprint → 显示确认卡，用户「信任并
 *   连接」后带 trustFingerprint 重发（TOFU）；
 * - 主机没有可用密码（从未保存、或密码认证被拒）→ 主进程推 password-required，
 *   这里弹密码卡，用户提交后带 password/rememberPassword 重发；密码只在
 *   渲染端 → 主进程单向传递，不落会话记录；
 * - 断开后「重新连接」同样重发（连接由主进程持有，tab 关闭才 kill）。
 *
 * 文件面板（SshFilesPanel）挂在终端**下方分屏**（竖向 flex，非覆盖层）：预览面板最
 * 小宽仅 310px（见 styles.css 的 minmax(310px, 28%)），左右分栏会把 xterm 挤到
 * 不可用；下方分屏只压缩高度不动宽度，xterm 的 FitAddon 由 ResizeObserver 自动
 * 跟随（fit 逻辑一行不动）。开关按钮在操作条里、面板之外，故不会被面板遮住
 * ——初版是覆盖层且开关在面板内，打开后点不回终端（已修，见 ssh-files-layout 测试）。
 *
 * 外观：`highlightPrompt` 只在这个（远端）终端开启 —— 服务器 PS1 普遍是无色白字，
 * 由渲染端在数据进 xterm 前把「用户@主机:路径」着色（见 lib/terminal-prompt.ts）。
 */
export function SshTerminalPanel({ terminalId, hostId, hostName, workspace }: { terminalId: string; hostId: string; hostName: string; workspace?: string }): ReactNode {
  const [state, setState] = useState<ConnectionState>({ status: "connecting" });
  const [restartNonce, setRestartNonce] = useState(0);
  const [filesOpen, setFilesOpen] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const apiRef = useRef<XtermApi | undefined>(undefined);

  const connect = useCallback((trustFingerprint: boolean, credentials?: { password: string; remember: boolean }): void => {
    setState({ status: "connecting" });
    void window.piDesktop.ssh({
      type: "connect",
      terminalId,
      hostId,
      cols: Math.max(2, apiRef.current?.terminal.cols ?? 80),
      rows: Math.max(2, apiRef.current?.terminal.rows ?? 24),
      ...(trustFingerprint ? { trustFingerprint: true } : {}),
      // 密码只在这一条命令里上行（密码卡提交时）；主进程侧不回传任何明文。
      ...(credentials ? { password: credentials.password, rememberPassword: credentials.remember } : {})
    }).catch((error: unknown) => {
      setState({ status: "closed", error: error instanceof Error ? error.message : String(error) });
    });
  }, [terminalId, hostId]);

  const handleReady = useCallback((api: XtermApi): void => {
    apiRef.current = api;
    connect(false);
  }, [connect]);

  const handleInput = useCallback((data: string): void => {
    void window.piDesktop.ssh({ type: "input", terminalId, data });
  }, [terminalId]);

  const handleResize = useCallback((cols: number, rows: number): void => {
    void window.piDesktop.ssh({ type: "resize", terminalId, cols, rows });
  }, [terminalId]);

  useEffect(() => {
    const unsubscribe = window.piDesktop.onSshData(terminalId, (event) => {
      const api = apiRef.current;
      if (event.type === "data") {
        if (api) api.write(event.data);
        return;
      }
      // TOFU 探测：hostVerifier 在异步握手中拿到指纹后推事件（connect 命令返回时
      // 握手尚未发生），首次连接的确认卡在这里出现。
      if (event.type === "fingerprint") {
        setState({ status: "confirming", fingerprint: event.fingerprint });
        return;
      }
      // 没有可用密码 / 密码认证被拒：弹密码卡（不切到失败页——用户此刻该做的是输密码）。
      if (event.type === "password-required") {
        setState({
          status: "password",
          request: {
            hostName: event.hostName,
            host: event.host,
            port: event.port,
            username: event.username,
            reason: event.reason,
            credentialInsecure: event.credentialInsecure,
            ...(event.detail ? { detail: event.detail } : {})
          }
        });
        return;
      }
      if (event.type === "status") {
        if (event.status === "connected") setState({ status: "connected" });
        else if (event.status === "connecting") setState({ status: "connecting", detail: event.detail });
        else setState({ status: "closed", detail: event.detail });
        return;
      }
      // 文件传输事件由 SshFilesPanel 单独订阅（同一通道不同事件类型），
      // 终端面板必须忽略，否则会被误当成断连。
      if (event.type === "transfer") return;
      setState({ status: "closed", error: event.message });
    });
    return unsubscribe;
  }, [terminalId]);

  return (
    <div className="terminal-pane ssh-terminal-pane" data-pane="terminal">
      <XtermView key={`${terminalId}-${restartNonce}`} onReady={handleReady} onInput={handleInput} onResize={handleResize} focus highlightPrompt />
      {/* 操作条：固定在终端下方，抽屉开关就在这里（所以永远不会被抽屉盖住）。 */}
      {state.status === "connected" && (
        <div className="ssh-actions-bar">
          <button
            type="button"
            className={`ssh-files-toggle${filesOpen ? " active" : ""}`}
            data-control="ssh-files-toggle"
            title={filesOpen ? "收起远端文件" : "浏览并传输远端文件"}
            aria-expanded={filesOpen}
            onClick={() => { setFilesOpen((open) => !open); setActionError(undefined); }}
          >
            {filesOpen ? <ChevronDown size={14} /> : <FolderTree size={14} />}
            <span>{filesOpen ? "收起文件" : "远端文件"}</span>
          </button>
        </div>
      )}
      {/* 文件面板：**下方分屏**（flex 同级），不是覆盖层——终端只变矮不变窄，
          xterm 的 FitAddon 由 ResizeObserver 自动跟随。 */}
      {filesOpen && state.status === "connected" && (
        <div className="ssh-files-drawer">
          <SshFilesPanel terminalId={terminalId} workspace={workspace} onError={setActionError} />
        </div>
      )}
      {actionError && (
        <div className="ssh-files-error" role="status">
          <span>{actionError}</span>
          <button type="button" className="ghost-icon" aria-label="关闭提示" onClick={() => setActionError(undefined)}><X size={12} /></button>
        </div>
      )}
      {state.status === "connecting" && (
        <div className="terminal-overlay">
          <LoaderCircle className="spinning" size={18} />
          <span>正在连接 {hostName}…</span>
          {state.detail && <span className="terminal-overlay-detail">{state.detail}</span>}
        </div>
      )}
      {state.status === "password" && (
        <SshPasswordCard
          request={state.request}
          onSubmit={(password, remember) => connect(false, { password, remember })}
          onCancel={() => {
            // 告诉主进程「已取消」：正在等这条输入的那次 AI 连接（若有）必须立刻收摊，
            // 而不是干等到超时。无 record 的 kill 是幂等的。
            void window.piDesktop.ssh({ type: "kill", terminalId });
            setState({ status: "closed", detail: "已取消输入密码" });
          }}
        />
      )}
      {state.status === "confirming" && (
        <div className="terminal-overlay ssh-fingerprint-card" data-pane="ssh">
          <div className="ssh-fingerprint-head"><ShieldAlert size={18} /><strong>首次连接，请确认服务器指纹</strong></div>
          <p className="ssh-fingerprint-value">{state.fingerprint}</p>
          <p className="ssh-fingerprint-hint">指纹来自服务器首次握手（TOFU）。请与云控制台显示的主机指纹比对：一致则信任；不一致说明连接被劫持，切勿继续。</p>
          <div className="ssh-fingerprint-actions">
            <button type="button" className="primary-button" data-control="ssh-trust-fingerprint" onClick={() => { setState({ status: "connecting" }); connect(true); }}>
              <ShieldCheck size={14} />信任并连接
            </button>
            <button type="button" className="ghost-button" onClick={() => { void window.piDesktop.ssh({ type: "kill", terminalId }); setState({ status: "closed", detail: "已取消连接" }); }}>取消</button>
          </div>
        </div>
      )}
      {state.status === "closed" && (
        <div className="terminal-ended">
          <strong>{state.error ? "连接失败" : "连接已断开"}</strong>
          {(state.error ?? state.detail) && <span>{state.error ?? state.detail}</span>}
          <button type="button" className="primary-button" onClick={() => { setRestartNonce((nonce) => nonce + 1); }}>
            <RotateCw size={14} />重新连接
          </button>
        </div>
      )}
    </div>
  );
}
