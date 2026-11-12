import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopSettings, ImChannelConfig, RuntimeCommand, RuntimeMessage } from "../shared/protocol";
import { defaultSettings } from "./settings";
import { ImGateway, type ImApiLike, type ImWsHandlers } from "./im-gateway";
import type { ImApiResult } from "./im-feishu-api";
import type { ImWsCardAck } from "./im-feishu-ws";
import { ImStore } from "./im-store";

/**
 * IM 网关的端到端回归网（假 api / 假 ws / 手动时钟，零网络）。
 *
 * 覆盖计划里点名的七件「静默会坏」的事：白名单、去重、绑定复用、ACK 顺序、
 * 审批回调载荷、审批超时文案、卡片更新失败的回退。全部通过**真实入口**驱动
 * （ws 的 onEvent / onCardAction、runtime 消息），不是直接调私有方法。
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `pidesktop-im-gateway-${label}-`));
  directories.push(directory);
  return directory;
}

const flush = async (rounds = 5): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => { setTimeout(resolve, 0); });
};

interface HarnessOptions {
  channel?: Partial<ImChannelConfig>;
  enabled?: boolean;
  secret?: string | null;
  cardSendFails?: boolean;
  patchFails?: boolean;
  textSendFails?: boolean;
}

interface SentCard {
  chatId: string;
  card: { config: { update_multi: boolean }; header?: { title: { content: string } }; elements: unknown[] };
}

async function createHarness(options: HarnessOptions = {}) {
  const userDataDir = await tempDir("store");
  const channel: ImChannelConfig = {
    id: "feishu",
    kind: "feishu",
    enabled: true,
    appId: "cli_1",
    allowFrom: ["ou_owner"],
    accessMode: "workspace",
    approvalTimeoutMs: 60_000,
    ...options.channel
  };
  const settings: DesktopSettings = {
    ...defaultSettings(),
    im: { enabled: options.enabled ?? true, channels: [channel] }
  };
  const commands: RuntimeCommand[] = [];
  const pushes: RuntimeMessage[] = [];
  const texts: string[] = [];
  const cards: SentCard[] = [];
  const patches: { messageId: string; card: unknown }[] = [];
  const order: string[] = [];
  let sequence = 0;
  let handlers: ImWsHandlers | undefined;
  let wsDisposed = 0;

  const api = (): ImApiLike => ({
    tenantToken: async () => ({ ok: true, data: "token" }),
    botInfo: async () => ({ ok: true, data: { name: "值班机器人" } }),
    sendText: async (_chatId, text): Promise<ImApiResult<{ messageId: string }>> => {
      if (options.textSendFails) return { ok: false, code: 230013, message: "Bot 未开启接收消息权限（im:message:send_as_bot）" };
      texts.push(text);
      order.push("text");
      return { ok: true, data: { messageId: `om_t${++sequence}` } };
    },
    sendCard: async (chatId, card): Promise<ImApiResult<{ messageId: string }>> => {
      if (options.cardSendFails) return { ok: false, message: "卡片发送失败" };
      cards.push({ chatId, card: card as SentCard["card"] });
      order.push("card");
      return { ok: true, data: { messageId: `om_c${++sequence}` } };
    },
    patchCard: async (messageId, card): Promise<ImApiResult<{ messageId: string }>> => {
      if (options.patchFails) return { ok: false, message: "卡片更新失败" };
      patches.push({ messageId, card });
      order.push("patch");
      return { ok: true, data: { messageId } };
    }
  });

  // 手动时钟：审批超时的断言不需要等真的 10 分钟。
  let now = 1_000_000;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    now: (): number => now,
    schedule: (fn: () => void, ms: number): number => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel: (id: number): void => { timers.delete(id); },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    }
  };

  const gateway = new ImGateway({
    userDataDir,
    getSettings: () => settings,
    getSecret: (channelId) => (options.secret === null ? undefined : options.secret ?? "app-secret"),
    sendCommand: (command) => {
      commands.push(command);
      order.push(`command:${command.type}`);
    },
    push: (message) => pushes.push(message),
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
    createApi: () => api(),
    createWs: (_config, _secret, wsHandlers) => {
      handlers = wsHandlers;
      return { start: async () => undefined, dispose: () => { wsDisposed += 1; }, connected: () => true };
    },
    makeApprovalCode: () => "ABCD2345",
    log: () => undefined
  });

  return {
    gateway,
    settings,
    channel,
    commands,
    pushes,
    texts,
    cards,
    patches,
    order,
    clock,
    userDataDir,
    handlers: (): ImWsHandlers => {
      if (!handlers) throw new Error("ws 还没建立");
      return handlers;
    },
    wsDisposed: () => wsDisposed
  };
}

function feishuEvent(input: { openId?: string; messageId?: string; text?: string; chatType?: string } = {}) {
  return {
    schema: "2.0",
    header: { event_id: "ev_1", event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_id: { open_id: input.openId ?? "ou_owner" }, sender_type: "user" },
      message: {
        message_id: input.messageId ?? "om_1",
        chat_id: "oc_chat",
        chat_type: input.chatType ?? "p2p",
        message_type: "text",
        content: JSON.stringify({ text: input.text ?? "帮我跑一下测试" })
      }
    }
  };
}

const SESSION_KEY = "feishu:feishu:p2p:ou_owner";

function ready(harness: Awaited<ReturnType<typeof createHarness>>, overrides: { requestId?: string; sessionId?: string; sessionPath?: string; created?: boolean } = {}) {
  const ensure = [...harness.commands].reverse().find((command) => command.type === "im.session.ensure");
  if (!ensure || ensure.type !== "im.session.ensure") throw new Error("没有 im.session.ensure 命令");
  harness.gateway.handleRuntimeMessage({
    type: "im.session.ready",
    requestId: overrides.requestId ?? ensure.requestId,
    sessionKey: SESSION_KEY,
    sessionId: overrides.sessionId ?? "sess-1",
    sessionPath: overrides.sessionPath ?? "C:/agent/chatanytime-sessions/default/hash/2026.jsonl",
    created: overrides.created ?? true,
    model: "anthropic/claude"
  });
}

describe("startup / status", () => {
  it("connects only when master switch + channel + secret are all present", async () => {
    const disabled = await createHarness({ enabled: false });
    disabled.gateway.start();
    expect(disabled.pushes.at(-1)).toMatchObject({ type: "im.status", status: { enabled: false } });
    const disabledStatus = disabled.pushes.at(-1);
    expect(disabledStatus?.type === "im.status" && disabledStatus.status.channels[0]?.state).toBe("disabled");

    const noSecret = await createHarness({ secret: null });
    noSecret.gateway.start();
    const status = noSecret.pushes.at(-1);
    expect(status?.type === "im.status" && status.status.channels[0]).toMatchObject({ state: "disabled", message: "未保存 App Secret" });
  });

  it("reports connecting, then reads the bot name after the socket connects", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onStatus("connected");
    await flush();
    const status = harness.pushes.at(-1);
    expect(status?.type === "im.status" && status.status.channels[0]).toMatchObject({ state: "connected", botName: "值班机器人" });
  });

  it("dispose closes the socket once and stops pushing status", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.gateway.dispose();
    expect(harness.wsDisposed()).toBe(1);
  });
});

describe("inbound routing", () => {
  it("refuses an unknown sender without creating any session", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent({ openId: "ou_stranger" }));
    await flush();
    expect(harness.commands).toHaveLength(0);
    expect(harness.texts).toHaveLength(1);
    expect(harness.texts[0]).toContain("ou_stranger");
    expect(harness.texts[0]).toContain("授权名单");
  });

  it("replies with the open_id when the allowlist is empty (and keeps the channel idle)", async () => {
    const harness = await createHarness({ channel: { allowFrom: [] } });
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    expect(harness.commands).toHaveLength(0);
    expect(harness.texts[0]).toContain("ou_owner");
    expect(harness.texts[0]).toContain("白名单");
  });

  it("dedupes by message_id (a platform redelivery must not run the task twice)", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent({ messageId: "om_same" }));
    await flush();
    // 第二次投递发生在会话还没就绪时：去重失效的话它会进待发队列，就绪后被投递两遍。
    harness.handlers().onEvent(feishuEvent({ messageId: "om_same" }));
    await flush();
    ready(harness);
    await flush();
    expect(harness.commands.filter((command) => command.type === "im.session.ensure")).toHaveLength(1);
    expect(harness.commands.filter((command) => command.type === "im.prompt")).toHaveLength(1);
  });

  it("ignores group chat and non-text events entirely", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent({ chatType: "group" }));
    await flush();
    expect(harness.commands).toHaveLength(0);
    expect(harness.texts).toHaveLength(0);
  });

  it("ACKs first (a card), then asks the runtime for the session", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    expect(harness.order.slice(0, 2)).toEqual(["card", "command:im.session.ensure"]);
    expect(harness.cards[0]?.card.header?.title.content).toContain("处理中");
    const ensure = harness.commands[0]!;
    expect(ensure.type === "im.session.ensure" && ensure).toMatchObject({
      sessionKey: SESSION_KEY,
      title: "飞书 · ou_owner",
      accessMode: "workspace",
      approvalTimeoutMs: 60_000
    });
    expect(ensure.type === "im.session.ensure" && ensure.sessionPath).toBeUndefined();
  });

  it("forwards the prompt once the session is ready and streams the answer into the same card", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    ready(harness);
    await flush();
    expect(harness.commands.at(-1)).toEqual({ type: "im.prompt", sessionId: "sess-1", text: "帮我跑一下测试" });

    // 回合进行中：进度补丁打到同一条回执卡片上（节流 ≥1.5s，先把时钟推进）。
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "start" });
    harness.clock.advance(2_000);
    harness.gateway.handleRuntimeMessage({ type: "im.delta", sessionId: "sess-1", text: "正在跑…" });
    await flush();
    expect(harness.patches).toHaveLength(1);
    expect(harness.patches[0]?.messageId).toBe("om_c1");

    // 收尾：最终答案 patch 同一张卡（不是再发一条）。
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "end", status: "ok", text: "全部通过 ✅" });
    await flush();
    expect(harness.patches.at(-1)?.messageId).toBe("om_c1");
    expect(JSON.stringify(harness.patches.at(-1)?.card)).toContain("全部通过");
    expect(harness.cards).toHaveLength(1);
  });

  it("reuses the bound sessionPath on the next message", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent({ messageId: "om_1" }));
    await flush();
    ready(harness);
    await flush();
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "start" });
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "end", status: "ok", text: "done" });
    await flush();
    harness.handlers().onEvent(feishuEvent({ messageId: "om_2" }));
    await flush();
    const ensures = harness.commands.filter((command) => command.type === "im.session.ensure");
    expect(ensures).toHaveLength(2);
    const second = ensures[1];
    expect(second?.type === "im.session.ensure" && second.sessionPath).toBe("C:/agent/chatanytime-sessions/default/hash/2026.jsonl");
    // 绑定也落了盘（重启后仍能复用）。
    const store = new ImStore(join(harness.userDataDir, "pidesktop-im.json"));
    expect(store.binding(SESSION_KEY)?.sessionPath).toContain("2026.jsonl");
  });

  it("survives a settings-triggered restart (in-flight conversation keeps its binding)", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    ready(harness);
    await flush();
    // 保存设置 → 主进程重建连接（start 只回收 socket，不丢会话映射）。
    harness.gateway.start();
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "start" });
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "end", status: "ok", text: "重连后的答案" });
    await flush();
    expect(JSON.stringify(harness.patches.at(-1)?.card)).toContain("重连后的答案");
  });

  it("ignores events for a channel that is no longer enabled", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.channel.enabled = false;
    harness.handlers().onEvent(feishuEvent({ messageId: "om_disabled" }));
    await flush();
    expect(harness.commands).toHaveLength(0);
  });

  it("answers /status, /help, /new and /stop without touching the model", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    for (const [index, text] of ["/status", "/help", "/new", "/stop"].entries()) {
      harness.handlers().onEvent(feishuEvent({ messageId: `om_cmd_${index}`, text }));
      await flush();
    }
    expect(harness.commands).toHaveLength(0);
    expect(harness.texts.some((line) => line.includes("会话键"))).toBe(true);
    expect(harness.texts.some((line) => line.includes("/allow <code>"))).toBe(true);
    expect(harness.texts.some((line) => line.includes("已开启新话题"))).toBe(true);
    expect(harness.texts.some((line) => line.includes("还没有进行中的会话"))).toBe(true);
  });

  it("reports aborted turns and execution failures with text", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    ready(harness);
    await flush();
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "start" });
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "end", status: "aborted" });
    await flush();
    // 中止停在原回执卡上（中性文案），不是另发一条。
    expect(JSON.stringify(harness.patches.at(-1)?.card)).toContain("已停止当前回复。");

    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "start" });
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "end", status: "error", error: "模型超时" });
    await flush();
    expect(harness.texts.at(-1)).toContain("执行失败：模型超时");
  });

  it("falls back to a new card when the status card cannot be patched", async () => {
    const harness = await createHarness({ patchFails: true });
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    ready(harness);
    await flush();
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "start" });
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "end", status: "ok", text: "答案正文" });
    await flush();
    expect(harness.patches).toHaveLength(0);
    expect(harness.cards).toHaveLength(2);
    expect(JSON.stringify(harness.cards.at(-1)?.card)).toContain("答案正文");
  });

  it("still delivers the answer as text when every card send fails", async () => {
    const harness = await createHarness({ cardSendFails: true });
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    ready(harness);
    await flush();
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "start" });
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "end", status: "ok", text: "兜底文本" });
    await flush();
    expect(harness.texts.at(-1)).toContain("兜底文本");
  });

  it("flattens a Div bubble before it hits the card (Feishu renders no HTML)", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    ready(harness);
    await flush();
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "start" });
    harness.gateway.handleRuntimeMessage({
      type: "im.turn",
      sessionId: "sess-1",
      phase: "end",
      status: "ok",
      text: "<assistant_html>\n<div>\n<style>.a{color:red}</style>\n<h2>已配好</h2>\n<p>通道通了</p>\n</div>\n</assistant_html>"
    });
    await flush();
    const sent = JSON.stringify(harness.patches.at(-1)?.card);
    expect(sent).not.toContain("assistant_html");
    expect(sent).not.toContain("color:red");
    expect(sent).toContain("已配好");
    expect(sent).toContain("通道通了");
  });

  it("splits a very long answer across several cards", async () => {    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    ready(harness);
    await flush();
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "start" });
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "end", status: "ok", text: "段".repeat(30_000) });
    await flush();
    // 第一段 patch 回执卡，其余按切片发新卡。
    expect(harness.patches.length).toBeGreaterThanOrEqual(1);
    expect(harness.cards.length).toBeGreaterThanOrEqual(2);
  });
});

describe("通道诊断（「发了消息没反应」的可观测性）", () => {
  it("records inbound frames, message events and pushes them with im.status", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onStatus("connected");
    harness.handlers().onInbound();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    harness.clock.advance(1_000);
    await flush();
    const status = harness.pushes.filter((message) => message.type === "im.status").at(-1);
    expect(status?.type === "im.status" && status.status.channels[0]?.state).toBe("connected");
    const channel = status?.type === "im.status" ? status.status.channels[0] : undefined;
    expect(channel?.lastFrameAt).toBeGreaterThan(0);
    expect(channel?.lastEventAt).toBeGreaterThan(0);
    expect(channel?.lastEventSummary).toContain("ou_owner");
  });

  it("records the ignore reason (a dropped event must not be invisible)", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent({ chatType: "group" }));
    await flush();
    harness.clock.advance(1_000);
    await flush();
    const status = harness.pushes.filter((message) => message.type === "im.status").at(-1);
    const channel = status?.type === "im.status" ? status.status.channels[0] : undefined;
    expect(channel?.lastIgnored).toContain("私聊");
    expect(channel?.lastEventAt).toBeGreaterThan(0);
  });

  it("records outbound failures (missing send permission is visible in the panel)", async () => {
    const harness = await createHarness({ channel: { allowFrom: [] }, textSendFails: true });
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent({ openId: "ou_stranger" }));
    await flush();
    harness.clock.advance(1_000);
    await flush();
    const status = harness.pushes.filter((message) => message.type === "im.status").at(-1);
    const channel = status?.type === "im.status" ? status.status.channels[0] : undefined;
    expect(channel?.lastError).toContain("send_as_bot");
  });
});

describe("approvals", () => {
  function permissionRequest(sessionId = "sess-1") {
    return {
      type: "permission" as const,
      request: {
        id: "permission-1",
        toolName: "bash",
        summary: "执行命令：npm test",
        args: { command: "npm test" },
        risk: "command" as const,
        principal: { kind: "root-agent" as const, sessionId, agentId: "default", toolCallId: "call-1" }
      }
    };
  }

  async function withConversation() {
    const harness = await createHarness();
    harness.gateway.start();
    harness.handlers().onEvent(feishuEvent());
    await flush();
    ready(harness);
    await flush();
    return harness;
  }

  it("sends an approval card whose buttons carry perm:<code>:<decision>", async () => {
    const harness = await withConversation();
    expect(harness.gateway.handleRuntimeMessage(permissionRequest())).toBe(false);
    await flush();
    const card = harness.cards.at(-1);
    expect(card?.card.config.update_multi).toBe(true);
    const json = JSON.stringify(card?.card);
    expect(json).toContain("perm:ABCD2345:allow-once");
    expect(json).toContain("/allow ABCD2345");
    expect(json).toContain("npm test");
  });

  it("resolves the permission when the button is clicked (and answers with a toast)", async () => {
    const harness = await withConversation();
    harness.gateway.handleRuntimeMessage(permissionRequest());
    await flush();
    const ack: ImWsCardAck | undefined = await harness.handlers().onCardAction({
      schema: "2.0",
      header: { event_type: "card.action.trigger" },
      event: { operator: { open_id: "ou_owner" }, action: { tag: "button", value: { k: "perm:ABCD2345:allow-once" } } }
    });
    expect(ack?.toast?.content).toContain("已放行");
    expect(harness.commands.at(-1)).toEqual({ type: "permission.resolve", id: "permission-1", decision: "allow-once" });
    // 卡片被就地改成「结果」，按钮不再挂着。
    expect(JSON.stringify(harness.patches.at(-1)?.card)).toContain("已允许一次");
  });

  it("resolves the same approval from a /deny text command", async () => {
    const harness = await withConversation();
    harness.gateway.handleRuntimeMessage(permissionRequest());
    await flush();
    harness.handlers().onEvent(feishuEvent({ messageId: "om_deny", text: "/deny ABCD2345" }));
    await flush();
    expect(harness.commands.at(-1)).toEqual({ type: "permission.resolve", id: "permission-1", decision: "deny" });
  });

  it("refuses a click from someone outside the allowlist", async () => {
    const harness = await withConversation();
    harness.gateway.handleRuntimeMessage(permissionRequest());
    await flush();
    const ack = await harness.handlers().onCardAction({ event: { operator: { open_id: "ou_stranger" }, action: { value: { k: "perm:ABCD2345:allow-once" } } } });
    expect(ack?.toast?.content).toContain("授权名单");
    expect(harness.commands.some((command) => command.type === "permission.resolve")).toBe(false);
  });

  it("tells the phone when the approval times out (broker denies on its own)", async () => {
    const harness = await withConversation();
    harness.gateway.handleRuntimeMessage(permissionRequest());
    await flush();
    harness.clock.advance(60_000);
    await flush();
    expect(harness.texts.at(-1)).toContain("审批超时");
    // 超时后再点按钮：只回一条「已处理」，不再产生 permission.resolve。
    const ack = await harness.handlers().onCardAction({ event: { operator: { open_id: "ou_owner" }, action: { value: { k: "perm:ABCD2345:allow-once" } } } });
    expect(ack?.toast?.content).toContain("已处理");
    expect(harness.commands.some((command) => command.type === "permission.resolve")).toBe(false);
  });

  it("ignores permission requests from sessions that are not IM-bound", async () => {
    const harness = await createHarness();
    harness.gateway.start();
    harness.gateway.handleRuntimeMessage(permissionRequest("other-session"));
    await flush();
    expect(harness.cards).toHaveLength(0);
  });

  it("clears the pending approval when the desktop answered first", async () => {
    const harness = await withConversation();
    harness.gateway.handleRuntimeMessage(permissionRequest());
    await flush();
    harness.gateway.handleRuntimeMessage({ type: "permission.dismiss", id: "permission-1" });
    await flush();
    expect(JSON.stringify(harness.patches.at(-1)?.card)).toContain("已在桌面端处理");
    const ack = await harness.handlers().onCardAction({ event: { operator: { open_id: "ou_owner" }, action: { value: { k: "perm:ABCD2345:allow-once" } } } });
    expect(ack?.toast?.content).toContain("已处理");
  });
});

describe("testChannel", () => {
  it("reports the bot name on success and a readable error on a bad secret", async () => {
    const harness = await createHarness();
    await harness.gateway.testChannel({ requestId: "r1", channelId: "feishu" });
    expect(harness.pushes.at(-1)).toMatchObject({ type: "im.test-result", requestId: "r1", ok: true, botName: "值班机器人" });

    const failing = await createHarness({ secret: null });
    await failing.gateway.testChannel({ requestId: "r2", channelId: "feishu" });
    const result = failing.pushes.at(-1);
    expect(result?.type === "im.test-result" && result).toMatchObject({ ok: false });
    expect(result?.type === "im.test-result" && result.message).toContain("App Secret");
  });
});

describe("自定义通道（脚本接入的本地 HTTP 端点）", () => {
  /** HTTP 服务器要真的跑完一次事件循环，光 await setTimeout(0) 不够稳定。 */
  const waitFor = async (check: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    throw new Error("等待超时");
  };

  it("POST 一条消息走同一条网关链路（白名单/绑定/模型），答案从 /v1/replies 取回", async () => {
    const harness = await createHarness({
      channel: { id: "hook", kind: "custom", appId: "", host: "127.0.0.1", port: 0, allowFrom: ["ou_owner"] }
    });
    harness.gateway.start();
    await flush();
    const status = harness.gateway.status().channels.find((item) => item.channelId === "hook");
    expect(status?.state).toBe("connected");
    expect(status?.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    const base = status!.endpoint!;

    // Token 不对：401，而且绝不能有会话被建出来。
    const denied = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ peerId: "ou_owner", text: "hi" })
    });
    expect(denied.status).toBe(401);

    const accepted = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer app-secret" },
      body: JSON.stringify({ peerId: "ou_owner", text: "帮我看看今天发了什么版", messageId: "custom-1" })
    });
    expect(accepted.status).toBe(202);
    await waitFor(() => harness.commands.some((command) => command.type === "im.session.ensure"));
    const ensure = [...harness.commands].reverse().find((command) => command.type === "im.session.ensure");
    expect(ensure?.type === "im.session.ensure" && ensure.sessionKey).toBe("custom:hook:p2p:ou_owner");

    ready(harness);
    await flush();
    expect(harness.commands.at(-1)).toMatchObject({ type: "im.prompt", sessionId: "sess-1" });
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "start" });
    harness.gateway.handleRuntimeMessage({ type: "im.turn", sessionId: "sess-1", phase: "end", status: "ok", text: "今天发了 1.15.1，只含毛玻璃修复。" });

    await waitFor(async () => {
      const response = await fetch(`${base}/replies?since=0&token=app-secret`);
      const body = await response.json() as { items?: { text: string }[] };
      return (body.items ?? []).some((item) => item.text.includes("1.15.1"));
    });
  });

  it("同一个 messageId 重投不会跑第二次（平台重投是常态）", async () => {
    const harness = await createHarness({
      channel: { id: "hook", kind: "custom", appId: "", host: "127.0.0.1", port: 0, allowFrom: ["ou_owner"] }
    });
    harness.gateway.start();
    await flush();
    const base = harness.gateway.status().channels.find((item) => item.channelId === "hook")!.endpoint!;
    for (let index = 0; index < 2; index += 1) {
      await fetch(`${base}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer app-secret" },
        body: JSON.stringify({ peerId: "ou_owner", text: "重投测试", messageId: "dup-1" })
      });
    }
    await flush(20);
    const ensures = harness.commands.filter((command) => command.type === "im.session.ensure");
    expect(ensures).toHaveLength(1);
  });
});
