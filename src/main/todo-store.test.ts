import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTodoStore } from "./todo-store.js";

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
  it("creates, lists and persists todos across store instances", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "pi-desktop-todos-")), "todos.json");
    temporaryDirectories.push(dirname(path));
    const store = createTodoStore(path, () => {});
    const a = store.create("审阅 PR", "关注安全");
    store.create("提交");
    expect(store.list().map((todo) => todo.title)).toEqual(["审阅 PR", "提交"]);
    expect(a).toMatchObject({ status: "pending", notes: "关注安全" });

    // Reopen from disk → data persists, normalized.
    const reopened = createTodoStore(path, () => {});
    expect(reopened.list()).toHaveLength(2);
    expect(reopened.list()[0]).toMatchObject({ id: a.id, title: "审阅 PR", notes: "关注安全" });
  });

  it("updates title/notes/status and stamps completion", async () => {
    const store = await makeStore();
    const todo = store.create("任务");
    store.update(todo.id, { status: "in_progress" });
    store.update(todo.id, { notes: "  细节  " });
    const updated = store.update(todo.id, { status: "completed" });
    expect(updated).toMatchObject({ status: "completed", notes: "细节" });
    expect(typeof updated?.completedAt).toBe("number");

    // clearing notes removes the field
    store.update(todo.id, { notes: "" });
    expect(store.list().find((item) => item.id === todo.id)?.notes).toBeUndefined();
  });

  it("ignores updates to unknown ids and removes todos", async () => {
    const store = await makeStore();
    const todo = store.create("任务");
    expect(store.update("missing", { status: "completed" })).toBeUndefined();
    expect(store.remove(todo.id)).toBe(true);
    expect(store.remove(todo.id)).toBe(false);
    expect(store.list()).toHaveLength(0);
  });

  it("survives a corrupt file by starting empty", async () => {
    const { promises: fs } = await import("node:fs");
    const dir = await mkdtemp(join(tmpdir(), "pi-desktop-todos-"));
    temporaryDirectories.push(dir);
    const path = join(dir, "todos.json");
    await fs.writeFile(path, "{ not valid json", "utf8");
    const store = createTodoStore(path, () => {});
    expect(store.list()).toEqual([]);
    store.create("恢复后的任务");
    expect(store.list()).toHaveLength(1);
  });
});

function dirname(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slash < 0 ? path : path.slice(0, slash);
}
