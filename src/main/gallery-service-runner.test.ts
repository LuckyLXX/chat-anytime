import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import {
  GalleryServiceRunner,
  createShellLauncher,
  galleryServiceLogTail,
  killProcessTree,
  type GalleryServiceLauncher,
  type GalleryServiceProcessHandle
} from "./gallery-service-runner.js";
import { probeService, type ServiceAddress } from "./gallery-service.js";

/**
 * 后台服务管理器的行为契约（2026-11-12，作品墙服务型作品从「终端标签」改到「后台进程」）。
 *
 * 全部用注入件：launch / killTree / probe / 时钟。真进程的形态（shell 解析、taskkill
 * 的进程树回收）由真机与 dev 冒烟覆盖，这里钉的是**判定与状态机**——它们是静默失效的
 * 高发区：复用判错了会在同一端口上叠出两个进程，退出事件没接住会让看板永远显示「运行中」。
 */

/** 假进程句柄：可手动制造输出与退出；监听器注册前的输出/退出会补发（同真实流）。 */
function fakeHandle(pid = 4242) {
  const dataListeners: ((chunk: string) => void)[] = [];
  const exitListeners: ((info: { exitCode?: number | null; error?: string }) => void)[] = [];
  const earlyData: string[] = [];
  let earlyExit: { exitCode?: number | null; error?: string } | undefined;
  const handle: GalleryServiceProcessHandle & {
    data(chunk: string): void;
    exit(exitCode?: number | null, error?: string): void;
    killCalls: number;
  } = {
    pid,
    killCalls: 0,
    onData(listener) {
      dataListeners.push(listener);
      for (const chunk of earlyData.splice(0)) listener(chunk);
    },
    onExit(listener) {
      exitListeners.push(listener);
      if (earlyExit) listener(earlyExit);
    },
    kill() {
      handle.killCalls += 1;
    },
    data(chunk) {
      if (dataListeners.length === 0) {
        earlyData.push(chunk);
        return;
      }
      for (const listener of dataListeners) listener(chunk);
    },
    exit(exitCode, error) {
      const info = error === undefined ? { exitCode } : { exitCode, error };
      if (exitListeners.length === 0) {
        earlyExit = info;
        return;
      }
      for (const listener of exitListeners) listener(info);
    }
  };
  return handle;
}

interface Harness {
  runner: GalleryServiceRunner;
  handles: ReturnType<typeof fakeHandle>[];
  launched: { command: string; cwd: string }[];
  killed: number[];
  /** 变更通知次数（onChange 每调一次加一）。 */
  changes: { count: number };
  clock: { now: number };
}

function harness(options: {
  probe?: (address: ServiceAddress) => Promise<boolean>;
  launchError?: string;
  waitMs?: number;
  logBufferChars?: number;
  /** 进程一被拉起就做点什么（例如立刻写一行输出再退出）。 */
  onLaunch?: (handle: ReturnType<typeof fakeHandle>) => void;
} = {}): Harness {
  const handles: ReturnType<typeof fakeHandle>[] = [];
  const launched: { command: string; cwd: string }[] = [];
  const killed: number[] = [];
  const clock = { now: 1_000 };
  const changes = { count: 0 };
  const launcher: GalleryServiceLauncher = (command, cwd) => {
    if (options.launchError) throw new Error(options.launchError);
    launched.push({ command, cwd });
    const handle = fakeHandle(9_000 + handles.length);
    handles.push(handle);
    options.onLaunch?.(handle);
    return handle;
  };
  const runner = new GalleryServiceRunner({
    launch: launcher,
    killTree: (pid) => killed.push(pid),
    probe: options.probe ?? (async () => false),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    onChange: () => {
      changes.count += 1;
    },
    waitMs: options.waitMs ?? 3_000,
    ...(options.logBufferChars ? { logBufferChars: options.logBufferChars } : {})
  });
  return { runner, handles, launched, killed, changes, clock };
}

const baseInput = { appId: "g1", title: "反代", command: "node proxy.mjs", cwd: "D:/ws/proxy" };

describe("GalleryServiceRunner：启动与就绪", () => {
  it("没有探活地址：spawn 成功即「运行中」，带上 pid 与目录", async () => {
    const h = harness();
    const result = await h.runner.start(baseInput);
    expect(result.ok).toBe(true);
    expect(h.launched).toEqual([{ command: "node proxy.mjs", cwd: "D:/ws/proxy" }]);
    const list = h.runner.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ appId: "g1", title: "反代", status: "running", ready: true, pid: 9_000 });
  });

  it("有探活地址：探针通过才算就绪，超时则如实标「未就绪」但进程留在看板上", async () => {
    let probes = 0;
    const ready = harness({ probe: async () => { probes += 1; return probes >= 2; } });
    expect((await ready.runner.start({ ...baseInput, url: "http://127.0.0.1:8787" })).ok).toBe(true);
    expect(ready.runner.list()[0]?.ready).toBe(true);

    const never = harness({ probe: async () => false, waitMs: 1_200 });
    const result = await never.runner.start({ ...baseInput, url: "http://127.0.0.1:8787" });
    expect(result.ok).toBe(false);
    const record = never.runner.list()[0];
    // 进程还活着（不是失败进程）：留在看板上，ready=false + 一句可读的说明
    expect(record).toMatchObject({ status: "running", ready: false });
    expect(record?.note).toContain("超时");
    expect(never.killed).toEqual([]);
  });
});

describe("GalleryServiceRunner：复用与重启", () => {
  it("同命令同目录重复「运行」不叠进程（复用同一个记录）", async () => {
    const h = harness();
    const first = await h.runner.start(baseInput);
    const second = await h.runner.start(baseInput);
    expect(h.launched).toHaveLength(1);
    expect(first.ok && second.ok && first.record?.id === second.record?.id).toBe(true);
    expect(second.ok && second.reused).toBe(true);
  });

  it("复用已就绪的服务不再重等一轮预算（再点一次运行不该卡 30 秒）", async () => {
    let probes = 0;
    // 第 1 次探针是「地址已可达吗」（此时没起过 → false，于是真的 spawn）；
    // 之后探针通过 → 就绪。
    const h = harness({ probe: async () => { probes += 1; return probes > 1; } });
    const input = { ...baseInput, url: "http://127.0.0.1:8787" };
    expect((await h.runner.start(input)).ok).toBe(true);
    expect(h.launched).toHaveLength(1);
    const probesAfterStart = probes;
    const again = await h.runner.start(input);
    expect(again.ok && again.reused).toBe(true);
    expect(probes).toBe(probesAfterStart);
  });

  it("命令变了要先停旧进程、等它退出再起新的", async () => {
    const h = harness();
    const first = await h.runner.start(baseInput);
    const firstId = first.ok ? first.record?.id : undefined;
    const pending = h.runner.start({ ...baseInput, command: "node proxy2.mjs" });
    // 旧的还在跑：停它（killTree + 单进程 kill）
    await Promise.resolve();
    expect(h.killed).toEqual([9_000]);
    // 有 pid 时**只**走进程树回收：再同时 handle.kill() 会先打死 shell，
    // taskkill /T 随后找不到父子关系，孙进程（node）反而活下来占着端口。
    expect(h.handles[0]?.killCalls).toBe(0);
    h.handles[0]?.exit(null);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(h.launched.map((entry) => entry.command)).toEqual(["node proxy.mjs", "node proxy2.mjs"]);
    expect(h.runner.list().find((record) => record.id === firstId)?.status).toBe("stopped");
  });

  it("地址已可达时不另起进程（用户手工起的服务不碰）", async () => {
    const h = harness({ probe: async () => true });
    const result = await h.runner.start({ ...baseInput, url: "http://127.0.0.1:8787" });
    expect(result.ok).toBe(true);
    expect(result.ok && result.external).toBe(true);
    expect(h.launched).toEqual([]);
    expect(h.runner.list()).toEqual([]);
  });

  it("restart 用同一份登记停掉再起（新进程、新记录、同 appId）", async () => {
    const h = harness();
    const first = await h.runner.start(baseInput);
    const pending = h.runner.restart(first.ok ? first.record!.id : "");
    await Promise.resolve();
    h.handles[0]?.exit(null);
    const second = await pending;
    expect(second.ok).toBe(true);
    expect(h.launched).toHaveLength(2);
    const live = h.runner.list().filter((record) => record.status === "running");
    expect(live).toHaveLength(1);
    expect(live[0]?.appId).toBe("g1");
  });
});

describe("GalleryServiceRunner：退出、停止与清理", () => {
  it("进程非 0 退出：标记失败、保留退出码与输出尾部（看板要能回答「为啥没起来」）", async () => {
    const h = harness();
    await h.runner.start(baseInput);
    h.handles[0]?.data("\u001b[31mError: EADDRINUSE\u001b[0m 8787\n");
    h.handles[0]?.exit(1);
    const record = h.runner.list()[0];
    expect(record).toMatchObject({ status: "failed", exitCode: 1 });
    expect(record?.log).toContain("EADDRINUSE"); // ANSI 已剥
    expect(record?.note).toContain("1");
  });

  it("退出码 0 视为正常结束（启动器形态），不算失败", async () => {
    const h = harness();
    await h.runner.start(baseInput);
    h.handles[0]?.exit(0);
    expect(h.runner.list()[0]).toMatchObject({ status: "stopped", exitCode: 0 });
  });

  it("stop 结束进程树；再点一次把已结束的记录移出看板", async () => {
    const h = harness();
    const started = await h.runner.start(baseInput);
    const id = started.ok ? started.record!.id : "";
    expect(h.runner.stop(id)).toBe(true);
    expect(h.killed).toEqual([9_000]);
    h.handles[0]?.exit(null);
    expect(h.runner.list()[0]).toMatchObject({ status: "stopped", note: "已手动停止" });
    expect(h.runner.stop(id)).toBe(true);
    expect(h.runner.list()).toEqual([]);
  });

  it("stopByOwner：只停面板自己起的服务", async () => {
    const h = harness();
    await h.runner.start({ ...baseInput, appId: "panel-a", ownerPanelId: "panel-a" });
    await h.runner.start({ ...baseInput, appId: "panel-b", ownerPanelId: "panel-b" });
    await h.runner.start({ ...baseInput, appId: "server-c" });
    expect(h.runner.stopByOwner("panel-a")).toBe(1);
    expect(h.killed).toEqual([9_000]);
    // 进程被杀到退出事件到达之间状态仍是「运行中」（note = 正在停止…）：
    // 退出回调到达后才真正变成已停止。
    h.handles[0]?.exit(null);
    expect(h.runner.list().filter((record) => record.status === "running").map((record) => record.appId)).toEqual(["panel-b", "server-c"]);
  });

  it("disposeAll：把所有活着的进程树都杀掉（应用退出不留孤儿）", async () => {
    const h = harness();
    await h.runner.start({ ...baseInput, appId: "a" });
    await h.runner.start({ ...baseInput, appId: "b" });
    h.runner.disposeAll();
    expect(h.killed).toEqual([9_000, 9_001]);
    expect(h.runner.list()).toEqual([]);
  });

  it("spawn 抛错：记录标失败并给出原因（不静默）", async () => {
    const h = harness({ launchError: "spawn cmd.exe ENOENT" });
    const result = await h.runner.start(baseInput);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("ENOENT");
    expect(h.runner.list()[0]).toMatchObject({ status: "failed" });
    expect(h.runner.list()[0]?.note).toContain("ENOENT");
  });

  it("起不来时的提示用 shared 层的唯一文案（带退出码与输出尾部，不各写一套）", async () => {
    // 进程一拉起来就写一行错并退出（退出事件放在微任务里发：监听器在 launch 返回后才注册）。
    const h = harness({
      probe: async () => false,
      onLaunch: (handle) => {
        handle.data("Error: Cannot find module 'express'\n");
        queueMicrotask(() => handle.exit(1));
      }
    });
    const result = await h.runner.start({ ...baseInput, url: "http://127.0.0.1:8787" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("已退出（代码 1）");
    expect(!result.ok && result.message).toContain("Cannot find module");
    // 多行输出压成一行（toast 是单行流式布局）
    expect(!result.ok && result.message).not.toContain("\n");
  });

  it("日志缓冲有上限（不会因为一个话痨 dev server 把内存吃掉）", async () => {
    const h = harness({ logBufferChars: 40 });
    await h.runner.start(baseInput);
    h.handles[0]?.data("0123456789".repeat(20));
    const log = h.runner.list()[0]?.log ?? "";
    expect(log.length).toBeLessThanOrEqual(40);
    expect(log.endsWith("0123456789")).toBe(true);
  });
});

describe("galleryServiceLogTail", () => {
  it("剥 ANSI 并只保留尾部", () => {
    expect(galleryServiceLogTail("\u001b[32mok\u001b[0m\n", 100)).toBe("ok\n");
    expect(galleryServiceLogTail("abcdef", 3)).toBe("def");
  });
});

/** 拿一个当前空闲的本机端口（先 bind(0) 再关掉，随后交给被测进程用）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("取不到空闲端口")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/**
 * 真实进程的一次性集成（不注入任何假件）：这条路径覆盖的正是假件替不掉的四件事——
 * shell 解析（Windows 的 cmd 走环境变量）、spawn 的 stdio 配置、`waitForService` 的
 * 真 TCP 就绪判定、以及 `killProcessTree` 真能把孙进程（node）带走。
 */
describe("真实进程：起服务 → 判定就绪 → 结束进程树", () => {
  it("node http 服务被后台拉起、探活通过，停止后端口不再监听", async () => {
    const port = await freePort();
    const runner = new GalleryServiceRunner({
      launch: createShellLauncher(),
      killTree: killProcessTree,
      waitMs: 25_000
    });
    const script = `require('http').createServer((req,res)=>res.end('ok')).listen(${port},'127.0.0.1')`;
    const result = await runner.start({
      appId: "real-1",
      title: "真实服务",
      command: `node -e "${script}"`,
      cwd: process.cwd(),
      url: `http://127.0.0.1:${port}`
    });
    expect(result.ok, !result.ok ? result.message : "").toBe(true);
    const record = runner.list()[0];
    expect(record?.status).toBe("running");
    expect(record?.ready).toBe(true);
    expect(record?.pid).toBeGreaterThan(0);
    expect(await probeService({ host: "127.0.0.1", port, secure: false })).toBe(true);

    expect(runner.stop(record!.id)).toBe(true);
    // 进程退出事件到达后端口必须真的没人听了（killTree 带走 node 孙进程）
    const deadline = Date.now() + 10_000;
    let listening = true;
    while (Date.now() < deadline) {
      listening = await probeService({ host: "127.0.0.1", port, secure: false }, { timeoutMs: 300 });
      if (!listening) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(listening).toBe(false);
    // 端口先没人听（killTree 带走了 node 孙进程）；退出事件随后才到达记录上，
    // 所以状态要再单独等一小会儿——两件事的顺序在真进程上是异步的。
    const statusDeadline = Date.now() + 10_000;
    while (Date.now() < statusDeadline && runner.list()[0]?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(runner.list()[0]?.status).not.toBe("running");
  }, 40_000);
});
