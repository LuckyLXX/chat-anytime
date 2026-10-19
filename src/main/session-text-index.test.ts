import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionPathKey } from "./session-scope.js";
import {
  createEmptySessionTextIndex,
  extractSearchText,
  loadSessionTextIndex,
  MAX_DOC_CHARS,
  parseSessionTextLine,
  pruneSessionTextIndex,
  saveSessionTextIndex,
  sessionTextIndexChars,
  updateSessionTextEntry
} from "./session-text-index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-text-index-"));
  temporaryDirectories.push(directory);
  return directory;
}

const header = JSON.stringify({ type: "session", id: "s1", timestamp: "2026-10-01T00:00:00.000Z", cwd: "C:/work" });
const userLine = JSON.stringify({ type: "message", message: { role: "user", timestamp: 1_000, content: "部署失败了怎么办" } });
const assistantLine = JSON.stringify({
  type: "message",
  message: {
    role: "assistant",
    timestamp: 2_000,
    content: [
      { type: "thinking", thinking: "内部推理不应进索引" },
      { type: "text", text: "先看构建日志" },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm run build" } }
    ]
  }
});
const toolResultLine = JSON.stringify({
  type: "message",
  message: { role: "toolResult", timestamp: 3_000, toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "工具输出不应进索引" }], isError: false }
});

async function writeSession(directory: string, extra = ""): Promise<string> {
  const file = join(directory, "session.jsonl");
  writeFileSync(file, [header, userLine, assistantLine, toolResultLine].join("\n") + "\n" + extra, "utf8");
  return file;
}

describe("session text extraction", () => {
  it("keeps user/assistant text and skips thinking, tool calls and tool results", () => {
    expect(parseSessionTextLine(userLine)?.doc).toEqual({ timestamp: 1_000, role: "user", text: "部署失败了怎么办" });
    expect(parseSessionTextLine(assistantLine)?.doc).toEqual({ timestamp: 2_000, role: "assistant", text: "先看构建日志" });
    expect(parseSessionTextLine(toolResultLine)).toBeUndefined();
    expect(parseSessionTextLine(header)).toBeUndefined();
  });

  it("accepts array content and rejects empty text", () => {
    expect(extractSearchText([{ type: "text", text: "甲" }, { type: "image", data: "xx" }, { type: "text", text: "乙" }])).toBe("甲\n乙");
    expect(extractSearchText("直接字符串")).toBe("直接字符串");
    expect(parseSessionTextLine(JSON.stringify({ type: "message", message: { role: "user", content: "   " } }))).toBeUndefined();
  });

  it("caps a single oversized message", () => {
    const huge = JSON.stringify({ type: "message", message: { role: "assistant", timestamp: 5, content: [{ type: "text", text: "a".repeat(MAX_DOC_CHARS + 100) }] } });
    expect(parseSessionTextLine(huge)?.doc.text).toHaveLength(MAX_DOC_CHARS);
  });
});

describe("session text index updates", () => {
  it("builds only once and appends the tail when the file grows", async () => {
    const directory = await makeDirectory();
    const file = await writeSession(directory);
    const index = createEmptySessionTextIndex();

    expect(updateSessionTextEntry(index, file)).toBe(true);
    const key = sessionPathKey(file);
    expect(index.files[key]?.docs).toHaveLength(2);

    // Unchanged file: zero work.
    expect(updateSessionTextEntry(index, file)).toBe(false);

    appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", timestamp: 4_000, content: "再补一句" } })}\n`, "utf8");
    expect(updateSessionTextEntry(index, file)).toBe(true);
    expect(index.files[key]?.docs.map((doc) => doc.text)).toEqual(["部署失败了怎么办", "先看构建日志", "再补一句"]);
  });

  it("re-reads the whole file when it shrinks (rewrite/rollback)", async () => {
    const directory = await makeDirectory();
    const file = await writeSession(directory);
    const index = createEmptySessionTextIndex();
    updateSessionTextEntry(index, file);

    await writeFile(file, [header, JSON.stringify({ type: "message", message: { role: "user", timestamp: 9_000, content: "重写后只剩这一条" } })].join("\n") + "\n", "utf8");
    expect(updateSessionTextEntry(index, file)).toBe(true);
    expect(index.files[sessionPathKey(file)]?.docs.map((doc) => doc.text)).toEqual(["重写后只剩这一条"]);
  });

  it("waits for a complete line before consuming it", async () => {
    const directory = await makeDirectory();
    const file = await writeSession(directory);
    const index = createEmptySessionTextIndex();
    updateSessionTextEntry(index, file);
    const key = sessionPathKey(file);
    const before = index.files[key]!.docs.length;

    const line = JSON.stringify({ type: "message", message: { role: "user", timestamp: 6_000, content: "半行写入中" } });
    appendFileSync(file, line.slice(0, 20), "utf8");
    updateSessionTextEntry(index, file);
    expect(index.files[key]?.docs).toHaveLength(before);

    appendFileSync(file, `${line.slice(20)}\n`, "utf8");
    updateSessionTextEntry(index, file);
    expect(index.files[key]?.docs.at(-1)?.text).toBe("半行写入中");
  });

  it("ignores missing files and malformed lines", async () => {
    const directory = await makeDirectory();
    const index = createEmptySessionTextIndex();
    expect(updateSessionTextEntry(index, join(directory, "missing.jsonl"))).toBe(false);

    const file = join(directory, "broken.jsonl");
    writeFileSync(file, `${header}\n{ not json but mentions \"role\":\"user\"\n`, "utf8");
    expect(updateSessionTextEntry(index, file)).toBe(true);
    expect(index.files[sessionPathKey(file)]?.docs).toEqual([]);
  });
});

describe("session text index persistence", () => {
  it("round-trips through disk and degrades to empty on a bad version", async () => {
    const directory = await makeDirectory();
    const file = await writeSession(directory);
    const index = createEmptySessionTextIndex();
    updateSessionTextEntry(index, file);

    const storePath = join(directory, "index.json");
    saveSessionTextIndex(storePath, index);
    const loaded = loadSessionTextIndex(storePath);
    expect(loaded.files[sessionPathKey(file)]?.docs).toHaveLength(2);

    await writeFile(storePath, JSON.stringify({ version: 999, files: {} }), "utf8");
    expect(loadSessionTextIndex(storePath).files).toEqual({});

    await writeFile(storePath, "{ broken", "utf8");
    expect(loadSessionTextIndex(storePath).files).toEqual({});
  });

  it("prunes the oldest files when the index exceeds its budget", async () => {
    const directory = await makeDirectory();
    const index = createEmptySessionTextIndex();
    index.files["a"] = { mtimeMs: 1, size: 1, parsedBytes: 1, docs: [{ timestamp: 1, role: "user", text: "a".repeat(100) }] };
    index.files["b"] = { mtimeMs: 2, size: 1, parsedBytes: 1, docs: [{ timestamp: 2, role: "user", text: "b".repeat(100) }] };

    expect(sessionTextIndexChars(index)).toBe(200);
    expect(pruneSessionTextIndex(index, 150)).toBe(true);
    expect(Object.keys(index.files)).toEqual(["b"]);
  });

  it("normalizes invalid docs out of a loaded index", async () => {
    const directory = await makeDirectory();
    const file = join(directory, "index.json");
    await writeFile(file, JSON.stringify({
      version: 1,
      updatedAt: 0,
      files: {
        [sessionPathKey("C:/s/a.jsonl")]: { mtimeMs: 1, size: 10, parsedBytes: 10, docs: [{ role: "system", text: "x" }, { role: "user", text: "保留" }, { role: "user" }] }
      }
    }), "utf8");
    expect(loadSessionTextIndex(file).files[sessionPathKey("C:/s/a.jsonl")]?.docs).toEqual([{ timestamp: 0, role: "user", text: "保留" }]);
  });

  it("drops entries with negative or non-finite sizes instead of letting readSync throw", async () => {
    const directory = await makeDirectory();
    const file = join(directory, "index.json");
    await writeFile(file, JSON.stringify({
      version: 1,
      updatedAt: 0,
      files: {
        bad: { mtimeMs: 1, size: -5, parsedBytes: -5, docs: [] },
        worse: { mtimeMs: 1, size: "huge", parsedBytes: 0, docs: [] },
        ok: { mtimeMs: 1, size: 0, parsedBytes: 0, docs: [] }
      }
    }), "utf8");

    expect(Object.keys(loadSessionTextIndex(file).files)).toEqual(["ok"]);
  });

  it("prunes by last scan time, not by the file's own mtime", async () => {
    const directory = await makeDirectory();
    const index = createEmptySessionTextIndex();
    index.files["recentlyScanned"] = { mtimeMs: 1, size: 1, parsedBytes: 1, lastUsedAt: 100, docs: [{ timestamp: 1, role: "user", text: "a".repeat(100) }] };
    index.files["stale"] = { mtimeMs: 2, size: 1, parsedBytes: 1, lastUsedAt: 50, docs: [{ timestamp: 2, role: "user", text: "b".repeat(100) }] };

    expect(pruneSessionTextIndex(index, 150)).toBe(true);
    expect(Object.keys(index.files)).toEqual(["recentlyScanned"]);
  });
});

describe("saveSessionTextIndex", () => {
  it("writes valid JSON that can be read back", async () => {
    const directory = await makeDirectory();
    const path = join(directory, "nested", "index.json");
    const index = createEmptySessionTextIndex();
    index.files["k"] = { mtimeMs: 1, size: 1, parsedBytes: 1, docs: [] };
    saveSessionTextIndex(path, index);
    expect(JSON.parse(await readFile(path, "utf8")).files).toEqual({ k: index.files["k"] });
  });
});
