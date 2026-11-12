import { describe, expect, it } from "vitest";
import {
  createImApprovalCode,
  formatImApprovalCode,
  formatImDenyCode,
  imSessionKey,
  IM_APPROVAL_CODE_ALPHABET,
  normalizeImAllowFrom,
  normalizeImChannel,
  parseImSessionKey,
  parseImSettings,
  splitMarkdown
} from "./im";

/**
 * IM 通道共享纯逻辑的回归网（主进程与渲染端共用同一份口径）。
 *
 * 重点在「坏数据不崩、默认值安全、长答案不切断围栏」：这些判定一侧写错会变成
 * 「面板能存、主进程不认」或「代码块被劈成两半」这类难查的线上问题。
 */

describe("session key", () => {
  it("builds and parses the stable conversation key", () => {
    const key = imSessionKey({ channelId: "feishu", peerId: "ou_abc" });
    expect(key).toBe("feishu:feishu:p2p:ou_abc");
    expect(parseImSessionKey(key)).toEqual({ kind: "feishu", channelId: "feishu", peerId: "ou_abc" });
  });

  it("自定义通道同样进同一个键空间（kind 区分，老绑定不变）", () => {
    const key = imSessionKey({ kind: "custom", channelId: "dingtalk", peerId: "zhangsan" });
    expect(key).toBe("custom:dingtalk:p2p:zhangsan");
    expect(parseImSessionKey(key)).toEqual({ kind: "custom", channelId: "dingtalk", peerId: "zhangsan" });
  });

  it("rejects keys of the wrong shape", () => {
    expect(parseImSessionKey("feishu:feishu:group:ou_abc")).toBeUndefined();
    expect(parseImSessionKey("telegram:1:p2p:2")).toBeUndefined();
    expect(parseImSessionKey("feishu::p2p:")).toBeUndefined();
    expect(parseImSessionKey("nonsense")).toBeUndefined();
  });
});

describe("normalizeImChannel", () => {
  it("自定义通道：默认只本机、端口 0（随机）、无 appId，并接受白名单/权限", () => {
    expect(normalizeImChannel({ id: "dingtalk", kind: "custom", enabled: true, allowFrom: ["zhangsan"], accessMode: "ask" })).toEqual({
      id: "dingtalk",
      kind: "custom",
      enabled: true,
      appId: "",
      host: "127.0.0.1",
      port: 0,
      allowFrom: ["zhangsan"],
      accessMode: "ask"
    });
  });

  it("自定义通道：监听地址只认两个取值，端口越界就回落随机", () => {
    expect(normalizeImChannel({ id: "a", kind: "custom", host: "0.0.0.0", port: 8787 })).toMatchObject({ host: "0.0.0.0", port: 8787 });
    expect(normalizeImChannel({ id: "b", kind: "custom", host: "192.168.1.5", port: 70000 })).toMatchObject({ host: "127.0.0.1", port: 0 });
    expect(normalizeImChannel({ id: "c", kind: "custom", port: "9123" })).toMatchObject({ host: "127.0.0.1", port: 9123 });
  });

  it("applies safe defaults (enabled off, workspace access, no allowlist)", () => {
    expect(normalizeImChannel({ id: "feishu", kind: "feishu", appId: "cli_1" })).toEqual({
      id: "feishu",
      kind: "feishu",
      enabled: false,
      appId: "cli_1",
      allowFrom: [],
      accessMode: "workspace"
    });
  });

  it("keeps a full valid config and normalizes domain/accessMode/ack", () => {
    const channel = normalizeImChannel({
      id: "feishu-main",
      kind: "feishu",
      enabled: true,
      label: "  值班机器人  ",
      appId: " cli_1 ",
      appSecretConfigured: true,
      domain: "https://open.larksuite.com/",
      allowFrom: [" ou_a ", "ou_a", "ou_b", ""],
      accessMode: "read-only",
      workspace: " D:/ws ",
      agentId: " agent-1 ",
      approvalTimeoutMs: 60_000,
      ack: false
    });
    expect(channel).toEqual({
      id: "feishu-main",
      kind: "feishu",
      enabled: true,
      label: "值班机器人",
      appId: "cli_1",
      appSecretConfigured: true,
      domain: "open.larksuite.com",
      allowFrom: ["ou_a", "ou_b"],
      accessMode: "read-only",
      workspace: "D:/ws",
      agentId: "agent-1",
      approvalTimeoutMs: 60_000,
      ack: false
    });
  });

  it("clamps the approval timeout into the safe window instead of dropping it", () => {
    expect(normalizeImChannel({ id: "a", kind: "feishu", approvalTimeoutMs: 1 })?.approvalTimeoutMs).toBe(30_000);
    expect(normalizeImChannel({ id: "a", kind: "feishu", approvalTimeoutMs: 99_999_999 })?.approvalTimeoutMs).toBe(3_600_000);
    expect(normalizeImChannel({ id: "a", kind: "feishu", approvalTimeoutMs: "abc" })?.approvalTimeoutMs).toBeUndefined();
  });

  it("rejects unusable identities (bad id / unknown kind) but tolerates a missing appId", () => {
    expect(normalizeImChannel({ id: "feishu:main", kind: "feishu" })).toBeUndefined();
    expect(normalizeImChannel({ id: "", kind: "feishu" })).toBeUndefined();
    expect(normalizeImChannel({ id: "feishu", kind: "telegram" })).toBeUndefined();
    expect(normalizeImChannel(undefined)).toBeUndefined();
    expect(normalizeImChannel({ id: "feishu", kind: "feishu" })?.appId).toBe("");
  });
});

describe("parseImSettings", () => {
  it("is absent (undefined) when nothing is configured", () => {
    expect(parseImSettings(undefined)).toBeUndefined();
    expect(parseImSettings({})).toBeUndefined();
    expect(parseImSettings({ enabled: false, channels: [] })).toBeUndefined();
    expect(parseImSettings("garbage")).toBeUndefined();
  });

  it("keeps the master switch and de-duplicates channels by id", () => {
    const settings = parseImSettings({
      enabled: true,
      channels: [
        { id: "feishu", kind: "feishu", enabled: true, appId: "cli_1" },
        { id: "feishu", kind: "feishu", enabled: false, appId: "cli_2" },
        { id: "bad id", kind: "feishu" }
      ]
    });
    expect(settings?.enabled).toBe(true);
    expect(settings?.channels).toHaveLength(1);
    expect(settings?.channels[0]?.appId).toBe("cli_1");
  });

  it("keeps a channel list even with the master switch off (so the panel can show it)", () => {
    const settings = parseImSettings({ enabled: false, channels: [{ id: "feishu", kind: "feishu" }] });
    expect(settings?.enabled).toBe(false);
    expect(settings?.channels).toHaveLength(1);
  });
});

describe("allowlist normalization", () => {
  it("trims, de-duplicates, drops junk and caps the size", () => {
    expect(normalizeImAllowFrom([" a ", "a", "", 42, null])).toEqual(["a"]);
    expect(normalizeImAllowFrom("ou_1")).toEqual([]);
    expect(normalizeImAllowFrom(Array.from({ length: 300 }, (_, index) => `ou_${index}`))).toHaveLength(200);
  });
});

describe("approval code", () => {
  it("is 8 chars from the unambiguous alphabet and formats the fallback commands", () => {
    let counter = 0;
    const code = createImApprovalCode(() => counter++);
    expect(code).toHaveLength(8);
    for (const char of code) expect(IM_APPROVAL_CODE_ALPHABET).toContain(char);
    expect(code).not.toMatch(/[0O1I]/u);
    expect(formatImApprovalCode("ABC23456")).toBe("/allow ABC23456");
    expect(formatImDenyCode("ABC23456")).toBe("/deny ABC23456");
  });
});

describe("splitMarkdown", () => {
  it("returns the text untouched when it fits", () => {
    expect(splitMarkdown("短答案", 100)).toEqual(["短答案"]);
  });

  it("prefers paragraph boundaries and never loses characters", () => {
    const text = `${"a".repeat(60)}\n\n${"b".repeat(60)}\n\n${"c".repeat(60)}`;
    const chunks = splitMarkdown(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n\n")).toBe(text);
    expect(chunks[0]).toBe("a".repeat(60));
  });

  it("never cuts inside a fenced code block", () => {
    const before = "说明段落\n\n";
    const fence = `\`\`\`ts\n${Array.from({ length: 20 }, (_, index) => `const v${index} = ${index};`).join("\n")}\n\`\`\`\n`;
    const after = "收尾段落。";
    const chunks = splitMarkdown(`${before}${fence}${after}`, 120);
    // 任何一个分片里，围栏标记的出现次数都必须是偶数（成对）。
    for (const chunk of chunks) {
      const fences = chunk.match(/```/gu)?.length ?? 0;
      expect(fences % 2).toBe(0);
    }
    expect(chunks.join("\n").includes("```ts")).toBe(true);
    expect(chunks.at(-1)).toContain("收尾段落");
  });

  it("falls back to a hard cut when a single unbreakable run exceeds the limit", () => {
    const text = "x".repeat(250);
    const chunks = splitMarkdown(text, 100);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });
});
