import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * IM 通道的接线契约（源码级断言，同 skill-store-wiring / single-instance-wiring 的形态）。
 *
 * 为什么必须有：`im-gateway.test.ts` / `im-feishu-ws.test.ts` 全绿也证明不了宿主真的
 * 接上了通道——把 index.ts 的 `startImGateway()` 删掉、把内部 im.* 事件继续转发渲染端、
 * 或者 pi-runtime 里的 `im.session.ensure` 分支忘了接，纯逻辑测试全都不会红，而用户
 * 看到的是「设置保存了但机器人一句话都不回」。
 *
 * 源码行尾在本地工作区（LF）与 CI 检出（CRLF）之间不一致：读入即归一化。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

const protocol = read("../shared/protocol.ts");
const runtime = read("pi-runtime.ts");
const gatewaySource = read("im-gateway.ts");
const index = read("index.ts");
const broker = read("permission-broker.ts");
const permissions = read("runtime-permissions.ts");
const settings = read("settings.ts");
const store = read("../renderer/src/store.ts");
const app = read("../renderer/src/App.tsx");
const component = read("../renderer/src/ImChannelSettings.tsx");
const customComponent = read("../renderer/src/ImCustomChannelSettings.tsx");
const demoApi = read("../renderer/src/demo-api.ts");
const styles = read("../renderer/src/styles.css");
const agents = read("../../AGENTS.md");
const themeGuide = read("../../docs/theme-guide.md");
const themeSkill = read("../../resources/skills/pidesktop-theme-creator/SKILL.md");
const themeVariables = read("../../resources/skills/pidesktop-theme-creator/references/variables.md");
const themeCheck = read("../../resources/skills/pidesktop-theme-creator/scripts/check_theme.py");

describe("协议层", () => {
  it("设置、会话来源、三条会话命令、三条内部事件与两条推送都在 shared 协议里", () => {
    expect(protocol).toContain("export interface ImSettings");
    expect(protocol).toContain("export interface ImChannelConfig");
    expect(protocol).toContain("im?: ImSettings;");
    expect(protocol).toContain('kind: "im";');
    for (const type of ["im.session.ensure", "im.prompt", "im.abort", "im.channel.save", "im.channel.delete", "im.channel.test"]) {
      expect(protocol).toContain(`type: "${type}"`);
    }
    for (const type of ["im.session.ready", "im.turn", "im.delta", "im.status", "im.test-result"]) {
      expect(protocol).toContain(`type: "${type}"`);
    }
    expect(protocol).toContain("imStatus?: ImStatus;");
  });

  it("消息来源标记的 custom entry 类型名保持向后兼容（旧名仍是别名）", () => {
    const shared = read("../shared/session-origin.ts");
    expect(shared).toContain('export const SESSION_ORIGIN_CUSTOM_TYPE = "pidesktop.session.origin"');
    expect(shared).toContain("export const AUTOMATION_SESSION_ORIGIN_CUSTOM_TYPE = SESSION_ORIGIN_CUSTOM_TYPE");
    expect(shared).toContain('if (record.kind === "im")');
  });

  it("settings.im 会被 migrateSettings 读回（漏读＝下次写入被抹掉）", () => {
    expect(settings).toContain("export function normalizeIm(");
    expect(settings).toContain("im: normalizeIm(source.im)");
  });
});

describe("主进程接线", () => {
  it("启动时建连、退出时释放、bootstrap 带状态", () => {
    expect(index).toContain("startImGateway();");
    expect(index).toContain("imGateway?.dispose();");
    expect(index).toContain("imStatus: imGatewayStatus()");
  });

  it("im.* 设置命令由主进程独占（不转发 utility），且密钥走 safeStorage", () => {
    expect(index).toContain("function handleImCommand(command: RuntimeCommand): boolean");
    expect(index).toContain("if (handleImCommand(command)) return;");
    // 密钥键按 kind 分键：官方通道 im.feishu.<id>、自定义通道 im.custom.<id>。
    expect(index).toContain('const IM_CREDENTIAL_PREFIX = "im.";');
    expect(index).toContain("saveCredential(imCredentialKey(incoming.kind, incoming.id), secret)");
    expect(index).toContain("deleteCredential(imCredentialKey(kind, command.channelId))");
    // 下发 utility 的密钥表剥掉 IM 密钥（多一个进程知道就多一份暴露面）。
    expect(index).toContain("apiKeys: runtimeApiKeys()");
    expect(index).toContain("!key.startsWith(IM_CREDENTIAL_PREFIX)");
  });

  it("内部 im.* 事件在转发渲染端之前被网关消费", () => {
    expect(index).toContain("if (imGateway?.handleRuntimeMessage(message)) return;");
    // 网关必须排在 state 缓存/转发逻辑之前。
    const gatewayIdx = index.indexOf("imGateway?.handleRuntimeMessage(message)");
    const stateIdx = index.indexOf('if (message.type === "state") latestSnapshot = message.snapshot;');
    expect(gatewayIdx).toBeGreaterThan(0);
    expect(gatewayIdx).toBeLessThan(stateIdx);
  });

  it("权限消息仍继续转发渲染端（桌面与手机双通道，先到先得）", () => {
    expect(index).toContain("permission / permission.dismiss 仍继续走下面");
    expect(index).toContain('if (message.type !== "sessions.live") mainWindow?.webContents.send("runtime:message", message);');
  });
});

describe("运行时接线（pi-runtime）", () => {
  it("三条 im 命令都有分支", () => {
    expect(runtime).toContain('case "im.session.ensure":');
    expect(runtime).toContain("await ensureImSession(command);");
    expect(runtime).toContain('case "im.prompt":');
    expect(runtime).toContain('case "im.abort":');
  });

  it("会话准备：按路径复用、跳过激活、无人值守、写 im origin", () => {
    expect(runtime).toContain("async function ensureImSession(");
    expect(runtime).toContain("sessionOrigin: { kind: \"im\", channelId: parsedKey.channelId, sessionKey, peerId: parsedKey.peerId }");
    expect(runtime).toContain("skipActivate: true");
    expect(runtime).toContain("unattended: true");
    expect(runtime).toContain("accessModeOverride: command.accessMode");
  });

  it("sink 只在 IM 会话上推事件，并在 agent_end 之前读结局", () => {
    expect(runtime).toContain("function handleImSessionEvent(");
    expect(runtime).toContain("function imTurnEnd(");
    expect(runtime).toContain("handleImSessionEvent(record, event);");
    const endIdx = runtime.indexOf("imTurnEnd(record, event.messages);");
    const resolveIdx = runtime.indexOf("resolveRunOutcome(record, event.messages);", endIdx);
    expect(endIdx).toBeGreaterThan(0);
    expect(resolveIdx).toBeGreaterThan(endIdx);
    expect(runtime).toContain('type: "im.delta"');
    expect(runtime).toContain("IM_DELTA_INTERVAL_MS");
  });

  it("队列：忙则排队（上限 3），settled 后排空，abort 清队列", () => {
    expect(runtime).toContain("IM_MAX_QUEUED_PROMPTS");
    expect(runtime).toContain("drainImPromptQueue(record);");
    expect(runtime).toContain('post({ type: "im.turn", sessionId: command.sessionId, phase: "queued" });');
    expect(runtime).toContain("imPromptQueues.delete(command.sessionId);");
  });
});

describe("出站整形（手机端不显示 HTML）", () => {
  it("IM 会话不注入 Div 气泡：档位被压成 off（创建时与后绑都要盖）", () => {
    // 构造时快照不够：会话可能先在桌面创建、之后才被 IM 绑上，所以读 recordBox。
    expect(runtime).toContain("const divModeForSession = (): DivBubbleMode => (recordBox?.im || options.im ? \"off\" : recordAgent.divMode);");
    expect(runtime).toContain("divMode: divModeForSession");
    expect(runtime).toContain("buildDivModePrompt(divModeForSession())");
    // 反回退：任何一处还按 recordAgent.divMode 注入就等于 IM 会话又收到气泡规范。
    expect(runtime).not.toContain("divMode: () => recordAgent.divMode");
    expect(runtime).not.toContain("buildDivModePrompt(recordAgent.divMode)");
  });

  it("答案与进度卡片都先过 toImMarkdown（会话在桌面端创建也不会漏出标签）", () => {
    expect(gatewaySource).toContain('import { toImMarkdown } from "./im-outbound.js";');
    expect(gatewaySource).toContain("const text = toImMarkdown((message.text ?? \"\").trim() || (conversation.lastDelta ?? \"\").trim());");
    expect(gatewaySource).toContain("conversation.lastDelta = toImMarkdown(message.text);");
    const outbound = read("im-outbound.ts");
    // 只在含气泡标记时动手：普通 markdown 必须逐字节不变。
    expect(outbound).toContain("const DIV_BUBBLE_MARK = /<assistant_html[\\s>]/iu;");
    expect(outbound).toContain("if (!DIV_BUBBLE_MARK.test(text)) return text;");
  });
});

describe("自定义通道（接内网工作软件）", () => {
  it("协议与净化层把 custom 当作一等通道（不是硬编码补丁）", () => {
    expect(protocol).toContain('export type ImChannelKind = "feishu" | "custom";');
    expect(protocol).toContain("export type ImCustomHost = \"127.0.0.1\" | \"0.0.0.0\";");
    expect(protocol).toContain("endpoint?: string;");
    const shared = read("../shared/im.ts");
    expect(shared).toContain('export const IM_CHANNEL_KINDS = ["feishu", "custom"] as const;');
    expect(shared).toContain("export const IM_CUSTOM_DEFAULT_HOST = \"127.0.0.1\";");
  });

  it("网关按 kind 造适配器：入站出口唯一（deliverInbound），会话键与去重键都带 kind", () => {
    expect(gatewaySource).toContain('import { createCustomChannelTransport } from "./im-custom-channel.js";');
    expect(gatewaySource).toContain("private createTransport(config: ImChannelConfig, secret: string)");
    expect(gatewaySource).toContain("private deliverInbound(channelId: string, message: ImInboundMessage): void");
    expect(gatewaySource).toContain("onMessage: (message) => this.deliverInbound(config.id, message)");
    expect(gatewaySource).toContain("const channelKey = `\${channel.config.kind}:\${channelId}`;");
    expect(gatewaySource).toContain("imSessionKey({ kind: config.kind, channelId: config.id, peerId: message.openId })");
    // 官方通道只认 App ID + Secret；自定义通道只认 Token（不拿 App ID 去拦它）。
    expect(gatewaySource).toContain('if (channel.kind === "feishu" && !channel.appId.trim())');
    expect(gatewaySource).toContain('channel.kind === "feishu" ? "未保存 App Secret" : "未设置接入 Token"');
  });

  it("传输入：三条路由、Token 必填 fail-closed、回复两头都有（回调 + 轮询）", () => {
    const custom = read("im-custom-channel.ts");
    expect(custom).toContain('export const IM_CUSTOM_MESSAGES_PATH = "/v1/messages";');
    expect(custom).toContain('export const IM_CUSTOM_REPLIES_PATH = "/v1/replies";');
    expect(custom).toContain('export const IM_CUSTOM_HEALTH_PATH = "/v1/health";');
    expect(custom).toContain("if (!token) {");
    expect(custom).toContain("timingSafeEqual(a, b)");
    expect(custom).toContain("deliverCallback(");
    expect(custom).toContain("outbox.push({ peerId: chatId, text, at: now() })");
    // 卡片一律「不支持」⇒ 网关自动降级成纯文本（审批码 / 答案）。
    expect(custom).toContain('sendCard: async () => ({ ok: false, message: "自定义通道不支持卡片，请改用纯文本" })');
  });

  it("对接说明与示例脚本在位（用户要照抄的那份规则）", () => {
    const doc = read("../../docs/im-channel-protocol.md");
    for (const route of ["POST /v1/messages", "GET /v1/replies", "GET /v1/health"]) {
      expect(doc).toContain(route);
    }
    expect(doc).toContain("replyUrl");
    expect(doc).toContain("peerId");
    const example = read("../../docs/im-channel-bridge-example.mjs");
    expect(example).toContain("/v1/messages");
  });
});

describe("权限超时", () => {
  it("broker 支持 timeoutMs：超时走同一条 resolve(deny)，并清理定时器", () => {
    expect(broker).toContain("timeoutMs?: number;");
    expect(broker).toContain("this.resolve(id, \"deny\");");
    expect(broker).toContain("clearTimeout(pending.timer)");
  });

  it("权限门把会话级超时透传给 broker", () => {
    expect(permissions).toContain("permissionTimeoutMs?: () => number | undefined;");
    expect(permissions).toContain("...(deps.permissionTimeoutMs ? { timeoutMs: deps.permissionTimeoutMs() } : {})");
    expect(runtime).toContain("() => recordBox?.im?.approvalTimeoutMs");
  });
});

describe("渲染端接线", () => {
  it("设置页有「消息通道」tab，组件带契约钩子", () => {
    expect(app).toContain('"im"');
    expect(app).toContain("<ImChannelSettings />");
    expect(app).toContain('tab === "im" ?');
    for (const control of ["im-channel-enable", "im-feishu-enabled", "im-feishu-appid", "im-feishu-secret", "im-feishu-allowfrom", "im-feishu-access", "im-feishu-workspace", "im-feishu-save", "im-feishu-test"]) {
      expect(component).toContain(`data-control="${control}"`);
    }
    expect(component).toContain('data-pane="im-channel-settings"');
    // 自定义通道同一 tab 里的第二张卡（官方通道 = 飞书，自定义 = 本机 HTTP）。
    expect(component).toContain("<ImCustomChannelSettings masterEnabled={masterEnabled} />");
    for (const control of ["im-custom-add", "im-custom-enabled", "im-custom-save", "im-custom-delete"]) {
      expect(customComponent).toContain(`data-control="${control}"`);
    }
    expect(customComponent).toContain('kind: "custom"');
    expect(customComponent).toContain('type: "im.channel.delete"');
  });

  it("store 消费 im.status / im.test-result / im.save-result，bootstrap 带 imStatus", () => {
    expect(store).toContain('case "im.status":');
    expect(store).toContain('case "im.test-result":');
    expect(store).toContain('case "im.save-result":');
    expect(store).toContain("bootstrap.imStatus");
  });

  it("保存回执来自主进程（面板不靠本地计时器假装成功）", () => {
    expect(protocol).toContain('type: "im.save-result"');
    // 主进程：回执必须带落盘后的权威 channel（含 appSecretConfigured）与总闸状态。
    expect(index).toContain('type: "im.save-result"');
    expect(index).toContain("channel,");
    expect(index).toContain("ok: secretError === undefined");
    // 渲染端：只认 requestId 对得上的回执，且有 5s 兜底。
    expect(component).toContain("pendingSaveRef");
    expect(component).toContain("imSave.requestId");
    expect(component).toContain("主进程没有回应保存请求");
  });

  it("演示环境如实降级（不伪造连接成功）", () => {
    expect(demoApi).toContain("演示环境不会发起真实通道连接");
  });

  it("「发了消息没反应」可诊断：帧/事件/过滤/出站错误四层都推给面板", () => {
    for (const field of ["lastFrameAt", "lastEventAt", "lastEventSummary", "lastIgnored", "lastError"]) {
      expect(protocol).toContain(`${field}?:`);
    }
    expect(read("im-feishu-ws.ts")).toContain("onInbound?.()");
    expect(read("im-gateway.ts")).toContain("onInbound: () => this.noteFrame(config.id)");
    expect(read("im-gateway.ts")).toContain("this.noteIgnored(config.id, normalized.reason)");
    expect(read("im-gateway.ts")).toContain("this.noteError(conversation.channelId, result.message)");
    expect(component).toContain("im-channel-diag");
    expect(component).toContain("从未收到任何消息事件");
  });

  it("样式块带 .im-channel-* 前缀", () => {
    expect(styles).toContain(".im-channel-page");
    expect(styles).toContain(".im-channel-card");
  });
});

describe("主题契约五处镜像", () => {
  it("新 pane / control 出现在全部五处，且计数同步", () => {
    for (const source of [agents, themeGuide, themeSkill, themeVariables]) {
      expect(source).toContain("im-channel-settings");
    }
    for (const control of ["im-channel-enable", "im-feishu-enabled", "im-feishu-appid", "im-feishu-secret", "im-feishu-allowfrom", "im-feishu-access", "im-feishu-workspace", "im-feishu-save", "im-feishu-test"]) {
      expect(themeSkill).toContain(control);
      expect(themeVariables).toContain(control);
      expect(themeCheck).toContain(`"${control}"`);
    }
    expect(themeSkill).toContain("主要区域（44）");
    expect(themeSkill).toContain("关键控件（146）");
    expect(themeVariables).toContain("`data-pane`（44）");
    expect(themeVariables).toContain("`data-control`（146）");
    expect(themeCheck).toContain('"im-channel-settings"');
    expect(themeCheck).toContain('"im-channel-enable"');
  });
});
