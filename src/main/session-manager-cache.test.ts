import { describe, expect, it } from "vitest";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { SessionManagerCache } from "./session-manager-cache.js";

function manager(id: string): SessionManager {
  return { getSessionId: () => id } as unknown as SessionManager;
}

describe("SessionManagerCache", () => {
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
    cache.remember({ path: "/s/a", agentId: "a", workspace: "/w", mtimeMs: 1, size: 6, manager: manager("a") });
    cache.remember({ path: "/s/b", agentId: "a", workspace: "/w", mtimeMs: 1, size: 6, manager: manager("b") });
    expect(cache.size()).toBe(1);
    cache.remember({ path: "/s/c", agentId: "a", workspace: "/w", mtimeMs: 1, size: 6, manager: manager("c") });
    expect(cache.size()).toBe(1);
  });
});
