// Computer-use capability cluster (utility process): the computer_* customTools
// Pi sessions use to control other desktop windows (enumerate / screenshot /
// click / type / press). The tools validate arguments and translate results;
// every operation executes by spawning a short-lived Python process that
// imports the `ljqCtrl` module shipped with the `computer-use` skill asset
// (`.pidesktop-skills/computer-use/ljqCtrl.py`, trimmed from GenericAgent,
// MIT). Script location is injected so the tools and the skill share ONE
// implementation — the skill stays the home of the long-tail operations
// (UIA probing, template matching, background message-level control) the
// model writes as ad-hoc code, while the high-frequency perceive-act loop
// gets structured tools.
//
// Permission model (permissions.ts): computer_click / computer_type /
// computer_press carry risk "desktop" — denied in read-only mode, confirmed
// per call in ask mode (the permission card shows the target window and
// coordinates), auto-allowed in workspace/full. computer_windows and
// computer_screenshot are read-only observation and ungated (a screenshot
// activates its window but does not change application state).
//
// Python transport: arguments travel base64-encoded inside a `-c` script
// (no quoting/escaping hazards), results come back on a `__CU__<json>` line
// so diagnostics printed by ljqCtrl (e.g. the `[Click check]` pixel-change
// report) can be collected verbatim as notes instead of corrupting the JSON.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Marker prefix of the JSON result line printed by the generated Python scripts. */
export const CU_RESULT_MARKER = "__CU__";

/** Operation timeout: ljqCtrl's GrabWindow sleeps ~0.4s (activate + settle); everything else is sub-second. */
const CU_SPAWN_TIMEOUT_MS = 30_000;

/** Screenshots can be a few MB base64 — the default 1MB maxBuffer would truncate them. */
const CU_SPAWN_MAX_BUFFER = 16 * 1024 * 1024;

export interface PythonSpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type PythonSpawn = (command: string[], script: string) => Promise<PythonSpawnResult>;

export interface ComputerToolDeps {
  /** The record's workspace (screenshot persistence). */
  workspace: () => string | undefined;
  /** Master switch, read live per call (settings.computer?.enabled !== false). */
  enabled: () => boolean;
  /** Directory containing ljqCtrl.py (the computer-use skill dir); undefined = asset missing. */
  locateScriptDir: () => string | undefined;
  /** Persist a captured screenshot to the workspace's default dir; returns a workspace-relative path. */
  saveScreenshot?: (data: string, mimeType: "image/png" | "image/jpeg") => Promise<string>;
  /** Python runner (injectable for tests). Defaults to execFile with a 30s timeout. */
  spawnPython?: PythonSpawn;
}

/**
 * Locate the computer-use skill dir containing ljqCtrl.py — project scope first
 * (`<workspace>/.pidesktop-skills/computer-use`), then the global dir
 * (`<agentDir>/pidesktop-skills/computer-use`) — the same precedence
 * skill-catalog applies to SKILL.md discovery.
 */
export function locateLjqCtrlDir(agentDir: string | undefined, workspace: string | undefined): string | undefined {
  const candidates = [
    ...(workspace ? [join(resolve(workspace), ".pidesktop-skills", "computer-use")] : []),
    ...(agentDir ? [join(agentDir, "pidesktop-skills", "computer-use")] : [])
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "ljqCtrl.py"))) return dir;
  }
  return undefined;
}

const DISABLED_TEXT = "电脑控制已在设置中停用（settings.computer.enabled），请在设置中开启后再试。";

// ---------------------------------------------------------------- python transport

async function defaultSpawnPython(command: string[], script: string): Promise<PythonSpawnResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command[0]!,
      [...command.slice(1), "-X", "utf8", "-c", script],
      { timeout: CU_SPAWN_TIMEOUT_MS, maxBuffer: CU_SPAWN_MAX_BUFFER, windowsHide: true, encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } },
      (error, stdout, stderr) => {
        if (error && typeof stdout !== "string") rejectPromise(new Error(error.message));
        else resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", code: error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? null) : 0 });
      }
    );
  });
}

interface PythonDetector {
  (): Promise<string[] | undefined>;
}

/** Cache of the detected Python launcher (["python"] or ["py", "-3"]); undefined until a successful probe. */
let detectedPython: string[] | undefined;

/** Reset the launcher-detection cache (tests inject their own spawn). */
export function resetComputerPythonDetector(): void {
  detectedPython = undefined;
}

function createPythonDetector(spawn: PythonSpawn): PythonDetector {
  return async () => {
    if (detectedPython) return detectedPython;
    for (const command of [["python"], ["py", "-3"]]) {
      try {
        const result = await spawn(command, "print('cu-ok')");
        if (/cu-ok/.test(result.stdout) && !/__CU__/.test(result.stdout)) {
          detectedPython = command;
          return command;
        }
      } catch {
        // try the next launcher
      }
    }
    return undefined;
  };
}

/** Build the Python script for one operation. Arguments ride base64-encoded — no quoting hazards. */
export function buildComputerScript(scriptDir: string, operation: string, args: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  return [
    "import sys, json, base64",
    `sys.path.insert(0, ${JSON.stringify(scriptDir)})`,
    "import ljqCtrl",
    `ARGS = json.loads(base64.b64decode(${JSON.stringify(payload)}))`,
    "def out(p):",
    `    print(${JSON.stringify(CU_RESULT_MARKER)} + json.dumps(p, ensure_ascii=False))`,
    "def resolve(w):",
    "    s = str(w)",
    "    if s.isdigit():",
    "        h = int(s)",
    "        if not ljqCtrl.win32gui.IsWindow(h):",
    "            raise RuntimeError('invalid hwnd: %d' % h)",
    "        return h",
    "    return ljqCtrl.FindWindow(s)",
    "try:",
    operation.split("\n").map((line) => (line ? `    ${line}` : "")).join("\n"),
    "except Exception as e:",
    "    out({'ok': False, 'error': type(e).__name__ + ': ' + str(e)})",
    ""
  ].join("\n");
}

/** Each operation body receives ARGS (decoded args), `out()` and `resolve()` from the wrapper above. Exported for smoke tests. */
export const OP_WINDOWS = [
  "rows = ljqCtrl.ListWindows()",
  "fg = ljqCtrl.Foreground()['hwnd']",
  "q = str(ARGS.get('query') or '').lower()",
  "items = []",
  "for r in rows:",
  "    if q and q not in r['title'].lower() and q not in r['class'].lower():",
  "        continue",
  "    rect = r['rect']",
  "    items.append({'hwnd': r['hwnd'], 'title': r['title'], 'class': r['class'], 'w': rect[2] - rect[0], 'h': rect[3] - rect[1], 'foreground': r['hwnd'] == fg})",
  "    if len(items) >= 60:",
  "        break",
  "out({'ok': True, 'windows': items, 'total': len(rows)})"
].join("\n");

export const OP_SCREENSHOT = [
  "hwnd = resolve(ARGS['window'])",
  "img = ljqCtrl.GrabWindow(hwnd)   # activates the window first",
  "import io",
  "buf = io.BytesIO()",
  "img.save(buf, format='PNG')",
  "ox, oy = ljqCtrl.ClientOrigin(hwnd)",
  "out({'ok': True, 'width': img.size[0], 'height': img.size[1], 'origin': [ox, oy], 'title': ljqCtrl.win32gui.GetWindowText(hwnd), 'png_b64': base64.b64encode(buf.getvalue()).decode('ascii')})"
].join("\n");

export const OP_CLICK = [
  "hwnd = resolve(ARGS['window'])",
  "ljqCtrl.Activate(hwnd)",
  "ox, oy = ljqCtrl.ClientOrigin(hwnd)",
  "x, y = ox + int(ARGS['x']), oy + int(ARGS['y'])",
  "title = ljqCtrl.win32gui.GetWindowText(hwnd)",
  "if ARGS.get('button') == 'double':",
  "    ljqCtrl.SetCursorPos((x, y))",
  "    ljqCtrl.MouseDClick()",
  "    out({'ok': True, 'action': 'double-click', 'screen': [x, y], 'title': title})",
  "else:",
  "    ljqCtrl.Click(x, y)   # prints the [Click check] report",
  "    out({'ok': True, 'action': 'click', 'screen': [x, y], 'title': title})"
].join("\n");

export const OP_TYPE = [
  "hwnd = resolve(ARGS['window']) if ARGS.get('window') is not None else None",
  "if hwnd:",
  "    ljqCtrl.Activate(hwnd)",
  "bak = ljqCtrl.GetClipboardText()",
  "ljqCtrl.type_text(ARGS['text'])",
  "import time as _t",
  "_t.sleep(0.4)",
  "try:",
  "    ljqCtrl.SetClipboardText(bak)   # type_text borrows the clipboard; restore the user's content",
  "except Exception:",
  "    pass",
  "out({'ok': True, 'typed': len(ARGS['text'])})"
].join("\n");

export const OP_PRESS = [
  "hwnd = resolve(ARGS['window']) if ARGS.get('window') is not None else None",
  "if hwnd:",
  "    ljqCtrl.Activate(hwnd)",
  "ljqCtrl.Press(ARGS['key'])",
  "out({'ok': True, 'key': ARGS['key']})"
].join("\n");

export interface ComputerOperationOutcome {
  ok: boolean;
  error?: string;
  notes: string[];
  data?: Record<string, unknown>;
}

/**
 * Parse the spawned process output: the `__CU__<json>` line is the result,
 * `[Click check]`/ljqCtrl diagnostic lines are collected verbatim as notes
 * (the pixel-change report is the model's only feedback on whether the click
 * landed — it must survive the transport).
 */
export function parseComputerOutput(stdout: string, stderr: string): ComputerOperationOutcome {
  const notes: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("[Click check]") || trimmed.startsWith("[TIPS]")) {
      notes.push(trimmed);
      continue;
    }
    if (trimmed.startsWith(CU_RESULT_MARKER)) {
      try {
        const parsed = JSON.parse(trimmed.slice(CU_RESULT_MARKER.length)) as Record<string, unknown>;
        return {
          ok: parsed.ok === true,
          error: typeof parsed.error === "string" ? parsed.error : undefined,
          notes,
          data: parsed
        };
      } catch {
        // fall through to the no-marker error below
      }
    }
  }
  const errTail = (stderr || stdout).split(/\r?\n/u).filter(Boolean).slice(-3).join(" | ");
  return { ok: false, error: errTail || "电脑控制脚本没有返回结果" , notes };
}

/** Turn low-level failures into actionable guidance (missing python / deps / script). */
export function describeComputerSpawnFailure(error: unknown, scriptDirMissing: boolean): string {
  if (scriptDirMissing) {
    return "电脑控制脚本未找到：需要 .pidesktop-skills/computer-use/ljqCtrl.py（computer-use skill 资产）。请确认 skill 已安装。";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ModuleNotFoundError: No module named '(win32\w+|PIL\w*)'/.test(message)) {
    return "缺少 Python 依赖：请先执行 pip install pywin32 pillow 后重试。";
  }
  if (/ModuleNotFoundError: No module named 'ljqCtrl'/.test(message)) {
    return "无法导入 ljqCtrl 模块：skill 资产目录不完整（缺 ljqCtrl.py）。";
  }
  if (/没有找到|not found|ENOENT|无法找到/i.test(message)) {
    return "未找到可用的 Python：请安装 Python 3.10+ 并确保 python 或 py 命令可用。";
  }
  return `电脑控制执行失败：${message}`;
}

interface ComputerExecuteContext {
  deps: ComputerToolDeps;
  spawn: PythonSpawn;
  detect: PythonDetector;
}

async function runComputerOperation(context: ComputerExecuteContext, operation: string, args: Record<string, unknown>): Promise<ComputerOperationOutcome> {
  if (!context.deps.enabled()) throw new Error(DISABLED_TEXT);
  const scriptDir = context.deps.locateScriptDir();
  if (!scriptDir) throw new Error(describeComputerSpawnFailure(undefined, true));
  const command = await context.detect();
  if (!command) throw new Error(describeComputerSpawnFailure(new Error("python not found"), false));
  try {
    const result = await context.spawn(command, buildComputerScript(scriptDir, operation, args));
    const outcome = parseComputerOutput(result.stdout, result.stderr);
    if (!outcome.ok && outcome.error && /window not found|invalid hwnd/.test(outcome.error)) {
      return { ...outcome, error: `窗口未找到（${outcome.error}）。先调用 computer_windows 查看窗口列表并核对标题。` };
    }
    return outcome;
  } catch (error) {
    throw new Error(describeComputerSpawnFailure(error, false));
  }
}

// ---------------------------------------------------------------- tool builders

const WINDOW_PARAM = Type.Union([Type.String(), Type.Number()], { description: "目标窗口：标题子串（大小写不敏感）或 hwnd 数字（来自 computer_windows）" });

const WINDOWS_TOOL_TEXT = "枚举本机可见顶层窗口（标题/类名/句柄/客户区尺寸，标记当前前台窗口）。控制桌面其他应用的第一步：先枚举定位目标窗口，再截图看清内容。query 可按标题/类名过滤。只读操作。";

const SCREENSHOT_TOOL_TEXT = "截取目标窗口客户区图像（自动切到前台）。返回图片（支持图片输入的模型直接查看；纯文本模型用 recognize_images 识别保存的文件）。回执带 origin（客户区原点屏幕坐标）：computer_click 的 x/y 就用这张截图的坐标系，不要自行换算。只读操作。";

const CLICK_TOOL_TEXT = "点击目标窗口客户区的指定坐标。x/y 是 computer_screenshot 截图内的坐标（工具自动换算屏幕物理坐标并先激活窗口）。回执带 [Click check] 像素变化验证：0% 变化说明点歪，必须停下重新截图诊断，禁止盲目重试。";

const TYPE_TOOL_TEXT = "向目标窗口输入文本（剪贴板 + ctrl+v；输入框必须已有焦点，必要时先 computer_click 点击输入框）。会临时借用系统剪贴板并自动恢复。";

const PRESS_TOOL_TEXT = "向目标窗口发送组合键（如 'ctrl+s'、'alt+tab'、'enter'、'esc'；键名见 computer-use skill）。可选 window 先激活目标窗口。";

export function buildComputerTools(deps: ComputerToolDeps): ToolDefinition[] {
  const spawn = deps.spawnPython ?? defaultSpawnPython;
  const detect = createPythonDetector(spawn);
  const context: ComputerExecuteContext = { deps, spawn, detect };

  const windows = defineTool({
    name: "computer_windows",
    label: "枚举桌面窗口",
    description: WINDOWS_TOOL_TEXT,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "按标题/类名子串过滤（大小写不敏感）" }))
    }),
    async execute(_id, params) {
      const outcome = await runComputerOperation(context, OP_WINDOWS, { query: params?.query });
      if (!outcome.ok) throw new Error(outcome.error);
      const windowsList = Array.isArray(outcome.data?.windows) ? (outcome.data!.windows as Record<string, unknown>[]) : [];
      const lines = windowsList.map((item) => {
        const fg = item.foreground ? " · 前台" : "";
        return `hwnd=${String(item.hwnd)} [${String(item.class)}] ${String(item.title).slice(0, 48)} (${String(item.w)}×${String(item.h)})${fg}`;
      });
      const total = typeof outcome.data?.total === "number" ? String(outcome.data.total) : "?";
      const hint = "\n下一步：computer_screenshot 截图看清窗口内容（坐标用截图内坐标）。";
      return { content: [{ type: "text" as const, text: `可见窗口 ${total} 个（列出 ${lines.length} 个）：\n${lines.join("\n")}${hint}` }], details: {} };
    }
  });

  const screenshot = defineTool({
    name: "computer_screenshot",
    label: "窗口截图",
    description: SCREENSHOT_TOOL_TEXT,
    parameters: Type.Object({
      window: WINDOW_PARAM
    }),
    async execute(_id, params) {
      const outcome = await runComputerOperation(context, OP_SCREENSHOT, { window: params?.window });
      if (!outcome.ok) throw new Error(outcome.error);
      const width = outcome.data?.width;
      const height = outcome.data?.height;
      const origin = Array.isArray(outcome.data?.origin) ? (outcome.data!.origin as number[]).join(", ") : "?";
      const title = String(outcome.data?.title ?? "");
      const pngB64 = typeof outcome.data?.png_b64 === "string" ? (outcome.data!.png_b64 as string) : "";
      let savedPath: string | undefined;
      if (pngB64 && deps.saveScreenshot && deps.workspace()) {
        try {
          savedPath = await deps.saveScreenshot(pngB64, "image/png");
        } catch {
          // persistence is an enhancement, never a precondition
        }
      }
      const text = `已截取窗口「${title}」（${String(width)}×${String(height)}）。点击坐标就用这张截图的坐标系：computer_click { window, x, y }。${savedPath ? `截图已保存到 ${savedPath}；` : ""}当前模型不支持图片输入时可调用 recognize_images 工具${savedPath ? "识别该文件" : "识别截图"}。客户区屏幕原点：(${origin})。`;
      return {
        content: [
          { type: "text" as const, text },
          ...(pngB64 ? [{ type: "image" as const, data: pngB64, mimeType: "image/png" as const }] : [])
        ],
        details: { width, height, ...(savedPath ? { savedPath } : {}) }
      };
    }
  });

  const click = defineTool({
    name: "computer_click",
    label: "桌面点击",
    description: CLICK_TOOL_TEXT,
    parameters: Type.Object({
      window: WINDOW_PARAM,
      x: Type.Number({ description: "客户区 X 坐标（computer_screenshot 截图内坐标）" }),
      y: Type.Number({ description: "客户区 Y 坐标（computer_screenshot 截图内坐标）" }),
      button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("double")], { description: "left 单击（默认，带像素变化验证）/ double 双击" }))
    }),
    async execute(_id, params) {
      const outcome = await runComputerOperation(context, OP_CLICK, { window: params?.window, x: params?.x, y: params?.y, button: params?.button });
      if (!outcome.ok) throw new Error(outcome.error);
      const screen = Array.isArray(outcome.data?.screen) ? (outcome.data!.screen as number[]).join(", ") : "?";
      const title = String(outcome.data?.title ?? "");
      const action = outcome.data?.action === "double-click" ? "已双击" : "已点击";
      const notes = outcome.notes.length ? `\n${outcome.notes.join("\n")}` : "";
      const verify = outcome.data?.action === "double-click"
        ? "双击不自带验证，请截图确认效果。"
        : "若上方报告 0% 像素变化，说明点击落点不对——重新截图核对坐标，禁止盲目重试。";
      return { content: [{ type: "text" as const, text: `${action}「${title}」客户区 (${String(params?.x)}, ${String(params?.y)}) → 屏幕 (${screen})。${verify}${notes}` }], details: {} };
    }
  });

  const type = defineTool({
    name: "computer_type",
    label: "桌面输入文本",
    description: TYPE_TOOL_TEXT,
    parameters: Type.Object({
      text: Type.String({ description: "要输入的文本（剪贴板粘贴，自动恢复用户剪贴板）" }),
      window: Type.Optional(WINDOW_PARAM)
    }),
    async execute(_id, params) {
      const outcome = await runComputerOperation(context, OP_TYPE, { text: params?.text, window: params?.window });
      if (!outcome.ok) throw new Error(outcome.error);
      return { content: [{ type: "text" as const, text: `已向目标窗口输入 ${String(outcome.data?.typed ?? String(params?.text ?? "").length)} 个字符（剪贴板已恢复）。验证：截图确认文本已进入输入框。` }], details: {} };
    }
  });

  const press = defineTool({
    name: "computer_press",
    label: "桌面按键",
    description: PRESS_TOOL_TEXT,
    parameters: Type.Object({
      key: Type.String({ description: "组合键，如 'ctrl+s'、'enter'、'alt+f4'" }),
      window: Type.Optional(WINDOW_PARAM)
    }),
    async execute(_id, params) {
      const outcome = await runComputerOperation(context, OP_PRESS, { key: params?.key, window: params?.window });
      if (!outcome.ok) throw new Error(outcome.error);
      return { content: [{ type: "text" as const, text: `已发送按键 ${String(params?.key)}。验证：截图确认按键效果（弹窗/保存/导航等）。` }], details: {} };
    }
  });

  return [windows, screenshot, click, type, press];
}
