import { describe, expect, it } from "vitest";
import {
  buildImAnswerCard,
  buildImApprovalCard,
  parseImCardAction,
  parseImCommand,
  normalizeFeishuEvent,
  parseTextContent
} from "./im-feishu-channel";
import { splitByBytes, splitMarkdown } from "../shared/im";

/**
 * 飞书「方言层」的回归网：事件归一化、卡片形状、指令解析、长答案切片。
 *
 * 这些判定错一条就是用户体验级的 bug（群聊被当私聊执行、按钮回调认错、代码块
 * 被劈成两半），而且都不会抛错——只能靠断言钉住。
 */

function event(overrides: {
  chatType?: string;
  senderType?: string;
  messageType?: string;
  content?: string;
  openId?: string;
  messageId?: string;
  chatId?: string;
  eventType?: string;
} = {}) {
  const content = overrides.content ?? JSON.stringify({ text: "帮我看看这个 bug" });
  return {
    schema: "2.0",
    header: { event_id: "ev_1", event_type: overrides.eventType ?? "im.message.receive_v1", create_time: "1" },
    event: {
      sender: { sender_id: { open_id: overrides.openId ?? "ou_owner", union_id: "on_x" }, sender_type: overrides.senderType ?? "user" },
      message: {
        message_id: overrides.messageId ?? "om_1",
        chat_id: overrides.chatId ?? "oc_chat",
        chat_type: overrides.chatType ?? "p2p",
        message_type: overrides.messageType ?? "text",
        content
      }
    }
  };
}

describe("normalizeFeishuEvent", () => {
  it("accepts a p2p text message and exposes the fields the gateway needs", () => {
    expect(normalizeFeishuEvent(event())).toEqual({
      kind: "message",
      message: { messageId: "om_1", chatId: "oc_chat", chatType: "p2p", openId: "ou_owner", senderType: "user", messageType: "text", text: "帮我看看这个 bug" }
    });
  });

  it("drops group chat messages (P1.5 scope) with a reason", () => {
    const result = normalizeFeishuEvent(event({ chatType: "group" }));
    expect(result.kind).toBe("ignore");
    expect(result.kind === "ignore" && result.reason).toContain("私聊");
  });

  it("drops messages from other bots (otherwise two bots answer forever)", () => {
    const result = normalizeFeishuEvent(event({ senderType: "app" }));
    expect(result.kind).toBe("ignore");
  });

  it("drops non-text message types (images/files are P2)", () => {
    const result = normalizeFeishuEvent(event({ messageType: "image", content: JSON.stringify({ image_key: "img_1" }) }));
    expect(result.kind).toBe("ignore");
    expect(result.kind === "ignore" && result.reason).toContain("文本");
  });

  it("ignores other event types and malformed bodies without throwing", () => {
    expect(normalizeFeishuEvent(event({ eventType: "im.chat.updated_v1" })).kind).toBe("ignore");
    expect(normalizeFeishuEvent(undefined).kind).toBe("ignore");
    expect(normalizeFeishuEvent({ header: {}, event: {} }).kind).toBe("ignore");
    expect(normalizeFeishuEvent({ header: { event_type: "im.message.receive_v1" }, event: { message: { message_id: "" } } }).kind).toBe("ignore");
  });

  it("strips @-mention placeholders and collapses whitespace", () => {
    expect(parseTextContent(JSON.stringify({ text: "@_user_1  <at user_id=\"ou_bot\">机器人</at>   帮 我 看看" }))).toBe("帮 我 看看");
  });
});

describe("parseImCommand", () => {
  it("parses the approval commands case-insensitively", () => {
    expect(parseImCommand("/allow abcd2345")).toEqual({ kind: "allow", code: "ABCD2345" });
    expect(parseImCommand("/DENY abcd2345")).toEqual({ kind: "deny", code: "ABCD2345" });
    expect(parseImCommand("/allow")).toEqual({ kind: "text", text: "/allow" });
  });

  it("parses control commands and treats everything else as model text", () => {
    expect(parseImCommand("/new")).toEqual({ kind: "new" });
    expect(parseImCommand("/stop")).toEqual({ kind: "stop" });
    expect(parseImCommand("/abort")).toEqual({ kind: "stop" });
    expect(parseImCommand("/status")).toEqual({ kind: "status" });
    expect(parseImCommand("/help")).toEqual({ kind: "help" });
    expect(parseImCommand("帮我改一下 README")).toEqual({ kind: "text", text: "帮我改一下 README" });
    expect(parseImCommand("/unknown x")).toEqual({ kind: "text", text: "/unknown x" });
  });
});

describe("cards", () => {
  it("always carries update_multi (required for PATCH) and wide screen", () => {
    expect(buildImAnswerCard("hi").config).toEqual({ wide_screen_mode: true, update_multi: true });
    expect(buildImApprovalCard({ code: "ABCD2345", toolName: "bash", summary: "rm -rf dist", risk: "command", timeoutMs: 600_000 }).config.update_multi).toBe(true);
  });

  it("renders the approval card buttons with perm:<code>:<decision> values and the text fallback", () => {
    const card = buildImApprovalCard({ code: "ABCD2345", toolName: "bash", summary: "执行命令：npm test", risk: "command", timeoutMs: 600_000 });
    const action = card.elements.find((element) => (element as { tag?: string }).tag === "action") as { actions: { value: { k: string }; text: { content: string } }[] };
    expect(action.actions.map((button) => button.value.k)).toEqual([
      "perm:ABCD2345:allow-once",
      "perm:ABCD2345:allow-session",
      "perm:ABCD2345:deny"
    ]);
    expect(action.actions.map((button) => button.text.content)).toEqual(["允许一次", "本会话信任", "拒绝"]);
    const body = (card.elements[0] as { content: string }).content;
    expect(body).toContain("/allow ABCD2345");
    expect(body).toContain("/deny ABCD2345");
    expect(body).toContain("10 分钟内未处理将自动拒绝");
    expect(body).toContain("npm test");
  });

  it("parses our approval button payloads and rejects foreign ones", () => {
    const body = (value: unknown, openId = "ou_owner") => ({ schema: "2.0", header: { event_type: "card.action.trigger" }, event: { operator: { open_id: openId }, action: { tag: "button", value } } });
    expect(parseImCardAction(body({ k: "perm:ABCD2345:allow-once" }))).toEqual({ code: "ABCD2345", decision: "allow-once", openId: "ou_owner" });
    expect(parseImCardAction(body({ k: "perm:ABCD2345:deny" }))).toEqual({ code: "ABCD2345", decision: "deny", openId: "ou_owner" });
    expect(parseImCardAction(body({ k: "other:1" }))).toBeUndefined();
    expect(parseImCardAction(body({ k: "perm:lower:allow-once" }))).toBeUndefined();
    expect(parseImCardAction(undefined)).toBeUndefined();
  });
});

describe("long answer slicing", () => {
  it("keeps every fenced block balanced across chunks", () => {
    const fence = `\`\`\`ts\n${Array.from({ length: 12 }, (_, index) => `const a${index} = "${"x".repeat(20)}";`).join("\n")}\n\`\`\``;
    const text = `开头说明。\n\n${fence}\n\n结尾。`;
    const chunks = splitMarkdown(text, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect((chunk.match(/```/gu) ?? []).length % 2).toBe(0);
    }
  });

  it("splits by card bytes for CJK text (chars × 3 bytes is not the same budget)", () => {
    const text = "汉".repeat(20_000);
    const chunks = splitByBytes(text, 28 * 1024);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(28 * 1024);
    expect(chunks.join("")).toBe(text);
  });

  it("never splits a surrogate pair (emoji stays intact)", () => {
    const text = "😀".repeat(1000);
    const chunks = splitByBytes(text, 100);
    for (const chunk of chunks) expect(chunk).not.toMatch(/[\ud800-\udbff]$/u);
    expect(chunks.join("")).toBe(text);
  });
});
