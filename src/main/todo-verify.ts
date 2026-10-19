import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

/**
 * 执行 todo 条目的验收命令。
 *
 * 语义与 Pi 自己的 bash 工具对齐（同一套 shell 解析：Windows 下 Git Bash，
 * 迁移到 stdin 的 legacy WSL bash 也照做；用户配置的 shellPath / commandPrefix
 * 由接线方透传），因为模型写给 verify 的命令就是它平时写 bash 命令的那一套；
 * 用 `spawn(command, {shell:true})` 会在 Windows 落到 cmd，`test -f` 这类命令
 * 直接失效，配置了 commandPrefix（激活 venv 等）时还会在错误环境里判定。
 *
 * 与 hooks 的执行器同一纪律：超时强杀整棵进程树、永不 reject（失败信息进
 * 结果字段）、输出有上限。区别是这里必须支持 AbortSignal——验收跑在工具调用
 * 里，用户中止本轮时要连命令一起停。
 */

/** verify 命令的长度上限：它随清单出现在对话与 UI 里，不该是一段脚本。 */
export const TODO_VERIFY_MAX_CHARS = 500;

/** 单条验收命令的默认超时。`npm test` 量级的检查足够；长任务应由模型拆小。 */
export const VERIFY_TIMEOUT_MS = 180_000;

/** 模型看到的输出上限（保留尾部——测试失败信息通常在最后）。 */
export const VERIFY_OUTPUT_CAP = 4_000;

export interface VerifyResult {
  ok: boolean;
  exitCode?: number;
  timedOut: boolean;
  aborted: boolean;
  /** stdout + stderr 合并后的尾部；超限时带截断说明。 */
  output: string;
  durationMs: number;
}

export interface VerifyRunOptions {
  /** 必须是工作区路径：验收命令在用户的项目里跑，不在安装目录里跑。 */
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** 与内建 bash 同源：SettingsManager.getShellPath()。 */
  shellPath?: string;
  /** 与内建 bash 同源：SettingsManager.getShellCommandPrefix()。 */
  commandPrefix?: string;
}

/** 保留尾部并注明截断：测试/构建的失败原因几乎总在最后几行。 */
export function truncateVerifyOutput(text: string, cap = VERIFY_OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  return `…（输出已截断，仅保留最后 ${String(cap)} 字符）\n${text.slice(-cap)}`;
}

interface ShellPlan {
  shell: string;
  args: string[];
  commandFromStdin: boolean;
}

/**
 * 解析执行用 shell。优先 Pi 的 bash 解析（与内置 bash 工具一致）；解析失败
 * （例如 Windows 上没有 Git Bash）时返回 undefined，由调用方退回系统 shell。
 */
function resolveShellPlan(shellPath: string | undefined): ShellPlan | undefined {
  try {
    const config = getShellConfig(shellPath) as { shell: string; args: string[]; commandTransport?: string };
    return {
      shell: config.shell,
      args: config.args,
      commandFromStdin: config.commandTransport === "stdin"
    };
  } catch {
    return undefined;
  }
}

/** 杀掉整棵进程树：Windows 走 System32 的 taskkill，Unix 走进程组。 */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      const child = spawn(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(pid)],
        { stdio: "ignore", detached: true, windowsHide: true }
      );
      // 失败的 spawn 会异步发 error；消费掉它，别让清理动作把进程带崩。
      child.once("error", () => undefined);
      child.unref();
    } catch {
      // taskkill 不可用就算了：超时已经发生，进程可能自己退出。
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程可能已经退出。
    }
  }
}

function failed(output: string, extra: Partial<VerifyResult> = {}): VerifyResult {
  return { ok: false, timedOut: false, aborted: false, output, durationMs: 0, ...extra };
}

export function runVerifyCommand(command: string, options: VerifyRunOptions): Promise<VerifyResult> {
  const cwd = options.cwd.trim();
  if (!cwd) return Promise.resolve(failed("当前没有工作区，无法执行验收命令。"));
  if (!existsSync(cwd)) return Promise.resolve(failed(`工作目录不存在：${cwd}`));
  if (options.signal?.aborted) return Promise.resolve(failed("验收命令已中止。", { aborted: true }));

  const timeoutMs = Math.max(100, options.timeoutMs ?? VERIFY_TIMEOUT_MS);
  const plan = resolveShellPlan(options.shellPath);
  // 与 Pi 的 bash 工具一致：commandPrefix 是用户给每条命令铺的环境（激活 venv 等），
  // 换行拼接而不是 `;`，保持前缀本身的语句边界。
  const effectiveCommand = options.commandPrefix ? `${options.commandPrefix}\n${command}` : command;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    // 按 chunk 直接 toString 会在多字节字符跨 chunk 时产生乱码；decoder 负责拼接半个字符。
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let spawnError: string | undefined;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const append = (current: string, text: string): string => {
      const next = current + text;
      // 流式阶段就裁剪，避免一条刷屏命令把内存撑爆；最终还会再裁一次。
      return next.length > VERIFY_OUTPUT_CAP * 2 ? next.slice(-VERIFY_OUTPUT_CAP * 2) : next;
    };

    const child = plan
      ? spawn(plan.shell, plan.commandFromStdin ? plan.args : [...plan.args, effectiveCommand], {
          cwd,
          detached: process.platform !== "win32",
          env: process.env,
          stdio: [plan.commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true
        })
      : spawn(effectiveCommand, {
          shell: true,
          cwd,
          detached: process.platform !== "win32",
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });

    if (plan?.commandFromStdin) {
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(effectiveCommand, "utf8");
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, stdoutDecoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, stderrDecoder.write(chunk));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killProcessTree(child.pid);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      const merged = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
      resolve({
        ok: !timedOut && !aborted && exitCode === 0,
        exitCode,
        timedOut,
        aborted,
        output: truncateVerifyOutput(
          spawnError ? `命令启动失败：${spawnError}${merged ? `\n${merged}` : ""}` : merged
        ),
        durationMs: Date.now() - startedAt
      });
    };

    child.on("error", (error) => {
      spawnError = error.message;
      finish(undefined);
    });
    child.on("close", (exitCode) => finish(exitCode ?? undefined));
  });
}
