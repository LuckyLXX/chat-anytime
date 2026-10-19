import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTeamMode, writeTeamMode } from "./team-mode-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-desktop-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

describe("team mode state store", () => {
  it("round-trips the enabled flag (atomic write)", async () => {
    const dir = await tempDir("team-mode");
    const path = join(dir, "team-mode", "session-1.json");
    expect(readTeamMode(path)).toBe(false);
    writeTeamMode(path, true);
    expect(readTeamMode(path)).toBe(true);
    writeTeamMode(path, false);
    expect(readTeamMode(path)).toBe(false);
  });

  it("creates the parent directory when missing", async () => {
    const dir = await tempDir("team-mode-nested");
    const path = join(dir, "a", "b", "session-1.json");
    writeTeamMode(path, true);
    expect(readTeamMode(path)).toBe(true);
  });

  it("treats missing/corrupt files as disabled (new sessions default off)", async () => {
    const dir = await tempDir("team-mode-bad");
    expect(readTeamMode(join(dir, "missing.json"))).toBe(false);
    const corrupt = join(dir, "corrupt.json");
    await mkdir(dirname(corrupt), { recursive: true });
    await writeFile(corrupt, "{not json", "utf8");
    expect(readTeamMode(corrupt)).toBe(false);
    // 合法 JSON 但字段类型不对（enabled 不是 true）同样按关闭处理：
    // 「默认不开」是省前缀成本的前提，误读成 true 会让每个会话白付团队工具的前缀。
    const wrong = join(dir, "wrong.json");
    await writeFile(wrong, JSON.stringify({ enabled: "yes" }), "utf8");
    expect(readTeamMode(wrong)).toBe(false);
  });
});
