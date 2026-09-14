// Computer-use capability cluster (utility process): the computer_* customTools
// Pi sessions use to control other desktop windows (enumerate / screenshot /
// click / type / press). The tools validate arguments and translate results;
// every operation executes by spawning a short-lived Python process that
// imports the `ljqCtrl` module shipped with the `computer-use` skill asset
// (`resources/skills/computer-use/ljqCtrl.py` in the repo / install dir,
// trimmed from GenericAgent, MIT). Script location is injected so the tools
// and the skill share ONE implementation — the skill stays the home of the long-tail operations
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
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Marker prefix of the JSON result line printed by the generated Python scripts. */
export const CU_RESULT_MARKER = "__CU__";

/**
 * Diagnostic line prefixes ljqCtrl prints on stdout that must be surfaced to
 * the model verbatim (they carry the on-screen truth the structured result
 * cannot express).
 */
const NOTE_PREFIXES = ["[Click check]", "[TIPS]", "[Activate]", "[GrabWindow]"] as const;

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
  /** Show the screen overlay "AI 正在操作 XX" before activating/acting on a window (fire-and-forget). */
  notify?: (text: string) => void;
  /** Python runner (injectable for tests). Defaults to execFile with a 30s timeout. */
  spawnPython?: PythonSpawn;
}

/**
 * Locate the computer-use skill dir containing ljqCtrl.py. Candidates follow
 * the same precedence as skill discovery (highest first): project
 * (`<workspace>/.pidesktop-skills/computer-use`) → user global
 * (`<agentDir>/pidesktop-skills/computer-use`) → bundled app skills
 * (`<install dir>/resources/skills/computer-use`, passed in by main) → the
 * shared cross-agent dir (`~/.agents/skills/computer-use`).
 */
export function locateLjqCtrlDir(agentDir: string | undefined, workspace: string | undefined, bundledDir?: string): string | undefined {
  const candidates = [
    ...(workspace ? [join(resolve(workspace), ".pidesktop-skills", "computer-use")] : []),
    ...(agentDir ? [join(agentDir, "pidesktop-skills", "computer-use")] : []),
    ...(bundledDir ? [join(bundledDir, "computer-use")] : []),
    join(homedir(), ".agents", "skills", "computer-use")
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
  "info = getattr(img, 'info', {}) or {}",
  "# cu_fg_ok=False 表示截图时前台不是目标窗口：这张图可能压根不是目标窗口的画面，",
  "# 必须让模型看到（GrabWindow 只截那块屏幕区域，它不知道上面盖着谁）。",
  "out({'ok': True, 'width': img.size[0], 'height': img.size[1], 'origin': [ox, oy], 'title': ljqCtrl.win32gui.GetWindowText(hwnd), 'fg_ok': bool(info.get('cu_fg_ok', True)), 'fg_title': str(info.get('cu_fg_title') or ''), 'png_b64': base64.b64encode(buf.getvalue()).decode('ascii')})"
].join("\n");

export const OP_CLICK = [
  "hwnd = resolve(ARGS['window'])",
  "ljqCtrl.Activate(hwnd)",
  "ox, oy = ljqCtrl.ClientOrigin(hwnd)",
  "x, y = ox + int(ARGS['x']), oy + int(ARGS['y'])",
  "title = ljqCtrl.win32gui.GetWindowText(hwnd)",
  "# 三件套验证（命中窗口 / 客户区变化 / 前台）由 ljqCtrl.Click 统一负责；",
  "# hwnd= 是关键：命中校验要拿它比对，否则「点到了别的窗口」永远发现不了。",
  "report = ljqCtrl.Click(x, y, hwnd=hwnd, double=(ARGS.get('button') == 'double'))",
  "report['title'] = title",
  "report['client'] = [int(ARGS['x']), int(ARGS['y'])]",
  "out(report)"
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
 * runtime diagnostics are collected verbatim as notes. These notes are the
 * model's only feedback on what actually happened on screen — the click
 * verification report (`[Click check]`), a window that failed to come to the
 * foreground (`[Activate]`), a screenshot whose foreground was a different
 * window (`[GrabWindow]`) — so every one of them must survive the transport.
 */
export function parseComputerOutput(stdout: string, stderr: string): ComputerOperationOutcome {
  const notes: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (NOTE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
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
    return "电脑控制脚本未找到：需要 computer-use skill 资产（ljqCtrl.py）。内置资产缺失请重装应用，或把 computer-use 目录放到全局技能目录 ~/.pi/agent/pidesktop-skills/ 或项目 .pidesktop-skills/。";
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
  // 屏幕提示条：用户焦点在目标窗口上，只有屏幕级提示有效；screenshot 的激活
  // 抢焦点也算操作，windows 枚举（无 window 参数）不打扰。
  if (context.deps.notify && args.window !== undefined && args.window !== null && String(args.window).trim()) {
    context.deps.notify(`AI 正在操作「${String(args.window)}」`);
  }
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

const SCREENSHOT_TOOL_TEXT = "截取目标窗口客户区图像（自动切到前台）。返回图片（支持图片输入的模型直接查看；纯文本模型用 recognize_images 识别保存的文件）。回执带 origin（客户区原点屏幕坐标）：computer_click 的 x/y 就用这张截图的坐标系，不要自行换算。回执同时报告截图时前台是否就是目标窗口（fg_ok=false 说明这张图可能不是目标窗口的画面，不可信）；只读操作。";

const CLICK_TOOL_TEXT = "点击目标窗口客户区的指定坐标。x/y 是 computer_screenshot 截图内的坐标（工具自动换算屏幕物理坐标并先激活窗口）。**点击前会先校对坐标上真正躺着哪个窗口：不是目标窗口（且不属于同一进程）就直接拒绝点击**——避免在用户别的窗口里乱点；被拒绝时坐标就是错的，重新截图算一遍。回执带三项验证：① 命中窗口（「点到了别的窗口」比坐标算错更常见）；② 屏幕变化（客户区整体与光标局部）；③ 前台校验（焦点被抢时后续键盘会落到别处）。**「无变化」不等于点歪**（静态区域正常无变化），先看命中与前台两项；命中失败时先重新截图核对，禁止盲目重试。";

const TYPE_TOOL_TEXT = "向目标窗口输入文本（剪贴板 + ctrl+v；输入框必须已有焦点，必要时先 computer_click 点击输入框）。会临时借用系统剪贴板并自动恢复。";

const PRESS_TOOL_TEXT = "向目标窗口发送组合键（如 'ctrl+s'、'alt+tab'、'enter'、'esc'；键名见 computer-use skill）。可选 window 先激活目标窗口。";

interface ClickReportView {
  window: string;
  x?: unknown;
  y?: unknown;
  button?: unknown;
  double?: boolean;
  screen?: unknown;
  title?: unknown;
  hitOk?: boolean;
  hitTitle?: unknown;
  inClient?: boolean;
  fgOk?: boolean;
  fgTitle?: unknown;
  clientChanged?: boolean;
  clientDiffRatio?: unknown;
  roiChanged?: boolean;
  verdict?: unknown;
  advice?: unknown;
}

function verdictIcon(ok: boolean | undefined): string {
  return ok === false ? "⚠️" : ok === true ? "✓" : "?";
}

/**
 * Render the multi-signal click report as model-facing prose.
 *
 * Kept as a pure function so the wording IS the contract under test: the whole
 * point of this change is that the receipt must (a) name the window the click
 * actually landed on, (b) stop equating 「no pixel change」 with 「clicked
 * wrong」, and (c) tell the model what to do next. The Python side already
 * picks the verdict; this only formats it.
 */
export function describeClickReport(report: ClickReportView): string {
  const action = report.double ? "已双击" : "已点击";
  const client = `${String(report.x ?? "?")}, ${String(report.y ?? "?")}`;
  const screen = Array.isArray(report.screen) ? (report.screen as number[]).join(", ") : "?";
  const title = String(report.title ?? report.window ?? "");
  const lines = [`${action}「${title}」客户区 (${client}) → 屏幕 (${screen})。`];
  const hit = report.hitOk === false
    ? `⚠️ 该坐标上的顶层窗口是「${String(report.hitTitle ?? "?")}」，不是目标窗口`
    : `${verdictIcon(true)} 命中目标窗口`;
  lines.push(`- 命中：${hit}`);
  const change = report.clientChanged === undefined
    ? "未测"
    : report.clientChanged
      ? `有（客户区变化 ${report.clientDiffRatio === undefined ? "?" : String(report.clientDiffRatio)}）`
      : `无（客户区变化 ${report.clientDiffRatio === undefined ? "0" : String(report.clientDiffRatio)}）`;
  const roi = report.roiChanged === undefined ? "未测" : report.roiChanged ? "有" : "无";
  lines.push(`- 变化：客户区 ${change}；光标局部 ${roi}`);
  lines.push(report.fgOk === false
    ? `- 前台：⚠️ 焦点在「${String(report.fgTitle ?? "?")}」（不是目标窗口）——后续电脑键盘会落到它那里，需要键盘时先 Activate`
    : `- 前台：${verdictIcon(true)}「${String(report.fgTitle ?? title)}」`);
  if (typeof report.advice === "string" && report.advice) lines.push(`- 结论：${report.advice}`);
  return lines.join("\n");
}

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
      const fgOk = outcome.data?.fg_ok !== false;
      const fgTitle = String(outcome.data?.fg_title ?? "");
      const pngB64 = typeof outcome.data?.png_b64 === "string" ? (outcome.data!.png_b64 as string) : "";
      let savedPath: string | undefined;
      if (pngB64 && deps.saveScreenshot && deps.workspace()) {
        try {
          savedPath = await deps.saveScreenshot(pngB64, "image/png");
        } catch {
          // persistence is an enhancement, never a precondition
        }
      }
      const fgWarning = fgOk
        ? ""
        : `⚠️ 截图时前台是「${fgTitle}」不是目标窗口「${title}」——GrabWindow 只截目标客户区那块屏幕区域，前台被抢时拿到的是**别的窗口的画面**。先重新 computer_screenshot 确认，不要基于这张图算坐标。`;
      const text = `${fgWarning ? `${fgWarning}\n` : ""}已截取窗口「${title}」（${String(width)}×${String(height)}）。点击坐标就用这张截图的坐标系：computer_click { window, x, y }。${savedPath ? `截图已保存到 ${savedPath}；` : ""}当前模型不支持图片输入时可调用 recognize_images 工具${savedPath ? "识别该文件" : "识别截图"}。客户区屏幕原点：(${origin})。`;
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
      // 点击前守卫拦下（坐标上坐的是别的应用的窗口）：这是可修正的模型错误，不是崩溃——
      // 报错文案里已经写了怎么办，模型据此重新截图算坐标即可。
      if (outcome.data?.verdict === "refused_hit") {
        const notes = outcome.notes.length ? `\n\n诊断输出：\n${outcome.notes.join("\n")}` : "";
        // 坐标要两个坐标系都报：模型给的是客户区坐标，守卫看到的是屏幕坐标，只报后者会让人对不上号。
        const screen = Array.isArray(outcome.data?.screen) ? (outcome.data!.screen as number[]).join(", ") : "?";
        const mapping = `坐标映射：客户区 (${String(params?.x)}, ${String(params?.y)}) → 屏幕 (${screen})。\n`;
        throw new Error(`${mapping}${outcome.error ?? "点击已被安全守卫拦下"}${notes}`);
      }
      if (!outcome.ok) throw new Error(outcome.error);
      const data = outcome.data ?? {};
      const notes = outcome.notes.length ? `\n\n诊断输出：\n${outcome.notes.join("\n")}` : "";
      const verdict = String(data.verdict ?? "");
      const tail = verdict === "changed"
        ? "\n关键动作建议再用 computer_screenshot 确认效果。"
        : "";
      const text = `${
        describeClickReport({
          window: params?.window as string,
          x: params?.x,
          y: params?.y,
          button: params?.button,
          double: params?.button === "double",
          screen: data.screen,
          title: data.title,
          hitOk: data.hit_ok as boolean | undefined,
          hitTitle: data.hit_title,
          inClient: data.in_client as boolean | undefined,
          fgOk: data.fg_ok as boolean | undefined,
          fgTitle: data.fg_title_after,
          clientChanged: data.client_changed as boolean | undefined,
          clientDiffRatio: data.client_diff_ratio,
          roiChanged: data.roi_changed as boolean | undefined,
          verdict: data.verdict,
          advice: data.advice
        })
      }${tail}${notes}`;
      return { content: [{ type: "text" as const, text }], details: {} };
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
