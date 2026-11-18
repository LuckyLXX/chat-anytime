#!/usr/bin/env node
/**
 * 会话冷开（session.open / 自动化冷恢复）的只读基准脚本（2026-11-18 P0 冷开优化）。
 *
 * 用法：
 *   node --experimental-transform-types scripts/benchmark-session-open.mjs
 *   node --expose-gc --experimental-transform-types scripts/benchmark-session-open.mjs --sizes 1,10,50 --round 3
 *   node --experimental-transform-types scripts/benchmark-session-open.mjs --path "C:/.../xxx.jsonl"
 *
 * 纪律：
 * - **只读**：默认在系统临时目录里合成 JSONL；传 --path 时只读打开真实会话文件，
 *   绝不写、绝不调用任何宿主生命周期操作（不启 Electron、不碰 settings）。
 * - 不把这里的结果当作「物理冷盘」承诺：默认跑的是**应用缓存未命中**（有界
 *   manager 缓存里没有），但文件通常还在操作系统页缓存里。同一环境下重复读取，
 *   操作系统那一层是热的——所以这里报中位数与首轮值，并把口径写清楚。
 * - 缓存收益的硬指标是**整文件解析次数归零**；50 MiB 缓存命中的 manager 获取
 *   阶段以「相对冷解析降低 ≥90%」为初始目标（不达标会以退出码 1 结束）。
 *
 * 记录项：cache lookup、整文件 parse、session context 装配（纯 CPU 部分）、
 * 首帧序列化代理、单次同步阻塞（事件循环最大间隔）、manager 缓存条数/字节预算、
 * GC 后 heap。**资源装配（skills/MCP/hooks）与 SDK 创建/扩展绑定只能在应用进程
 * 里测**：这里不伪造那两个数字，控制台会明确标注。
 */
import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SESSION_MANAGER_CACHE_BYTES, DEFAULT_SESSION_MANAGER_CACHE_ENTRIES, SessionManagerCache } from "../src/main/session-manager-cache.ts";

const MiB = 1024 * 1024;

function parseArgs(argv) {
  const options = { sizes: [1, 10, 50, 100], rounds: 3, path: undefined, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sizes") {
      options.sizes = String(argv[++index] ?? "").split(",").map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value > 0);
    } else if (arg === "--round") {
      options.rounds = Math.max(1, Number(argv[++index] ?? 1) || 1);
    } else if (arg === "--path") {
      options.path = argv[++index];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("用法: node --experimental-transform-types scripts/benchmark-session-open.mjs [--path <真实会话.jsonl>] [--sizes 1,10,50,100] [--round 3] [--json]");
      process.exit(0);
    }
  }
  if (options.sizes.length === 0) options.sizes = [1, 10, 50];
  return options;
}

/** 每次整文件解析都过这个函数（用来数解析次数，而不是靠猜）。 */
let parseCount = 0;
function countParse() {
  parseCount += 1;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function ms(value) {
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ms`;
}

/**
 * 造一个与 Pi 会话文件同构的合成 JSONL：头部 + N 条消息。
 * 内容混合长文本与「工具结果内联 base64 图片」——这正是真实大会话的两种体积来源。
 */
function writeSyntheticSession(path, cwd, targetBytes) {
  const sessionId = `bench-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd };
  writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".repeat(220);
  const longText = "会话冷开基准：这是一段用来模拟真实长回答的文本。".repeat(60);
  let written = Buffer.byteLength(JSON.stringify(header)) + 1;
  let index = 0;
  while (written < targetBytes) {
    const withImage = index % 4 === 0;
    const message = withImage
      ? { role: "assistant", content: [{ type: "text", text: longText }, { type: "image", data: base64, mimeType: "image/png" }] }
      : index % 2 === 0
        ? { role: "user", content: `${longText}\n#${index}` }
        : { role: "assistant", content: [{ type: "text", text: longText }] };
    const line = JSON.stringify({
      type: "message",
      id: `${sessionId}-m${index}`,
      parentId: index === 0 ? null : `${sessionId}-m${index - 1}`,
      timestamp: new Date(Date.now() + index).toISOString(),
      message
    });
    appendFileSync(path, `${line}\n`, "utf8");
    written += Buffer.byteLength(line) + 1;
    index += 1;
  }
  return { sessionId, messages: index, bytes: written };
}

/**
 * 同步阻塞探针：后台每 0ms 打一次点，报告最长未被打点的间隔。
 * 这段间隔就是「用户在这期间点什么都没反应」的时长。
 */
function createBlockProbe() {
  let last = performance.now();
  let maxGap = 0;
  let running = true;
  const tick = () => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    if (running) setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return {
    async finish() {
      await new Promise((done) => setTimeout(done, 15));
      running = false;
      return maxGap;
    }
  };
}

function heapUsed() {
  if (typeof globalThis.gc !== "function") return undefined;
  globalThis.gc();
  return process.memoryUsage().heapUsed;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  return bytes >= MiB ? `${(bytes / MiB).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(0)} KiB`;
}

async function measureFile(path, rounds) {
  const info = statSync(path);
  const parses = [];
  const loads = [];
  let heapAfterParse = 0;
  const contexts = [];
  const frames = [];
  const blocks = [];
  let manager;
  for (let round = 0; round < rounds; round += 1) {
    const probe = createBlockProbe();
    const before = performance.now();
    countParse();
    manager = SessionManager.open(path);
    const parseMs = performance.now() - before;
    blocks.push(await probe.finish());
    parses.push(parseMs);

    const contextStart = performance.now();
    const context = manager.buildSessionContext();
    contexts.push(performance.now() - contextStart);

    const frameStart = performance.now();
    // 首帧载荷的序列化代理：应用侧发的是规范化后的消息数组，成本主体在这里。
    JSON.stringify(context.messages);
    frames.push(performance.now() - frameStart);
    heapAfterParse = Math.max(heapAfterParse, process.memoryUsage().heapUsed);
    loads.push({ entries: manager.getEntries().length, messages: context.messages.length });
  }
  return {
    bytes: info.size,
    parseMs: median(parses),
    parseFirstMs: parses[0],
    contextMs: median(contexts),
    frameMs: median(frames),
    blockMs: Math.max(...blocks),
    entries: loads.at(-1)?.entries ?? 0,
    messages: loads.at(-1)?.messages ?? 0,
    heapAfterParse
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const temporaryDirectories = [];
  const root = mkdtempSync(join(tmpdir(), "pidesktop-session-open-bench-"));
  temporaryDirectories.push(root);
  const report = {
    note: "application-cache-miss (OS page cache may still be warm)",
    managerCache: { entries: DEFAULT_SESSION_MANAGER_CACHE_ENTRIES, bytes: DEFAULT_SESSION_MANAGER_CACHE_BYTES },
    files: [],
    realPath: undefined,
    roundTrip: undefined,
    scheduling: undefined,
    heap: undefined
  };
  const lines = [];
  const say = (line = "") => {
    lines.push(line);
    if (!options.json) console.log(line);
  };

  say(`# 会话冷开基准（应用缓存未命中；操作系统页缓存可能仍是热的）`);
  say(`node ${process.version} · manager 缓存 ${DEFAULT_SESSION_MANAGER_CACHE_ENTRIES} 条 / ${formatBytes(DEFAULT_SESSION_MANAGER_CACHE_BYTES)}`);
  say(`# 口径：parse = SessionManager.open 整文件解析；cache lookup = statSync + take；`);
  say(`#       context = buildSessionContext；frame = context.messages 的 JSON 序列化代理（首帧成本主体）；`);
  say(`#       block = 单次同步阻塞（事件循环最大间隔）——应用里由阶段让出点切成小段。`);
  say(`# 未在此测量（只能在应用进程里测）：资源装配（skills/MCP/hooks）、SDK 创建与扩展绑定。`);
  say("");

  const files = options.path ? [] : options.sizes;
  for (const sizeMiB of files) {
    const path = join(root, `bench-${sizeMiB}mib.jsonl`);
    const fixture = writeSyntheticSession(path, join(root, "workspace"), sizeMiB * MiB);
    const measured = await measureFile(path, options.rounds);
    report.files.push({ requestedMiB: sizeMiB, ...fixture, ...measured });
    say(`## 合成会话 ≈${sizeMiB} MiB（${formatBytes(measured.bytes)} / ${measured.entries} 条 entry）`);
    say(`  parse（整文件解析）      ${ms(measured.parseMs)}（首轮 ${ms(measured.parseFirstMs)}）`);
    say(`  context 装配（纯 CPU）  ${ms(measured.contextMs)}`);
    say(`  frame 序列化代理        ${ms(measured.frameMs)}`);
    say(`  同步阻塞                ${ms(measured.blockMs)}`);
    say("");
  }

  if (options.path) {
    const realPath = resolve(options.path);
    if (!existsSync(realPath)) throw new Error(`找不到会话文件：${realPath}`);
    const measured = await measureFile(realPath, options.rounds);
    report.realPath = { path: realPath, ...measured };
    say(`## 真实会话（只读）${realPath}`);
    say(`  ${formatBytes(measured.bytes)} / ${measured.entries} 条 entry`);
    say(`  parse ${ms(measured.parseMs)}（首轮 ${ms(measured.parseFirstMs)}）· context ${ms(measured.contextMs)} · frame ${ms(measured.frameMs)} · 同步阻塞 ${ms(measured.blockMs)}`);
    say("");
  }

  // —— 缓存命中：与冷解析对比（同一个 manager 只能被 take 一次）——
  // 合成文件与 --path 的真实文件一视同仁：真实文件同样只读复用。
  const measuredFiles = [
    ...report.files.map((entry) => ({ path: join(root, `bench-${entry.requestedMiB}mib.jsonl`), parseMs: entry.parseMs, bytes: entry.bytes })),
    ...(report.realPath ? [{ path: report.realPath.path, parseMs: report.realPath.parseMs, bytes: report.realPath.bytes }] : [])
  ];
  const cache = new SessionManagerCache();
  const cached = [];
  for (const [index, entry] of measuredFiles.entries()) {
    const path = entry.path;
    const info = statSync(path);
    // 复用一次已经发生的解析（模拟 release/scan 准入时留下的 manager）。
    const manager = SessionManager.open(path);
    cache.remember({ path, agentId: "bench", workspace: root, mtimeMs: info.mtimeMs, size: info.size, manager, origin: "release", usedAt: index });
    const lookupStart = performance.now();
    const taken = cache.take(path, "bench", root, { mtimeMs: info.mtimeMs, size: info.size });
    const lookupMs = performance.now() - lookupStart;
    if (!taken) throw new Error("缓存命中失败：take 返回空");
    cached.push({ path, lookupMs, parseMs: entry.parseMs, bytes: info.size });
  }
  report.cacheLookups = cached;
  say(`## 缓存命中（statSync + take，0 次整文件解析）`);
  for (const item of cached) {
    const reduction = item.parseMs > 0 ? (1 - item.lookupMs / item.parseMs) * 100 : 100;
    say(`  ${formatBytes(item.bytes).padStart(9)}  parse ${ms(item.parseMs).padStart(9)} → lookup ${ms(item.lookupMs).padStart(8)}  （-${reduction.toFixed(1)}%）`);
  }
  say("");

  // —— 8 个中小会话的往返（条数预算 8）：解析次数必须为 0 ——
  const roundTripDir = mkdtempSync(join(root, "roundtrip-"));
  temporaryDirectories.push(roundTripDir);
  const roundTrip = { files: [], parses: 0, hits: 0, lookups: [] };
  const roundTripCache = new SessionManagerCache();
  const roundTripPaths = [];
  for (let index = 0; index < 8; index += 1) {
    const path = join(roundTripDir, `roundtrip-${index}.jsonl`);
    writeSyntheticSession(path, join(root, "workspace"), 2 * MiB);
    const info = statSync(path);
    countParse();
    const manager = SessionManager.open(path);
    roundTripCache.remember({ path, agentId: "bench", workspace: root, mtimeMs: info.mtimeMs, size: info.size, manager, origin: "release", usedAt: index });
    roundTripPaths.push({ path, info });
  }
  roundTrip.files = roundTripPaths.length;
  roundTrip.prepareParses = 8; // 造夹具时每个文件必须真解析一次（模拟 release 准入）
  // 硬指标从这里开始数：往返阶段（take 8 次）必须 0 次整文件解析。
  parseCount = 0;
  for (const { path, info } of roundTripPaths) {
    const lookupStart = performance.now();
    const taken = roundTripCache.take(path, "bench", root, { mtimeMs: info.mtimeMs, size: info.size });
    roundTrip.lookups.push(performance.now() - lookupStart);
    if (taken) roundTrip.hits += 1;
  }
  roundTrip.parses = parseCount;
  report.roundTrip = { ...roundTrip, cacheSizeNow: roundTripCache.size() };
  say(`## 8 个中小会话往返（2 MiB × 8，条数预算 ${DEFAULT_SESSION_MANAGER_CACHE_ENTRIES}）`);
  say(`  命中 ${roundTrip.hits}/8 · lookup 中位 ${ms(median(roundTrip.lookups))} · 往返阶段整文件解析次数 ${roundTrip.parses}`);
  say("");

  // —— 调度机会：让出点把「一次长同步块」切成多段（这里只演示可测的部分）——
  const scheduling = { longBlockMs: report.files.at(-1)?.blockMs ?? report.realPath?.blockMs ?? 0, yieldedBlocks: 0, yieldedMaxBlockMs: 0 };
  {
    const largest = [...measuredFiles].sort((left, right) => right.bytes - left.bytes)[0];
    const path = largest?.path;
    if (path) {
      // 模拟「阶段边界让出」：同样的解析量，中间插入 setImmediate 让出点后，单次阻塞下降。
      const probe = createBlockProbe();
      const manager = SessionManager.open(path);
      const entries = manager.getEntries();
      let blocks = 0;
      let maxBlock = 0;
      for (let offset = 0; offset < entries.length; offset += Math.max(1, Math.ceil(entries.length / 8))) {
        const start = performance.now();
        // 模拟逐段处理（规范化/序列化的一部分）：真正的工作量仍在同步段里。
        JSON.stringify(entries.slice(offset, offset + Math.ceil(entries.length / 8)));
        maxBlock = Math.max(maxBlock, performance.now() - start);
        blocks += 1;
        await new Promise((done) => setImmediate(done));
      }
      const overall = await probe.finish();
      scheduling.yieldedBlocks = blocks;
      scheduling.yieldedMaxBlockMs = maxBlock;
      scheduling.yieldedOverallBlockMs = overall;
    }
  }
  report.scheduling = scheduling;
  say(`## 调度机会（阶段让出的效果，仅示意可测部分）`);
  say(`  一次整读的同步阻塞 ${ms(scheduling.longBlockMs)} · 切成 ${scheduling.yieldedBlocks} 段后单段最大 ${ms(scheduling.yieldedMaxBlockMs)}（切段不改变总工作量）`);
  say("");

  const heapPeak = Math.max(0, ...report.files.map((file) => file.heapAfterParse ?? 0), report.realPath?.heapAfterParse ?? 0);
  // 释放缓存引用后测 heap：留在缓存里的 manager 本来就是设计内的常驻，不计入泄漏。
  cache.clear();
  roundTripCache.clear();
  const heapIdle = heapUsed();
  report.heap = { peakAfterParse: heapPeak || undefined, idleAfterClear: heapIdle, gc: heapIdle !== undefined };
  say(`## 内存`);
  say(`  单次解析后 heap 峰值 ${formatBytes(heapPeak)}（一个完整 manager 在内存里的量级）`);
  say(`  ${heapIdle === undefined ? "清空缓存后：未启用 --expose-gc，跳过" : `清空缓存并 GC 后 ${formatBytes(heapIdle)}`}`);
  say("");

  // —— 硬指标 ——
  const target = [...cached].sort((left, right) => right.bytes - left.bytes).find((item) => item.bytes >= 50 * MiB) ?? [...cached].sort((left, right) => right.bytes - left.bytes)[0];
  const reduction = target && target.parseMs > 0 ? (1 - target.lookupMs / target.parseMs) * 100 : 100;
  // 往返硬指标：8 次 take 全部命中 + 往返阶段 0 次整文件解析。
  // 只数「解析次数」是恒真的（take 路径本身不会调用 SessionManager.open），
  // 必须同时要求 hits 达到预期，否则全部 miss 也会 PASS。
  const passParse = roundTrip.parses === 0 && roundTrip.hits === roundTrip.files;
  const passReduction = reduction >= 90;
  say(`## 结论`);
  say(`  往返命中 ${roundTrip.hits}/${roundTrip.files} · 整文件解析次数 ${roundTrip.parses}（硬指标 8/8 命中且 0 次解析）${passParse ? " PASS" : " FAIL"}`);
  say(`  ${formatBytes(target?.bytes ?? 0)} 缓存命中的 manager 获取：cold ${ms(target?.parseMs ?? 0)} → cached ${ms(target?.lookupMs ?? 0)}（-${reduction.toFixed(1)}%，目标 ≥90%）${passReduction ? " PASS" : " FAIL"}`);
  say(`  总首帧耗时（含资源装配/SDK）需在应用内单独测量，本脚本不承诺。`);

  for (const directory of temporaryDirectories.reverse()) rmSync(directory, { recursive: true, force: true });

  if (options.json) console.log(JSON.stringify({ ...report, lines, pass: passParse && passReduction }, null, 2));
  if (!passParse || !passReduction) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
