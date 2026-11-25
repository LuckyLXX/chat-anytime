import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import {
  GalleryServiceOutputDecoder,
  GalleryServiceRunner,
  createShellLauncher,
  defaultServiceLegacyEncodings,
  galleryServiceLogTail,
  killProcessTree,
  utf8CompletePrefixLength,
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
function fakeHandle(pid?: number) {
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
  /** 异步 spawn 失败：句柄从来没有 pid，且在下一个宏任务发 error（Node 的 ENOENT 就是这个形态）。 */
  spawnError?: string;
  /** 句柄没有 pid，但也不报错（启动器没交出进程号）。 */
  noPid?: boolean;
  /** 固定 pid（例如 `process.pid`：验证「停止没生效」时需要一个真的还活着的 pid）。 */
  pid?: number;
  waitMs?: number;
  stopGraceMs?: number;
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
    const handle = fakeHandle(options.noPid || options.spawnError ? undefined : (options.pid ?? 9_000 + handles.length));
    handles.push(handle);
    options.onLaunch?.(handle);
    if (options.spawnError) {
      const message = options.spawnError;
      setImmediate(() => handle.exit(null, message));
    }
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
    ...(options.stopGraceMs ? { stopGraceMs: options.stopGraceMs } : {}),
    ...(options.logBufferChars ? { logBufferChars: options.logBufferChars } : {})
  });
  return { runner, handles, launched, killed, changes, clock };
}

/** 让出若干微任务：把「排队 → spawn → 进入探活」这几步走到位，不用数 microtask 层数。 */
async function flush(turns = 12): Promise<void> {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
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
    expect((await h.runner.start(baseInput)).ok).toBe(true);
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
    // 旧记录随着新纪录登记被换掉（同一作品只留一行，见「看板唯一性」）——这里能看出的
    // 是「旧进程确实被停了」：它先被 killTree，退出事件到时才有地方接着起新进程。
    expect(h.runner.list().filter((record) => record.appId === "g1")).toMatchObject([{ id: result.ok ? result.record?.id : "", status: "running" }]);
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

  it("服务就绪后退出码 0 视为正常结束，不算启动失败", async () => {
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

  it("探活地址解析不了：spawn 前就 fail-closed（不留「运行中」的无主进程）", async () => {
    const h = harness();
    const result = await h.runner.start({ ...baseInput, url: "ftp://example.com:21" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("无法解析");
    expect(!result.ok && result.failure?.reason).toBe("invalid-url");
    // 关键：根本没有执行启动命令，也没在看板上留下记录
    expect(h.launched).toEqual([]);
    expect(h.runner.list()).toEqual([]);
  });

  it("换命令 + 坏地址：先校验地址，不会把已在跑的服务停掉再失败", async () => {
    const h = harness();
    const first = await h.runner.start(baseInput);
    expect(first.ok).toBe(true);
    const bad = await h.runner.start({ ...baseInput, command: "node proxy2.mjs", url: "ftp://example.com:21" });
    expect(bad.ok).toBe(false);
    expect(h.killed).toEqual([]); // 旧进程没被误杀
    expect(h.launched).toHaveLength(1);
    expect(h.runner.list().filter((record) => record.status === "running")).toHaveLength(1);
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

/**
 * 看板唯一性（2026-11-25，用户报「同一个服务已经关闭了还会重复出现，没有保证唯一」）。
 *
 * 病根不在展示层：`entries` 每次 start 都新建一条记录，而上一次运行留下的**已结束**记录
 * 一直留在里面——同一作品跑几次，看板上就有几行同名记录（一行在跑、其余「已停止」）。
 * 契约：**一个作品（appId）在看板上永远只有一行**，新记录登记时替换同作品已结束的记录；
 * 别的作品的记录、以及还活着的记录一律不碰。
 */
describe("GalleryServiceRunner：看板唯一性（同一作品只留一行）", () => {
  it("停止后再运行：上一次已结束的记录被新记录替换，不会叠出第二行", async () => {
    const h = harness();
    const first = await h.runner.start(baseInput);
    expect(h.runner.stop(first.ok ? first.record!.id : "")).toBe(true);
    h.handles[0]?.exit(null);
    expect(h.runner.list()).toMatchObject([{ appId: "g1", status: "stopped" }]);

    const again = await h.runner.start(baseInput);
    expect(again.ok).toBe(true);
    const rows = h.runner.list().filter((record) => record.appId === "g1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: again.ok ? again.record!.id : "", status: "running" });
  });

  it("启动失败后再运行：失败记录随新记录一起被替换（看板不堆同一作品的失败历史）", async () => {
    const h = harness();
    await h.runner.start(baseInput);
    h.handles[0]?.exit(1); // 起不来 → 看板留一条「启动失败」
    expect(h.runner.list()).toMatchObject([{ status: "failed" }]);

    const retry = await h.runner.start(baseInput);
    expect(retry.ok).toBe(true);
    const rows = h.runner.list().filter((record) => record.appId === "g1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("running");
  });

  it("面板关窗停止后重新打开：仍只有一行（关窗留下的已停止记录被替换）", async () => {
    const h = harness();
    const panelInput = { ...baseInput, appId: "panel-a", ownerPanelId: "panel-a" };
    await h.runner.start(panelInput);
    const ticket = h.runner.prepareOwnerStop("panel-a");
    expect(h.runner.stopByOwner("panel-a", ticket)).toBe(1);
    h.handles[0]?.exit(null);
    expect(h.runner.list().filter((record) => record.appId === "panel-a")).toHaveLength(1);

    const reopened = await h.runner.start(panelInput);
    expect(reopened.ok).toBe(true);
    const rows = h.runner.list().filter((record) => record.appId === "panel-a");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("running");
  });

  it("只替换同一个 appId：别的作品（包括它已结束的记录）原样保留", async () => {
    const h = harness();
    await h.runner.start({ ...baseInput, appId: "a" });
    await h.runner.start({ ...baseInput, appId: "b" });
    // 两个都停掉：看板上每个作品各留一条「已停止」
    h.runner.stop(h.runner.list().find((record) => record.appId === "a")!.id);
    h.handles[0]?.exit(null);
    h.runner.stop(h.runner.list().find((record) => record.appId === "b")!.id);
    h.handles[1]?.exit(null);
    expect(h.runner.list().map((record) => `${record.appId}:${record.status}`).sort()).toEqual(["a:stopped", "b:stopped"]);

    // 只重跑 b：b 的旧记录被新记录替掉，a 的已结束记录原样留着（清理绝不越过 appId）
    expect((await h.runner.start({ ...baseInput, appId: "b" })).ok).toBe(true);
    const rows = h.runner.list();
    expect(rows.filter((record) => record.appId === "b")).toMatchObject([{ status: "running" }]);
    expect(rows.filter((record) => record.appId === "a")).toMatchObject([{ status: "stopped" }]);
  });
});

/**
 * 并发与竞态（2026-11-16 计划 4.4）。
 *
 * 这一组全是「不报错、不崩溃，但结果错」的时序：双击运行叠两个进程、停止中的记录被复用、
 * 旧进程没走就起新的、关窗的迟到回调误杀重开的面板。假件（launch / killTree / probe / 时钟）
 * 让这些时序变成确定性的序列，不靠真计时碰运气。
 */
describe("GalleryServiceRunner：并发（同 appId 串行 + 同请求合流）", () => {
  it("同参数并发两次 start 合流：只 spawn 一次，两边拿到同一份回执", async () => {
    const h = harness();
    const first = h.runner.start(baseInput);
    const second = h.runner.start(baseInput);
    const [a, b] = await Promise.all([first, second]);
    expect(h.launched).toHaveLength(1);
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && b.ok && a.record?.id === b.record?.id).toBe(true);
    expect(a).toBe(b);
  });

  it("不同命令并发：排队执行（先停旧再起新），不会同时在跑两个", async () => {
    const h = harness();
    const first = h.runner.start(baseInput);
    const second = h.runner.start({ ...baseInput, command: "node proxy2.mjs" });
    await flush();
    // 第一支已经起好（无 url → 立即就绪）；第二支停在「等旧进程真的退出」
    expect(h.launched).toHaveLength(1);
    expect(h.killed).toEqual([9_000]);
    h.handles[0]?.exit(null);
    const [a, b] = await Promise.all([first, second]);
    expect(a.ok && b.ok).toBe(true);
    expect(h.launched.map((entry) => entry.command)).toEqual(["node proxy.mjs", "node proxy2.mjs"]);
    expect(h.runner.list().filter((record) => record.status === "running")).toHaveLength(1);
  });

  it("不同 appId 各起各的（队列按作品隔离，不互相阻塞）", async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.runner.start({ ...baseInput, appId: "g1" }),
      h.runner.start({ ...baseInput, appId: "g2" })
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(h.launched).toHaveLength(2);
    expect(h.runner.list().filter((record) => record.status === "running").map((record) => record.appId).sort()).toEqual(["g1", "g2"]);
  });
});

describe("GalleryServiceRunner：停止态闸门（不许复用、不许叠进程）", () => {
  it("停止中的记录不许复用：再点运行返回「正在停止，请稍后再运行」，且不再 spawn", async () => {
    const h = harness();
    const started = await h.runner.start(baseInput);
    const id = started.ok ? started.record!.id : "";
    expect(h.runner.stop(id)).toBe(true);
    // 退出事件还没到：记录仍算活着，但已经在停止态
    const again = await h.runner.start(baseInput);
    expect(again.ok).toBe(false);
    expect(!again.ok && again.message).toContain("正在停止，请稍后再运行");
    expect(h.launched).toHaveLength(1);
    expect(h.killed).toEqual([9_000]);
  });

  it("重复点停止是幂等的：进程树只回收一次", async () => {
    const h = harness();
    const started = await h.runner.start(baseInput);
    const id = started.ok ? started.record!.id : "";
    expect(h.runner.stop(id)).toBe(true);
    expect(h.runner.stop(id)).toBe(true);
    expect(h.killed).toEqual([9_000]);
  });

  it("启动等待期间点停止：在途 start 明确说「已取消」，不报成探活超时", async () => {
    const gates: ((ok: boolean) => void)[] = [];
    const h = harness({ probe: () => new Promise<boolean>((resolve) => gates.push(resolve)) });
    const pending = h.runner.start({ ...baseInput, url: "http://127.0.0.1:8787" });
    await flush();
    gates.shift()?.(false); // 外部服务探活：不可达 → 真的去 spawn
    await flush();
    const id = h.runner.list()[0]?.id ?? "";
    expect(id).not.toBe("");
    expect(h.runner.stop(id)).toBe(true);
    h.handles[0]?.exit(null);
    gates.shift()?.(false); // 就绪轮询里的那一次探活
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("已取消");
    expect(h.runner.list()[0]).toMatchObject({ status: "stopped" });
  });

  it("restart：旧进程在宽限内没退出就不起新进程，并明确说「可能仍在运行」", async () => {
    // 用一个**真的活着**的 pid（本进程）：停止兜底定时器才会判「kill 没生效」
    const h = harness({ pid: process.pid, stopGraceMs: 30 });
    const started = await h.runner.start(baseInput);
    const result = await h.runner.restart(started.ok ? started.record!.id : "");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("可能仍在运行");
    expect(h.launched).toHaveLength(1);
    const record = h.runner.list()[0];
    // 旧记录仍然算活着，并且如实告知「停止没生效」（不能默默当成已停）
    expect(record?.status).toBe("running");
    expect(record?.note).toContain("停止命令没有生效");
  });
});

describe("GalleryServiceRunner：面板关窗（owner）停止不误杀新服务", () => {
  const panelInput = { ...baseInput, appId: "panel-a", ownerPanelId: "panel-a" };

  it("关窗快照：关窗后才被重新认领的服务不杀（迟到一拍的回调不能误杀重开的面板）", async () => {
    const h = harness();
    const first = await h.runner.start(panelInput);
    const ticket = h.runner.ownerStopTicket("panel-a"); // 关窗当拍抓的快照
    // 用户重开面板并再次运行：同一个记录被重新认领（复用同一活进程）
    const again = await h.runner.start(panelInput);
    expect(first.ok && again.ok && again.reused).toBe(true);
    expect(h.runner.stopByOwner("panel-a", ticket)).toBe(0);
    expect(h.killed).toEqual([]);
    expect(h.runner.list().filter((record) => record.status === "running")).toHaveLength(1);
  });

  it("关窗时服务还在启动中也照停（不能因为「在途」就留孤儿）", async () => {
    const gates: ((ok: boolean) => void)[] = [];
    const h = harness({ probe: () => new Promise<boolean>((resolve) => gates.push(resolve)) });
    const pending = h.runner.start({ ...panelInput, url: "http://127.0.0.1:8787" });
    await flush();
    gates.shift()?.(false); // 外部不可达 → 真的去 spawn
    await flush(); // 现在停在「等就绪」上（记录 status = starting）
    const ticket = h.runner.ownerStopTicket("panel-a");
    expect([...ticket.claims.keys()]).toHaveLength(1);
    expect(h.runner.stopByOwner("panel-a", ticket)).toBe(1);
    expect(h.killed).toEqual([9_000]);
    h.handles[0]?.exit(null);
    gates.shift()?.(false); // 放行探活
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("已取消");
    expect(h.runner.list()[0]).toMatchObject({ status: "stopped" });
  });

  it("start 还卡在探活（记录还没登记）时关窗：probe 恢复后绝不 spawn（不留孤儿）", async () => {
    const gates: ((ok: boolean) => void)[] = [];
    const h = harness({ probe: () => new Promise<boolean>((resolve) => gates.push(resolve)) });
    const pending = h.runner.start({ ...panelInput, url: "http://127.0.0.1:8787" });
    await flush();
    expect(h.runner.list()).toEqual([]); // 还卡在探活里，entries 里根本没有这个作品
    const ticket = h.runner.ownerStopTicket("panel-a");
    expect(ticket.pending).toHaveLength(1);
    expect(h.runner.stopByOwner("panel-a", ticket)).toBe(0); // 没有记录可停
    gates.shift()?.(false); // 探活恢复：不可达 —— 旧实现会在这里照样 spawn 出孤儿
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("已取消");
    expect(h.launched).toEqual([]);
    expect(h.killed).toEqual([]);
  });

  it("不给快照时也会挂在途 start（面板关了，服务不能凭空起）", async () => {
    const gates: ((ok: boolean) => void)[] = [];
    const h = harness({ probe: () => new Promise<boolean>((resolve) => gates.push(resolve)) });
    const pending = h.runner.start({ ...panelInput, url: "http://127.0.0.1:8787" });
    await flush();
    expect(h.runner.stopByOwner("panel-a")).toBe(0);
    gates.shift()?.(true); // 即使探活说「已可达」，也只算外部服务、不再接着走
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(h.launched).toEqual([]);
  });

  it("prepareOwnerStop 当拍取消在途认领：微任务里恢复探活也不 spawn（早于延时的精确停）", async () => {
    const gates: ((ok: boolean) => void)[] = [];
    const h = harness({ probe: () => new Promise<boolean>((resolve) => gates.push(resolve)) });
    const pending = h.runner.start({ ...panelInput, url: "http://127.0.0.1:8787" });
    await flush();
    expect(h.runner.list()).toEqual([]); // 卡在探活里，entries 为空
    // 关窗当拍：抓快照 + 就地取消在途认领（纯数据，不 kill）
    const ticket = h.runner.prepareOwnerStop("panel-a");
    expect(ticket.pending).toHaveLength(1);
    // 探活在**同一个微任务批**里恢复（早于 setImmediate 里的 stopByOwner）：
    // 只把取消留给延时回调时，这里就会 spawn 出一个不在快照里的孤儿
    gates.shift()?.(false);
    await Promise.resolve();
    expect(h.launched).toEqual([]);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("已取消");
    // 延时拍里的精确停止照常执行（没有记录 → 0），也不会事后多出进程
    expect(h.runner.stopByOwner("panel-a", ticket)).toBe(0);
    expect(h.launched).toEqual([]);
    expect(h.killed).toEqual([]);
  });

  it("prepareOwnerStop 之后延时精确停：快照里的记录照停，且不重复 kill", async () => {
    const gates: ((ok: boolean) => void)[] = [];
    const h = harness({ probe: () => new Promise<boolean>((resolve) => gates.push(resolve)) });
    const first = await h.runner.start(panelInput); // 已登记的记录（无 url ⇒ 立即就绪）
    // 换命令的第二次运行：它先停旧、再等退出，而新的外部探活还没开始（在途认领已登记）
    const second = h.runner.start({ ...panelInput, command: "node proxy2.mjs", url: "http://127.0.0.1:8787" });
    await flush();
    const ticket = h.runner.prepareOwnerStop("panel-a");
    expect(ticket.claims.size).toBe(1); // 旧记录在快照里
    expect(ticket.pending).toHaveLength(1); // 第二支还在途
    h.handles[0]?.exit(null); // 旧进程退出：第二支本该接着探活 + spawn
    const secondResult = await second;
    expect(secondResult.ok).toBe(false);
    expect(!secondResult.ok && secondResult.message).toContain("已取消");
    expect(h.launched).toHaveLength(1); // 只有第一支真的起过
    // 延时拍里的精确停：旧记录已在退出中，不重复 kill
    expect(h.runner.stopByOwner("panel-a", ticket)).toBe(0);
    expect(h.killed).toEqual([9_000]);
    expect((first.ok && first.record?.id) || "").not.toBe("");
  });

  it("关窗快照只取消旧的那次在途 start：重开后新起的照常起来", async () => {
    const gates: ((ok: boolean) => void)[] = [];
    const h = harness({ probe: () => new Promise<boolean>((resolve) => gates.push(resolve)) });
    // 旧一轮：卡在探活里（还没有记录）
    const stale = h.runner.start({ ...panelInput, command: "node old.mjs", url: "http://127.0.0.1:8787" });
    await flush();
    const ticket = h.runner.ownerStopTicket("panel-a"); // 关窗当拍：旧的这次在快照里
    expect(ticket.pending).toHaveLength(1);
    // 重开面板后的新一次运行（不同命令 ⇒ 不合流；无 url ⇒ 不用探活）
    const fresh = h.runner.start({ ...panelInput, command: "node new.mjs" });
    await flush();
    expect(h.runner.stopByOwner("panel-a", ticket)).toBe(0);
    gates.shift()?.(false); // 旧的那次探活恢复 → 必须取消，不 spawn
    const staleResult = await stale;
    expect(staleResult.ok).toBe(false);
    expect(!staleResult.ok && staleResult.message).toContain("已取消");
    expect((await fresh).ok).toBe(true);
    expect(h.launched.map((entry) => entry.command)).toEqual(["node new.mjs"]);
    expect(h.runner.list().filter((record) => record.status === "running")).toHaveLength(1);
  });

  it("关窗快照只认同一条记录：重开后另起的记录不受影响", async () => {
    const h = harness();
    await h.runner.start(panelInput);
    const ticket = h.runner.ownerStopTicket("panel-a");
    // 关窗回调还没到，旧服务自己崩了；面板重开又起了一个新记录
    h.handles[0]?.exit(1);
    const second = await h.runner.start({ ...panelInput, command: "node proxy2.mjs" });
    expect(second.ok).toBe(true);
    expect(h.runner.stopByOwner("panel-a", ticket)).toBe(0);
    expect(h.runner.list().filter((record) => record.status === "running")).toHaveLength(1);
  });

  it("同一份关窗快照被执行两次：第二次无事可做（幂等）", async () => {
    const h = harness();
    await h.runner.start(panelInput);
    const ticket = h.runner.ownerStopTicket("panel-a");
    expect(h.runner.stopByOwner("panel-a", ticket)).toBe(1);
    h.handles[0]?.exit(null);
    expect(h.runner.stopByOwner("panel-a", ticket)).toBe(0);
    expect(h.killed).toEqual([9_000]);
  });

  it("不给快照时维持旧语义：停掉这个面板认领的活服务", async () => {
    const h = harness();
    await h.runner.start(panelInput);
    expect(h.runner.stopByOwner("panel-a")).toBe(1);
    expect(h.killed).toEqual([9_000]);
  });

  it("外部已可达的服务不建记录，也不进 stopByOwner 的停止链路", async () => {
    const h = harness({ probe: async () => true });
    const result = await h.runner.start({ ...panelInput, url: "http://127.0.0.1:8787" });
    expect(result.ok && result.external).toBe(true);
    expect(h.runner.list()).toEqual([]);
    expect(h.runner.ownerStopTicket("panel-a").claims.size).toBe(0);
    expect(h.runner.stopByOwner("panel-a")).toBe(0);
    expect(h.killed).toEqual([]);
  });

  it("复用记录时同步 url / 面板归属并推一帧（看板不能显示旧值）", async () => {
    const h = harness();
    await h.runner.start(baseInput);
    const before = h.changes.count;
    const again = await h.runner.start({ ...baseInput, url: "http://127.0.0.1:8787", ownerPanelId: "p1" });
    expect(again.ok && again.reused).toBe(true);
    const record = h.runner.list()[0];
    expect(record?.url).toBe("http://127.0.0.1:8787");
    expect(record?.ownerPanelId).toBe("p1");
    expect(h.changes.count).toBeGreaterThan(before);
  });
});

describe("GalleryServiceRunner：就绪前退出与一次性结算", () => {
  it("就绪前以 0 退出：判启动失败，端口随后可达也不能改回「运行中」", async () => {
    let probes = 0;
    const h = harness({
      // 第 1 次是「地址已可达吗」（否 ⇒ 真的 spawn），第 2 次是就绪轮询（此刻进程已经死了）
      probe: async () => {
        probes += 1;
        return probes > 1;
      },
      onLaunch: (handle) => {
        handle.data("detached\n");
        queueMicrotask(() => handle.exit(0));
      }
    });
    const result = await h.runner.start({ ...baseInput, url: "http://127.0.0.1:8787" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("不能建立可回收的服务所有权");
    const record = h.runner.list()[0];
    expect(record).toMatchObject({ status: "failed", ready: false, exitCode: 0 });
    expect(record?.log).toContain("detached"); // 日志必须留着（看板上要能回答「为啥没起来」）
  });

  it("error + exit 双事件只结算一次（后到的不能改写终态）", async () => {
    const h = harness();
    await h.runner.start(baseInput);
    h.handles[0]?.exit(null, "spawn cmd.exe ENOENT");
    expect(h.runner.list()[0]).toMatchObject({ status: "failed" });
    expect(h.runner.list()[0]?.note).toContain("ENOENT");
    h.handles[0]?.exit(0);
    const record = h.runner.list()[0];
    expect(record?.status).toBe("failed");
    expect(record?.note).toContain("ENOENT");
    expect(record?.exitCode).toBeUndefined();
  });

  it("无 URL + 句柄没有 pid：先等异步 spawn error，绝不先回「已运行」", async () => {
    const h = harness({ spawnError: "spawn cmd.exe ENOENT" });
    const result = await h.runner.start(baseInput);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("ENOENT");
    expect(h.runner.list()[0]).toMatchObject({ status: "failed", ready: false });
  });

  it("无 URL + 句柄没有 pid 也不报错：明确失败（拿不到可回收的进程身份）", async () => {
    const h = harness({ noPid: true });
    const result = await h.runner.start(baseInput);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("没有返回进程号");
    expect(h.runner.list()[0]).toMatchObject({ status: "failed", ready: false });
  });
});

describe("GalleryServiceRunner：应用退出（disposeAll）", () => {
  it("disposeAll 之后不再启动新服务", async () => {
    const h = harness();
    h.runner.disposeAll();
    const result = await h.runner.start(baseInput);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("应用正在退出");
    expect(h.launched).toEqual([]);
  });

  it("disposeAll 之后外部服务探活成功也不能回「已复用」", async () => {
    const gates: ((ok: boolean) => void)[] = [];
    const h = harness({ probe: () => new Promise<boolean>((resolve) => gates.push(resolve)) });
    const pending = h.runner.start({ ...baseInput, url: "http://127.0.0.1:8787" });
    await flush();
    h.runner.disposeAll();
    gates.shift()?.(true); // 探活「成功」：仍然要以「应用正在退出」取消
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("应用正在退出");
    expect(h.launched).toEqual([]);
  });

  it("disposeAll 让在途 start 在 spawn 前取消（不凭空多一个进程）", async () => {
    const gates: ((ok: boolean) => void)[] = [];
    const h = harness({ probe: () => new Promise<boolean>((resolve) => gates.push(resolve)) });
    const pending = h.runner.start({ ...baseInput, url: "http://127.0.0.1:8787" });
    await flush();
    h.runner.disposeAll();
    gates.shift()?.(false);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("应用正在退出");
    expect(h.launched).toEqual([]);
  });

  it("disposeAll 让在途 restart 立刻放行（不等满宽限、也不起新进程）", async () => {
    // 宽限开到 60s：只有 dispose 能放行；同时钉住「注入的宽限真的生效」——
    // 旧实现用 Math.min(5s, 注入值) 时这里会白等 5 秒。
    const h = harness({ pid: process.pid, stopGraceMs: 60_000 });
    const started = await h.runner.start(baseInput);
    const startedAt = Date.now();
    const pending = h.runner.restart(started.ok ? started.record!.id : "");
    await flush();
    h.runner.disposeAll();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(h.launched).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("disposeAll 把没有 pid 的活记录也收掉（走 handle.kill 兜底）", async () => {
    let probes = 0;
    const h = harness({
      noPid: true,
      probe: async () => {
        probes += 1;
        return probes > 1;
      }
    });
    const started = await h.runner.start({ ...baseInput, url: "http://127.0.0.1:8787" });
    expect(started.ok).toBe(true);
    h.runner.disposeAll();
    expect(h.killed).toEqual([]); // 没有 pid 就没法走进程树回收
    expect(h.handles[0]?.killCalls).toBe(1); // 单进程兜底
    expect(h.runner.list()).toEqual([]);
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

describe("子进程输出解码（GBK / UTF-8 / 跨 chunk）", () => {
  // 真字节：中文 Windows 上 cmd 的内建命令与 PowerShell 的 cmdlet 就是按 936（GBK）写的。
  const GBK_ERROR = new Uint8Array([0xcf, 0xb5, 0xcd, 0xb3, 0xd5, 0xd2, 0xb2, 0xbb, 0xb5, 0xbd, 0xd6, 0xb8, 0xb6, 0xa8, 0xb5, 0xc4, 0xc2, 0xb7, 0xbe, 0xb6, 0xa1, 0xa3]); // 系统找不到指定的路径。
  const GBK_WITH_PATH = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0xc2, 0xb7, 0xbe, 0xb6, 0x20, 0x44, 0x3a, 0xc8, 0xd5, 0xb3, 0xa3, 0xb9, 0xa4, 0xd7, 0xf7, 0xc7, 0xf8]); // 中文路径 D:日常工作区
  const UTF8_CJK = new TextEncoder().encode("中文");
  const REPLACEMENT = String.fromCharCode(0xfffd);

  it("UTF-8 原文照旧（绝大多数输出走这条路，不能被回退逻辑碰坏）", () => {
    const decoder = new GalleryServiceOutputDecoder(["gbk"]);
    expect(decoder.push(UTF8_CJK)).toBe("中文");
    expect(decoder.push("plain ascii")).toBe("plain ascii");
  });

  it("GBK 字节解成中文（以前 String(chunk) 会得到一串替换字符）", () => {
    const decoder = new GalleryServiceOutputDecoder(["gbk"]);
    expect(decoder.push(GBK_ERROR)).toBe("系统找不到指定的路径。");
    expect(decoder.push(GBK_WITH_PATH)).toBe("中文路径 D:日常工作区");
  });

  it("跨 chunk 的半个字符既不丢也不产生替换字符（UTF-8 与 GBK 都要接住）", () => {
    const utf8 = new GalleryServiceOutputDecoder(["gbk"]);
    // 第一块切在「中」的第三个字节里：完整的「中」先出，半个字留到下一块。
    expect(utf8.push(UTF8_CJK.subarray(0, 4))).toBe("中");
    expect(utf8.push(UTF8_CJK.subarray(4))).toBe("文");

    const gbk = new GalleryServiceOutputDecoder(["gbk"]);
    // 21 字节 = 10 个完整的双字节字 + 下一个字的**首字节**：首字节要留到下一块。
    const first = gbk.push(GBK_ERROR.subarray(0, 21));
    const second = gbk.push(GBK_ERROR.subarray(21));
    expect(first + second).toBe("系统找不到指定的路径。");
    expect(first + second).not.toContain(REPLACEMENT);
  });

  it("同一股流里 ASCII 与 GBK 混排也各解各的，且一旦认定 GBK 就粘住", () => {
    const decoder = new GalleryServiceOutputDecoder(["gbk"]);
    expect(decoder.push(new TextEncoder().encode("> starting"))).toBe("> starting");
    expect(decoder.push(GBK_ERROR)).toBe("系统找不到指定的路径。");
    // 「路径」的 GBK 字节（c2 b7 be b6）碰巧是合法 UTF-8：粘住 GBK 才不会解成另一套乱码
    expect(decoder.push(new Uint8Array([0xc2, 0xb7, 0xbe, 0xb6]))).toBe("路径");
  });

  it("非 Windows（没有传统编码候选）时不做瞎猜：仍是替换字符，但绝不抛错", () => {
    const decoder = new GalleryServiceOutputDecoder([]);
    expect(decoder.push(GBK_ERROR)).toContain(REPLACEMENT);
  });

  it("退出时 flush 把挂起的半截字符吐出来（不静默丢）", () => {
    const decoder = new GalleryServiceOutputDecoder([]);
    expect(decoder.push(UTF8_CJK.subarray(0, 2))).toBe("");
    expect(decoder.flush()).toBe(REPLACEMENT);
    expect(decoder.flush()).toBe("");
  });

  it("utf8CompletePrefixLength 区分「跨块截断」与「根本不是 UTF-8」", () => {
    expect(utf8CompletePrefixLength(new TextEncoder().encode("abc"))).toBe(3);
    expect(utf8CompletePrefixLength(UTF8_CJK)).toBe(6);
    expect(utf8CompletePrefixLength(UTF8_CJK.subarray(0, 2))).toBe(0);
    expect(utf8CompletePrefixLength(UTF8_CJK.subarray(0, 4))).toBe(3);
    expect(utf8CompletePrefixLength(UTF8_CJK.subarray(0, 5))).toBe(3);
    expect(utf8CompletePrefixLength(GBK_ERROR)).toBe(-1);
    expect(utf8CompletePrefixLength(new Uint8Array([0xff]))).toBe(-1);
  });

  it("传统编码候选按系统语言推：中文 → gbk，日文 → shift_jis，POSIX 不猜", () => {
    expect(defaultServiceLegacyEncodings("win32", "zh-CN")).toEqual(["gbk", "windows-1252"]);
    expect(defaultServiceLegacyEncodings("win32", "ja-JP")).toEqual(["shift_jis", "windows-1252"]);
    expect(defaultServiceLegacyEncodings("win32", "en-US")).toEqual(["windows-1252"]);
    expect(defaultServiceLegacyEncodings("darwin", "zh-CN")).toEqual([]);
  });

  it("启动器把 stdout / stderr 各自交给解码器（源码级：String(chunk) 是这次的根因）", () => {
    const source = readFileSync(new URL("./gallery-service-runner.ts", import.meta.url), "utf8");
    expect(source).toContain("const stdoutDecoder = new GalleryServiceOutputDecoder(legacyEncodings);");
    expect(source).toContain("const stderrDecoder = new GalleryServiceOutputDecoder(legacyEncodings);");
    expect(source).toContain("emit(stdoutDecoder.push(chunk))");
    expect(source).toContain("emit(stderrDecoder.push(chunk))");
    expect(source).not.toContain("listener(String(chunk))");
  });
});
