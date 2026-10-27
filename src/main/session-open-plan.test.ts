import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { planSessionOpen, readSessionHeaderLine, type SessionOpenPlanInput } from "./session-open-plan.js";

/**
 * `session.open` 决策（2026-09-25 性能 P0）的回归网。
 *
 * 这三条分支各自对应一笔真实成本与一条真实故障：
 * - `live` 走错 → 白付一次全文件读（本机最大会话 44 MB，其中 43 MB 是内联
 *   base64 图片）；
 * - `cold` 走错（退回探测）→ 一次切换读两遍文件（≈1 s 阻塞）；
 * - `fallback` 被删 → 2026-09-16 那个「点侧边栏的新会话报会话路径与工作区不匹配、
 *   并把安装目录写进助手最后工作区」的故障会回潮（缺文件时 Pi 会另铸 sessionId、
 *   cwd 回退 process.cwd()）。
 */

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pidesktop-open-plan-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

const TARGET = "C:\\sessions\\ws-a\\2026-09-01T00-00-00-000Z_s1.jsonl";
const ROOT = "C:\\sessions";

function input(overrides: Partial<SessionOpenPlanInput> = {}): SessionOpenPlanInput {
  return { target: TARGET, root: ROOT, exists: true, liveFileMatches: false, header: { id: "s1", cwd: "C:\\work\\ws-a" }, ...overrides };
}

describe("planSessionOpen", () => {
  it("picks live for an in-memory record, regardless of the file being on disk", () => {
    expect(planSessionOpen(input({ liveFileMatches: true }))).toBe("live");
    // 未落盘的空话题（首条 assistant 消息前不写文件）同样走 live：这就是
    // 「点侧边栏新会话」不报错的路径。
    expect(planSessionOpen(input({ liveFileMatches: true, exists: false, header: undefined }))).toBe("live");
  });

  it("picks cold when the first line yields id + cwd (file exists, not live)", () => {
    expect(planSessionOpen(input())).toBe("cold");
    expect(planSessionOpen(input({ header: { id: "s1", cwd: "/home/u/ws", timestamp: "2026-09-01T00:00:00.000Z", createdAt: 1 } }))).toBe("cold");
  });

  it("falls back when the file is missing or the first line is unusable", () => {
    expect(planSessionOpen(input({ exists: false, header: undefined }))).toBe("fallback");
    expect(planSessionOpen(input({ header: undefined }))).toBe("fallback");
    // 首行不是 Pi 会话（tool-audit.jsonl / checkpoints/*.jsonl 的形状）→ fallback，
    // 由旧的探测路径去抛 Pi 自己的「不是有效会话文件」错误。
    expect(planSessionOpen(input({ header: undefined }))).toBe("fallback");
    // 缺 cwd（旧会话）或 id 为空 → 没有可依的工作区信息 → fallback。
    expect(planSessionOpen(input({ header: { id: "s1", cwd: "" } }))).toBe("fallback");
    expect(planSessionOpen(input({ header: { id: "", cwd: "C:\\work\\ws-a" } }))).toBe("fallback");
  });

  it("decides only on exists/liveFileMatches/header (target and root are context)", () => {
    for (const header of [{ id: "s1", cwd: "C:\\x" }, undefined] as const) {
      const base = input({ header });
      expect(planSessionOpen({ ...base, target: "D:\\other\\s.jsonl", root: "D:\\other" })).toBe(planSessionOpen(base));
    }
  });
});

describe("readSessionHeaderLine", () => {
  it("reads a normal header (newline-terminated or not)", () => {
    const dir = tempDir("normal");
    const header = { type: "session", version: 3, id: "s1", timestamp: "2026-09-01T00:00:00.000Z", cwd: "C:\\work\\ws-a" };
    const path = join(dir, "a.jsonl");
    writeFileSync(path, `${JSON.stringify(header)}\n{"type":"message"}\n`, "utf8");
    expect(readSessionHeaderLine(path)).toEqual({ id: "s1", cwd: "C:\\work\\ws-a", timestamp: header.timestamp, createdAt: Date.parse(header.timestamp) });
    // 无换行的单行文件同样是一行。
    writeFileSync(path, JSON.stringify(header), "utf8");
    expect(readSessionHeaderLine(path)?.id).toBe("s1");
  });

  it("returns undefined when the first parsed entry is not a session header", () => {
    const dir = tempDir("not-session");
    const path = join(dir, "tool-audit.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "tool_execution", tool: "read" })}\n`, "utf8");
    expect(readSessionHeaderLine(path)).toBeUndefined();
  });

  it("returns undefined for an empty file", () => {
    const dir = tempDir("empty");
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "", "utf8");
    expect(readSessionHeaderLine(path)).toBeUndefined();
    expect(readSessionHeaderLine(join(dir, "missing.jsonl"))).toBeUndefined();
  });

  it("gives up on a first line longer than the bounded scan window", () => {
    const dir = tempDir("no-newline");
    const path = join(dir, "huge.jsonl");
    writeFileSync(path, "x".repeat(300 * 1024), "utf8");
    expect(readSessionHeaderLine(path)).toBeUndefined();
  });

  it("skips blank and malformed leading lines (same口径 as Pi's line loop)", () => {
    const dir = tempDir("skip-lines");
    const path = join(dir, "b.jsonl");
    writeFileSync(path, `\n{不是 JSON\n${JSON.stringify({ type: "session", version: 3, id: "s9", timestamp: "2026-09-01T00:00:00.000Z", cwd: "C:/x" })}\n`, "utf8");
    expect(readSessionHeaderLine(path)).toMatchObject({ id: "s9", cwd: "C:/x" });
  });
});

/**
 * 接线断言（源码级）：决策纯函数单测挡不住「pi-runtime 没按决策走」——而本次
 * 性能收益 100% 来自接线（live 不 open、cold 只 open 一次）。这里只裁出
 * `session.open` 分支，钉住三件事，任一条被改回旧写法都会红。
 */
describe("pi-runtime session.open wiring", () => {
  const runtimeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pi-runtime.ts"), "utf8");
  const start = runtimeSource.indexOf('case "session.open": {');
  const end = runtimeSource.indexOf('case "session.rename": {', start);
  const branch = runtimeSource.slice(start, end);

  it("resolves live before touching the disk and validates the owner", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const liveIndex = branch.indexOf("const fileLive =");
    const diskIndex = branch.indexOf("await pathExists(target)");
    expect(liveIndex).toBeGreaterThan(-1);
    expect(diskIndex).toBeGreaterThan(liveIndex);
    expect(branch).toContain("activate(fileLive)");
    expect(branch).toContain("resolveSessionOwner(target, scopes");
  });

  it("cold branch opens once with cwd override (no probe-style SessionManager.open)", () => {
    expect(branch).toContain("const header = fileExists ? readSessionHeaderLine(target) : undefined;");
    expect(branch).toContain("openSessionManagerForReopen(target, recordRoot");
    expect(branch).not.toContain("SessionManager.open(target);");
  });

  it("missing files are rejected before creating a cwd=install-dir empty session", () => {
    expect(branch).toContain("该会话文件不存在");
    expect(branch).toContain("会话路径与工作区不匹配");
  });
});
