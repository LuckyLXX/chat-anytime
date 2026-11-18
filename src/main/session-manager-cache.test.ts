import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SESSION_MANAGER_CACHE_BYTES, DEFAULT_SESSION_MANAGER_CACHE_ENTRIES, SessionManagerCache } from "./session-manager-cache.js";
import { listSessionSummaries } from "./session-summary-cache.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pidesktop-manager-cache-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function manager(id: string): SessionManager {
  return { getSessionId: () => id } as unknown as SessionManager;
}

function entry(path: string, size: number, extra: Partial<{ agentId: string; workspace: string; mtimeMs: number }> = {}) {
  return {
    path,
    agentId: extra.agentId ?? "a",
    workspace: extra.workspace ?? "/ws",
    mtimeMs: extra.mtimeMs ?? 10,
    size,
    manager: manager(path)
  };
}

describe("SessionManagerCache", () => {
  it("keeps 8 entries by default (multi-session round trips) and still caps bytes", () => {
    expect(DEFAULT_SESSION_MANAGER_CACHE_ENTRIES).toBe(8);
    expect(DEFAULT_SESSION_MANAGER_CACHE_BYTES).toBe(96 * 1024 * 1024);
    const cache = new SessionManagerCache();
    // 8 个中小会话全部留得住：第 3～8 个也能在预算内复用（旧上限 2 会全部淘汰）。
    for (let index = 0; index < 8; index += 1) {
      cache.remember({ ...entry(`/s/${index}.jsonl`, 1024), usedAt: index });
    }
    expect(cache.size()).toBe(8);
    for (let index = 0; index < 8; index += 1) {
      expect(cache.take(`/S/${index}.jsonl`, "a", "/ws", { mtimeMs: 10, size: 1024 })).toBeTruthy();
      // 独占消费：同一个 manager 不能交给两个 AgentSession。
      expect(cache.take(`/S/${index}.jsonl`, "a", "/ws", { mtimeMs: 10, size: 1024 })).toBeUndefined();
    }
  });

  it("only returns a manager when path/agent/workspace/stat all match", () => {
    const cache = new SessionManagerCache();
    const m = manager("s1");
    cache.remember({ path: "/sessions/a.jsonl", agentId: "a", workspace: "/ws", mtimeMs: 10, size: 100, manager: m });
    expect(cache.take("/sessions/A.jsonl", "a", "/ws", { mtimeMs: 10, size: 100 })).toBe(m);
    expect(cache.take("/sessions/A.jsonl", "a", "/ws", { mtimeMs: 11, size: 100 })).toBeUndefined();
  });

  it("rejects a different agent/workspace and consumes the entry", () => {
    const cache = new SessionManagerCache();
    cache.remember({ path: "/s/a.jsonl", agentId: "a", workspace: "/w", mtimeMs: 1, size: 1, manager: manager("s") });
    expect(cache.take("/s/a.jsonl", "b", "/w", { mtimeMs: 1, size: 1 })).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("evicts by entry count and byte budget", () => {
    const cache = new SessionManagerCache(2, 10);
    cache.remember({ ...entry("/s/a", 6), usedAt: 1 });
    cache.remember({ ...entry("/s/b", 6), usedAt: 2 });
    expect(cache.size()).toBe(1);
    cache.remember({ ...entry("/s/c", 6), usedAt: 3 });
    expect(cache.size()).toBe(1);
  });

  it("evicts the least recently used release entry by real activatedAt order", () => {
    // 批量驱逐 parked 会话时循环是激活时间降序：最后一个入缓存的其实是**最旧**的会话。
    // 用记录顺序当 LRU 键会淘汰错对象，这里钉住 usedAt 才是键。
    const cache = new SessionManagerCache(3, 1024);
    cache.remember({ ...entry("/s/newest", 1), usedAt: 300 });
    cache.remember({ ...entry("/s/middle", 1), usedAt: 200 });
    cache.remember({ ...entry("/s/oldest", 1), usedAt: 100 });
    cache.remember({ ...entry("/s/fresh", 1), usedAt: 400 });
    expect(cache.size()).toBe(3);
    expect(cache.paths().sort()).toEqual(["/s/fresh", "/s/middle", "/s/newest"]);
  });

  it("never lets summary-scan entries evict user-released ones", () => {
    const full = new SessionManagerCache(1, 1024);
    full.remember({ ...entry("/s/user", 10), usedAt: 1 });
    // 扫描条目走剩余额度：条数已满时直接放弃，不挤掉用户条目。
    full.remember({ ...entry("/s/scan-1", 10), origin: "scan" });
    expect(full.paths()).toEqual(["/s/user"]);
    // 有余量时允许登记，并由 release 准入优先淘汰它。
    const roomy = new SessionManagerCache(2, 1024);
    roomy.remember({ ...entry("/s/user", 10), usedAt: 1 });
    roomy.remember({ ...entry("/s/scan", 10), origin: "scan" });
    expect(roomy.paths().sort()).toEqual(["/s/scan", "/s/user"]);
    roomy.remember({ ...entry("/s/user-2", 10), usedAt: 2 });
    expect(roomy.paths()).toEqual(["/s/user", "/s/user-2"]);
  });

  it("lets scan entries use leftover byte budget only", () => {
    const cache = new SessionManagerCache(8, 100);
    cache.remember({ ...entry("/s/user", 80), usedAt: 1 });
    // 剩 20 字节：10 字节能进，30 字节不能（否则会把用户条目挤出去）。
    cache.remember({ ...entry("/s/scan-small", 10), origin: "scan" });
    cache.remember({ ...entry("/s/scan-big", 30), origin: "scan" });
    expect(cache.paths().sort()).toEqual(["/s/scan-small", "/s/user"]);
  });

  it("drops a single file larger than the whole byte budget", () => {
    const cache = new SessionManagerCache(8, 64);
    cache.remember(entry("/s/huge", 65));
    expect(cache.size()).toBe(0);
    // 空文件也不留：没有可复用的历史。
    cache.remember(entry("/s/empty", 0));
    expect(cache.size()).toBe(0);
  });

  it("forgets a path explicitly (delete / failed acquisition)", () => {
    const cache = new SessionManagerCache();
    cache.remember(entry("/s/a.jsonl", 10));
    cache.forget("/S/A.jsonl");
    expect(cache.size()).toBe(0);
  });
});

/**
 * 组合契约：摘要扫描真的解析了正文 → 那份 manager 进缓存 → 下一次打开直接取走。
 *
 * 这是「打开所触发的列表刷新不再整读一遍」的另一半（冷开自己种摘要见
 * session-summary-cache.test.ts 的 seed 用例）。两边都必须成立，否则一次切换
 * 仍会付两遍解析。
 */
describe("session manager cache × summary scan", () => {
  it("reuses the manager a scan already parsed, exactly once", async () => {
    const dir = tempDir("scan-handoff");
    const manager = SessionManager.create("C:/work/ws", dir);
    manager.appendMessage({ role: "user", content: "你好" } as never);
    manager.appendMessage({ role: "assistant", content: "在" } as never);
    const path = manager.getSessionFile()!;
    const info = statSync(path);

    const cache = new SessionManagerCache();
    let handed = 0;
    const summaries = await listSessionSummaries([dir], {
      cache: new Map(),
      onManagerParsed: (input) => {
        handed += 1;
        cache.remember({
          path: input.path,
          agentId: "alpha",
          workspace: "C:/work/ws",
          mtimeMs: input.mtimeMs,
          size: input.size,
          manager: input.manager as SessionManager,
          origin: "scan"
        });
      }
    });
    expect(handed).toBe(1);
    expect(cache.size()).toBe(1);

    const taken = cache.take(path, "alpha", "C:/work/ws", { mtimeMs: info.mtimeMs, size: info.size });
    expect(taken).toBeDefined();
    expect(taken!.getSessionId()).toBe(summaries[0]!.id);
    // 独占消费：同一个可变 manager 不能再交给第二个 AgentSession。
    expect(cache.take(path, "alpha", "C:/work/ws", { mtimeMs: info.mtimeMs, size: info.size })).toBeUndefined();
    // 扫描条目也不挤占 release 的条数/字节额度（它只用剩余额度）。
    expect(cache.size()).toBe(0);
  });

  it("drops a scanned manager when the file changed after the parse", async () => {
    const dir = tempDir("scan-stale");
    const manager = SessionManager.create("C:/work/ws", dir);
    manager.appendMessage({ role: "user", content: "你好" } as never);
    manager.appendMessage({ role: "assistant", content: "在" } as never);
    const path = manager.getSessionFile()!;
    const info = statSync(path);
    // 模拟「解析完成后文件又被追加」：旧签名对应的 manager 已不是最新内容。
    manager.appendMessage({ role: "assistant", content: "后追加" } as never);
    const cache = new SessionManagerCache();
    cache.remember({ path, agentId: "alpha", workspace: "C:/work/ws", mtimeMs: info.mtimeMs, size: info.size, manager, origin: "scan" });
    expect(cache.take(path, "alpha", "C:/work/ws", { mtimeMs: statSync(path).mtimeMs, size: statSync(path).size })).toBeUndefined();
  });
});
