import { useState, type ReactNode } from "react";
import { ListTodo, NotebookTabs, Terminal, X } from "lucide-react";
import { useDesktopStore } from "./store";
import { MIN_RUNNING_AGE_MS, TaskPanelContent } from "./TaskPanel";

/**
 * 待办浮动面板坞（原「待办 + 长期记忆」双 tab 面板坞；2026-09-08 记忆治理
 * 迁往侧边栏记忆视图——悬浮面板高度受限，预览/编辑长正文憋屈）。关闭态是
 * 一个 FAB：badge 显示待办未完成数，运行中的终端沿用小图标；打开态是单一
 * 浮动面板，头部的待办 tab 保留 data-control="task-panel-toggle" 钩子。
 */
export function PanelDock(): ReactNode {
  const todos = useDesktopStore((state) => state.todos);
  const executions = useDesktopStore((state) => state.snapshot.executions);
  const backgroundProcesses = useDesktopStore((state) => state.snapshot.backgroundProcesses);
  const [open, setOpen] = useState(false);

  const activeCount = todos.filter((todo) => todo.status !== "completed").length;
  const backgroundCount = executions.filter((execution) => execution.status === "running" && Date.now() - execution.startedAt >= MIN_RUNNING_AGE_MS).length + backgroundProcesses.length;

  if (!open) {
    return (
      <button className="panel-dock-fab" data-control="task-panel-toggle" type="button" title={`待办 ${activeCount} 项未完成${backgroundCount > 0 ? `，${backgroundCount} 个终端运行中` : ""}`} aria-label={`打开待办面板，待办 ${activeCount} 项未完成`} onClick={() => setOpen(true)}>
        <NotebookTabs size={16} />
        {activeCount > 0 && <span className="task-panel-badge">{activeCount}</span>}
        {backgroundCount > 0 && <Terminal size={13} className="task-panel-fab-running" />}
      </button>
    );
  }

  return (
    <div className="panel-dock">
      <header className="panel-dock-tabs">
        <button className="panel-dock-tab active" data-control="task-panel-toggle" type="button" role="tab" aria-selected="true" title="待办清单与运行中的终端">
          <ListTodo size={13} />
          <span>待办</span>
          {activeCount > 0 && <em>{activeCount}</em>}
        </button>
        <button className="task-panel-close panel-dock-close" type="button" title="关闭面板" aria-label="关闭待办面板" onClick={() => setOpen(false)}><X size={14} /></button>
      </header>
      <div className="panel-dock-body">
        <div className="panel-dock-pane">
          <TaskPanelContent />
        </div>
      </div>
    </div>
  );
}
