import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { manualDownloadPrefs, moveDownloadedFile, resolveDownloadDir, uniqueDownloadName } from "./browser-manual-download.js";

const FALLBACK = join(tmpdir(), "pidesktop-fallback-downloads");

describe("resolveDownloadDir", () => {
  it("uses the configured directory when it is usable", () => {
    expect(resolveDownloadDir("D:\\Downloads", FALLBACK)).toBe("D:\\Downloads");
    expect(resolveDownloadDir("  D:\\Downloads  ", FALLBACK)).toBe("D:\\Downloads");
  });

  it("falls back for missing / blank / non-string values", () => {
    expect(resolveDownloadDir(undefined, FALLBACK)).toBe(FALLBACK);
    expect(resolveDownloadDir("", FALLBACK)).toBe(FALLBACK);
    expect(resolveDownloadDir("   ", FALLBACK)).toBe(FALLBACK);
    expect(resolveDownloadDir(42, FALLBACK)).toBe(FALLBACK);
    expect(resolveDownloadDir(null, FALLBACK)).toBe(FALLBACK);
  });
});

describe("manualDownloadPrefs", () => {
  it("defaults to asking with the system download dir", () => {
    expect(manualDownloadPrefs(undefined, FALLBACK)).toEqual({ dir: FALLBACK, ask: true });
    expect(manualDownloadPrefs({}, FALLBACK)).toEqual({ dir: FALLBACK, ask: true });
  });

  it("keeps an explicit answer and an explicit switch", () => {
    expect(manualDownloadPrefs({ downloadDir: "D:\\dl", downloadAsk: false }, FALLBACK)).toEqual({ dir: "D:\\dl", ask: false });
    expect(manualDownloadPrefs({ downloadAsk: true }, FALLBACK)).toEqual({ dir: FALLBACK, ask: true });
  });

  it("treats a broken switch as the default (ask)", () => {
    expect(manualDownloadPrefs({ downloadAsk: "no" }, FALLBACK).ask).toBe(true);
  });
});

describe("uniqueDownloadName", () => {
  it("keeps the name when nothing conflicts", () => {
    expect(uniqueDownloadName("C:\\dl", "photo.png", () => false)).toBe("photo.png");
  });

  it("appends an increasing suffix on conflict", () => {
    const taken = new Set([join("C:\\dl", "photo.png"), join("C:\\dl", "photo-1.png")]);
    expect(uniqueDownloadName("C:\\dl", "photo.png", (path) => taken.has(path))).toBe("photo-2.png");
  });

  it("handles names without an extension", () => {
    const taken = new Set([join("C:\\dl", "README")]);
    expect(uniqueDownloadName("C:\\dl", "README", (path) => taken.has(path))).toBe("README-1");
  });
});

describe("moveDownloadedFile", () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pidesktop-move-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reports 'same' for identical paths and leaves the file alone", async () => {
    const dir = tempDir();
    const file = join(dir, "a.bin");
    writeFileSync(file, "payload");
    expect(await moveDownloadedFile(file, file)).toBe("same");
    expect(readFileSync(file, "utf8")).toBe("payload");
  });

  it("moves the file to a new directory", async () => {
    const from = tempDir();
    const to = tempDir();
    const file = join(from, "a.bin");
    writeFileSync(file, "payload");
    expect(await moveDownloadedFile(file, join(to, "renamed.bin"))).toBe("moved");
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(to, "renamed.bin"), "utf8")).toBe("payload");
  });

  it("overwrites an existing target (the save dialog already asked about it)", async () => {
    const from = tempDir();
    const to = tempDir();
    const file = join(from, "a.bin");
    writeFileSync(file, "fresh");
    writeFileSync(join(to, "target.bin"), "stale");
    expect(await moveDownloadedFile(file, join(to, "target.bin"))).toBe("moved");
    expect(readFileSync(join(to, "target.bin"), "utf8")).toBe("fresh");
  });

  it("reports 'failed' when the source is gone", async () => {
    const from = tempDir();
    const to = tempDir();
    expect(await moveDownloadedFile(join(from, "missing.bin"), join(to, "x.bin"))).toBe("failed");
  });
});
