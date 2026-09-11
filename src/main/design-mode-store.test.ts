import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDesignMode, writeDesignMode } from "./design-mode-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-desktop-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

describe("design mode state store", () => {
  it("round-trips the enabled flag (atomic write)", async () => {
    const dir = await tempDir("design-mode");
    const path = join(dir, "design-mode", "session-1.json");
    expect(readDesignMode(path)).toBe(false);
    writeDesignMode(path, true);
    expect(readDesignMode(path)).toBe(true);
    writeDesignMode(path, false);
    expect(readDesignMode(path)).toBe(false);
  });

  it("creates the parent directory when missing", async () => {
    const dir = await tempDir("design-mode-nested");
    const path = join(dir, "a", "b", "session-1.json");
    writeDesignMode(path, true);
    expect(readDesignMode(path)).toBe(true);
  });

  it("treats missing/corrupt files as disabled (new sessions default off)", async () => {
    const dir = await tempDir("design-mode-bad");
    expect(readDesignMode(join(dir, "missing.json"))).toBe(false);
    const corrupt = join(dir, "corrupt.json");
    await mkdir(dirname(corrupt), { recursive: true });
    await writeFile(corrupt, "{not json", "utf8");
    expect(readDesignMode(corrupt)).toBe(false);
    // 合法 JSON 但字段类型不对（enabled 不是 true）同样按关闭处理。
    const wrong = join(dir, "wrong.json");
    await writeFile(wrong, JSON.stringify({ enabled: "yes" }), "utf8");
    expect(readDesignMode(wrong)).toBe(false);
  });
});
