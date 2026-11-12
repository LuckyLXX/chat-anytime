import type { PermissionDecision } from "../shared/protocol.js";
import { formatImApprovalCode, formatImDenyCode } from "../shared/im.js";

/**
 * 飞书通道的「方言层」（2026-11-12，IM 通道 P1）：
 *
 * - 入站：`im.message.receive_v1` 事件体 → 归一化的 {@link ImInboundMessage}；
 * - 出站：答案/审批/状态 → 卡片 JSON（1.0 结构，兼容所有客户端）；
 * - 指令：`/allow <code>` `/deny <code>` `/new` `/stop` `/status` `/help`。
 *
 * 这里只做纯函数（无 I/O、无状态）：平台形状变化只改这个文件，路由与绑定逻辑
 * 留在 im-gateway。卡片一律带 `config.update_multi: true`——更新卡片（PATCH）
 * 的前后都必须有它，漏了就只能发新消息。
 */

export interface ImInboundMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  openId: string;
  senderType: string;
  messageType: string;
  text: string;
}

export type ImEventNormalization =
  | { kind: "message"; message: ImInboundMessage }
  | { kind: "ignore"; reason: string };

export type ImCommand =
  | { kind: "allow"; code: string }
  | { kind: "deny"; code: string }
  | { kind: "new" }
  | { kind: "stop" }
  | { kind: "status" }
  | { kind: "help" }
  | { kind: "text"; text: string };

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * 事件体归一化。
 *
 * 本批只接私聊：`chat_type !== "p2p"` 一律忽略（群聊 P1.5），别的机器人发来的
 * 消息也不处理（`sender_type === "app"`，否则两个 bot 会互相回话形成环）。
 * 非文本消息（图片/文件）忽略——附件的安全面在 P2 再开。
 */
export function normalizeFeishuEvent(body: unknown): ImEventNormalization {
  const root = recordOf(body);
  if (!root) return { kind: "ignore", reason: "事件体不是 JSON 对象" };
  const header = recordOf(root.header) ?? {};
  const eventType = textOf(header.event_type);
  if (eventType && eventType !== "im.message.receive_v1") {
    return { kind: "ignore", reason: `事件类型 ${eventType} 不在本通道处理范围` };
  }
  const event = recordOf(root.event);
  if (!event) return { kind: "ignore", reason: "事件缺少 event 字段" };
  const message = recordOf(event.message);
  if (!message) return { kind: "ignore", reason: "事件缺少 message 字段" };
  const sender = recordOf(event.sender) ?? {};
  const senderId = recordOf(sender.sender_id) ?? {};
  const openId = textOf(senderId.open_id);
  const senderType = textOf(sender.sender_type) || "user";
  const messageId = textOf(message.message_id);
  const chatId = textOf(message.chat_id);
  const chatType = textOf(message.chat_type) || "unknown";
  const messageType = textOf(message.message_type) || "unknown";

  if (!messageId || !chatId || !openId) {
    return { kind: "ignore", reason: "事件缺少 message_id / chat_id / open_id" };
  }
  if (senderType === "app") return { kind: "ignore", reason: "消息来自其他机器人，避免互相回话" };
  if (chatType !== "p2p") return { kind: "ignore", reason: `本批只处理私聊（收到 chat_type=${chatType}）` };
  if (messageType !== "text") return { kind: "ignore", reason: `本批只处理文本消息（收到 message_type=${messageType}）` };

  const content = parseTextContent(message.content);
  if (!content) return { kind: "ignore", reason: "文本消息内容为空或无法解析" };
  return { kind: "message", message: { messageId, chatId, chatType, openId, senderType, messageType, text: content } };
}

/**
 * `content` 是 JSON 字符串（`{"text":"..."}`）。群里 @ 机器人会留下
 * `@_user_1`、`<at user_id="ou_xxx"></at>` 之类的占位，统一剥掉再 trim。
 */
export function parseTextContent(content: unknown): string {
  let text = "";
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content) as unknown;
      const record = recordOf(parsed);
      text = record ? textOf(record.text) : "";
    } catch {
      text = content;
    }
  } else {
    const record = recordOf(content);
    text = record ? textOf(record.text) : "";
  }
  return text
    .replace(/<at[^>]*>[^<]*<\/at>/gu, "")
    .replace(/@_user_\d+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** 解析一条消息里的斜杠指令；不是已知指令就当普通消息透给模型。 */
export function parseImCommand(text: string): ImCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { kind: "text", text: trimmed };
  const [command, ...rest] = trimmed.split(/\s+/u);
  const name = (command ?? "").slice(1).toLowerCase();
  const argument = rest.join(" ").trim();
  if (name === "allow" || name === "deny") {
    const code = argument.toUpperCase();
    if (!code) return { kind: "text", text: trimmed };
    return name === "allow" ? { kind: "allow", code } : { kind: "deny", code };
  }
  if (name === "new") return { kind: "new" };
  if (name === "stop" || name === "abort") return { kind: "stop" };
  if (name === "status") return { kind: "status" };
  if (name === "help") return { kind: "help" };
  return { kind: "text", text: trimmed };
}

// —— 出站卡片（飞书卡片 1.0 结构） ——

export interface ImCard {
  config: { wide_screen_mode: boolean; update_multi: boolean };
  header?: { title: { tag: "plain_text"; content: string }; template?: string };
  elements: unknown[];
}

function card(input: { title?: string; template?: string; elements: unknown[] }): ImCard {
  return {
    // update_multi 必须前后都有：PATCH 更新卡片的前提条件。
    config: { wide_screen_mode: true, update_multi: true },
    ...(input.title ? { header: { title: { tag: "plain_text" as const, content: input.title }, ...(input.template ? { template: input.template } : {}) } } : {}),
    elements: input.elements
  };
}

/** 答案/进度卡：正文走 markdown 元素（飞书渲染代码块、列表）。 */
export function buildImAnswerCard(text: string, options: { title?: string; template?: string } = {}): ImCard {
  return card({
    ...(options.title ? { title: options.title } : {}),
    ...(options.template ? { template: options.template } : {}),
    elements: [{ tag: "markdown", content: text }]
  });
}

/** 审批卡：标题 + 摘要 + 三个按钮；正文同时写出 `/allow <code>` 回退指令。 */
export function buildImApprovalCard(input: {
  code: string;
  toolName: string;
  summary: string;
  risk: string;
  timeoutMs: number;
  source?: string;
}): ImCard {
  const minutes = Math.max(1, Math.round(input.timeoutMs / 60_000));
  const body = [
    `**${input.toolName}** · 风险 ${input.risk}`,
    input.summary,
    input.source ? `来源会话：${input.source}` : "",
    "",
    `点按钮即可批复；卡片点不动时发送：\`${formatImApprovalCode(input.code)}\`（拒绝：\`${formatImDenyCode(input.code)}\`）`,
    `${minutes} 分钟内未处理将自动拒绝。`
  ].filter((line) => line !== "").join("\n");
  const button = (label: string, decision: PermissionDecision, style: "primary" | "danger" | "default") => ({
    tag: "button",
    text: { tag: "plain_text", content: label },
    ...(style === "default" ? {} : { type: style }),
    value: { k: `perm:${input.code}:${decision}` }
  });
  return card({
    title: "PiDesktop · 需要你确认",
    template: "orange",
    elements: [
      { tag: "markdown", content: body },
      { tag: "action", actions: [button("允许一次", "allow-once", "primary"), button("本会话信任", "allow-session", "default"), button("拒绝", "deny", "danger")] }
    ]
  });
}

/** 纯文本提示卡（错误/已停止/白名单提示等）：和答案卡同结构，方便统一 patch。 */
export function buildImTextCard(text: string, options: { title?: string; template?: string } = {}): ImCard {
  return buildImAnswerCard(text, options);
}

/**
 * 卡片按钮回调体 → 审批动作。
 *
 * 形状：`{event:{operator:{open_id}, action:{value:{k:"perm:<code>:<decision>"}, tag:"button", name}}}`
 * 值不是本应用写的（`k` 不匹配）时返回 undefined——别人家的卡片回调不当审批。
 */
export function parseImCardAction(body: unknown): { code: string; decision: PermissionDecision; openId?: string } | undefined {
  const root = recordOf(body);
  const event = recordOf(root?.event);
  const action = recordOf(event?.action);
  const value = recordOf(action?.value);
  const raw = value && typeof value.k === "string" ? value.k : "";
  const matched = /^perm:([A-Z0-9]{4,16}):(allow-once|allow-session|deny)$/u.exec(raw);
  if (!matched) return undefined;
  const operator = recordOf(event?.operator);
  const openId = textOf(operator?.open_id) || undefined;
  return { code: matched[1]!, decision: matched[2]! as PermissionDecision, ...(openId ? { openId } : {}) };
}

/** 审批是否属于本次点击的「按钮值」形状（供网关判定是否为我们的卡片）。 */
export function isImApprovalAction(body: unknown): boolean {
  return parseImCardAction(body) !== undefined;
}
