import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { McpClientManager } from "./mcp-client.js";
import type { ConfiguredMcpServer } from "./mcp-config.js";

/**
 * HTTP 请求头的端到端验证：走真实的 StreamableHTTPClientTransport 打一个本地
 * MCP 端点（不是对纯函数的断言），确认配置里的 headers 真的发出去了、Bearer
 * 环境变量真的覆盖了 Authorization。这一层必须真发请求才能守住：SDK 用
 * `new Headers({ ...authHeaders, ...requestInit.headers })` 组装请求头，同拼写才
 * 覆盖，大小写不同的两个 Authorization 会被合并成 "Bearer a, Bearer b"（实测）。
 */
describe("mcp http headers end to end", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running) await new Promise<void>((resolve) => { running.close(() => resolve()); });
  });

  /** 最小 MCP 端点：记录每个请求的头，按 initialize / notifications / tools/list 回包。 */
  async function startFakeServer(): Promise<{ url: string; requests: Array<Record<string, string | string[] | undefined>> }> {
    const requests: Array<Record<string, string | string[] | undefined>> = [];
    server = createServer((req, res) => {
      void (async () => {
        const body = await new Promise<string>((resolve) => {
          let data = "";
          req.on("data", (chunk) => { data += chunk; });
          req.on("end", () => resolve(data));
        });
        requests.push(req.headers);
        const message = JSON.parse(body || "{}") as { id?: number; method?: string };
        // 通知（notifications/initialized）没有 id：按 Streamable HTTP 约定回 202 空体。
        if (message.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result = message.method === "tools/list"
          ? { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] }
          : { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      })();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server!.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/mcp`, requests };
  }

  it("sends configured headers, with the bearer env token winning over a configured Authorization", async () => {
    const { url, requests } = await startFakeServer();
    process.env.PIDESKTOP_MCP_TEST_TOKEN = "from-env";
    const manager = new McpClientManager();
    try {
      const servers: ConfiguredMcpServer[] = [{
        name: "gateway",
        scope: "global",
        entry: { url, bearerTokenEnv: "PIDESKTOP_MCP_TEST_TOKEN", headers: { authorization: "Bearer stale", "X-API-Key": "custom-key" } }
      }];
      const { summaries, bindings } = await manager.sync(servers, { refresh: true });

      expect(summaries[0]).toMatchObject({ name: "gateway", status: "connected", toolCount: 1 });
      expect(bindings.map((binding) => binding.toolName)).toEqual(["ping"]);
      const headers = requests.at(-1)!;
      expect(headers["x-api-key"]).toBe("custom-key");
      // 不能是 "Bearer stale, Bearer from-env"（同名头大小写不同被 Headers 合并）——
      // 那正是 httpRequestHeaders 归一化键名要防的。
      expect(headers.authorization).toBe("Bearer from-env");
    } finally {
      delete process.env.PIDESKTOP_MCP_TEST_TOKEN;
      await manager.dispose();
    }
  });

  it("sends a hand-written Authorization as-is when no bearer env is configured", async () => {
    const { url, requests } = await startFakeServer();
    const manager = new McpClientManager();
    try {
      const servers: ConfiguredMcpServer[] = [{
        name: "manual",
        scope: "global",
        entry: { url, headers: { Authorization: "Bearer manual-token" } }
      }];
      const { summaries } = await manager.sync(servers, { refresh: true });

      expect(summaries[0]).toMatchObject({ status: "connected", toolCount: 1 });
      expect(requests.at(-1)!.authorization).toBe("Bearer manual-token");
    } finally {
      await manager.dispose();
    }
  });
});
