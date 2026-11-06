import { describe, expect, it } from "vitest";
import { installSingleInstanceGuard, type SingleInstanceHost } from "./single-instance.js";

/**
 * 安装版单实例守卫的行为契约（2026-11-07）。
 *
 * 用户报障：双击安装后的 exe 图标会再起一个 ChatAnyTime，而不是回到已经开着的窗口。
 * 三个结论必须钉住：
 *  1. 只有安装版（isPackaged）才碰锁——dev 与安装版并行是日常开发流程；
 *  2. 抢不到锁的次实例**立刻退出且不做任何初始化**（不注册 second-instance、不激活）；
 *  3. 启动期（ready 之前）到达的 second-instance 必须排队到启动完成后补发一次，
 *     因为 ready 之前既不能建窗口、也不能保证事件不会丢。
 */

interface HostCalls {
  locks: number;
  exits: number[];
  activations: number;
  listeners: Array<() => void>;
}

function createHost(
  options: { isPackaged?: boolean; lock?: boolean; ready?: boolean } = {},
  overrides: Partial<SingleInstanceHost> = {}
): { host: SingleInstanceHost; calls: HostCalls; setReady: (value: boolean) => void; fireSecondInstance: () => void } {
  const calls: HostCalls = { locks: 0, exits: [], activations: 0, listeners: [] };
  let ready = options.ready ?? true;
  const host: SingleInstanceHost = {
    isPackaged: options.isPackaged ?? true,
    requestLock: () => {
      calls.locks += 1;
      return options.lock ?? true;
    },
    exit: (code) => {
      calls.exits.push(code);
    },
    isReady: () => ready,
    onSecondInstance: (listener) => {
      calls.listeners.push(listener);
    },
    activate: () => {
      calls.activations += 1;
    },
    ...overrides
  };
  return { host, calls, setReady: (value) => { ready = value; }, fireSecondInstance: () => { for (const listener of calls.listeners) listener(); } };
}

describe("安装版单实例守卫", () => {
  it("dev（未打包）完全不碰锁：保持 dev 与安装版并行", () => {
    const { host, calls, fireSecondInstance } = createHost({ isPackaged: false });
    const guard = installSingleInstanceGuard(host);
    expect(guard.primary).toBe(true);
    expect(calls.locks).toBe(0);
    expect(calls.listeners).toHaveLength(0);
    expect(calls.exits).toEqual([]);
    // 没有监听器时 flush 什么都不做（不该凭空前置一个窗口）
    guard.flushPendingActivation();
    expect(calls.activations).toBe(0);
    fireSecondInstance();
    expect(calls.activations).toBe(0);
  });

  it("次实例：抢不到锁就 exit(0)、不注册 second-instance、绝不激活", () => {
    const { host, calls, fireSecondInstance } = createHost({ lock: false });
    const guard = installSingleInstanceGuard(host);
    expect(guard.primary).toBe(false);
    expect(calls.locks).toBe(1);
    expect(calls.exits).toEqual([0]);
    expect(calls.listeners).toHaveLength(0);
    guard.flushPendingActivation();
    fireSecondInstance();
    expect(calls.activations).toBe(0);
  });

  it("主实例：抢到锁后只注册一次 second-instance", () => {
    const { host, calls } = createHost();
    const guard = installSingleInstanceGuard(host);
    expect(guard.primary).toBe(true);
    expect(calls.locks).toBe(1);
    expect(calls.listeners).toHaveLength(1);
    expect(calls.exits).toEqual([]);
  });

  it("ready 之后到达：立即唤回主界面（每次都唤，不排队）", () => {
    const { host, calls, fireSecondInstance } = createHost({ ready: true });
    const guard = installSingleInstanceGuard(host);
    fireSecondInstance();
    expect(calls.activations).toBe(1);
    fireSecondInstance();
    expect(calls.activations).toBe(2);
    guard.flushPendingActivation();
    expect(calls.activations).toBe(2);
  });

  it("ready 之前到达：先排队，flush 时补发一次（幂等）", () => {
    const { host, calls, setReady, fireSecondInstance } = createHost({ ready: false });
    const guard = installSingleInstanceGuard(host);
    fireSecondInstance();
    expect(calls.activations).toBe(0);
    guard.flushPendingActivation();
    expect(calls.activations).toBe(0);
    setReady(true);
    guard.flushPendingActivation();
    expect(calls.activations).toBe(1);
    // 同一个排队请求只补发一次：再 flush 不能把窗口反复前置
    guard.flushPendingActivation();
    expect(calls.activations).toBe(1);
  });

  it("启动期连续两次双击只补发一次（用户只想看见一个窗口）", () => {
    const { host, calls, setReady, fireSecondInstance } = createHost({ ready: false });
    const guard = installSingleInstanceGuard(host);
    fireSecondInstance();
    fireSecondInstance();
    setReady(true);
    guard.flushPendingActivation();
    expect(calls.activations).toBe(1);
  });

  it("启动完成后的事件走直达路径，不再积压", () => {
    const { host, calls, setReady, fireSecondInstance } = createHost({ ready: false });
    const guard = installSingleInstanceGuard(host);
    fireSecondInstance();
    setReady(true);
    // ready 之后到达的事件直接前置，不排队
    fireSecondInstance();
    expect(calls.activations).toBe(1);
    // 启动期排队的那次随后补发
    guard.flushPendingActivation();
    expect(calls.activations).toBe(2);
  });
});
