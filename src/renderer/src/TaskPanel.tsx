import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Square, Terminal } from "lucide-react";
import type { BackgroundProcess, RuntimeCommand, Todo, TodoStatus, ToolExecution } from "../../shared/protocol";
import { toolLabel } from "../../shared/locale";
import { useDesktopStore } from "./store";

const statusLabels: Record<TodoStatus, string> = { pending: "待办", in_progress: "进行中", completed: "已完成" };

/**
 * 正在执行的工具调用至少运行这么久才显示在面板里（与后台进程的 MIN_AGE 对齐），
 * 避免 `echo` 这类秒回命令在"运行中的终端"里闪进闪出。
 */
export const MIN_RUNNING_AGE_MS = 5_000;

function executionCommand(execution: ToolExecution): string {
  if (execution.name === "bash") {
    const command = (execution.args as { command?: unknown } | undefined)?.command;
    return typeof command === "string" && command.trim() ? command.trim() : "执行命令";
  }
  return toolLabel(execution.name);
}

function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * 待办页内容（由 PanelDock 的 tab 承载）。只读待办清单——用户不直接改
 * （dsh 式单所有者：模型经 todo_write 整表替换维护）——外加后台运行中的
 * bash 工具调用与游离后台进程（dev server 等），各带停止控制。
 */
export function TaskPanelContent(): ReactNode {
  const todos = useDesktopStore((state) => state.todos);
  const executions = useDesktopStore((state) => state.snapshot.executions);
  const backgroundProcesses = useDesktopStore((state) => state.snapshot.backgroundProcesses);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  // 只显示已运行超过阈值的执行；now 每秒刷新一次，命令跑够时长后自然出现。
  const running = useMemo(
    () => executions.filter((execution) => execution.status === "running" && now - execution.startedAt >= MIN_RUNNING_AGE_MS),
    [executions, now]
  );
  const backgroundCount = running.length + backgroundProcesses.length;

  // 只要有工具在跑（无论是否已达显示阈值）或后台进程存在，就每秒刷新 now：
  // 未达阈值的命令需要靠 tick 在到点后进入面板，后台进程的耗时显示也要实时更新。
  const hasLiveExecution = executions.some((execution) => execution.status === "running");
  const hasBackground = backgroundProcesses.length > 0;
  useEffect(() => {
    if (!hasLiveExecution && !hasBackground) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLiveExecution, hasBackground]);

  async function run(command: RuntimeCommand): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      await window.piDesktop.send(command);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "任务操作失败");
      return false;
    } finally {
      setBusy(false);
    }
  }

  // Completed items sink to the bottom; the model-controlled list order is
  // preserved within each group (sort is stable).
  const ordered = [...todos].sort((left, right) => {
    const rank = (todo: Todo): number => (todo.status === "completed" ? 1 : 0);
    return rank(left) - rank(right);
  });

  return (
    <div className="task-panel" data-pane="task-panel">
      {error && <p className="task-panel-error">{error}</p>}
      {backgroundCount > 0 && (
        <div className="task-panel-running">
          <div className="task-panel-section-title"><Terminal size={12} /><span>运行中的终端</span><em>{backgroundCount}</em></div>
          {running.map((execution) => (
            <div className="task-panel-running-item" key={execution.id}>
              <div className="task-panel-running-head">
                <Terminal size={12} className="spinning" />
                <strong title={executionCommand(execution)}>{executionCommand(execution)}</strong>
                <small>{formatElapsed(execution.startedAt, now)}</small>
                <button className="task-panel-running-stop" type="button" title="停止运行" aria-label={`停止 ${executionCommand(execution)}`} disabled={busy} onClick={() => void run({ type: "session.abort" })}><Square size={10} /></button>
              </div>
            </div>
          ))}
          {backgroundProcesses.map((process) => (
            <div className="task-panel-running-item" key={process.id}>
              <div className="task-panel-running-head">
                <Terminal size={12} className="spinning" />
                <strong title={process.command}>{process.command}</strong>
                <small>PID {process.pid} · {formatElapsed(process.startedAt, now)}</small>
                <button className="task-panel-running-stop" type="button" title="结束进程" aria-label={`结束 PID ${process.pid}`} disabled={busy} onClick={() => void run({ type: "background.kill", id: process.id })}><Square size={10} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="task-panel-list">
        {todos.length === 0 ? <p className="task-panel-empty">暂无任务。让助手用 todo_write 维护任务清单。</p> : ordered.map((todo, index) => (
          <div className={`task-panel-item${todo.status === "completed" ? " completed" : ""}`} key={`${index}-${todo.content}`}>
            <div className="task-panel-copy">
              <strong>{todo.content}</strong>
              <span className={`task-panel-status ${todo.status}`}>{statusLabels[todo.status]}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
