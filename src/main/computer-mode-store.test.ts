import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readComputerMode, writeComputerMode } from "./computer-mode-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-desktop-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

describe("computer mode state store", () => {
  it("round-trips the enabled flag (atomic write)", async () => {
    const dir = await tempDir("computer-mode");
    const path = join(dir, "computer-mode", "session-1.json");
    expect(readComputerMode(path)).toBe(false);
    writeComputerMode(path, true);
    expect(readComputerMode(path)).toBe(true);
    writeComputerMode(path, false);
    expect(readComputerMode(path)).toBe(false);
  });

  it("creates the parent directory when missing", async () => {
    const dir = await tempDir("computer-mode-nested");
    const path = join(dir, "a", "b", "session-1.json");
    writeComputerMode(path, true);
    expect(readComputerMode(path)).toBe(true);
  });

  it("treats missing/corrupt files as disabled (new sessions default off)", async () => {
    const dir = await tempDir("computer-mode-bad");
    expect(readComputerMode(join(dir, "missing.json"))).toBe(false);
    const corrupt = join(dir, "corrupt.json");
    await mkdir(dirname(corrupt), { recursive: true });
    await writeFile(corrupt, "{not json", "utf8");
    expect(readComputerMode(corrupt)).toBe(false);
    // 合法 JSON 但字段类型不对（enabled 不是 true）同样按关闭处理——
    // 「默认不开」是省前缀成本的前提，误读成 true 会让每个会话白付 ≈580 tokens。
    const wrong = join(dir, "wrong.json");
    await writeFile(wrong, JSON.stringify({ enabled: "yes" }), "utf8");
    expect(readComputerMode(wrong)).toBe(false);
  });
});
