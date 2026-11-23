/**
 * utility 侧的 Codex 进程桥：把 main 的受监管进程包装成「可写 / 可停 / 可收事件」的句柄。
 *
 * 与 main 的契约（见 `shared/protocol.ts` 的 codex.process.*）：
 * - utility 生成 handle，main 只按 handle 记账；每次 utility 重启都换一套句柄，
 *   旧句柄在新实例里不可达（迟到的 stdout/exit 按 handle 丢弃）。
 * - `codex.process.start-result` 是唯一受理回执；失败带可读原因（校验/上限/spawn error）。
 * - 停止后只转发 exit（让客户端把挂起请求收场），stdout/stderr 一律丢弃。
 */

import { randomUUID } from "node:crypto";
import type { CodexProcessEvent, CodexProcessStartOptions, RuntimeCommand, RuntimeMessage } from "../shared/protocol.js";

/** 等 main 受理启动的上限（spawn 本身在主进程最多等 5s）。 */
export const CODEX_PROCESS_START_TIMEOUT_MS = 20_000;

export interface CodexProcessHandle {
  readonly handle: string;
  readonly pid?: number;
  /** 写一帧（JSONL 文本，调用方负责换行）。停止/退出后静默丢弃。 */
  write(data: string): void;
  /** 停止整棵进程树（幂等）。 */
  stop(reason?: string): void;
  /** 订阅事件；返回取消订阅。 */
  onEvent(listener: (event: CodexProcessEvent) => void): () => void;
  readonly closed: boolean;
}

export interface CodexProcessBridgeOptions {
  /** 发给 main 的消息通道（utility 的 parentPort.postMessage 包装）。 */
  post(message: RuntimeMessage): void;
  startTimeoutMs?: number;
  newHandleId?(): string;
}

interface PendingStart {
  handle: string;
  resolve(pid: number | undefined): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface LiveHandle {
  handle: string;
  pid?: number;
  listeners: Set<(event: CodexProcessEvent) => void>;
  stopping: boolean;
  settled: boolean;
  /**
   * 监听器挂上之前的早期事件（spawn 后立刻来的 stderr 警告、极快的 exit）。
   * 有界：只留最近 64 条，避免无人订阅时吃掉内存。
   */
  buffer: CodexProcessEvent[];
  /** exit 之后还没人订阅时的回收定时器。 */
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

/** 一个 utility 实例内的 Codex 进程句柄表。 */
export class CodexProcessBridge {
  private readonly handles = new Map<string, LiveHandle>();
  private readonly pendingStarts = new Map<string, PendingStart>();
  private readonly startTimeoutMs: number;
  private readonly post: (message: RuntimeMessage) => void;
  private readonly newHandleId: () => string;
  private disposed = false;

  constructor(options: CodexProcessBridgeOptions) {
    this.post = options.post;
    this.startTimeoutMs = options.startTimeoutMs ?? CODEX_PROCESS_START_TIMEOUT_MS;
    this.newHandleId = options.newHandleId ?? (() => `codex-${randomUUID()}`);
  }

  /** 拉起一条 Codex 进程；main 校验/上限/spawn 失败都会在这里以可读错误抛出。 */
  start(options: CodexProcessStartOptions): Promise<CodexProcessHandle> {
    if (this.disposed) return Promise.reject(new Error("Codex 进程桥已关闭（运行时正在退出）"));
    const handle = this.newHandleId();
    const requestId = `codex-start-${handle}`;
    return new Promise<CodexProcessHandle>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStarts.delete(requestId);
        this.post({ type: "codex.process.stop", handle, reason: "启动超时" });
        reject(new Error(`Codex 进程启动超时（${Math.round(this.startTimeoutMs / 1000)} 秒未受理）`));
      }, this.startTimeoutMs);
      timer.unref?.();
      this.pendingStarts.set(requestId, {
        handle,
        timer,
        resolve: (pid) => {
          const live: LiveHandle = { handle, listeners: new Set(), stopping: false, settled: false, buffer: [], ...(pid === undefined ? {} : { pid }) };
          this.handles.set(handle, live);
          resolve({
            handle,
            get pid() { return live.pid; },
            write: (data: string) => this.write(handle, data),
            stop: (reason?: string) => this.stop(handle, reason),
            onEvent: (listener) => this.subscribe(handle, listener),
            get closed() { return live.settled; }
          });
        },
        reject
      });
      try {
        this.post({ type: "codex.process.start", requestId, handle, options });
      } catch (error) {
        clearTimeout(timer);
        this.pendingStarts.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * 处理 main 回推的 Codex 消息；返回 true = 已消费（调用方不要入命令队列、
   * 也不要转发渲染端）。
   */
  handleMessage(message: RuntimeCommand): boolean {
    if (message.type === "codex.process.start-result") {
      const pending = this.pendingStarts.get(message.requestId);
      if (!pending) return true; // 已超时/已取消的迟到回执
      this.pendingStarts.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.pid);
      else pending.reject(new Error(message.error));
      return true;
    }
    if (message.type === "codex.process.event") {
      const live = this.handles.get(message.handle);
      if (!live) return true; // 已回收句柄的迟到事件
      const event = message.event;
      if (event.kind === "exit") {
        if (live.settled) return true;
        live.settled = true;
        if (live.listeners.size === 0) {
          // 还没人订阅：先留着，等订阅时补发（超时后丢弃）。
          live.buffer.push(event);
          live.cleanupTimer = setTimeout(() => this.handles.delete(live.handle), 60_000);
          live.cleanupTimer.unref?.();
          return true;
        }
        for (const listener of [...live.listeners]) listener(event);
        live.listeners.clear();
        this.handles.delete(live.handle);
        return true;
      }
      if (live.stopping) return true;
      if (live.listeners.size === 0) {
        live.buffer.push(event);
        if (live.buffer.length > 64) live.buffer.shift();
        return true;
      }
      for (const listener of [...live.listeners]) listener(event);
      return true;
    }
    return false;
  }

  /** utility 退出：尽力停掉全部进程（main 在 utility 退出时也会兜底回收）。 */
  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pending of [...this.pendingStarts.values()]) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex 进程桥已关闭（运行时正在退出）"));
    }
    this.pendingStarts.clear();
    for (const live of [...this.handles.values()]) {
      if (live.cleanupTimer) clearTimeout(live.cleanupTimer);
      live.stopping = true;
      try {
        this.post({ type: "codex.process.stop", handle: live.handle, reason: "运行时退出" });
      } catch {
        // 通道已经断了：main 会按 utility 退出回收。
      }
      live.settled = true;
      live.listeners.clear();
    }
    this.handles.clear();
  }

  private write(handle: string, data: string): void {
    const live = this.handles.get(handle);
    if (!live || live.stopping || live.settled || !data) return;
    this.post({ type: "codex.process.write", handle, data });
  }

  private stop(handle: string, reason?: string): void {
    const live = this.handles.get(handle);
    if (!live || live.stopping) return;
    live.stopping = true;
    this.post({ type: "codex.process.stop", handle, ...(reason ? { reason } : {}) });
  }

  private subscribe(handle: string, listener: (event: CodexProcessEvent) => void): () => void {
    const live = this.handles.get(handle);
    if (!live) return () => undefined;
    if (live.buffer.length > 0) {
      // 重放早期事件（含「还没来得及订阅就退出」的 exit），订阅之后清空。
      const pending = live.buffer.splice(0);
      for (const event of pending) listener(event);
    }
    if (live.settled) return () => undefined;
    live.listeners.add(listener);
    return () => live.listeners.delete(listener);
  }
}
