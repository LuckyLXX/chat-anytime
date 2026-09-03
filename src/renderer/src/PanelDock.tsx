import { useState, type ReactNode } from "react";
import { Brain, ListTodo, NotebookTabs, Terminal, X } from "lucide-react";
import { useDesktopStore } from "./store";
import { MIN_RUNNING_AGE_MS, TaskPanelContent } from "./TaskPanel";
import { MemoryPanelContent } from "./MemoryPanel";

type PanelTab = "tasks" | "memory";

/**
 * 待办 + 长期记忆 的合并面板坞（原 TaskPanel / MemoryPanel 各自独立并共用
 * 右上角区域时会重叠）。关闭态是一个 FAB：badge 显示待办未完成数与记忆
 * 主题数，运行中的终端沿用小图标。打开态是单一浮动面板，head 为两个
 * tab——待办（默认在前）与记忆；两个内容页始终挂载（隐藏而非卸载），
 * tab 切换不丢各自的编辑/展开状态。
 *
 * 主题钩子保持不变：data-pane="task-panel"/"memory-panel" 各自留在内容页
 * 根节点上；data-control="task-panel-toggle" 在 FAB 与待办 tab 上，
 * data-control="memory-toggle" 在记忆 tab 上。
 */
export function PanelDock(): ReactNode {
  const todos = useDesktopStore((state) => state.todos);
  const memory = useDesktopStore((state) => state.memory);
  const executions = useDesktopStore((state) => state.snapshot.executions);
  const backgroundProcesses = useDesktopStore((state) => state.snapshot.backgroundProcesses);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>("tasks");

  const activeCount = todos.filter((todo) => todo.status !== "completed").length;
  const backgroundCount = executions.filter((execution) => execution.status === "running" && Date.now() - execution.startedAt >= MIN_RUNNING_AGE_MS).length + backgroundProcesses.length;

  if (!open) {
    return (
      <button className="panel-dock-fab" data-control="task-panel-toggle" type="button" title={`待办 ${activeCount} 项未完成${backgroundCount > 0 ? `，${backgroundCount} 个终端运行中` : ""} · 长期记忆 ${memory.length} 个主题`} aria-label={`打开任务与记忆面板，待办 ${activeCount} 项未完成，记忆 ${memory.length} 个主题`} onClick={() => setOpen(true)}>
        <NotebookTabs size={16} />
        {activeCount > 0 && <span className="task-panel-badge">{activeCount}</span>}
        {memory.length > 0 && <span className="task-panel-badge neutral">{memory.length}</span>}
        {backgroundCount > 0 && <Terminal size={13} className="task-panel-fab-running" />}
      </button>
    );
  }

  return (
    <div className="panel-dock">
      <header className="panel-dock-tabs">
        <button className={`panel-dock-tab${tab === "tasks" ? " active" : ""}`} data-control="task-panel-toggle" type="button" role="tab" aria-selected={tab === "tasks"} title="待办清单与运行中的终端" onClick={() => setTab("tasks")}>
          <ListTodo size={13} />
          <span>待办</span>
          {activeCount > 0 && <em>{activeCount}</em>}
        </button>
        <button className={`panel-dock-tab${tab === "memory" ? " active" : ""}`} data-control="memory-toggle" type="button" role="tab" aria-selected={tab === "memory"} title="长期记忆治理" onClick={() => setTab("memory")}>
          <Brain size={13} />
          <span>记忆</span>
          {memory.length > 0 && <em>{memory.length}</em>}
        </button>
        <button className="task-panel-close panel-dock-close" type="button" title="关闭面板" aria-label="关闭任务与记忆面板" onClick={() => setOpen(false)}><X size={14} /></button>
      </header>
      <div className="panel-dock-body">
        <div className="panel-dock-pane" hidden={tab !== "tasks"}>
          <TaskPanelContent />
        </div>
        <div className="panel-dock-pane" hidden={tab !== "memory"}>
          <MemoryPanelContent />
        </div>
      </div>
    </div>
  );
}