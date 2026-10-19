import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runVerifyCommand, truncateVerifyOutput, VERIFY_OUTPUT_CAP } from "./todo-verify.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-verify-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("runVerifyCommand", () => {
  it("runs in the workspace and captures stdout on success", async () => {
    const cwd = await makeDirectory();
    const result = await runVerifyCommand("node -e \"console.log('verify-ok')\"", { cwd });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.output).toContain("verify-ok");
  });

  it("reports a non-zero exit with stderr and the exit code", async () => {
    const cwd = await makeDirectory();
    const result = await runVerifyCommand("node -e \"process.stderr.write('boom'); process.exit(3)\"", { cwd });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.output).toContain("boom");
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("kills the command when the timeout elapses", async () => {
    const cwd = await makeDirectory();
    const startedAt = Date.now();
    const result = await runVerifyCommand("node -e \"setTimeout(() => {}, 5000)\"", { cwd, timeoutMs: 300 });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("kills the command when the abort signal fires", async () => {
    const cwd = await makeDirectory();
    const controller = new AbortController();
    const pending = runVerifyCommand("node -e \"setTimeout(() => {}, 5000)\"", { cwd, signal: controller.signal });

    setTimeout(() => controller.abort(), 150);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    const cwd = await makeDirectory();
    const controller = new AbortController();
    controller.abort();
    const result = await runVerifyCommand("echo never", { cwd, signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
  });

  it("truncates output but keeps the tail", async () => {
    const cwd = await makeDirectory();
    const result = await runVerifyCommand("node -e \"process.stdout.write('x'.repeat(9000) + 'THE-END')\"", { cwd });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("THE-END");
    expect(result.output).toContain("输出已截断");
    expect(result.output.length).toBeLessThan(VERIFY_OUTPUT_CAP + 100);
  });

  it("uses the requested working directory", async () => {
    const cwd = await makeDirectory();
    const result = await runVerifyCommand("node -e \"require('fs').writeFileSync('verify-cwd-probe.txt', '1')\"", { cwd });

    expect(result.ok).toBe(true);
    expect(existsSync(join(cwd, "verify-cwd-probe.txt"))).toBe(true);
  });

  it("fails cleanly for a missing or empty workspace", async () => {
    const missing = await runVerifyCommand("echo hi", { cwd: join(tmpdir(), "pi-desktop-missing-workspace") });
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("工作目录不存在");

    const empty = await runVerifyCommand("echo hi", { cwd: "   " });
    expect(empty.ok).toBe(false);
    expect(empty.output).toContain("没有工作区");
  });
});

describe("truncateVerifyOutput", () => {
  it("returns short output untouched and marks long output", () => {
    expect(truncateVerifyOutput("short")).toBe("short");
    const long = "a".repeat(VERIFY_OUTPUT_CAP + 50);
    const truncated = truncateVerifyOutput(long);
    expect(truncated).toContain("输出已截断");
    expect(truncated.endsWith("a".repeat(50))).toBe(true);
    expect(truncated.length).toBeLessThan(VERIFY_OUTPUT_CAP + 100);
  });
});
