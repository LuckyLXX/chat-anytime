import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecentWorkspaces, recordRecentWorkspace, removeRecentWorkspace, writeRecentWorkspaces } from "./recent-workspaces.js";

describe("recent workspaces", () => {
  it("records a workspace at the front and dedupes by normalized path", () => {
    let list = recordRecentWorkspace([], "C:/Projects/One", 100);
    list = recordRecentWorkspace(list, "C:\\Projects\\Two", 200);
    list = recordRecentWorkspace(list, "c:/projects/one", 300);

    expect(list.map((item) => item.path)).toEqual([resolve("c:/projects/one"), resolve("C:/Projects/Two")]);
    expect(list[0]?.openedAt).toBe(300);
  });

  it("caps the list length", () => {
    let list: ReturnType<typeof recordRecentWorkspace> = [];
    for (let index = 0; index < 30; index += 1) {
      list = recordRecentWorkspace(list, `C:/Projects/Project-${index}`, index);
    }
    expect(list).toHaveLength(15);
    expect(list[0]?.path).toBe(resolve("C:/Projects/Project-29"));
  });

  it("removes a workspace by path", () => {
    const list = [
      { path: "C:/Projects/One", openedAt: 100 },
      { path: "C:/Projects/Two", openedAt: 200 }
    ];
    const next = removeRecentWorkspace(list, "c:/projects/one");
    expect(next.map((item) => item.path)).toEqual(["C:/Projects/Two"]);
  });

  it("round-trips through the JSON file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pidesktop-recent-"));
    const filePath = join(dir, "recent-workspaces.json");
    const list = [
      { path: "C:/Projects/One", openedAt: 100 },
      { path: "C:/Projects/Two", openedAt: 200 }
    ];
    writeRecentWorkspaces(filePath, list);
    expect(await readFile(filePath, "utf8")).toContain("C:/Projects/Two");
    expect(loadRecentWorkspaces(filePath).map((item) => item.path)).toEqual([resolve("C:/Projects/Two"), resolve("C:/Projects/One")]);
  });

  it("starts empty on a missing or corrupt file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pidesktop-recent-"));
    await writeFile(join(dir, "corrupt.json"), "{ not json", "utf8");
    expect(loadRecentWorkspaces(join(dir, "missing.json"))).toEqual([]);
    expect(loadRecentWorkspaces(join(dir, "corrupt.json"))).toEqual([]);
  });
});
