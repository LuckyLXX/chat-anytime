// 端到端回归：轮换型 OAuth 服务器下，「同一个 refresh_token 被并发用两次」曾导致 SDK
// 执行 invalidateCredentials('tokens') 把凭据从磁盘删掉——用户看到的就是「每次重启软件
// 都要重新登录授权一遍」。
//
// 这里用本地假授权服务器（刷新即轮换 refresh_token，复用即撤销）+ 真实的
// McpOAuthController / McpClientManager 复现该场景，断言修复后的行为：
// 并发 sync 串行化 → 只刷一次 → 凭据保留 → 不自动弹授权页。
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpClientManager } from "./mcp-client.js";
import type { ConfiguredMcpServer } from "./mcp-config.js";
import { McpAuthStore, McpOAuthController } from "./mcp-oauth.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryAuthPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-desktop-mcp-rotation-"));
  temporaryDirectories.push(directory);
  return join(directory, "pidesktop-mcp-auth.json");
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

interface FakeAuthorizationServer {
  server: Server;
  refreshRequests: string[];
  toolCalls: number[];
  /** 服务器侧当前有效的 refresh_token（用来对齐「客户端保存的是什么」）。 */
  liveRefreshToken: () => string;
}

/**
 * 轮换 + 复用检测的假授权服务器，附带一个「只接受最新 access token」的 MCP 端点
 * （旧 token 请求会拿到 401 + WWW-Authenticate，驱动 SDK 走刷新）。
 */
function createRotatingServer(portRef: { port: number }): FakeAuthorizationServer {
  let liveRefreshToken = "rt-1";
  let issued = 1;
  // 与种子里保存的旧 access token 不同：首次请求必然 401，驱动 SDK 走刷新。
  let accessToken = "at-server-initial";
  const toolCalls: number[] = [];
  // 授权码流程的 PKCE 校验：按 code 记下 code_challenge，兑换时重算 S256(code_verifier)
  // 比对。没有这道校验，测试就守不住「回调时必须用本次流程自己的 verifier」。
  const challenges = new Map<string, string>();
  const refreshRequests: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const body = await new Promise<string>((resolve) => {
        let data = "";
        req.on("data", (chunk) => { data += chunk; });
        req.on("end", () => resolve(data));
      });
      const url = req.url ?? "/";
      const port = portRef.port;
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      if (url.startsWith("/.well-known/oauth-protected-resource")) {
        send(200, { resource: `http://127.0.0.1:${port}/mcp`, authorization_servers: [`http://127.0.0.1:${port}`] });
        return;
      }
      if (url.startsWith("/.well-known/oauth-authorization-server")) {
        send(200, {
          issuer: `http://127.0.0.1:${port}`,
          authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
          token_endpoint: `http://127.0.0.1:${port}/token`,
          registration_endpoint: `http://127.0.0.1:${port}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["mcp:tools"]
        });
        return;
      }
      if (url.startsWith("/authorize")) {
        const query = new URL(url, `http://127.0.0.1:${port}`).searchParams;
        const code = `code-${challenges.size + 1}`;
        challenges.set(code, query.get("code_challenge") ?? "");
        res.writeHead(302, { location: `${query.get("redirect_uri")}?code=${code}&state=${query.get("state")}` });
        res.end();
        return;
      }
      if (url.startsWith("/register")) {
        const registration = JSON.parse(body || "{}") as { redirect_uris?: string[] };
        send(200, { client_id: `client-${port}`, token_endpoint_auth_method: "none", redirect_uris: registration.redirect_uris ?? [] });
        return;
      }
      if (url.startsWith("/token")) {
        const params = new URLSearchParams(body);
        if (params.get("grant_type") !== "refresh_token") {
          const code = params.get("code") ?? "";
          const expected = challenges.get(code);
          if (expected !== undefined) {
            const verifier = params.get("code_verifier") ?? "";
            const actual = createHash("sha256").update(verifier).digest("base64url");
            // 授权服务器就该这样回答：verifier 不是本次流程的那份 → PKCE 校验失败。
            if (actual !== expected) {
              send(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
              return;
            }
          }
          send(200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: liveRefreshToken });
          return;
        }
        const sent = params.get("refresh_token") ?? "";
        refreshRequests.push(sent);
        if (sent !== liveRefreshToken) {
          // 复用检测：旧 refresh_token 被再次使用即撤销整个令牌族
          send(400, { error: "invalid_grant", error_description: "Refresh token has been revoked" });
          return;
        }
        issued += 1;
        liveRefreshToken = `rt-${issued}`;
        accessToken = `at-${issued}`;
        send(200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: liveRefreshToken });
        return;
      }
      const authorization = req.headers.authorization ?? "";
      if (authorization !== `Bearer ${accessToken}`) {
        send(401, { jsonrpc: "2.0", error: { code: -32000, message: "expired" }, id: null }, {
          "www-authenticate": `Bearer error="invalid_token", resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp"`
        });
        return;
      }
      const message = JSON.parse(body || "{}") as { id?: number; method?: string };
      if (message.method === "tools/list") {
        send(200, { jsonrpc: "2.0", id: message.id ?? 1, result: { tools: [{ name: "search", description: "s", inputSchema: { type: "object" } }] } });
        return;
      }
      if (message.method === "tools/call") {
        toolCalls.push(message.id ?? 0);
        send(200, { jsonrpc: "2.0", id: message.id ?? 1, result: { content: [{ type: "text", text: "ok" }] } });
        return;
      }
      send(200, { jsonrpc: "2.0", id: message.id ?? 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } });
    })();
  });
  return { server, refreshRequests, toolCalls, liveRefreshToken: () => liveRefreshToken };
}

/**
 * 建一个「重启后磁盘上已有凭据」的控制器：先起回调服务器拿到真实 redirectUrl，再
 * 按它写入凭据（redirectUrl 与当前端口一致 → 注册信息可复用，不会触发重新注册）。
 * store 实例注入，保证后续读到的就是这份凭据。
 */
async function seededController(
  authPath: string,
  options: { refreshToken?: string; refreshFailed?: boolean; opened: string[]; logs?: string[] }
): Promise<{ controller: McpOAuthController; redirectUrl: string; store: McpAuthStore }> {
  const store = new McpAuthStore(() => authPath);
  const controller = new McpOAuthController({
    storePath: () => authPath,
    store,
    openExternal: (url) => { options.opened.push(url); },
    onAuthorized: async () => undefined,
    log: (message) => options.logs?.push(message)
  });
  const redirectUrl = await controller.ensureReady();
  store.update("exa", {
    tokens: { access_token: "at-expired", refresh_token: options.refreshToken ?? "rt-1", token_type: "Bearer" },
    clientInformation: { client_id: "client-seed" },
    redirectUrl,
    ...(options.refreshFailed ? { refreshFailed: { reason: "invalid_grant", at: Date.now() } } : {})
  });
  // 把 store 一并交出去：控制器读的是这个内存实例，测试要模拟「运行中 token 过期」
  // 就必须改它（另开一个 McpAuthStore 改盘上的文件不会被控制器看到）。
  return { controller, redirectUrl, store };
}

/** 测试里的 MCP server 配置（URL 指向本地假服务器）。 */
function exaServer(url: string): ConfiguredMcpServer {
  return { name: "exa", scope: "global", entry: { url, auth: "oauth" } };
}

describe("rotating-refresh-token servers", () => {
  it("refreshes once, keeps the rotated refresh_token, and never pops the browser", async () => {
    const portRef = { port: 0 };
    const fake = createRotatingServer(portRef);
    portRef.port = await listen(fake.server);
    const authPath = temporaryAuthPath();
    const opened: string[] = [];
    // 回调服务器的实际端口要先起来才知道（种子里的 redirectUrl 必须与它一致，
    // 否则等于「端口漂移」场景，会触发重新注册）。
    const { controller } = await seededController(authPath, { opened });
    try {
      const manager = new McpClientManager({ oauth: controller });
      const servers = [exaServer(`http://127.0.0.1:${portRef.port}/mcp`)];

      // 启动期的并发 sync：两条都带 refresh。修复前两条各自拿 rt-1 去刷 → 复用检测
      // 撤销令牌族 → SDK 删掉 tokens → 磁盘上凭据消失（用户看到「没保存」）。
      const [first, second] = await Promise.all([
        manager.sync(servers, { refresh: true }),
        manager.sync(servers, { refresh: true })
      ]);

      // 恰好刷一次（串行化）：两条并发 sync 里只有第一条需要真刷新，第二条复用活连接。
      expect(fake.refreshRequests).toEqual(["rt-1"]);
      // 凭据仍在磁盘上，且已经是轮换后的新 refresh_token
      const stored = JSON.parse(readFileSync(authPath, "utf8")).servers.exa;
      expect(stored.tokens?.refresh_token).toBeTruthy();
      expect(stored.refreshFailed).toBeUndefined();
      // 没有任何一次同步把服务器判成「需认证」（凭据没被销毁）
      for (const result of [first, second]) {
        expect(result.summaries[0]?.status).not.toBe("needs-auth");
      }
      // 启动期不自动弹授权页
      expect(opened).toEqual([]);
    } finally {
      await controller.dispose();
      fake.server.close();
    }
  });

  it("keeps the credential and reports the reason when the refresh really is rejected", async () => {
    const portRef = { port: 0 };
    const fake = createRotatingServer(portRef);
    portRef.port = await listen(fake.server);
    const authPath = temporaryAuthPath();
    const logs: string[] = [];
    // 磁盘上是一个已被服务器撤销的 refresh_token（真实场景：上一条记录被轮换过）
    const { controller } = await seededController(authPath, { refreshToken: "rt-revoked", opened: [], logs });
    try {
      const manager = new McpClientManager({ oauth: controller });
      const servers = [exaServer(`http://127.0.0.1:${portRef.port}/mcp`)];
      const result = await manager.sync(servers, { refresh: true });

      const stored = JSON.parse(readFileSync(authPath, "utf8")).servers.exa;
      // 关键回归点：旧实现这里 tokens 会被整段删掉（磁盘上凭据消失）。
      expect(stored.tokens?.refresh_token).toBe("rt-revoked");
      expect(stored.refreshFailed?.reason).toBeTruthy();
      // 面板拿到的是真实原因，而不是笼统的 Unauthorized
      const summary = result.summaries[0];
      expect(summary?.status).toBe("needs-auth");
      expect(summary?.authState).toBe("failed");
      expect(summary?.error).toMatch(/需重新授权|刷新令牌|invalid_grant|revoked/u);
      expect(logs.join("\n")).toContain("已保留凭据");
    } finally {
      await controller.dispose();
      fake.server.close();
    }
  });

  it("retries the kept refresh_token only when the user explicitly asks to authorize", async () => {
    const portRef = { port: 0 };
    const fake = createRotatingServer(portRef);
    portRef.port = await listen(fake.server);
    const authPath = temporaryAuthPath();
    const opened: string[] = [];
    // rt-1 仍被服务器认作有效，只是此前被标记了失败
    const { controller } = await seededController(authPath, { refreshFailed: true, opened });
    try {
      const server = exaServer(`http://127.0.0.1:${portRef.port}/mcp`);

      // 用户点「认证」：保留的 refresh_token 被拿出来重试一次即成功恢复，不再需要浏览器授权
      await expect(controller.authorizeInteractive(server)).resolves.toBe("authorized");
      expect(opened).toEqual([]);
      const stored = JSON.parse(readFileSync(authPath, "utf8")).servers.exa;
      expect(stored.refreshFailed).toBeUndefined();
      expect(stored.tokens?.refresh_token).toBe("rt-2");
      expect(controller.authStateOf("exa")).toBe("authorized");
    } finally {
      await controller.dispose();
      fake.server.close();
    }
  });
});

describe("parallel tool calls with an expiring access token", () => {
  it("refreshes once before sending instead of letting two 401s race the refresh", async () => {
    const portRef = { port: 0 };
    const fake = createRotatingServer(portRef);
    portRef.port = await listen(fake.server);
    const authPath = temporaryAuthPath();
    const { controller, store } = await seededController(authPath, { opened: [] });
    try {
      const manager = new McpClientManager({ oauth: controller });
      const servers = [exaServer(`http://127.0.0.1:${portRef.port}/mcp`)];
      fake.refreshRequests.length = 0;
      const first = await manager.sync(servers, { refresh: true });
      expect(first.summaries[0]?.status).toBe("connected");

      // 关键准备：把库里的 access token 换成「已过期」的 JWT，而服务器只认最新 token。
      // 这样并行调用会同时进入「需要刷新」的状态（P1-3 的真实触发条件）。
      const expiredJwt = makeJwt(-120);
      store.update("exa", { tokens: { ...(store.get("exa")?.tokens ?? { token_type: "Bearer" }), access_token: expiredJwt } });

      // 从这里开始只统计「工具调用期间」的刷新
      fake.refreshRequests.length = 0;
      // 模型一条消息里并行调用同一 server 的两个工具（Pi 默认并行执行）。
      const results = await Promise.allSettled([
        manager.callTool("mcp__exa__search", { q: "a" }),
        manager.callTool("mcp__exa__search", { q: "b" })
      ]);
      expect(results.every((item) => item.status === "fulfilled")).toBe(true);

      // 真正要守住的不变量：同一个 refresh_token 绝不能被用第二次（轮换型授权服务器
      // 视其为重放，会撤销整个令牌族）。修复前这里会是 ['rt-2','rt-2']。
      const seen = fake.refreshRequests;
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen).size).toBe(seen.length);
      // 凭据没被销毁，且已经轮换到更新的 refresh_token（不写死编号：sync 阶段也会轮换）
      const stored = JSON.parse(readFileSync(authPath, "utf8")).servers.exa;
      expect(stored.tokens?.refresh_token).toBe(fake.liveRefreshToken());
      expect(stored.refreshFailed).toBeUndefined();
      expect(fake.toolCalls.length).toBe(2);
    } finally {
      await controller.dispose();
      fake.server.close();
    }
  });
});

/** 造一个 exp 已过（或未到）的假 JWT —— 只需要能被 isAccessTokenExpired 解析。 */
function makeJwt(expOffsetSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + expOffsetSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("authorization page vs. concurrent sync (P1-1)", () => {
  it("keeps the pending authorization page usable when a sync runs meanwhile", async () => {
    const portRef = { port: 0 };
    const fake = createRotatingServer(portRef);
    portRef.port = await listen(fake.server);
    const authPath = temporaryAuthPath();
    // 种子里的 refresh_token 已被服务器撤销：刷新必然失败 → SDK 转浏览器授权
    const { controller } = await seededController(authPath, { refreshToken: "rt-revoked", opened: [] });
    try {
      const manager = new McpClientManager({ oauth: controller });
      const servers = [exaServer(`http://127.0.0.1:${portRef.port}/mcp`)];

      // 用户点「认证」但没有可用的 refresh_token（被撤销）→ SDK 打开授权页，进入 pending。
      // 此间 SDK 已经把 state/codeVerifier 写进凭据库。
      const pending = await controller.authorizeInteractive(servers[0]!);
      const authorizationUrl = controller.pendingAuthorizationUrl("exa");
      const stateFromUrl = new URL(authorizationUrl!).searchParams.get("state");
      expect(pending).toBe("pending");
      expect(stateFromUrl).toBeTruthy();

      // 并发一次同步（真实场景：编辑/重载另一条资源、或授权成功后的收尾重连）：
      // 它会再走一遍 SDK auth()，把库里的 state/codeVerifier 覆写成新流程的。
      await manager.sync(servers, { refresh: true });

      // 用户浏览器里那个授权页回来：必须仍然能完成（修复前 state 已被覆写 → 400 废页）。
      // 走真实的授权端点：/authorize 会用**当时的** code_challenge 记下这枚 code，
      // 回调兑换时假服务器按 S256(code_verifier) 校验 PKCE —— 只要交出去的 verifier
      // 被并发流程换过，这里就会以 PKCE verification failed 失败。
      const authorizeResponse = await fetch(authorizationUrl!, { redirect: "manual" });
      const callbackUrl = authorizeResponse.headers.get("location");
      expect(callbackUrl).toBeTruthy();
      const response = await fetch(callbackUrl!);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("授权成功");
    } finally {
      await controller.dispose();
      fake.server.close();
    }
  });
});

describe("parallel tool calls with an opaque (non-JWT) access token", () => {
  it("still never sends the same refresh_token twice", async () => {
    const portRef = { port: 0 };
    const fake = createRotatingServer(portRef);
    portRef.port = await listen(fake.server);
    const authPath = temporaryAuthPath();
    const { controller, store } = await seededController(authPath, { opened: [] });
    try {
      const manager = new McpClientManager({ oauth: controller });
      const servers = [exaServer(`http://127.0.0.1:${portRef.port}/mcp`)];
      const first = await manager.sync(servers, { refresh: true });
      expect(first.summaries[0]?.status).toBe("connected");

      // 关键：把库里的 access token 换成**不可解析**的 opaque 值（没有 exp 可读），
      // 发送前的到期判断看不见它，只能靠「同一 server 的发送串行化」来避免两个
      // 401 同时刷新——这正是只做 JWT 预判时留下的漏洞。
      store.update("exa", { tokens: { ...(store.get("exa")?.tokens ?? { token_type: "Bearer" }), access_token: "opaque-not-a-jwt" } });
      fake.refreshRequests.length = 0;

      const results = await Promise.allSettled([
        manager.callTool("mcp__exa__search", { q: "a" }),
        manager.callTool("mcp__exa__search", { q: "b" })
      ]);
      expect(results.every((item) => item.status === "fulfilled")).toBe(true);

      const seen = fake.refreshRequests;
      expect(seen.length).toBeGreaterThan(0);
      // 不变量：同一个 refresh_token 绝不能被发送两次（轮换型服务器会撤销令牌族）
      expect(new Set(seen).size).toBe(seen.length);
      const stored = JSON.parse(readFileSync(authPath, "utf8")).servers.exa;
      expect(stored.tokens?.refresh_token).toBe(fake.liveRefreshToken());
      expect(stored.refreshFailed).toBeUndefined();
      expect(fake.toolCalls.length).toBe(2);
    } finally {
      await controller.dispose();
      fake.server.close();
    }
  });
});

describe("sync overlapping tool calls (P1: two independent queues)", () => {
  it("never lets a forced sync and a tool call refresh with the same refresh_token", async () => {
    const portRef = { port: 0 };
    const fake = createRotatingServer(portRef);
    portRef.port = await listen(fake.server);
    const authPath = temporaryAuthPath();
    const { controller, store } = await seededController(authPath, { opened: [] });
    try {
      const manager = new McpClientManager({ oauth: controller });
      const servers = [exaServer(`http://127.0.0.1:${portRef.port}/mcp`)];
      const first = await manager.sync(servers, { refresh: true });
      expect(first.summaries[0]?.status).toBe("connected");

      // 两个路径同时需要刷新：sync 侧（强制重连，401 由 SDK 内部 auth 刷新）与
      // callTool 侧（发送前的到期刷新）。它们分别在 server: / send: 两条队列里，
      // 只有共用 auth 闸门才不会拿同一个 refresh_token 并发去换。
      store.update("exa", { tokens: { ...(store.get("exa")?.tokens ?? { token_type: "Bearer" }), access_token: "opaque-not-a-jwt" } });
      fake.refreshRequests.length = 0;
      const results = await Promise.allSettled([
        manager.sync(servers, { refresh: true }),
        manager.callTool("mcp__exa__search", { q: "a" })
      ]);
      expect(results.every((item) => item.status === "fulfilled")).toBe(true);

      const seen = fake.refreshRequests;
      expect(seen.length).toBeGreaterThan(0);
      // 不变量：同一个 refresh_token 绝不能被发送两次（轮换型服务器撤销令牌族）
      expect(new Set(seen).size).toBe(seen.length);
      const stored = JSON.parse(readFileSync(authPath, "utf8")).servers.exa;
      expect(stored.tokens?.refresh_token).toBe(fake.liveRefreshToken());
      expect(stored.refreshFailed).toBeUndefined();
    } finally {
      await controller.dispose();
      fake.server.close();
    }
  });
});
