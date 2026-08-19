import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTodoStore, migrateLegacyTodoFile } from "./todo-store.js";
import type { Todo } from "../shared/protocol.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeStore(): Promise<ReturnType<typeof createTodoStore>> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-todos-"));
  temporaryDirectories.push(directory);
  return createTodoStore(join(directory, "todos.json"), () => { /* no-op for tests */ });
}

describe("todo store", () => {
  it("replaces the whole list atomically and persists across store instances", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "pi-desktop-todos-")), "todos.json");
    temporaryDirectories.push(dirname(path));
    const store = createTodoStore(path, () => {});
    store.replaceAll([
      { content: "审阅 PR", status: "pending" },
      { content: "提交", status: "in_progress" }
    ]);
    expect(store.list()).toEqual([
      { content: "审阅 PR", status: "pending" },
      { content: "提交", status: "in_progress" }
    ]);

    // Whole-list replacement drops everything not resent.
    store.replaceAll([{ content: "提交", status: "completed" }]);

    // Reopen from disk → data persists, normalized.
    const reopened = createTodoStore(path, () => {});
    expect(reopened.list()).toEqual([{ content: "提交", status: "completed" }]);
  });

  it("normalizes the legacy {id, title, notes} shape on read", async () => {
    const { promises: fs } = await import("node:fs");
    const dir = await mkdtemp(join(tmpdir(), "pi-desktop-todos-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "todos.json");
    await fs.writeFile(path, JSON.stringify({ todos: [
      { id: "t1", title: "旧任务", notes: "备注", status: "pending", createdAt: 1, updatedAt: 1 },
      { id: "t2", title: "已完成任务", status: "completed", createdAt: 2, updatedAt: 2 }
    ] }), "utf8");

    const store = createTodoStore(path, () => {});
    expect(store.list()).toEqual([
      { content: "旧任务（备注）", status: "pending" },
      { content: "已完成任务", status: "completed" }
    ]);
  });

  it("survives a corrupt file by starting empty", async () => {
    const { promises: fs } = await import("node:fs");
    const dir = await mkdtemp(join(tmpdir(), "pi-desktop-todos-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "todos.json");
    await fs.writeFile(path, "{ not valid json", "utf8");
    const store = createTodoStore(path, () => {});
    expect(store.list()).toEqual([]);
    store.replaceAll([{ content: "恢复后的任务", status: "pending" } satisfies Todo]);
    expect(store.list()).toHaveLength(1);
  });
});

describe("legacy todo migration", () => {
  it("seeds a fresh session file from the global file exactly once", async () => {
    const { promises: fs } = await import("node:fs");
    const dir = await mkdtemp(join(tmpdir(), "pi-desktop-todos-"));
    temporaryDirectories.push(dir);
    const legacy = join(dir, "pidesktop-todos.json");
    const first = join(dir, "todos", "session-a.json");
    await fs.writeFile(legacy, JSON.stringify({ todos: [{ content: "旧任务", status: "pending" }] }), "utf8");

    migrateLegacyTodoFile(first, legacy);
    expect(createTodoStore(first, () => {}).list().map((todo) => todo.content)).toEqual(["旧任务"]);
    // Legacy file is renamed so a second session never inherits the same todos.
    const renamed = await fs.readFile(`${legacy}.migrated`, "utf8");
    expect(renamed).toContain("旧任务");

    const second = join(dir, "todos", "session-b.json");
    migrateLegacyTodoFile(second, legacy);
    expect(createTodoStore(second, () => {}).list()).toEqual([]);
  });

  it("never overwrites an existing session file and ignores corrupt legacy data", async () => {
    const { promises: fs } = await import("node:fs");
    const dir = await mkdtemp(join(tmpdir(), "pi-desktop-todos-"));
    temporaryDirectories.push(dir);
    const legacy = join(dir, "pidesktop-todos.json");
    const target = join(dir, "todos", "session-a.json");

    const store = createTodoStore(target, () => {});
    store.replaceAll([{ content: "会话自己的任务", status: "pending" }]);
    await fs.writeFile(legacy, JSON.stringify({ todos: [{ content: "全局任务", status: "pending" }] }), "utf8");
    migrateLegacyTodoFile(target, legacy);
    expect(store.list().map((todo) => todo.content)).toEqual(["会话自己的任务"]);
    expect(await fs.readFile(legacy, "utf8")).toContain("全局任务");

    const corruptTarget = join(dir, "todos", "session-b.json");
    await fs.writeFile(legacy, "{ not valid json", "utf8");
    migrateLegacyTodoFile(corruptTarget, legacy);
    expect(createTodoStore(corruptTarget, () => {}).list()).toEqual([]);
  });
});
