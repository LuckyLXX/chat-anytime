import { describe, expect, it } from "vitest";
import { McpClientManager, type McpToolBinding } from "./mcp-client.js";
import type { ConfiguredMcpServer } from "./mcp-config.js";
import { combinedCallSignal, configHash, convertMcpResult, isUnauthorizedError, mcpToolName, toTypeBoxSchema } from "./mcp-client.js";

describe("mcp-client helpers", () => {
  it("names tools as mcp__<server>__<tool> with sanitized segments", () => {
    expect(mcpToolName("context7", "resolve-library-id")).toBe("mcp__context7__resolve-library-id");
    expect(mcpToolName("My Server!", "do it")).toBe("mcp__My_Server___do_it");
  });

  it("passes object input schemas through and falls back to empty object otherwise", () => {
    const objectSchema = toTypeBoxSchema({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
    expect(objectSchema).toMatchObject({ type: "object", properties: { q: { type: "string" } } });

    expect(toTypeBoxSchema({ type: "string" })).toMatchObject({ type: "object", properties: {} });
    expect(toTypeBoxSchema(undefined)).toMatchObject({ type: "object", properties: {} });
  });

  it("hashes config by value, ignoring env key order", () => {
    const a = configHash({ command: "npx", args: ["x"], env: { A: "1", B: "2" } });
    const b = configHash({ command: "npx", args: ["x"], env: { B: "2", A: "1" } });
    expect(a).toBe(b);
    expect(configHash({ command: "npx" })).not.toBe(configHash({ command: "node" }));
  });

  it("recognizes SDK unauthorized errors so they become needs-auth instead of failed", () => {
    const sdkError = new Error("Unauthorized");
    sdkError.name = "UnauthorizedError";
    expect(isUnauthorizedError(sdkError)).toBe(true);
    expect(isUnauthorizedError(new Error("连接超时"))).toBe(false);
    expect(isUnauthorizedError(undefined)).toBe(false);
  });

  it("converts MCP callTool results into Pi AgentToolResult content", () => {
    const result = convertMcpResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "embedded", resource: { uri: "x" } }
      ]
    });
    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "text", text: expect.stringContaining("embedded") }
    ]);
    expect(result.details).toMatchObject({ content: expect.any(Array) });
  });

  it("flattens structuredContent and flags MCP errors", () => {
    const result = convertMcpResult({ isError: true, structuredContent: { ok: 1 } });
    expect(result.content[0]).toMatchObject({ type: "text", text: "MCP 工具返回 isError=true。" });
    expect(result.content.some((block) => block.type === "text" && block.text.includes("structuredContent"))).toBe(true);
  });

  it("emits a fallback text block when the result is empty", () => {
    const result = convertMcpResult({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
  });
});

describe("mcp call signal", () => {
  it("aborts on timeout when no caller signal is provided", async () => {
    const signal = combinedCallSignal(undefined, 10);
    expect(signal.aborted).toBe(false);
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as { name?: string })?.name).toBe("TimeoutError");
  });

  it("propagates caller cancellation before the timeout elapses", async () => {
    const controller = new AbortController();
    const signal = combinedCallSignal(controller.signal, 60_000);
    controller.abort();
    expect(signal.aborted).toBe(true);
    expect(signal.aborted && !controller.signal.aborted ? "unexpected" : "propagated").toBe("propagated");
  });
});

describe("mcp concurrent sync serialization", () => {
  it("runs two concurrent syncs of the same server one after another (no double OAuth refresh)", async () => {
    const events: string[] = [];
    let concurrent = 0;
    let peak = 0;
    const oauth = {
      supports: () => true,
      ensureReady: async () => "http://127.0.0.1:1456/callback",
      beginSync: () => { events.push("beginSync"); },
      endSync: () => { events.push("endSync"); },
      authStateOf: () => "authorized" as const,
      authErrorOf: () => undefined,
      providerFor: () => undefined,
      registerTransport: () => undefined
    };
    const manager = new McpClientManager({ oauth: oauth as never });
    const servers: ConfiguredMcpServer[] = [{ name: "exa", scope: "global", entry: { url: "https://mcp.example.com/mcp", auth: "oauth" } }];
    // 打桩：每次真正进入单 server 同步体时登记并发度，并用假连接替代网络。
    const internals = manager as unknown as {
      syncOne: (server: ConfiguredMcpServer, refresh: boolean) => Promise<McpToolBinding[]>;
    };
    const original = internals.syncOne.bind(manager);
    internals.syncOne = async (server, refresh) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 15));
      concurrent -= 1;
      return original(server, refresh).catch(() => []);
    };
    await Promise.all([manager.sync(servers, { refresh: true }), manager.sync(servers, { refresh: true })]);
    // 关键：同一个 server 的两条 sync 不得同时进入同步体。
    expect(peak).toBe(1);
    // 同步期间的授权页抑制闸门要成对开关（否则会一直不弹授权页）
    expect(events.filter((event) => event.startsWith("beginSync")).length).toBe(2);
    expect(events.filter((event) => event.startsWith("endSync")).length).toBe(2);
  });
});

describe("disabled servers stay untouched", () => {
  it("makes no network request and opens no connection for a disabled server", async () => {
    const requested: string[] = [];
    const manager = new McpClientManager();
    const internals = manager as unknown as {
      syncOne: (server: ConfiguredMcpServer, refresh: boolean) => Promise<McpToolBinding[]>;
      connect: (server: ConfiguredMcpServer, hash: string) => Promise<unknown>;
    };
    const originalConnect = internals.connect.bind(manager);
    internals.connect = async (server, hash) => {
      requested.push(server.name);
      return originalConnect(server, hash);
    };
    const servers: ConfiguredMcpServer[] = [{ name: "off", scope: "global", entry: { url: "https://mcp.example.com/mcp", disabled: true } }];
    const result = await manager.sync(servers, { refresh: true });

    // 停用不是「列表里跳过」：它不能建连、不能保活（stdio server 每次 sync 被拉起
    // 会白烧 npx 冷启动，OAuth server 还会每次被 401 打一次）。
    expect(requested).toEqual([]);
    expect(result.summaries[0]).toMatchObject({ name: "off", status: "disabled", disabled: true });
    expect((manager as unknown as { connections: Map<string, unknown> }).connections.size).toBe(0);
  });
});
