import { connect } from "node:net";
import { normalizeBrowserUrl } from "./browser-preview-url.js";

/**
 * 服务型作品的「起服务」判定（作品墙的运行链路）。
 *
 * 背景（2026-09-23 与用户对齐）：作品登记的 `kind: "server"` 只会被「运行」当成
 * 一个地址打开——服务没在跑时，用户看到的就是一个连不上的空白页，观感等于「点了
 * 没反应」。本轮把「运行」改成：先探测地址；连不上就在终端标签里跑启动命令，等
 * 地址真的可访问再打开浏览器。
 *
 * 「可访问」的判据是 **TCP 能否连上 host:port**，不是 HTTP 状态码：dev server
 * 起来后返回 404/500 也算起来了，而 `/healthz` 之类的路径各家都不一样。这一层
 * 只管判定与等待，进程由 TerminalManager 的 PTY 持有（见 terminal-pty.ts 的
 * initialCommand），本模块保持纯逻辑 + 注入 connect，便于单测。
 */

export interface ServiceAddress {
  host: string;
  port: number;
  secure: boolean;
}

/** 单次探测的连接超时：本机端口要么立刻连上、要么立刻 refused，不需要长超时。 */
export const SERVICE_PROBE_TIMEOUT_MS = 800;
/** 轮询间隔：够快（用户感知「起来就进页面」），又不至于把事件循环刷满。 */
export const SERVICE_POLL_INTERVAL_MS = 500;
/** 等待上限的允许范围（渲染端传值，主进程钳制）。 */
export const SERVICE_WAIT_MIN_MS = 0;
export const SERVICE_WAIT_MAX_MS = 120_000;

export interface ServiceSocket {
  once(event: "connect", listener: () => void): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  destroy(): void;
}

export type ServiceConnect = (options: { host: string; port: number }) => ServiceSocket;

const defaultConnect: ServiceConnect = (options) => connect(options);

/**
 * 把作品登记的服务地址解析成 host/port。
 *
 * 走 `normalizeBrowserUrl` 而非裸 `new URL`：用户/AI 登记时写的是
 * `localhost:8787` 这种没有 scheme 的写法，裸 URL 会把它当协议
 * （protocol = "localhost:"）而判为非法——同一个字符串内置浏览器地址栏是接受的，
 * 两处口径必须一致。解析不出来返回 undefined（调用方报「地址无法解析」）。
 */
export function parseServiceAddress(input: string): ServiceAddress | undefined {
  let url: URL;
  try {
    url = new URL(normalizeBrowserUrl(input));
  } catch {
    return undefined;
  }
  const secure = url.protocol === "https:";
  const port = url.port ? Number(url.port) : (secure ? 443 : 80);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (!host) return undefined;
  return { host, port, secure };
}

/** 探测一次：TCP 连上即视为服务已就绪（见文件头判据说明）。 */
export function probeService(address: ServiceAddress, options: { timeoutMs?: number; connect?: ServiceConnect } = {}): Promise<boolean> {
  const createSocket = options.connect ?? defaultConnect;
  const timeoutMs = options.timeoutMs ?? SERVICE_PROBE_TIMEOUT_MS;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let socket: ServiceSocket;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // 已销毁/已关闭：探测结果不受影响。
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = createSocket({ host: address.host, port: address.port });
    } catch {
      finish(false);
      return;
    }
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * 启动进程的观察结果：已退出就立刻失败，不必干等满超时。
 *
 * 这是「命令立刻报错退出」与「服务真的还没起来」的分界——没有它，一次写错的启动
 * 命令也要让用户等满 30 秒才看到结果。
 */
export interface ServiceProcessWatch {
  exited: boolean;
  exitCode?: number;
  tail?: string;
}

export type ServiceWaitResult =
  | { ok: true }
  | { ok: false; reason: "invalid-url" | "timeout" | "exited"; exitCode?: number; tail?: string };

export interface ServiceWaitInput {
  url: string;
  timeoutMs: number;
  intervalMs?: number;
  probe?: (address: ServiceAddress) => Promise<boolean>;
  watch?: () => ServiceProcessWatch | undefined;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 等地址可访问，或等到必然失败。
 *
 * 顺序是「先探测、后看退出」：命令把服务 daemon 化后自己退出（exit 0）是合法
 * 形态，先看退出会把它误判成失败；反过来，服务已经监听了端口却退出，说明它确实
 * 起来了，也不该报错。
 */
export async function waitForService(input: ServiceWaitInput): Promise<ServiceWaitResult> {
  const address = parseServiceAddress(input.url);
  if (!address) return { ok: false, reason: "invalid-url" };
  const probe = input.probe ?? ((target) => probeService(target));
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = input.intervalMs ?? SERVICE_POLL_INTERVAL_MS;
  const deadline = now() + Math.max(0, input.timeoutMs);
  for (;;) {
    if (await probe(address)) return { ok: true };
    const watched = input.watch?.();
    if (watched?.exited) {
      const result: ServiceWaitResult = { ok: false, reason: "exited" };
      if (watched.exitCode !== undefined) result.exitCode = watched.exitCode;
      if (watched.tail) result.tail = watched.tail;
      return result;
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { ok: false, reason: "timeout" };
    await sleep(Math.min(interval, remaining));
  }
}

/** 渲染端传进来的 timeoutMs 可能是任意数字（含 NaN/负数）：钳到合法区间。 */
export function clampServiceWait(timeoutMs: unknown): number {
  const value = Number(timeoutMs);
  if (!Number.isFinite(value)) return 0;
  return Math.min(SERVICE_WAIT_MAX_MS, Math.max(SERVICE_WAIT_MIN_MS, Math.round(value)));
}
