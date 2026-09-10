import { createBashToolDefinition, createPowerShellToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * 可单独终止的 shell 工具（bash / powershell）。
 *
 * 任务面板此前对「运行中的终端」点停止只能发 session.abort——整个回合被中止。
 * 这里用同名 customTools 覆盖内建定义（AgentSession._refreshToolRegistry 对
 * customTools 按 name 后写胜出），工厂与选项和 Pi 内部构造完全一致，schema /
 * description 字节不变，不影响请求前缀缓存。包装只在 execute 一层：
 *
 * - 每次调用派生独立 AbortController，同时桥接运行级 abort 信号（整回合适别
 *   中止时行为与原内建工具完全相同）与用户按命令终止；
 * - 用户终止 → controller.abort() → Pi exec 层杀进程树并抛 "aborted" → 内建
 *   工具抛 `…\n\nCommand aborted` → 包装层识别为用户终止，把状态行改写为
 *   「用户已终止」说明后重新抛出。agent loop 把工具错误作为 error 结果回给
 *   模型并继续本轮（会话不中止），模型据此知道命令被用户停止；
 * - kill() 以 Pi 的 toolCallId（即 ToolExecution.id）定位在途调用；未在执行
 *   时返回 false。
 */

/** 模型可见的终止说明：替换内建工具的 "Command aborted" 状态行。 */
export const USER_KILL_NOTICE = "用户在任务面板手动终止了这条命令的进程（会话未中止，其余工作不受影响）。以上是终止前已捕获的输出，请基于当前进度继续任务。";

export interface KillableShellTools {
  /** 与被替换内建工具同名的定义（bash / powershell），交给 customTools。 */
  tools: ToolDefinition[];
  /** 终止一条在途 shell 调用（杀进程树）；id 不在执行中时返回 false。 */
  kill(toolCallId: string): boolean;
}

export function buildKillableShellTools(options: {
  cwd: string;
  /** 与内建 bash 相同的来源：SettingsManager.getShellCommandPrefix()。 */
  commandPrefix?: string;
  /** SettingsManager.getShellPath()。 */
  shellPath?: string;
}): KillableShellTools {
  const pending = new Map<string, () => void>();
  const bash = createBashToolDefinition(options.cwd, { commandPrefix: options.commandPrefix, shellPath: options.shellPath });
  const powershell = createPowerShellToolDefinition(options.cwd);
  return {
    tools: [wrapKillable(bash, pending), wrapKillable(powershell, pending)],
    kill(toolCallId) {
      const kill = pending.get(toolCallId);
      if (!kill) return false;
      kill();
      return true;
    }
  };
}

function wrapKillable(base: ToolDefinition<any, any, any>, pending: Map<string, () => void>): ToolDefinition {
  return {
    ...base,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const controller = new AbortController();
      let killedByUser = false;
      const forwardAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", forwardAbort, { once: true });
      }
      pending.set(toolCallId, () => {
        killedByUser = true;
        controller.abort();
      });
      try {
        return await base.execute(toolCallId, params, controller.signal, onUpdate, ctx);
      } catch (error) {
        // 仅用户按命令终止时改写状态行；整回合适别中止（killedByUser=false）
        // 与其它失败原样透传，保持内建工具既有语义。
        if (killedByUser && error instanceof Error && /(?:\n\n)?Command aborted$/u.test(error.message)) {
          const text = error.message.replace(/(?:\n\n)?Command aborted$/u, "");
          throw new Error(`${text ? `${text}\n\n` : ""}${USER_KILL_NOTICE}`);
        }
        throw error;
      } finally {
        pending.delete(toolCallId);
        if (signal) signal.removeEventListener("abort", forwardAbort);
      }
    }
  };
}
