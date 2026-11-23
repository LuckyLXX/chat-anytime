import { describe, expect, it } from "vitest";
import {
  CodexAppServerClient,
  CodexRpcError,
  defaultServerRequestDecision,
  readAuthStatus,
  readHandshake,
  readItemInfo,
  readThreadInfo,
  readTurnInfo
} from "./codex-app-server.js";

/**
 * JSONL / JSON-RPC 客户端的行为钉死：分帧、跨块、乱序、超时、拒绝服务端请求、
 * 单帧上限、退出收场。这些是「进程在、协议在、但回合悄悄丢失」的典型来源。
 */

interface Harness {
  client: CodexAppServerClient;
  frames: Record<string, unknown>[];
  protocolErrors: string[];
}

function harness(options: { requestTimeoutMs?: number; handshakeTimeoutMs?: number; maxFrameChars?: number } = {}): Harness {
  const frames: Record<string, unknown>[] = [];
  const protocolErrors: string[] = [];
  const client = new CodexAppServerClient({
    write: (frame) => {
      frames.push(JSON.parse(frame) as Record<string, unknown>);
    },
    ...options,
    onProtocolError: (message) => protocolErrors.push(message)
  });
  return { client, frames, protocolErrors };
}

function respond(client: CodexAppServerClient, payload: unknown, chunkSize = 0): void {
  const text = `${JSON.stringify(payload)}\n`;
  if (chunkSize <= 0) {
    client.pushStdout(text);
    return;
  }
  for (let index = 0; index < text.length; index += chunkSize) client.pushStdout(text.slice(index, index + chunkSize));
}

function nextFrame(h: Harness, method: string): Record<string, unknown> {
  const frame = h.frames.find((candidate) => candidate.method === method);
  if (!frame) throw new Error(`missing frame ${method}`);
  return frame;
}

describe("read helpers", () => {
  it("projects only the fields the team needs and rejects malformed shapes", () => {
    expect(readHandshake({ userAgent: "u", codexHome: "/h", platformOs: "windows", platformFamily: "windows" }))
      .toEqual({ userAgent: "u", codexHome: "/h", platformOs: "windows", platformFamily: "windows" });
    expect(readHandshake({ userAgent: "u" })).toBeUndefined();
    expect(readThreadInfo({ thread: { id: "t1", cliVersion: "0.171.0" }, model: "m" })).toEqual({ id: "t1", cliVersion: "0.171.0", model: "m" });
    expect(readThreadInfo({ thread: {} })).toBeUndefined();
    expect(readTurnInfo({ turn: { id: "x", status: "completed" } })).toEqual({ id: "x", status: "completed" });
    expect(readTurnInfo({ turn: { id: "x", status: "weird" } })).toBeUndefined();
    expect(readTurnInfo({ turn: { id: "x", status: "failed", error: { message: "boom" } } })).toEqual({ id: "x", status: "failed", error: "boom" });
    expect(readItemInfo({ item: { id: "i1", type: "commandExecution", command: "npm test", status: "inProgress" } }))
      .toEqual({ id: "i1", type: "commandExecution", command: "npm test", status: "inProgress" });
    expect(readItemInfo({ item: { id: "i2", type: "fileChange", changes: [{ path: "src/a.ts" }] } }))
      .toEqual({ id: "i2", type: "fileChange", path: "src/a.ts", changedPaths: ["src/a.ts"] });
    expect(readItemInfo({ item: { id: "i3" } })).toBeUndefined();
  });

  it("maps account state without leaking identity fields", () => {
    expect(readAuthStatus({ account: { type: "chatgpt", email: "a@b.c", planType: "plus" }, requiresOpenaiAuth: true }))
      .toEqual({ state: "signed-in", plan: "plus" });
    expect(readAuthStatus({ account: { type: "apiKey" } })).toEqual({ state: "api-key" });
    expect(readAuthStatus({ account: null, requiresOpenaiAuth: true })).toEqual({ state: "signed-out" });
    expect(readAuthStatus({ account: null, requiresOpenaiAuth: false })).toEqual({ state: "not-required" });
    expect(readAuthStatus(undefined)).toEqual({ state: "unknown" });
  });
});

describe("handshake", () => {
  it("sends initialize → initialized → account/read and survives frames split mid-JSON", async () => {
    const h = harness();
    const pending = h.client.handshake();
    const init = nextFrame(h, "initialize");
    expect(init.id).toBeDefined();
    expect((init.params as { clientInfo: { name: string } }).clientInfo.name).toBe("pidesktop");
    respond(h.client, { id: init.id, result: { userAgent: "pidesktop/1", codexHome: "/h", platformOs: "windows", platformFamily: "windows" } }, 7);
    await Promise.resolve();
    const account = nextFrame(h, "account/read");
    expect(account.params).toEqual({ refreshToken: false });
    respond(h.client, { id: account.id, result: { account: { type: "chatgpt", planType: "plus" }, requiresOpenaiAuth: true } });
    const result = await pending;
    expect(result.auth).toEqual({ state: "signed-in", plan: "plus" });
    expect(result.platformOs).toBe("windows");
    // initialized 是通知（无 id、无 params）。
    expect(h.frames.some((frame) => frame.method === "initialized" && frame.id === undefined)).toBe(true);
  });

  it("buffers notifications that arrive before the initialize response", async () => {
    const h = harness();
    const seen: string[] = [];
    h.client.onNotification((method) => seen.push(method));
    const pending = h.client.handshake();
    const init = nextFrame(h, "initialize");
    // 通知先于响应到达：握手完成前不能丢。
    respond(h.client, { method: "configWarning", params: { summary: "x" } });
    respond(h.client, { id: init.id, result: { userAgent: "u", codexHome: "/h", platformOs: "windows", platformFamily: "windows" } });
    await Promise.resolve();
    respond(h.client, { id: nextFrame(h, "account/read").id, result: { account: null, requiresOpenaiAuth: false } });
    await pending;
    expect(seen).toEqual(["configWarning"]);
  });

  it("rejects an incompatible server instead of guessing the protocol", async () => {
    const h = harness();
    const pending = h.client.handshake();
    respond(h.client, { id: nextFrame(h, "initialize").id, result: { userAgent: "u" } });
    await expect(pending).rejects.toMatchObject({ kind: "incompatible" });

    const h2 = harness();
    const pending2 = h2.client.handshake();
    respond(h2.client, { id: nextFrame(h2, "initialize").id, error: { code: -32601, message: "method not found" } });
    await expect(pending2).rejects.toThrow(/不支持 app-server/u);
  });

  it("keeps the handshake successful when account/read fails", async () => {
    const h = harness();
    const pending = h.client.handshake();
    respond(h.client, { id: nextFrame(h, "initialize").id, result: { userAgent: "u", codexHome: "/h", platformOs: "linux", platformFamily: "unix" } });
    await Promise.resolve();
    respond(h.client, { id: nextFrame(h, "account/read").id, error: { code: -32000, message: "nope" } });
    const result = await pending;
    expect(result.auth).toEqual({ state: "unknown" });
    expect(result.accountError).toContain("nope");
  });
});

describe("frames and requests", () => {
  it("parses multiple frames from one chunk and ignores late/unknown response ids", async () => {
    const h = harness();
    const pending = h.client.request("account/read", { refreshToken: false });
    const id = nextFrame(h, "account/read").id;
    h.client.pushStdout(`${JSON.stringify({ id: "stale", result: {} })}\n${JSON.stringify({ id, result: { account: null } })}\n`);
    await expect(pending).resolves.toEqual({ account: null });
    expect(h.protocolErrors.some((message) => message.includes("未知请求 id"))).toBe(true);
  });

  it("times out a request and drops its late response", async () => {
    const h = harness({ requestTimeoutMs: 20 });
    const pending = h.client.request("thread/start", {});
    const id = nextFrame(h, "thread/start").id;
    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
    respond(h.client, { id, result: { thread: { id: "late" } } });
    expect(h.protocolErrors.some((message) => message.includes("未知请求 id"))).toBe(true);
  });

  it("rejects JSON-RPC errors with the method and code", async () => {
    const h = harness();
    const pending = h.client.request("turn/start", {});
    respond(h.client, { id: nextFrame(h, "turn/start").id, error: { code: -32602, message: "bad params" } });
    await expect(pending).rejects.toMatchObject({ kind: "rpc", method: "turn/start", code: -32602 });
  });

  it("drops oversized frames but keeps parsing the next one", async () => {
    const h = harness({ maxFrameChars: 64 });
    h.client.pushStdout(`${"x".repeat(100)}\n${JSON.stringify({ method: "thread/started", params: {} })}\n`);
    expect(h.protocolErrors.some((message) => message.includes("单帧超过"))).toBe(true);
  });

  it("does not accumulate a never-ending oversized line in memory", async () => {
    const h = harness({ maxFrameChars: 64 });
    // 一条永不换行的巨大输出：丢弃阶段每块都必须被直接扔掉，不能攒进 buffer。
    // （旧实现每块 append，等到换行前可以一直涨到 OOM。）
    for (let index = 0; index < 100; index += 1) h.client.pushStdout("y".repeat(1_024));
    expect(h.protocolErrors.filter((message) => message.includes("单帧超过")).length).toBeGreaterThan(0);
    expect((h.client as unknown as { buffer: string }).buffer.length).toBe(0);
    // 换行之后的合法帧照常解析（丢弃只影响那一帧）。
    const seen: string[] = [];
    h.client.onNotification((method) => seen.push(method));
    h.client.pushStdout(`\n${JSON.stringify({ method: "warning", params: {} })}\n`);
    expect(seen).toEqual(["warning"]);
  });

  it("survives invalid JSON frames", async () => {
    const h = harness();
    h.client.pushStdout("{not json}\n");
    const seen: string[] = [];
    h.client.onNotification((method) => seen.push(method));
    h.client.pushStdout(`${JSON.stringify({ method: "warning", params: {} })}\n`);
    expect(h.protocolErrors.some((message) => message.includes("不是合法 JSON"))).toBe(true);
    expect(seen).toEqual(["warning"]);
  });

  it("counts unknown notifications instead of failing", () => {
    const h = harness();
    h.client.pushStdout(`${JSON.stringify({ method: "brand/new/thing", params: {} })}\n`);
    expect(h.client.unknownNotificationCount).toBe(1);
  });
});

describe("server requests", () => {
  it("denies approval requests with a JSON-RPC error (never hangs, never fails open)", () => {
    const h = harness();
    h.client.pushStdout(`${JSON.stringify({ id: "srv-1", method: "item/commandExecution/requestApproval", params: {} })}\n`);
    const reply = h.frames.find((frame) => frame.id === "srv-1");
    expect(reply).toMatchObject({ error: { code: -32000 } });
    expect(String((reply as { error: { message: string } }).error.message)).toContain("尚未接入 Codex 审批");
  });

  it("lets a caller override the decision (C 阶段的接入口) and still answers every request", () => {
    const decisions: string[] = [];
    const frames: Record<string, unknown>[] = [];
    const client = new CodexAppServerClient(
      { write: (frame) => frames.push(JSON.parse(frame) as Record<string, unknown>) },
      (request) => {
        decisions.push(request.method);
        return { kind: "result", result: { decision: "decline" } };
      }
    );
    client.pushStdout(`${JSON.stringify({ id: 7, method: "item/fileChange/requestApproval", params: {} })}\n`);
    expect(decisions).toEqual(["item/fileChange/requestApproval"]);
    expect(frames[0]).toMatchObject({ id: 7, result: { decision: "decline" } });
    // 默认策略本身仍是一律拒绝。
    expect(defaultServerRequestDecision({ id: 1, method: "m", params: {} }).kind).toBe("error");
  });

  it("handles a throwing request handler by denying", () => {
    const frames: Record<string, unknown>[] = [];
    const client = new CodexAppServerClient(
      { write: (frame) => frames.push(JSON.parse(frame) as Record<string, unknown>) },
      () => { throw new Error("boom"); }
    );
    client.pushStdout(`${JSON.stringify({ id: "x", method: "item/tool/requestUserInput", params: {} })}\n`);
    expect(frames[0]).toMatchObject({ id: "x", error: { code: -32000 } });
  });
});

describe("lifecycle", () => {
  it("rejects pending requests on exit and ignores everything afterwards", async () => {
    const h = harness();
    const pending = h.client.request("turn/start", {});
    nextFrame(h, "turn/start");
    h.client.handleExit({ code: 1 });
    await expect(pending).rejects.toBeInstanceOf(CodexRpcError);
    await expect(pending).rejects.toMatchObject({ kind: "closed" });
    const before = h.frames.length;
    h.client.pushStdout(`${JSON.stringify({ method: "warning", params: {} })}\n`);
    h.client.notify("initialized");
    expect(h.frames.length).toBe(before);
  });

  it("close() notifies the host exactly once so the process tree is reclaimed", () => {
    const reasons: string[] = [];
    const client = new CodexAppServerClient({ write: () => undefined, onClose: (reason) => reasons.push(reason) });
    client.close("停止");
    client.close("停止");
    expect(reasons).toEqual(["停止"]);
    expect(client.isClosed).toBe(true);
  });

  it("keeps a bounded stderr tail for diagnostics", () => {
    const h = harness();
    h.client.pushStderr("x".repeat(10_000));
    expect(h.client.stderr.length).toBeLessThanOrEqual(4_000);
  });
});
