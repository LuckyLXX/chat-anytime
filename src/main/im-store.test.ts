import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { ImStore, imStorePath, type ImStoreState } from "./im-store";
import { IM_SEEN_LIMIT } from "../shared/im";

/**
 * IM 通道持久化（bindings + seen LRU）的回归网。
 *
 * 三件事必须钉住，全是「坏了不会报错」的类型：坏 JSON 必须当空（不能把通道带崩）、
 * 写入必须是原子替换（不能留半个文件）、seen 必须有界（不能无界增长成几 MB 的
 * JSON 拖慢每条消息）。
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pidesktop-im-store-${label}-`));
  directories.push(directory);
  return directory;
}

function binding(overrides: Partial<{ sessionPath: string; chatId: string; openId: string }> = {}) {
  return {
    sessionPath: overrides.sessionPath ?? "C:/agent/sessions/a.jsonl",
    chatId: overrides.chatId ?? "oc_chat",
    openId: overrides.openId ?? "ou_user"
  };
}

describe("ImStore", () => {
  it("round-trips bindings through disk and stamps createdAt/lastSeenAt", async () => {
    const dir = await tempDir("roundtrip");
    const path = imStorePath(dir);
    const store = new ImStore(path, () => undefined, () => 1000);
    const saved = store.bind("feishu:feishu:p2p:ou_1", binding());
    expect(saved).toEqual({ ...binding(), createdAt: 1000, lastSeenAt: 1000 });

    const reopened = new ImStore(path);
    expect(reopened.binding("feishu:feishu:p2p:ou_1")).toMatchObject({ sessionPath: "C:/agent/sessions/a.jsonl", openId: "ou_user" });
    // 再次 bind 保留 createdAt（绑定的寿命不等于最后一次活动时间）。
    const updated = reopened.bind("feishu:feishu:p2p:ou_1", binding({ sessionPath: "C:/agent/sessions/b.jsonl" }));
    expect(updated.createdAt).toBe(1000);
    expect(updated.sessionPath).toBe("C:/agent/sessions/b.jsonl");
  });

  it("treats a corrupt file as empty instead of failing", async () => {
    const dir = await tempDir("corrupt");
    const path = imStorePath(dir);
    writeFileSync(path, "{not json", "utf8");
    const store = new ImStore(path, () => undefined, () => 5);
    expect(store.binding("any")).toBeUndefined();
    expect(store.hasSeen("feishu:x", "om_1")).toBe(false);
    // 坏文件之后仍能正常写入（首次写即修复）。
    store.markSeen("feishu:x", "om_1");
    expect(new ImStore(path).hasSeen("feishu:x", "om_1")).toBe(true);
  });

  it("drops malformed bindings/entries but keeps the valid neighbours", async () => {
    const dir = await tempDir("malformed");
    const path = imStorePath(dir);
    writeFileSync(path, JSON.stringify({
      version: 1,
      bindings: {
        good: { sessionPath: "C:/a.jsonl", chatId: "oc", openId: "ou", createdAt: 1, lastSeenAt: 2 },
        noPath: { chatId: "oc", openId: "ou" },
        weird: "nope"
      },
      seen: { "feishu:x": ["om_1", 42, "", "om_2"], "feishu:y": "not-an-array" }
    }), "utf8");
    const store = new ImStore(path);
    expect(store.binding("good")?.sessionPath).toBe("C:/a.jsonl");
    expect(store.binding("noPath")).toBeUndefined();
    expect(store.binding("weird")).toBeUndefined();
    expect(store.hasSeen("feishu:x", "om_1")).toBe(true);
    expect(store.hasSeen("feishu:x", "om_2")).toBe(true);
  });

  it("caps the seen list at IM_SEEN_LIMIT (LRU from the head)", async () => {
    const dir = await tempDir("seen-cap");
    const path = imStorePath(dir);
    const store = new ImStore(path);
    for (let index = 0; index < IM_SEEN_LIMIT + 25; index += 1) store.markSeen("feishu:x", `om_${index}`);
    const state = store.snapshot();
    expect(state.seen["feishu:x"]).toHaveLength(IM_SEEN_LIMIT);
    expect(store.hasSeen("feishu:x", "om_0")).toBe(false);
    expect(store.hasSeen("feishu:x", `om_${IM_SEEN_LIMIT + 24}`)).toBe(true);
    // 落盘体积随上限走，不随历史条数走。
    const raw = JSON.parse(await readFile(path, "utf8")) as ImStoreState;
    expect(raw.seen["feishu:x"]).toHaveLength(IM_SEEN_LIMIT);
  });

  it("writes atomically and leaves no tmp file behind", async () => {
    const dir = await tempDir("atomic");
    const path = imStorePath(dir);
    const store = new ImStore(path);
    store.bind("k", binding());
    store.markSeen("feishu:x", "om_1");
    const text = await readFile(path, "utf8");
    expect(() => JSON.parse(text)).not.toThrow();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps working when the file cannot be written (warn only, never throws)", async () => {
    const dir = await tempDir("unwritable");
    // 把目标路径做成目录：rename 必然失败，写入路径必须吞掉而不是中断消息处理。
    const path = join(dir, "pidesktop-im.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path);
    const warnings: string[] = [];
    const store = new ImStore(path, (message) => warnings.push(message));
    expect(() => store.markSeen("feishu:x", "om_1")).not.toThrow();
    expect(store.hasSeen("feishu:x", "om_1")).toBe(true); // 内存态仍然生效
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("unbind removes exactly one binding", async () => {
    const dir = await tempDir("unbind");
    const path = imStorePath(dir);
    const store = new ImStore(path);
    store.bind("a", binding({ openId: "ou_a" }));
    store.bind("b", binding({ openId: "ou_b" }));
    store.unbind("a");
    expect(store.binding("a")).toBeUndefined();
    expect(store.binding("b")?.openId).toBe("ou_b");
  });
});
