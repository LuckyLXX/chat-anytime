/**
 * 自定义斜杠命令目录（与 skill-catalog 平行的轻量扫描器）。
 *
 * 命令 = 一个 md 模板文件：项目作用域 `<workspace>/.pidesktop-commands/*.md`
 * 覆盖全局 `<agentDir>/pidesktop-commands/*.md`（文件名去扩展即命令名）。
 * 文件格式：可选 frontmatter（`description` 一项，用于菜单副标题），正文即
 * 提示词模板；模板中的 `$ARGUMENTS` / `${ARGUMENTS}` 会被发送时用户输入的
 * 参数替换，没有占位符时参数追加在模板末尾。
 *
 * 发送链路（与 skill 同构）：runtimeCommandPrompt 在发送时重读模板文件展开，
 * 展开文本前挂 base64url 显示 marker（command-prompt 约定）——message-normalize
 * 解析 marker 还原命令徽标 + 参数正文，模板本体只进请求不进气泡展示层
 * （regenerate 重发同样从 marker 之外的链路重建，编辑回填只取参数）。
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandSummary, ResourceScope } from "../shared/protocol.js";
import { parseSkillFrontmatter } from "./skill-catalog.js";

export interface DiscoveredCommand {
  name: string;
  description: string;
  filePath: string;
  scope: ResourceScope;
}

/** 命令名即文件名：字母/数字/下划线/短横线/中文（冒号等分隔符排除，避免撞 /skill: 前缀）。 */
export const COMMAND_NAME_PATTERN = /^[A-Za-z0-9_\-\u4e00-\u9fff]+$/u;

function scanCommandDir(rootDir: string, scope: "global" | "project"): DiscoveredCommand[] {
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return [];
  }
  const commands: DiscoveredCommand[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    if (!COMMAND_NAME_PATTERN.test(name)) continue;
    const filePath = join(rootDir, entry);
    if (!existsSync(filePath)) continue;
    commands.push({ name, description: "", filePath, scope });
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Discover custom commands from the global dir and the project dir. On name
 * clash, project entries win (skill-catalog semantics).
 */
export function discoverCommands(globalDir: string, projectDir: string): DiscoveredCommand[] {
  const merged = new Map<string, DiscoveredCommand>();
  for (const command of scanCommandDir(globalDir, "global")) merged.set(command.name, command);
  for (const command of scanCommandDir(projectDir, "project")) merged.set(command.name, command);
  return [...merged.values()];
}

export function toCommandSummaries(commands: DiscoveredCommand[]): CommandSummary[] {
  // 每个文件只读一次：description（frontmatter）与 template（正文）一起带出。
  return commands.map((command) => {
    const content = readCommandFile(command.filePath);
    const frontmatter = content === undefined ? {} : parseSkillFrontmatter(content);
    return {
      name: command.name,
      description: frontmatter.description?.trim() ?? "",
      scope: command.scope,
      filePath: command.filePath,
      ...(content === undefined ? {} : { template: stripCommandFrontmatter(content).trim() })
    };
  });
}

function readCommandFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;

/** 剥离 frontmatter，返回模板正文。 */
export function stripCommandFrontmatter(content: string): string {
  return content.replace(FRONTMATTER_PATTERN, "");
}

/** 校验保存载荷：名字合法且模板非空，返回净化后的值（不合法抛错）。 */
export function validateCommandDraft(draft: { name: string; description?: string; template: string }): { name: string; description: string; template: string } {
  const name = draft.name.trim();
  if (!COMMAND_NAME_PATTERN.test(name)) throw new Error("命令名只能包含字母、数字、下划线、短横线和中文，且不能为空");
  const template = draft.template.trim();
  if (!template) throw new Error("命令模板内容不能为空");
  return { name, description: draft.description?.trim() ?? "", template };
}

/** 序列化回 md：有 description 才写 frontmatter（与手工编辑的文件双向兼容）。 */
export function serializeCommandFile(description: string, template: string): string {
  return description ? `---\ndescription: ${description.replace(/\r?\n/u, " ")}\n---\n\n${template}\n` : `${template}\n`;
}

/** 原子写命令文件（目录不存在则创建；temp+rename 防半写）。 */
export function writeCommandFile(dir: string, name: string, description: string, template: string): string {
  const filePath = join(dir, `${name}.md`);
  mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, serializeCommandFile(description, template), "utf8");
  renameSync(tempPath, filePath);
  return filePath;
}

/** 删除命令文件；文件不存在返回 false（由调用方转成可读错误）。 */
export function deleteCommandFile(dir: string, name: string): boolean {
  const filePath = join(dir, `${name}.md`);
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

const ARGUMENTS_PLACEHOLDER = /\$\{?ARGUMENTS\}?/gu;

/**
 * 展开模板：占位符替换为参数；模板无占位符且有参数时追加在末尾（空行分隔）。
 * 参数为空时占位符替换为空串（用户可把占位符放在可选语境内）。
 */
export function expandCommandTemplate(template: string, args: string | undefined): string {
  const trimmed = template.trim();
  const argText = args?.trim() ?? "";
  if (ARGUMENTS_PLACEHOLDER.test(trimmed)) {
    // reset lastIndex（/g 标志的 test 会推进它，重复调用会漏配）
    ARGUMENTS_PLACEHOLDER.lastIndex = 0;
    return trimmed.replace(ARGUMENTS_PLACEHOLDER, argText);
  }
  ARGUMENTS_PLACEHOLDER.lastIndex = 0;
  if (!argText) return trimmed;
  return `${trimmed}\n\n${argText}`;
}

export interface CommandPromptDisplay {
  name: string;
  args: string;
}

/** 发送给模型的最终 prompt：marker（展示元数据）+ 展开后的模板文本。 */
export function buildCommandPrompt(name: string, args: string | undefined, expandedTemplate: string): string {
  const metadata = Buffer.from(JSON.stringify({ name, args: args ?? "" }), "utf8").toString("base64url");
  return `<!-- pidesktop-command-display:${metadata} -->\n${expandedTemplate}`;
}

const displayMarkerPattern = /^<!-- pidesktop-command-display:([A-Za-z0-9_-]+) -->\r?\n/u;

/** 解析消息头部的命令 marker（气泡徽标 + 参数回显用），非命令消息返回 undefined。 */
export function parseCommandPrompt(text: string): CommandPromptDisplay | undefined {
  const marker = displayMarkerPattern.exec(text);
  if (!marker?.[1]) return undefined;
  try {
    const value = JSON.parse(Buffer.from(marker[1], "base64url").toString("utf8")) as Partial<CommandPromptDisplay>;
    if (typeof value.name === "string" && value.name.trim() && typeof value.args === "string") {
      return { name: value.name, args: value.args };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 发送时构建完整 prompt：重读模板文件（发送即热更新，无需重载资源），
 * frontmatter 剥离 + 参数展开 + marker。找不到命令（目录变动/删除）时抛错。
 */
export function buildRuntimeCommandPrompt(discovered: readonly DiscoveredCommand[], name: string, args: string | undefined): string {
  const command = discovered.find((item) => item.name === name);
  if (!command) throw new Error(`未找到自定义命令：/${name}`);
  let content: string;
  try {
    content = readFileSync(command.filePath, "utf8");
  } catch (error) {
    throw new Error(`读取命令模板失败 /${name}：${error instanceof Error ? error.message : String(error)}`);
  }
  return buildCommandPrompt(name, args, expandCommandTemplate(stripCommandFrontmatter(content), args));
}
