/**
 * 斜杠调用的统一展示层（Skill + 自定义命令，一条消息可挂多个、可混搭）。
 *
 * 单调用沿用既有 marker（`pidesktop-skill-display` / `pidesktop-command-display`）——
 * 发给模型的 prompt 与历史版本字节一致，单技能/单命令的链路零回归；≥2 个调用
 * 改用 `pidesktop-invoke-display` marker 携带调用清单 + 共享文本，正文由各调用
 * 的片段合并（`composeInvocationBody`）。
 *
 * 解析只有这一个入口（新 marker → 旧 skill → 旧 command），新消息与旧会话
 * JSONL 都归一成同一个 `{ invocations, text }`：气泡徽标、编辑回填、regenerate
 * 定位三处消费同一口径。
 */

import type { SlashInvocation } from "../shared/protocol.js";
import { parseCommandPrompt } from "./command-catalog.js";
import { parseSkillPrompt } from "./skill-prompt.js";

export interface InvocationDisplay {
  invocations: SlashInvocation[];
  /** 共享的用户要求 / 命令参数文本（气泡回显、编辑回填用）。 */
  text: string;
}

export interface InvocationSegment {
  kind: SlashInvocation["kind"];
  name: string;
  /** 该调用自身的提示词片段（已展开，不含共享文本）。 */
  body: string;
}

const multiMarkerPattern = /^<!-- pidesktop-invoke-display:([A-Za-z0-9_-]+) -->\r?\n/u;

/** 多调用合并 prompt：marker（展示元数据）+ 合并正文。 */
export function buildMultiInvocationPrompt(invocations: readonly SlashInvocation[], text: string, body: string): string {
  const metadata = Buffer.from(JSON.stringify({ invocations, text }), "utf8").toString("base64url");
  return `<!-- pidesktop-invoke-display:${metadata} -->\n${body}`;
}

/** 解析消息头部的调用 marker，非斜杠调用消息返回 undefined（普通文本/旧格式都兼容）。 */
export function parseInvocationPrompt(text: string): InvocationDisplay | undefined {
  const marker = multiMarkerPattern.exec(text);
  if (marker) {
    try {
      const value = marker[1] ? JSON.parse(Buffer.from(marker[1], "base64url").toString("utf8")) as Partial<InvocationDisplay> : undefined;
      const invocations = normalizeInvocations(value?.invocations);
      if (invocations && typeof value?.text === "string") return { invocations, text: value.text };
    } catch {
      /* 坏 marker 当普通文本，不误判 */
    }
    return undefined;
  }
  const skill = parseSkillPrompt(text);
  if (skill) return { invocations: [{ kind: "skill", name: skill.name }], text: skill.instructions };
  const command = parseCommandPrompt(text);
  if (command) return { invocations: [{ kind: "command", name: command.name }], text: command.args };
  return undefined;
}

function normalizeInvocations(value: unknown): SlashInvocation[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const invocations: SlashInvocation[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const record = item as { kind?: unknown; name?: unknown };
    if ((record.kind !== "skill" && record.kind !== "command") || typeof record.name !== "string" || !record.name.trim()) return undefined;
    invocations.push({ kind: record.kind, name: record.name });
  }
  return invocations;
}

/** 合并正文：各调用一段小标题 + 末尾一次性共享要求（避免共享文本按调用重复注入）。 */
export function composeInvocationBody(segments: readonly InvocationSegment[], text: string): string {
  const blocks = segments.map((segment) => [
    segment.kind === "skill" ? `【Skill：${segment.name}】` : `【命令：/${segment.name}】`,
    segment.body
  ].join("\n"));
  const shared = text.trim();
  return [
    `使用以下 Skill / 命令完成任务（共 ${segments.length} 项，按顺序执行）。`,
    ...blocks,
    shared ? `用户要求：\n${shared}` : undefined
  ].filter(Boolean).join("\n\n");
}

/** 调用清单比较（regenerate 定位用：按选择顺序严格相等）。 */
export function sameInvocations(left: readonly SlashInvocation[] | undefined, right: readonly SlashInvocation[] | undefined): boolean {
  if (!left?.length || !right?.length) return !left?.length && !right?.length;
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.kind === right[index]!.kind && item.name === right[index]!.name);
}
