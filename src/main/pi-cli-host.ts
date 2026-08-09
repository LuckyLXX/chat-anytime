import { requestPiCliRun } from "./pi-cli-compat.js";
import type { ThinkingLevel } from "../shared/protocol.js";

export interface ParsedPiCliArgs {
  mode: "json" | "text";
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  sessionFile?: string;
  sessionDir?: string;
  noSession?: boolean;
  tools?: string[];
  excludeTools?: string[];
  noTools?: boolean;
  noBuiltinTools?: boolean;
  extensions?: string[];
  systemPrompt?: string;
  appendSystemPrompts?: string[];
  prompt?: string;
}

const thinkingLevels = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Parse the small, stable subset of Pi's print CLI used by extensions such as
 * the official subagent extension. The actual AgentSession stays in the
 * PiDesktop utility process; this module is intentionally a dependency-free
 * wire shim so Electron's run-as-node mode never has to load the Pi SDK.
 */
export function parsePiCliArgs(argv: string[]): ParsedPiCliArgs {
  let mode: ParsedPiCliArgs["mode"] = "text";
  let provider: string | undefined;
  let model: string | undefined;
  let thinking: ThinkingLevel | undefined;
  let sessionFile: string | undefined;
  let sessionDir: string | undefined;
  let noSession = false;
  let tools: string[] | undefined;
  let excludeTools: string[] | undefined;
  let noTools = false;
  let noBuiltinTools = false;
  const extensions: string[] = [];
  let systemPrompt: string | undefined;
  const appendSystemPrompts: string[] = [];
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      const value = argv[++index];
      if (value !== "json" && value !== "text") throw new Error(`不支持的 Pi CLI 输出模式：${value ?? "(缺少值)"}`);
      mode = value;
      continue;
    }
    if (arg === "--model") {
      model = argv[++index];
      if (!model) throw new Error("--model 缺少模型名称");
      continue;
    }
    if (arg === "--provider") {
      provider = argv[++index];
      if (!provider) throw new Error("--provider 缺少提供商名称");
      continue;
    }
    if (arg === "--thinking") {
      const value = argv[++index];
      if (!value || !thinkingLevels.has(value as ThinkingLevel)) throw new Error(`不支持的 Pi thinking level：${value ?? "(缺少值)"}`);
      thinking = value as ThinkingLevel;
      continue;
    }
    if (arg === "--session") {
      sessionFile = argv[++index];
      if (!sessionFile) throw new Error("--session 缺少会话文件路径");
      continue;
    }
    if (arg === "--session-dir") {
      sessionDir = argv[++index];
      if (!sessionDir) throw new Error("--session-dir 缺少会话目录路径");
      continue;
    }
    if (arg === "--system-prompt") {
      systemPrompt = argv[++index];
      if (!systemPrompt) throw new Error("--system-prompt 缺少内容");
      continue;
    }
    if (arg === "--tools" || arg === "-t") {
      const value = argv[++index];
      if (!value) throw new Error("--tools 缺少工具列表");
      tools = value.split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--exclude-tools" || arg === "-xt") {
      const value = argv[++index];
      if (!value) throw new Error("--exclude-tools 缺少工具列表");
      excludeTools = value.split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--no-tools" || arg === "-nt") {
      noTools = true;
      continue;
    }
    if (arg === "--no-builtin-tools" || arg === "-nbt") {
      noBuiltinTools = true;
      continue;
    }
    if (arg === "--extension" || arg === "-e") {
      const value = argv[++index];
      if (!value) throw new Error("--extension 缺少扩展路径");
      // pi-subagents always supplies its process-env based child runtime
      // extension. Keep the paths in the parsed contract, but do not import
      // them into the shared utility process: concurrent child sessions have
      // different PI_SUBAGENT_* values and process.env cannot isolate them.
      extensions.push(value);
      continue;
    }
    if (arg === "--append-system-prompt") {
      const value = argv[++index];
      if (!value) throw new Error("--append-system-prompt 缺少内容");
      appendSystemPrompts.push(value);
      continue;
    }
    if (arg === "--no-session") {
      noSession = true;
      continue;
    }
    if (arg === "-p" || arg === "--print") continue;
    // The shim deliberately runs without extension discovery. Accept the
    // corresponding Pi switches so extensions can pass their standard CLI
    // flags without accidentally broadening this process' trust boundary.
    if (arg === "--no-extensions" || arg === "--no-themes" || arg === "--no-skills" || arg === "--no-prompt-templates" || arg === "--no-context-files" || arg === "--approve" || arg === "-a" || arg === "--no-approve" || arg === "-na") continue;
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg?.startsWith("-")) throw new Error(`Pi CLI 兼容宿主暂不支持参数：${arg}`);
    if (arg) positional.push(arg);
  }

  if (noSession && (sessionFile || sessionDir)) {
    throw new Error("--no-session 不能与 --session 或 --session-dir 同时使用");
  }

  return {
    mode,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(sessionFile ? { sessionFile } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    ...(noSession ? { noSession } : {}),
    ...(tools ? { tools } : {}),
    ...(excludeTools ? { excludeTools } : {}),
    ...(noTools ? { noTools } : {}),
    ...(noBuiltinTools ? { noBuiltinTools } : {}),
    ...(extensions.length > 0 ? { extensions } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(appendSystemPrompts.length > 0 ? { appendSystemPrompts } : {}),
    ...(positional.length > 0 ? { prompt: positional.join(" ") } : {})
  };
}

function writeEvent(event: unknown): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function writeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

export async function runPiCliHost(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    return await requestPiCliRun({ argv, cwd: process.cwd() }, writeEvent, writeError);
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
