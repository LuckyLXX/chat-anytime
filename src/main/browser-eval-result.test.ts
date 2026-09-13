import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EVAL_KEEP, isJsonLikeText, saveBrowserEvalResult } from "./browser-eval-result.js";

const EVAL_PATTERN = /^eval-.*\.(json|txt)$/u;

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pidesktop-eval-"));
}

describe("saveBrowserEvalResult", () => {
  it("writes the result into .pidesktop/eval and returns a workspace-relative path", async () => {
    const root = await workspace();
    const text = JSON.stringify([{ id: 1 }, { id: 2 }]);
    const rel = await saveBrowserEvalResult(root, text, true);
    expect(rel).toMatch(/^\.pidesktop\/eval\/eval-.*\.json$/u);
    expect(await readFile(join(root, ...rel.split("/")), "utf8")).toBe(text);
  });

  it("uses the .txt extension when the caller says the value is not JSON", async () => {
    const root = await workspace();
    const rel = await saveBrowserEvalResult(root, "plain text output", false);
    expect(rel).toMatch(/\.txt$/u);
  });

  it("classifies JSON-looking text by its first non-space character", () => {
    expect(isJsonLikeText("[1,2]")).toBe(true);
    expect(isJsonLikeText('  \n {"a":1}')).toBe(true);
    expect(isJsonLikeText("42")).toBe(false);
    expect(isJsonLikeText("hello")).toBe(false);
    expect(isJsonLikeText("")).toBe(false);
  });

  it("does not clobber a second spill written in the same millisecond", async () => {
    const root = await workspace();
    const [first, second] = await Promise.all([
      saveBrowserEvalResult(root, "first", true),
      saveBrowserEvalResult(root, "second", true)
    ]);
    expect(first).not.toBe(second);
    const dir = join(root, ".pidesktop", "eval");
    const names = (await readdir(dir)).sort();
    expect(names).toHaveLength(2);
    const bodies = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")));
    expect(bodies.sort()).toEqual(["first", "second"]);
  });

  it("keeps only the most recent spills", async () => {
    vi.useFakeTimers();
    try {
      const root = await workspace();
      const dir = join(root, ".pidesktop", "eval");
      const start = Date.now();
      for (let index = 0; index < EVAL_KEEP + 5; index++) {
        // 每次推进 5ms：文件名时间前缀唯一，避免同毫秒后缀影响「最新」的判定。
        vi.setSystemTime(start + index * 5);
        await saveBrowserEvalResult(root, `spill-${index}`, true);
      }
      const spills = (await readdir(dir)).filter((name) => EVAL_PATTERN.test(name)).sort();
      expect(spills).toHaveLength(EVAL_KEEP);
      // 保留最新的：最后一次写入必然还在，且最早那批已被裁掉。
      expect(await readFile(join(dir, spills[spills.length - 1]!), "utf8")).toBe(`spill-${EVAL_KEEP + 4}`);
      const bodies = await Promise.all(spills.map((name) => readFile(join(dir, name), "utf8")));
      expect(bodies).toContain(`spill-${EVAL_KEEP + 4}`);
      expect(bodies).not.toContain("spill-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a forward-slash relative path even on Windows", async () => {
    const root = await workspace();
    const rel = await saveBrowserEvalResult(root, "{}", true);
    expect(rel).not.toContain("\\");
  });
});
