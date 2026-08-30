import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateUsage, collectUsageStats, compactTitle, createUsageStatsCache, localDateFromTs, parseUsageLine, scanSessionContent, sessionTitleFromPath, type UsageScanEntry } from "./usage-stats.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "usage-stats-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

const SESSION_A = join("x", "session-a.jsonl");
const SESSION_B = join("y", "session-b.jsonl");

/** 造一条 assistant JSONL 行（usage 可选字段缺省即真实形态）。 */
function assistantLine(options: {
  ts?: number;
  model?: string;
  provider?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  stopReason?: string;
  reasoning?: number;
  costTotal?: number;
}): string {
  const { ts = 1_786_351_592_921, model = "deepseek-v4-flash", provider = "chatanytime-openai-compatible", input = 100, output = 20, cacheRead = 0, cacheWrite = 0, stopReason = "toolUse", reasoning, costTotal } = options;
  return JSON.stringify({
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: ts,
    message: {
      role: "assistant",
      model,
      provider,
      timestamp: ts,
      stopReason,
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        ...(reasoning !== undefined ? { reasoning } : {}),
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(costTotal !== undefined ? { total: costTotal } : {}) }
      }
    }
  });
}

function userLine(text: string): string {
  return JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: 1_786_351_000_000, message: { role: "user", content: text, timestamp: 1_786_351_000_000 } });
}

describe("usage-stats 解析", () => {
  it("正常 assistant 行：字段完整、日期为本地时区", () => {
    const { entry, userText } = parseUsageLine(assistantLine({ input: 10410, output: 87, cacheRead: 5, cacheWrite: 3, reasoning: 41, costTotal: 0.02 }), "agent-1", SESSION_A);
    expect(userText).toBeUndefined();
    expect(entry).toBeDefined();
    expect(entry!.agentId).toBe("agent-1");
    expect(entry!.sessionPath).toBe(SESSION_A);
    expect(entry!.input).toBe(10410);
    expect(entry!.output).toBe(87);
    expect(entry!.cacheRead).toBe(5);
    expect(entry!.cacheWrite).toBe(3);
    expect(entry!.reasoning).toBe(41);
    expect(entry!.cost).toBeCloseTo(0.02);
    expect(entry!.date).toBe(localDateFromTs(1_786_351_592_921));
    expect(entry!.model).toBe("deepseek-v4-flash");
  });

  it("无效行跳过：aborted/error、usage 全零、非消息行、缺时间戳", () => {
    expect(parseUsageLine(assistantLine({ stopReason: "aborted" }), "a", SESSION_A).entry).toBeUndefined();
    expect(parseUsageLine(assistantLine({ stopReason: "error" }), "a", SESSION_A).entry).toBeUndefined();
    expect(parseUsageLine(assistantLine({ input: 0, output: 0 }), "a", SESSION_A).entry).toBeUndefined();
    expect(parseUsageLine(JSON.stringify({ type: "compaction", message: { role: "assistant" } }), "a", SESSION_A).entry).toBeUndefined();
    expect(parseUsageLine("not json", "a", SESSION_A).entry).toBeUndefined();
    expect(parseUsageLine(JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 10, output: 1 } } }), "a", SESSION_A).entry).toBeUndefined();
  });

  it("user 行：提取文本作标题候选；user content 数组取 text 块", () => {
    expect(parseUsageLine(userLine("帮我修复分屏的竞态问题"), "a", SESSION_A).userText).toBe("帮我修复分屏的竞态问题");
    const blocks = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "数组形态" }, { type: "image", data: "xx" }] } });
    expect(parseUsageLine(blocks, "a", SESSION_A).userText).toBe("数组形态");
    expect(parseUsageLine(JSON.stringify({ message: { role: "user", content: [{ type: "image", data: "x" }] } }), "a", SESSION_A).userText).toBeUndefined();
  });

  it("时间戳兼容 ISO 字符串（顶层）与毫秒数（message 内）两种形态", () => {
    const isoLine = JSON.stringify({ timestamp: "2026-08-10T08:46:35.259Z", message: { role: "assistant", stopReason: "stop", timestamp: 1_786_351_595_259, usage: { input: 10, output: 2 } } });
    const fromIso = parseUsageLine(isoLine, "a", SESSION_A).entry;
    expect(fromIso!.ts).toBe(Date.parse("2026-08-10T08:46:35.259Z"));
    const msLine = JSON.stringify({ message: { role: "assistant", stopReason: "stop", timestamp: 1_786_351_595_259, usage: { input: 10, output: 2 } } });
    expect(parseUsageLine(msLine, "a", SESSION_A).entry!.ts).toBe(1_786_351_595_259);
    expect(parseUsageLine(JSON.stringify({ timestamp: "not-a-date", message: { role: "assistant", usage: { input: 10, output: 2 } } }), "a", SESSION_A).entry).toBeUndefined();
  });

  it("缺 model/provider 回退未知占位", () => {
    const line = JSON.stringify({ timestamp: Date.now(), message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 2 } } });
    const { entry } = parseUsageLine(line, "a", SESSION_A);
    expect(entry!.model).toBe("未知模型");
    expect(entry!.provider).toBe("未知服务商");
  });

  it("scanSessionContent：混合行 → 用量记录 + 首条 user 标题压缩", () => {
    const content = [userLine("  第一行\n第二行   很长的标题".repeat(8)), assistantLine({}), assistantLine({ input: 50, output: 5 })].join("\n");
    const scan = scanSessionContent(content, "agent-1", SESSION_A);
    expect(scan.entries).toHaveLength(2);
    expect(scan.title).toBe(compactTitle("  第一行\n第二行   很长的标题".repeat(8)));
    expect(scan.title!.endsWith("…")).toBe(true);
  });

  it("compactTitle 与 sessionTitleFromPath", () => {
    expect(compactTitle("a b  c")).toBe("a b c");
    expect(compactTitle("x".repeat(80)).length).toBe(61);
    expect(sessionTitleFromPath(join("dir", "2026-08-30T10-00-00-000Z_abc.jsonl"))).toBe("2026-08-30T10-00-00-000Z_abc");
  });
});

describe("usage-stats 聚合", () => {
  const entries: UsageScanEntry[] = [
    { ts: 1000, date: "2026-08-28", model: "m1", provider: "p1", agentId: "a1", sessionPath: SESSION_A, input: 100, output: 10, cacheRead: 300, cacheWrite: 0, cost: 0.1 },
    { ts: 2000, date: "2026-08-28", model: "m1", provider: "p1", agentId: "a1", sessionPath: SESSION_A, input: 50, output: 40, cacheRead: 0, cacheWrite: 10, cost: 0.2 },
    { ts: 3000, date: "2026-08-30", model: "m2", provider: "p1", agentId: "a2", sessionPath: SESSION_B, input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.3 }
  ];

  it("总览：请求/输入/输出/缓存/命中率/时间范围", () => {
    const stats = aggregateUsage(entries, { scannedFiles: 2, scanMs: 5, generatedAt: 9999 });
    expect(stats.generatedAt).toBe(9999);
    expect(stats.scannedFiles).toBe(2);
    expect(stats.total.requests).toBe(3);
    expect(stats.total.input).toBe(160);
    expect(stats.total.output).toBe(150);
    expect(stats.total.cacheRead).toBe(300);
    expect(stats.total.cacheWrite).toBe(10);
    expect(stats.total.reasoning).toBeUndefined();
    expect(stats.total.cost).toBeCloseTo(0.6);
    expect(stats.total.cacheHitRate).toBeCloseTo((300 / 470) * 100);
    expect(stats.total.firstAt).toBe(1000);
    expect(stats.total.lastAt).toBe(3000);
  });

  it("按天升序、按模型/助手输出降序、会话 lastAt 降序", () => {
    const stats = aggregateUsage(entries, { scannedFiles: 2, scanMs: 5, generatedAt: 9999 });
    expect(stats.byDay.map((day) => day.date)).toEqual(["2026-08-28", "2026-08-30"]);
    expect(stats.byDay[0]!.requests).toBe(2);
    expect(stats.byModel.map((model) => model.model)).toEqual(["m2", "m1"]);
    expect(stats.byModel[0]!.output).toBe(100);
    expect(stats.byAgent.map((agent) => agent.agentId)).toEqual(["a2", "a1"]);
    expect(stats.bySession.map((session) => session.sessionPath)).toEqual([SESSION_B, SESSION_A]);
    expect(stats.bySession[0]!.agentId).toBe("a2");
  });

  it("reasoning 只在有值时出现；空数据零除安全", () => {
    const withReasoning = aggregateUsage([{ ...entries[0]!, reasoning: 7 }], { scannedFiles: 1, scanMs: 1, generatedAt: 1 });
    expect(withReasoning.total.reasoning).toBe(7);
    expect(withReasoning.byDay[0]!.reasoning).toBe(7);
    const empty = aggregateUsage([], { scannedFiles: 0, scanMs: 0, generatedAt: 1 });
    expect(empty.total.requests).toBe(0);
    expect(empty.total.cacheHitRate).toBeNull();
    expect(empty.total.firstAt).toBeUndefined();
    expect(empty.byDay).toEqual([]);
    expect(empty.bySession).toEqual([]);
  });
});

describe("collectUsageStats 目录扫描与缓存", () => {
  async function seed(root: string): Promise<{ sessionA: string; sessionB: string }> {
    const agentAWorkspace = join(root, "agent-alpha", "367b60355aac7fd3dad0");
    const agentBWorkspace = join(root, "agent-beta", "0123456789abcdef0123");
    await mkdir(agentAWorkspace, { recursive: true });
    await mkdir(agentBWorkspace, { recursive: true });
    await mkdir(join(root, "agent-alpha", "todos"), { recursive: true });
    await mkdir(join(root, "agent-alpha", "not-a-hash-dir"), { recursive: true });
    const sessionA = join(agentAWorkspace, "session-a.jsonl");
    const sessionB = join(agentBWorkspace, "session-b.jsonl");
    await writeFile(sessionA, [userLine("alpha 的会话"), assistantLine({ input: 100, output: 10 })].join("\n") + "\n", "utf8");
    await writeFile(sessionB, [assistantLine({ input: 7, output: 70, model: "m2" })].join("\n") + "\n", "utf8");
    await writeFile(join(root, "agent-alpha", "todos", "todo.json"), "{}", "utf8");
    await writeFile(join(root, "agent-alpha", "not-a-hash-dir", "nested.jsonl"), assistantLine({ input: 999, output: 999 }), "utf8");
    return { sessionA, sessionB };
  }

  it("跨助手扫描聚合；todos/非 hash 目录跳过", async () => {
    const root = await makeTempRoot();
    const { sessionA, sessionB } = await seed(root);
    const cache = createUsageStatsCache();
    const stats = await collectUsageStats(root, cache);
    expect(stats.total.requests).toBe(2);
    expect(stats.total.input).toBe(107);
    expect(stats.total.output).toBe(80);
    expect(stats.byAgent.map((agent) => agent.agentId).sort()).toEqual(["agent-alpha", "agent-beta"]);
    expect(stats.bySession.find((session) => session.sessionPath === sessionA)?.title).toBe("alpha 的会话");
    expect(stats.bySession.find((session) => session.sessionPath === sessionB)?.title).toBe("session-b");
    expect(stats.scannedFiles).toBe(2);
    void sessionB;
  });

  it("缓存命中零重扫；文件追加后仅重扫变化文件；agentId 过滤", async () => {
    const root = await makeTempRoot();
    const { sessionA } = await seed(root);
    const cache = createUsageStatsCache();
    const first = await collectUsageStats(root, cache);
    expect(first.scannedFiles).toBe(2);

    const cached = await collectUsageStats(root, cache);
    expect(cached.scannedFiles).toBe(0);
    expect(cached.total.requests).toBe(2);

    await appendFile(sessionA, assistantLine({ input: 500, output: 50 }) + "\n", "utf8");
    const afterAppend = await collectUsageStats(root, cache);
    expect(afterAppend.scannedFiles).toBe(1);
    expect(afterAppend.total.requests).toBe(3);
    expect(afterAppend.total.input).toBe(607);

    const filtered = await collectUsageStats(root, cache, "agent-beta");
    expect(filtered.scannedFiles).toBe(0);
    expect(filtered.total.requests).toBe(1);
    expect(filtered.byAgent).toHaveLength(1);
    expect(filtered.byAgent[0]!.agentId).toBe("agent-beta");
  });

  it("根目录不存在时返回空统计而非抛错", async () => {
    const root = await makeTempRoot();
    const stats = await collectUsageStats(join(root, "missing"), createUsageStatsCache());
    expect(stats.total.requests).toBe(0);
    expect(stats.byDay).toEqual([]);
  });
});

describe("usage-stats 缓存键", () => {
  it("mtime/size 变化后失效，一致时命中", () => {
    const cache = createUsageStatsCache();
    const scan = { entries: [], title: "t" };
    cache.set("a.jsonl", 100, 50, scan);
    expect(cache.get("a.jsonl", 100, 50)).toBe(scan);
    expect(cache.get("a.jsonl", 101, 50)).toBeUndefined();
    expect(cache.get("a.jsonl", 100, 51)).toBeUndefined();
    cache.clear();
    expect(cache.get("a.jsonl", 100, 50)).toBeUndefined();
  });
});
