import { LoaderCircle, RotateCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { XtermView, type XtermApi } from "./XtermView";

type ConnectionState =
  | { status: "connecting"; detail?: string }
  | { status: "confirming"; fingerprint: string }
  | { status: "connected" }
  | { status: "closed"; detail?: string; error?: string };

/**
 * SSH 远程终端视图：xterm.js 渲染主进程 ssh2 shell channel（与本地 PTY
 * 终端同一通道形状）。连接生命周期：
 * - mount 时发 connect（同 id 重连时主进程重放 scrollback——AI 建立的
 *   连接经 ssh:reveal 自动开 tab 也走这条路径）；
 * - 首次连接（指纹未记录）返回 fingerprint → 显示确认卡，用户「信任并
 *   连接」后带 trustFingerprint 重发（TOFU）；
 * - 断开后「重新连接」同样重发（连接由主进程持有，tab 关闭才 kill）。
 */
export function SshTerminalPanel({ terminalId, hostId, hostName }: { terminalId: string; hostId: string; hostName: string }): ReactNode {
  const [state, setState] = useState<ConnectionState>({ status: "connecting" });
  const [restartNonce, setRestartNonce] = useState(0);
  const apiRef = useRef<XtermApi | undefined>(undefined);

  const connect = useCallback((trustFingerprint: boolean): void => {
    setState({ status: "connecting" });
    void window.piDesktop.ssh({
      type: "connect",
      terminalId,
      hostId,
      cols: Math.max(2, apiRef.current?.terminal.cols ?? 80),
      rows: Math.max(2, apiRef.current?.terminal.rows ?? 24),
      ...(trustFingerprint ? { trustFingerprint: true } : {})
    }).then((result) => {
      if (result.kind === "connect" && result.fingerprint) setState({ status: "confirming", fingerprint: result.fingerprint });
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
      if (event.type === "status") {
        if (event.status === "connected") setState({ status: "connected" });
        else if (event.status === "connecting") setState({ status: "connecting", detail: event.detail });
        else setState({ status: "closed", detail: event.detail });
        return;
      }
      setState({ status: "closed", error: event.message });
    });
    return unsubscribe;
  }, [terminalId]);

  return (
    <div className="terminal-pane ssh-terminal-pane" data-pane="terminal">
      <XtermView key={`${terminalId}-${restartNonce}`} onReady={handleReady} onInput={handleInput} onResize={handleResize} focus />
      {state.status === "connecting" && (
        <div className="terminal-overlay">
          <LoaderCircle className="spinning" size={18} />
          <span>正在连接 {hostName}…</span>
          {state.detail && <span className="terminal-overlay-detail">{state.detail}</span>}
        </div>
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
