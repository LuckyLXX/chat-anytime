import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  clampServiceWait,
  parseServiceAddress,
  probeService,
  waitForService,
  SERVICE_POLL_INTERVAL_MS,
  type ServiceAddress,
  type ServiceWaitResult
} from "./gallery-service.js";

/** 真 loopback 服务：探测判据的真值只能在真端口上验（假件会把「连得上」编出来）。 */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP");
  return address.port;
}

const running: Server[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** 稍后再监听指定端口：端口被抢时重试（不给全量并发留下偶发红）。 */
async function listenLater(server: Server, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
}

describe("parseServiceAddress", () => {
  it("解析 http/https 与缺省端口", () => {
    expect(parseServiceAddress("http://localhost:8787")).toEqual({ host: "localhost", port: 8787, secure: false });
    expect(parseServiceAddress("https://example.com")).toEqual({ host: "example.com", port: 443, secure: true });
    expect(parseServiceAddress("http://example.com")).toEqual({ host: "example.com", port: 80, secure: false });
  });

  it("接受没有 scheme 的写法（与内置浏览器地址栏同口径，作品里常这么写）", () => {
    expect(parseServiceAddress("localhost:5173")).toEqual({ host: "localhost", port: 5173, secure: false });
    expect(parseServiceAddress(" 127.0.0.1:8787 ")).toEqual({ host: "127.0.0.1", port: 8787, secure: false });
  });

  it("忽略路径与查询串，IPv6 去掉方括号", () => {
    expect(parseServiceAddress("http://127.0.0.1:8787/api/health?x=1")).toEqual({ host: "127.0.0.1", port: 8787, secure: false });
    expect(parseServiceAddress("http://[::1]:5000/")).toEqual({ host: "::1", port: 5000, secure: false });
  });

  it("解析不了的一律 undefined（调用方报「地址无法解析」，绝不瞎猜端口）", () => {
    expect(parseServiceAddress("")).toBeUndefined();
    expect(parseServiceAddress("   ")).toBeUndefined();
    expect(parseServiceAddress("not a url")).toBeUndefined();
    expect(parseServiceAddress("ftp://example.com:21")).toBeUndefined();
  });
});

describe("probeService（TCP 连上即就绪）", () => {
  it("真端口：监听中为 true，关掉后为 false", async () => {
    const server = createServer((_request, response) => response.end("ok"));
    running.push(server);
    const port = await listen(server);
    await expect(probeService({ host: "127.0.0.1", port, secure: false })).resolves.toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    running.splice(running.indexOf(server), 1);
    await expect(probeService({ host: "127.0.0.1", port, secure: false })).resolves.toBe(false);
  });

  it("HTTP 500 也算起来了（判据是能连上，不是状态码）", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 500;
      response.end("boom");
    });
    running.push(server);
    const port = await listen(server);
    await expect(probeService({ host: "127.0.0.1", port, secure: false })).resolves.toBe(true);
  });

  it("连接报错/抛异常都返回 false，不把异常泄给调用方", async () => {
    await expect(probeService({ host: "127.0.0.1", port: 1, secure: false }, { timeoutMs: 300 })).resolves.toBe(false);
    await expect(probeService({ host: "127.0.0.1", port: 1, secure: false }, { connect: () => { throw new Error("boom"); } })).resolves.toBe(false);
  });

  it("连不上时不干等：超时到点返回 false", async () => {
    const started = Date.now();
    const ok = await probeService({ host: "10.255.255.1", port: 9, secure: false }, { timeoutMs: 120 });
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("waitForService", () => {
  const address: ServiceAddress = { host: "127.0.0.1", port: 8787, secure: false };
  /** 假时钟：把「等 30 秒」压成确定性序列，不依赖真实计时。 */
  function fakeClock() {
    let clock = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      }
    };
  }

  it("轮询到可访问即成功", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const result = await waitForService({
      url: "http://127.0.0.1:8787",
      timeoutMs: 30_000,
      probe: async () => ++attempts >= 3,
      now: clock.now,
      sleep: clock.sleep
    });
    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(3);
  });

  it("超时返回 timeout，且累计等待不超过预算", async () => {
    const clock = fakeClock();
    const result = await waitForService({
      url: "http://127.0.0.1:8787",
      timeoutMs: 1_000,
      intervalMs: 400,
      probe: async () => false,
      now: clock.now,
      sleep: clock.sleep
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(clock.sleeps).toEqual([400, 400, 200]);
  });

  it("启动命令已退出时立刻失败（不用干等满超时）并带上退出码与输出尾部", async () => {
    const clock = fakeClock();
    const result = await waitForService({
      url: "http://127.0.0.1:8787",
      timeoutMs: 30_000,
      probe: async () => false,
      watch: () => ({ exited: true, exitCode: 1, tail: "Error: port in use" }),
      now: clock.now,
      sleep: clock.sleep
    });
    expect(result).toEqual({ ok: false, reason: "exited", exitCode: 1, tail: "Error: port in use" });
    // 只探测/观察了一轮，没有 sleep 满预算
    expect(clock.sleeps).toEqual([]);
  });

  it("服务已监听但进程退出（daemon 化）算成功——先探测后看退出的顺序不能反", async () => {
    const clock = fakeClock();
    const result: ServiceWaitResult = await waitForService({
      url: "http://127.0.0.1:8787",
      timeoutMs: 1_000,
      probe: async () => true,
      watch: () => ({ exited: true, exitCode: 0 }),
      now: clock.now,
      sleep: clock.sleep
    });
    expect(result).toEqual({ ok: true });
  });

  it("地址解析不了时不探测、直接返回 invalid-url", async () => {
    let probed = 0;
    const result = await waitForService({
      url: "ftp://example.com",
      timeoutMs: 1_000,
      probe: async () => {
        probed += 1;
        return true;
      }
    });
    expect(result).toEqual({ ok: false, reason: "invalid-url" });
    expect(probed).toBe(0);
  });

  it("真计时：服务晚 250ms 起来也能等到（轮询真的在重试，不是一次判死）", async () => {
    // 先占一个端口再释放：拿到一个「当时闲置」的端口号。释放到重听之间这个端口
    // 理论上可能被别的测试抢走（全量并发下真发生过），所以重听带重试。
    const probePort = createServer();
    const port = await listen(probePort);
    await new Promise<void>((resolve) => probePort.close(() => resolve()));
    expect(await probeService({ host: "127.0.0.1", port, secure: false }, { timeoutMs: 200 })).toBe(false);

    const late = createServer((_request, response) => response.end("ok"));
    running.push(late);
    const started = Date.now();
    const lateStart = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      await listenLater(late, port);
    })();
    const result = await waitForService({
      url: `http://127.0.0.1:${port}`,
      timeoutMs: 6_000,
      intervalMs: SERVICE_POLL_INTERVAL_MS
    });
    await lateStart;
    expect(result).toEqual({ ok: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });
});

describe("clampServiceWait", () => {
  it("非法值归 0（单次探测），超界钳到上限", () => {
    expect(clampServiceWait(undefined)).toBe(0);
    expect(clampServiceWait("abc")).toBe(0);
    expect(clampServiceWait(-5)).toBe(0);
    expect(clampServiceWait(12_000)).toBe(12_000);
    expect(clampServiceWait(999_999)).toBe(120_000);
  });
});
