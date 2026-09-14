import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { permissionAction, toolRisk } from "./permissions.js";
import {
  CU_RESULT_MARKER,
  buildComputerScript,
  buildComputerTools,
  describeComputerSpawnFailure,
  locateLjqCtrlDir,
  parseComputerOutput,
  resetComputerPythonDetector,
  type ComputerToolDeps,
  type PythonSpawn
} from "./runtime-computer.js";

afterEach(() => {
  resetComputerPythonDetector();
  vi.restoreAllMocks();
});

function makeDeps(overrides: Partial<ComputerToolDeps> = {}): ComputerToolDeps {
  return {
    workspace: () => "/ws",
    enabled: () => true,
    locateScriptDir: () => "/skill-dir",
    ...overrides
  };
}

/** A spawn mock that answers the launcher probe, then replays a scripted payload. */
function mockSpawn(payload: Record<string, unknown>, notes: string[] = []): PythonSpawn {
  return vi.fn(async (_command: string[], script: string) => {
    if (script.includes("cu-ok")) return { stdout: "cu-ok\n", stderr: "", code: 0 };
    const lines = [...notes, `${CU_RESULT_MARKER}${JSON.stringify(payload)}`];
    return { stdout: `${lines.join("\n")}\n`, stderr: "", code: 0 };
  }) as unknown as PythonSpawn;
}

describe("buildComputerScript", () => {
  it("embeds the script dir and base64-encoded args (round-trips exactly, no quoting hazards)", () => {
    const script = buildComputerScript("D:\\skill dir'with quotes", "out({'ok': True})", { window: "记事\"本'", x: 12 });
    expect(script).toContain(`sys.path.insert(0, "D:\\\\skill dir'with quotes")`);
    // the base64 blob must decode back to the original args verbatim
    const match = /b64decode\("([A-Za-z0-9+/=]+)"\)/u.exec(script);
    expect(match).toBeTruthy();
    expect(JSON.parse(Buffer.from(match![1]!, "base64").toString("utf8"))).toEqual({ window: "记事\"本'", x: 12 });
    expect(script).toContain(CU_RESULT_MARKER);
  });
});

describe("parseComputerOutput", () => {
  it("extracts the marker line as JSON and collects Click-check diagnostics as notes", () => {
    const stdout = [
      "[TIPS] always use physical coordinates!",
      "[Click check] 有像素变化 | fg: \"记事本\" ",
      `${CU_RESULT_MARKER}${JSON.stringify({ ok: true, action: "click", screen: [100, 200] })}`
    ].join("\n");
    const outcome = parseComputerOutput(stdout, "");
    expect(outcome.ok).toBe(true);
    expect(outcome.data?.screen).toEqual([100, 200]);
    expect(outcome.notes).toHaveLength(2);
    expect(outcome.notes[0]).toContain("physical coordinates");
    expect(outcome.notes[1]).toContain("有像素变化");
  });

  it("surfaces the python-side error payload", () => {
    const outcome = parseComputerOutput(`${CU_RESULT_MARKER}${JSON.stringify({ ok: false, error: "RuntimeError: window not found: xyz" })}\n`, "");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("window not found");
  });

  it("reports a parseable error when the marker line is missing", () => {
    const outcome = parseComputerOutput("Traceback (most recent call last):\n  File ...\nModuleNotFoundError: No module named 'win32gui'", "");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("ModuleNotFoundError");
  });
});

describe("describeComputerSpawnFailure", () => {
  it("classifies missing script dir / deps / python with actionable guidance", () => {
    expect(describeComputerSpawnFailure(undefined, true)).toContain("ljqCtrl.py");
    expect(describeComputerSpawnFailure(new Error("ModuleNotFoundError: No module named 'win32api'"), false)).toContain("pip install pywin32 pillow");
    expect(describeComputerSpawnFailure(new Error("Command failed: python 不是内部或外部命令 ENOENT"), false)).toContain("Python 3.10+");
    expect(describeComputerSpawnFailure(new Error("boom"), false)).toContain("boom");
  });
});

describe("locateLjqCtrlDir", () => {
  it("prefers the project skill dir, falls back to global, returns undefined when absent", () => {
    const root = mkdtempSync(join(tmpdir(), "cu-locate-"));
    try {
      const project = join(root, "ws", ".pidesktop-skills", "computer-use");
      const global = join(root, "agent", "pidesktop-skills", "computer-use");
      expect(locateLjqCtrlDir(join(root, "agent"), join(root, "ws"))).toBeUndefined();
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "ljqCtrl.py"), "# stub");
      expect(locateLjqCtrlDir(join(root, "agent"), join(root, "ws"))).toBe(project);
      mkdirSync(global, { recursive: true });
      writeFileSync(join(global, "ljqCtrl.py"), "# stub");
      expect(locateLjqCtrlDir(join(root, "agent"), join(root, "ws"))).toBe(project);
      expect(locateLjqCtrlDir(join(root, "agent"), undefined)).toBe(global);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the bundled app skills dir after project and global", () => {
    const root = mkdtempSync(join(tmpdir(), "cu-bundled-"));
    try {
      const global = join(root, "agent", "pidesktop-skills", "computer-use");
      const bundled = join(root, "resources", "skills", "computer-use");
      mkdirSync(bundled, { recursive: true });
      writeFileSync(join(bundled, "ljqCtrl.py"), "# stub");
      // 仅内置存在：任意工作区都能命中。优先级最低的是共享目录 ~/.agents/skills，
      // 它在开发机上可能也有同名 skill（那时它胜出），所以按优先级推期望值。
      const sharedDir = join(homedir(), ".agents", "skills", "computer-use");
      const onlyBundled = existsSync(sharedDir) ? sharedDir : bundled;
      expect(locateLjqCtrlDir(join(root, "agent"), join(root, "ws"), join(root, "resources", "skills"))).toBe(onlyBundled);
      expect(locateLjqCtrlDir(join(root, "agent"), undefined, join(root, "resources", "skills"))).toBe(onlyBundled);
      // 用户全局存在时优先于内置（用户可覆盖内置行为）
      mkdirSync(global, { recursive: true });
      writeFileSync(join(global, "ljqCtrl.py"), "# stub");
      expect(locateLjqCtrlDir(join(root, "agent"), join(root, "ws"), join(root, "resources", "skills"))).toBe(global);
      // 项目优先于全局与内置
      const project = join(root, "ws", ".pidesktop-skills", "computer-use");
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "ljqCtrl.py"), "# stub");
      expect(locateLjqCtrlDir(join(root, "agent"), join(root, "ws"), join(root, "resources", "skills"))).toBe(project);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("treats the shared ~/.agents/skills dir as the last resort", () => {
    const root = mkdtempSync(join(tmpdir(), "cu-last-"));
    try {
      const sharedDir = join(homedir(), ".agents", "skills", "computer-use");
      expect(locateLjqCtrlDir(undefined, undefined, join(root, "missing"))).toBe(existsSync(join(sharedDir, "ljqCtrl.py")) ? sharedDir : undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildComputerTools", () => {
  it("exposes the five tools with labels", () => {
    const tools = buildComputerTools(makeDeps({ spawnPython: mockSpawn({ ok: true }) }));
    expect(tools.map((tool) => tool.name)).toEqual(["computer_windows", "computer_screenshot", "computer_click", "computer_type", "computer_press"]);
  });

  it("computer_windows formats the window list with a next-step hint", async () => {
    const tools = buildComputerTools(makeDeps({ spawnPython: mockSpawn({ ok: true, total: 2, windows: [
      { hwnd: 11, title: "记事本", class: "Notepad", w: 800, h: 600, foreground: true },
      { hwnd: 22, title: "微信", class: "Qt", w: 400, h: 700, foreground: false }
    ] }) }));
    const result = await tools[0]!.execute("id", {} as never, undefined, undefined, undefined as never) as { content: { text: string }[] };
    const text = result.content[0]!.text;
    expect(text).toContain("可见窗口 2 个");
    expect(text).toContain("hwnd=11 [Notepad] 记事本 (800×600) · 前台");
    expect(text).toContain("computer_screenshot");
  });

  it("computer_screenshot returns an image part and persists through saveScreenshot", async () => {
    const saveScreenshot = vi.fn(async () => ".pidesktop/screenshots/computer-1.png");
    const tools = buildComputerTools(makeDeps({ spawnPython: mockSpawn({ ok: true, width: 800, height: 600, origin: [10, 40], title: "记事本", png_b64: "aGVsbG8=" }), saveScreenshot }));
    const result = await tools[1]!.execute("id", { window: "记事本" } as never, undefined, undefined, undefined as never) as { content: { type: string; text?: string; data?: string }[] };
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
    expect(result.content[0]!.text).toContain("computer-1.png");
    expect(result.content[0]!.text).toContain("截图的坐标系");
    expect(saveScreenshot).toHaveBeenCalledWith("aGVsbG8=", "image/png");
  });

  it("computer_click echoes client→screen coordinates and the pixel-change note", async () => {
    const spawn = mockSpawn({ ok: true, action: "click", screen: [410, 640], title: "记事本" }, ["[Click check] 有像素变化 | fg: \"记事本\""]);
    const tools = buildComputerTools(makeDeps({ spawnPython: spawn }));
    const result = await tools[2]!.execute("id", { window: "记事本", x: 400, y: 600 } as never, undefined, undefined, undefined as never) as { content: { text: string }[] };
    const text = result.content[0]!.text;
    expect(text).toContain("已点击「记事本」客户区 (400, 600) → 屏幕 (410, 640)");
    expect(text).toContain("[Click check]");
    expect(text).toContain("0% 像素变化");
  });

  it("fails fast when the script dir is missing", async () => {
    const tools = buildComputerTools(makeDeps({ locateScriptDir: () => undefined, spawnPython: mockSpawn({ ok: true }) }));
    await expect(tools[0]!.execute("id", {} as never, undefined, undefined, undefined as never)).rejects.toThrow("ljqCtrl.py");
  });

  it("fails fast when no python launcher is available", async () => {
    const spawn = vi.fn(async () => ({ stdout: "", stderr: "not found", code: 127 })) as unknown as PythonSpawn;
    const tools = buildComputerTools(makeDeps({ spawnPython: spawn }));
    await expect(tools[0]!.execute("id", {} as never, undefined, undefined, undefined as never)).rejects.toThrow("Python 3.10+");
  });

  it("respects the master switch read live per call", async () => {
    let on = true;
    const tools = buildComputerTools(makeDeps({ enabled: () => on, spawnPython: mockSpawn({ ok: true }) }));
    on = false;
    await expect(tools[0]!.execute("id", {} as never, undefined, undefined, undefined as never)).rejects.toThrow("settings.computer.enabled");
  });

  it("rewrites window-not-found into a self-correcting hint", async () => {
    const tools = buildComputerTools(makeDeps({ spawnPython: mockSpawn({ ok: false, error: "RuntimeError: window not found: 不存在的窗口" }) }));
    await expect(tools[1]!.execute("id", { window: "不存在的窗口" } as never, undefined, undefined, undefined as never)).rejects.toThrow("computer_windows");
  });
});

describe("computer_* permissions", () => {
  it("marks input-injection tools as desktop risk and keeps observation ungated", () => {
    expect(toolRisk("/ws", "computer_click", { window: "x", x: 1, y: 2 })).toBe("desktop");
    expect(toolRisk("/ws", "computer_type", { text: "hi" })).toBe("desktop");
    expect(toolRisk("/ws", "computer_press", { key: "enter" })).toBe("desktop");
    expect(toolRisk("/ws", "computer_windows", {})).toBeUndefined();
    expect(toolRisk("/ws", "computer_screenshot", { window: "x" })).toBeUndefined();
  });

  it("denies desktop risk in read-only, auto-allows in workspace, asks otherwise", () => {
    expect(permissionAction("read-only", "computer_click", "desktop")).toBe("deny");
    expect(permissionAction("workspace", "computer_click", "desktop")).toBe("allow");
    expect(permissionAction("ask", "computer_click", "desktop")).toBe("ask");
    expect(permissionAction("full", "computer_click", "desktop")).toBe("allow");
  });
});
