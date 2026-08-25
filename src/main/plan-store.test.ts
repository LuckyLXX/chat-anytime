import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planFileName, readPlanMode, saveApprovedPlan, writePlanMode } from "./plan-store.js";

const temporaryDirectories: string[] = [];

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pi-desktop-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

describe("plan mode state store", () => {
  it("round-trips enabled flag (atomic write)", async () => {
    const dir = await tempDir("plan-state");
    const path = join(dir, "plans", "session-1.json");
    expect(readPlanMode(path)).toBe(false);
    writePlanMode(path, true);
    expect(readPlanMode(path)).toBe(true);
    writePlanMode(path, false);
    expect(readPlanMode(path)).toBe(false);
  });

  it("treats missing/corrupt files as disabled", async () => {
    const dir = await tempDir("plan-state");
    const missing = join(dir, "plans", "missing.json");
    expect(readPlanMode(missing)).toBe(false);
    const corrupt = join(dir, "plans", "corrupt.json");
    await writeText(corrupt, "{not json");
    expect(readPlanMode(corrupt)).toBe(false);
  });
});

describe("planFileName", () => {
  it("derives the name from the first markdown heading", () => {
    const date = new Date("2026-08-25T10:00:00Z");
    expect(planFileName("# 状态栏时钟功能实现计划\n\n正文", date)).toBe("2026-08-25-状态栏时钟功能实现计划.md");
  });

  it("falls back to a date name without a heading", () => {
    const date = new Date("2026-08-25T10:00:00Z");
    expect(planFileName("无标题计划", date)).toBe("2026-08-25-plan.md");
  });

  it("sanitizes path separators and invalid filename characters", () => {
    const date = new Date("2026-08-25T10:00:00Z");
    expect(planFileName("# a/b:c*d.md", date)).toBe("2026-08-25-a-b-c-d.md");
    expect(planFileName("# ..\\..\\evil", date)).not.toContain("\\");
  });
});

describe("saveApprovedPlan", () => {
  it("writes the plan into docs/plans and returns the relative path", async () => {
    const dir = await tempDir("plan-save");
    const plan = "# 计划\n\n步骤一";
    const result = saveApprovedPlan(dir, plan);
    const relative = (result as { path: string }).path.replace(/\\/gu, "/");
    expect(relative).toMatch(/^docs\/plans\/\d{4}-\d{2}-\d{2}-计划\.md$/u);
    const saved = await readFileSync(join(dir, (result as { path: string }).path), "utf8");
    expect(saved).toContain("# 计划");
  });

  it("appends a numeric suffix instead of overwriting a same-day plan", async () => {
    const dir = await tempDir("plan-save");
    const first = saveApprovedPlan(dir, "# 同名计划");
    const second = saveApprovedPlan(dir, "# 同名计划");
    expect("path" in first && "path" in second).toBe(true);
    if ("path" in first && "path" in second) {
      expect(second.path).toBe(first.path.replace(/\.md$/u, "-2.md"));
    }
  });

  it("creates the plans directory when missing", async () => {
    const dir = await tempDir("plan-save");
    const nested = join(dir, "a", "b");
    const result = saveApprovedPlan(nested, "# 嵌套");
    expect("path" in result).toBe(true);
  });
});