import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronUp, ListTodo, Pencil, Square, Terminal, Trash2, X } from "lucide-react";
import type { BackgroundProcess, RuntimeCommand, Todo, TodoStatus, ToolExecution } from "../../shared/protocol";
import { toolLabel } from "../../shared/locale";
import { useDesktopStore } from "./store";

type PanelState = "closed" | "open" | "collapsed";

const statusLabels: Record<TodoStatus, string> = { pending: "待办", in_progress: "进行中", completed: "已完成" };
const statusCycle: TodoStatus[] = ["pending", "in_progress", "completed"];

function nextStatus(status: TodoStatus): TodoStatus {
  return statusCycle[(statusCycle.indexOf(status) + 1) % statusCycle.length]!;
}

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
 * Floating task panel in the chat window (collapsible). Shows the live todo
 * list (read-only for the user — tasks are created and executed by the agent
 * via todo_create/todo_update/todo_delete) plus anything running in the
 * background: running bash tool executions and detached background processes
 * (dev servers etc.), each with a stop control.
 */
export function TaskPanel(): ReactNode {
  const todos = useDesktopStore((state) => state.todos);
  const executions = useDesktopStore((state) => state.snapshot.executions);
  const backgroundProcesses = useDesktopStore((state) => state.snapshot.backgroundProcesses);
  const [panel, setPanel] = useState<PanelState>("closed");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editStatus, setEditStatus] = useState<TodoStatus>("pending");
  const [now, setNow] = useState(() => Date.now());

  const running = useMemo(() => executions.filter((execution) => execution.status === "running"), [executions]);
  const collapsed = panel === "collapsed";
  const backgroundCount = running.length + backgroundProcesses.length;

  useEffect(() => {
    if (panel === "closed" || collapsed || backgroundCount === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [panel, collapsed, backgroundCount]);

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

  function startEdit(todo: Todo): void {
    setEditingId(todo.id);
    setEditTitle(todo.title);
    setEditNotes(todo.notes ?? "");
    setEditStatus(todo.status);
  }

  function saveEdit(todo: Todo): void {
    if (!editTitle.trim()) return;
    void run({ type: "todo.update", id: todo.id, title: editTitle.trim(), notes: editNotes, status: editStatus }).then((ok) => {
      if (ok) setEditingId(undefined);
    });
  }

  const ordered = [...todos].sort((left, right) => {
    const rank = (todo: Todo): number => (todo.status === "completed" ? 1 : 0);
    return rank(left) - rank(right) || left.createdAt - right.createdAt;
  });
  const activeCount = todos.filter((todo) => todo.status !== "completed").length;

  if (panel === "closed") {
    return (
      <button className="task-panel-fab" type="button" title={`任务面板，${activeCount} 项未完成${backgroundCount > 0 ? `，${backgroundCount} 个终端运行中` : ""}`} aria-label={`打开任务面板，${activeCount} 项未完成`} onClick={() => setPanel("open")}>
        <ListTodo size={16} />
        {activeCount > 0 && <span className="task-panel-badge">{activeCount}</span>}
        {backgroundCount > 0 && <Terminal size={13} className="task-panel-fab-running" />}
      </button>
    );
  }

  return (
    <div className={`task-panel${collapsed ? " collapsed" : ""}`} data-pane="task-panel">
      <header className="task-panel-header">
        <button className="task-panel-header-toggle" type="button" aria-expanded={!collapsed} title={collapsed ? "展开任务面板" : "折叠任务面板"} onClick={() => setPanel(collapsed ? "open" : "collapsed")}>
          <Check size={14} />
          <span>任务</span>
          <small>{activeCount > 0 ? `${activeCount} 项未完成` : "全部完成"}{backgroundCount > 0 ? ` · ${backgroundCount} 个终端运行中` : ""}</small>
          {collapsed ? <ChevronDown size={14} className="task-panel-chevron" /> : <ChevronUp size={14} className="task-panel-chevron" />}
        </button>
        <button className="task-panel-close" type="button" title="关闭任务面板" aria-label="关闭任务面板" onClick={() => setPanel("closed")}><X size={14} /></button>
      </header>
      {!collapsed && (
        <>
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
            {todos.length === 0 ? <p className="task-panel-empty">暂无任务。让助手用 todo_create 创建任务。</p> : ordered.map((todo) => (
              editingId === todo.id ? (
                <div className="task-panel-item task-panel-editing" key={todo.id}>
                  <div className="task-panel-edit-fields">
                    <input value={editTitle} placeholder="任务标题" aria-label="任务标题" disabled={busy} onChange={(event) => setEditTitle(event.target.value)} />
                    <input value={editNotes} placeholder="备注（可选）" aria-label="任务备注" disabled={busy} onChange={(event) => setEditNotes(event.target.value)} />
                    <select value={editStatus} aria-label="任务状态" disabled={busy} onChange={(event) => setEditStatus(event.target.value as TodoStatus)}>
                      {statusCycle.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
                    </select>
                  </div>
                  <div className="task-panel-edit-actions">
                    <button type="button" title="保存修改" aria-label="保存修改" disabled={busy || !editTitle.trim()} onClick={() => saveEdit(todo)}><Check size={12} />保存</button>
                    <button type="button" title="取消编辑" aria-label="取消编辑" disabled={busy} onClick={() => setEditingId(undefined)}><X size={12} />取消</button>
                  </div>
                </div>
              ) : (
                <div className={`task-panel-item${todo.status === "completed" ? " completed" : ""}`} key={todo.id}>
                  <label className="task-panel-check" title={todo.status === "completed" ? "标回待办" : "标记完成"}>
                    <input type="checkbox" checked={todo.status === "completed"} disabled={busy} onChange={(event) => void run({ type: "todo.update", id: todo.id, status: event.target.checked ? "completed" : "pending" })} />
                  </label>
                  <div className="task-panel-copy">
                    <strong>{todo.title}</strong>
                    {todo.notes && <small>{todo.notes}</small>}
                    <button className={`task-panel-status ${todo.status}`} type="button" title="点击切换状态（待办 → 进行中 → 已完成）" disabled={busy} onClick={() => void run({ type: "todo.update", id: todo.id, status: nextStatus(todo.status) })}>{statusLabels[todo.status]}</button>
                  </div>
                  <button className="task-panel-edit" type="button" title="编辑任务" aria-label={`编辑任务 ${todo.title}`} disabled={busy} onClick={() => startEdit(todo)}><Pencil size={12} /></button>
                  <button className="task-panel-remove" type="button" title="删除任务" aria-label={`删除任务 ${todo.title}`} disabled={busy} onClick={() => void run({ type: "todo.delete", id: todo.id })}><Trash2 size={13} /></button>
                </div>
              )
            ))}
          </div>
        </>
      )}
    </div>
  );
}
