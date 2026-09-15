import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfiguredMcpServer } from "./mcp-config.js";
import { McpAuthStore, McpOAuthCallbackServer, McpOAuthController, createMcpOAuthProvider } from "./mcp-oauth.js";

// SDK 的授权编排会走真实网络（发现/注册），这里只验证我们的封装契约：
// REDIRECT → 已打开浏览器且处于等待中；AUTHORIZED → 直接用已有凭据。
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, auth: (...args: unknown[]) => authMock(...args) };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-mcp-oauth-"));
  temporaryDirectories.push(directory);
  return join(directory, "pidesktop-mcp-auth.json");
}

function httpServer(name: string, entry: Partial<ConfiguredMcpServer["entry"]> = {}): ConfiguredMcpServer {
  return { name, scope: "global", entry: { url: "https://mcp.example.com/mcp", ...entry } };
}

describe("McpAuthStore", () => {
  it("round-trips credentials and tolerates a corrupt file", async () => {
    const path = await storePath();
    const store = new McpAuthStore(() => path);
    expect(store.redirectPort).toBeUndefined();

    store.setRedirectPort(1456);
    store.update("exa", { tokens: { access_token: "a", refresh_token: "r", token_type: "Bearer" }, redirectUrl: "http://127.0.0.1:1456/callback" });
    expect(store.hasTokens("exa")).toBe(true);
    expect(store.hasTokens("other")).toBe(false);

    const reloaded = new McpAuthStore(() => path);
    expect(reloaded.redirectPort).toBe(1456);
    expect(reloaded.get("exa")?.tokens?.refresh_token).toBe("r");

    await writeFile(path, "{ broken", "utf8");
    const tolerant = new McpAuthStore(() => path);
    expect(tolerant.get("exa")).toBeUndefined();
  });

  it("removes a field when the patch value is undefined and clears a record", async () => {
    const path = await storePath();
    const store = new McpAuthStore(() => path);
    store.update("exa", { tokens: { access_token: "a", token_type: "Bearer" }, codeVerifier: "v" });
    store.update("exa", { tokens: undefined });
    expect(store.get("exa")?.tokens).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8")).servers.exa.codeVerifier).toBe("v");

    store.clear("exa");
    expect(store.get("exa")).toBeUndefined();
  });
});

describe("createMcpOAuthProvider", () => {
  it("exposes client metadata, persists credentials and drops stale registrations", async () => {
    const path = await storePath();
    const store = new McpAuthStore(() => path);
    const opened: string[] = [];
    const provider = createMcpOAuthProvider({
      serverName: "exa",
      redirectUrl: "http://127.0.0.1:1456/callback",
      store,
      openExternal: (url) => { opened.push(url); },
      onAuthorizationUrl: (url) => { opened.push(`pending:${url}`); }
    });

    expect(provider.redirectUrl).toBe("http://127.0.0.1:1456/callback");
    expect(provider.clientMetadata.redirect_uris).toEqual(["http://127.0.0.1:1456/callback"]);
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");

    provider.saveClientInformation!({ client_id: "client-1" });
    expect(provider.clientInformation()).toEqual({ client_id: "client-1" });
    // 端口变化 → redirect_uri 不再匹配，需要重新注册
    const movedProvider = createMcpOAuthProvider({ serverName: "exa", redirectUrl: "http://127.0.0.1:9999/callback", store, openExternal: () => undefined });
    expect(movedProvider.clientInformation()).toBeUndefined();

    const state = await provider.state!();
    expect(state).toMatch(/^[0-9a-f]{32}$/u);
    expect(store.get("exa")?.state).toBe(state);

    await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
    expect(opened).toEqual(["pending:https://auth.example.com/authorize?x=1", "https://auth.example.com/authorize?x=1"]);

    provider.saveTokens!({ access_token: "a", refresh_token: "r", token_type: "Bearer" });
    expect((await provider.tokens())?.access_token).toBe("a");
    await provider.invalidateCredentials!("tokens");
    expect(await provider.tokens()).toBeUndefined();
    await provider.invalidateCredentials!("all");
    expect(provider.clientInformation()).toBeUndefined();
    expect(store.get("exa")).toBeUndefined();
  });
});

describe("McpOAuthCallbackServer", () => {
  it("serves /callback, forwards the query and answers with a page", async () => {
    const server = new McpOAuthCallbackServer();
    const seen: unknown[] = [];
    try {
      await server.start(0, async (request) => { seen.push(request); return { ok: true, message: "done" }; });
      const response = await fetch(`${server.redirectUrl}?code=abc&state=xyz`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("授权成功");
      expect(seen).toEqual([{ code: "abc", state: "xyz" }]);

      const missing = await fetch(`${server.redirectUrl!.replace("/callback", "/other")}`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
    expect(server.redirectUrl).toBeUndefined();
  });
});

describe("McpOAuthController", () => {
  it("drives the pending → callback → finishAuth → reconnect flow", async () => {
    const path = await storePath();
    const authorized: string[] = [];
    const controller = new McpOAuthController({
      storePath: () => path,
      openExternal: vi.fn(),
      onAuthorized: async (name) => { authorized.push(name); }
    });
    try {
      const redirectUrl = await controller.ensureReady();
      expect(redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
      // 幂等：第二次拿到的还是同一个地址
      expect(await controller.ensureReady()).toBe(redirectUrl);

      const server = httpServer("exa");
      expect(controller.supports(server)).toBe(true);
      expect(controller.supports({ name: "local", scope: "global", entry: { command: "npx" } })).toBe(false);
      expect(controller.supports({ name: "bearer", scope: "global", entry: { url: "https://x/mcp", bearerTokenEnv: "TOKEN" } })).toBe(false);

      const provider = controller.providerFor(server)!;
      expect(controller.authStateOf("exa")).toBe("idle");
      // 真实链路里 finishAuth 会把 token 写进 store（SDK 调 provider.saveTokens）。
      const finishAuth = vi.fn(async () => { provider.saveTokens({ access_token: "a", token_type: "Bearer" }); });
      controller.registerTransport("exa", { finishAuth });

      // 模拟 SDK 走到「需要用户授权」：写入 state + 打开浏览器
      const state = await provider.state!();
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?state=1"));
      expect(controller.authStateOf("exa")).toBe("pending");
      expect(controller.pendingAuthorizationUrl("exa")).toBe("https://auth.example.com/authorize?state=1");

      const response = await fetch(`${redirectUrl}?code=the-code&state=${state}`);
      expect(response.status).toBe(200);
      expect(finishAuth).toHaveBeenCalledWith("the-code");
      expect(authorized).toEqual(["exa"]);
      expect(controller.authStateOf("exa")).toBe("authorized");
    } finally {
      await controller.dispose();
    }
  });

  it("rejects a callback whose state does not match any pending flow", async () => {
    const path = await storePath();
    const controller = new McpOAuthController({ storePath: () => path, openExternal: vi.fn(), onAuthorized: async () => undefined });
    try {
      const redirectUrl = await controller.ensureReady();
      const finishAuth = vi.fn(async () => undefined);
      const provider = controller.providerFor(httpServer("exa"))!;
      await provider.state!();
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      controller.registerTransport("exa", { finishAuth });

      const response = await fetch(`${redirectUrl}?code=abc&state=deadbeef`);
      expect(response.status).toBe(400);
      expect(finishAuth).not.toHaveBeenCalled();
    } finally {
      await controller.dispose();
    }
  });

  it("drops the pending window after the timeout and clears credentials on request", async () => {
    const path = await storePath();
    const store = new McpAuthStore(() => path);
    store.update("exa", { tokens: { access_token: "a", token_type: "Bearer" } });
    const stateChanged = vi.fn();
    const controller = new McpOAuthController({ storePath: () => path, openExternal: vi.fn(), onAuthorized: async () => undefined, onAuthStateChanged: stateChanged, pendingTimeoutMs: 5 });
    try {
      await controller.ensureReady();
      expect(controller.authStateOf("exa")).toBe("authorized");

      const provider = controller.providerFor(httpServer("exa"))!;
      await provider.state!();
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      expect(controller.authStateOf("exa")).toBe("pending");

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(controller.authStateOf("exa")).toBe("authorized");
      // 超时发生在命令流之外：必须通知宿主重推资源目录，面板才能离开等待态
      expect(stateChanged).toHaveBeenCalledTimes(1);

      await controller.clear("exa");
      expect(controller.authStateOf("exa")).toBe("idle");
      expect(new McpAuthStore(() => path).hasTokens("exa")).toBe(false);
    } finally {
      await controller.dispose();
    }
  });

  it("proactively authorizes a server marked auth=oauth without waiting for a 401", async () => {
    const path = await storePath();
    const opened = vi.fn();
    const controller = new McpOAuthController({ storePath: () => path, openExternal: opened, onAuthorized: async () => undefined });
    try {
      await controller.ensureReady();
      const server = httpServer("exa", { auth: "oauth" });

      authMock.mockImplementation(async (provider: { redirectToAuthorization: (url: URL) => Promise<void> }) => {
        await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
        return "REDIRECT";
      });
      await expect(controller.beginAuthorization(server)).resolves.toBe("pending");
      expect(opened).toHaveBeenCalledWith("https://auth.example.com/authorize?x=1");
      expect(controller.authStateOf("exa")).toBe("pending");

      authMock.mockImplementation(async () => "AUTHORIZED");
      await expect(controller.beginAuthorization(server)).resolves.toBe("authorized");

      // 未打开授权页（既非 REDIRECT 也非 AUTHORIZED 的异常路径）要报错而不是静默等待
      authMock.mockImplementation(async () => "REDIRECT");
      await controller.clear("exa");
      await expect(controller.beginAuthorization(server)).rejects.toThrow("未提供 OAuth 元数据");
    } finally {
      await controller.dispose();
    }
  });

  it("reports a failed authorization through authErrorOf", async () => {
    const path = await storePath();
    const stateChanged = vi.fn();
    const controller = new McpOAuthController({ storePath: () => path, openExternal: vi.fn(), onAuthorized: async () => undefined, onAuthStateChanged: stateChanged });
    try {
      const redirectUrl = await controller.ensureReady();
      const provider = controller.providerFor(httpServer("exa"))!;
      const state = await provider.state!();
      await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));
      controller.registerTransport("exa", { finishAuth: async () => { throw new Error("invalid_grant"); } });

      const response = await fetch(`${redirectUrl}?code=bad&state=${state}`);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("invalid_grant");
      expect(controller.authStateOf("exa")).toBe("idle");
      expect(controller.authErrorOf("exa")).toBe("invalid_grant");
      // 回调失败同样要通知宿主重推目录（失败说明展示在列表行下方）
      expect(stateChanged).toHaveBeenCalledTimes(1);
    } finally {
      await controller.dispose();
    }
  });
});

describe("credential survival (regression: 重启后反复重新授权)", () => {
  it("keeps the refresh_token when the authorization server rejects it, and reports why", async () => {
    const path = await storePath();
    const logs: string[] = [];
    const controller = new McpOAuthController({
      storePath: () => path,
      openExternal: vi.fn(),
      onAuthorized: async () => undefined,
      log: (message) => logs.push(message)
    });
    try {
      await controller.ensureReady();
      const provider = controller.providerFor(httpServer("exa"))!;
      // 模拟「SDK 发现 refresh 被拒」：先读到凭据，再由 invalid_grant 触发失效处理
      provider.saveTokens({ access_token: "expired", refresh_token: "rt-1", token_type: "Bearer" });
      expect(await provider.tokens()).toMatchObject({ refresh_token: "rt-1" });

      provider.invalidateCredentials!("tokens");

      // 旧行为是真删（tokens: undefined）——轮换型服务器上一次竞态失败就永久丢凭据，
      // 这正是「每次重启都要重新授权」的根因。现在只标记失败、保留 refresh_token。
      const record = new McpAuthStore(() => path).get("exa");
      expect(record?.tokens?.refresh_token).toBe("rt-1");
      expect(record?.refreshFailed?.reason).toBeTruthy();
      // 标记期间不再把死 token 交给 SDK 反复刷
      expect(await provider.tokens()).toBeUndefined();
      // 面板要能看到真实原因，而不是笼统的 Unauthorized
      expect(controller.authStateOf("exa")).toBe("failed");
      expect(controller.authErrorOf("exa")).toMatch(/刷新令牌|重新授权/u);
      expect(logs.join("\n")).toContain("已保留凭据");
    } finally {
      await controller.dispose();
    }
  });

  it("ignores an invalidation whose credentials were already replaced by a concurrent refresh", async () => {
    const path = await storePath();
    const controller = new McpOAuthController({ storePath: () => path, openExternal: vi.fn(), onAuthorized: async () => undefined });
    try {
      await controller.ensureReady();
      const provider = controller.providerFor(httpServer("exa"))!;
      provider.saveTokens({ access_token: "old", refresh_token: "rt-1", token_type: "Bearer" });
      await provider.tokens();
      // 并发刷新的赢家写入新凭据后，输家的 invalid_grant 不得销毁它（指纹守卫）
      provider.saveTokens({ access_token: "new", refresh_token: "rt-2", token_type: "Bearer" });
      provider.invalidateCredentials!("tokens");

      const record = new McpAuthStore(() => path).get("exa");
      expect(record?.tokens?.refresh_token).toBe("rt-2");
      expect(record?.refreshFailed).toBeUndefined();
      expect(controller.authStateOf("exa")).toBe("authorized");
    } finally {
      await controller.dispose();
    }
  });

  it("does not pop the browser on its own, but a user-initiated authorize clears the failure for one retry", async () => {
    const path = await storePath();
    const store = new McpAuthStore(() => path);
    store.update("exa", {
      tokens: { access_token: "expired", refresh_token: "rt-1", token_type: "Bearer" },
      refreshFailed: { reason: "invalid_grant", at: Date.now() }
    });
    const opened: string[] = [];
    const controller = new McpOAuthController({ storePath: () => path, openExternal: (url) => { opened.push(url); }, onAuthorized: async () => undefined });
    try {
      await controller.ensureReady();
      const server = httpServer("exa", { auth: "oauth" });
      // 自动路径：不弹授权页，只提示（启动时不打扰用户）
      authMock.mockImplementation(async (provider: { redirectToAuthorization: (url: URL) => Promise<void> }) => {
        await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?auto=1"));
        return "REDIRECT";
      });
      // 授权页被抑制 ≠ 元数据缺失：报「需要重新登录授权」而不是误导性的
      // 「未提供 OAuth 元数据」（P2-4）。
      await expect(controller.beginAuthorization(server)).rejects.toThrow("需要重新登录授权");
      expect(opened).toEqual([]);
      expect(controller.authErrorOf("exa")).toContain("需重新授权");

      // 用户主动「认证」：清标记 → 保留的 refresh_token 得以重试一次；仍不行则照常弹页
      const retried: (string | undefined)[] = [];
      authMock.mockImplementation(async (provider: { tokens: () => Promise<{ refresh_token?: string } | undefined>; redirectToAuthorization: (url: URL) => Promise<void> }) => {
        retried.push((await provider.tokens())?.refresh_token);
        await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?user=1"));
        return "REDIRECT";
      });
      await expect(controller.authorizeInteractive(server)).resolves.toBe("pending");
      expect(retried).toEqual(["rt-1"]);
      expect(opened).toEqual(["https://auth.example.com/authorize?user=1"]);
    } finally {
      await controller.dispose();
    }
  });

  it("serializes concurrent auth rounds for the same server so only one refresh runs", async () => {
    const path = await storePath();
    const controller = new McpOAuthController({ storePath: () => path, openExternal: vi.fn(), onAuthorized: async () => undefined });
    try {
      await controller.ensureReady();
      const server = httpServer("exa");
      let concurrent = 0;
      let peak = 0;
      const order: string[] = [];
      authMock.mockImplementation(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        order.push(`start-${order.length}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        return "AUTHORIZED";
      });
      await Promise.all([
        controller.runExclusiveAuth("exa", () => authMock(controller.providerFor(server), { serverUrl: "https://mcp.example.com/mcp" })),
        controller.runExclusiveAuth("exa", () => authMock(controller.providerFor(server), { serverUrl: "https://mcp.example.com/mcp" }))
      ]);
      // 两个并发调用必须依次执行：上游 auth() 没有并发去重，重叠就是同一个
      // refresh_token 被刷两次 → 轮换型服务器撤销整个令牌族。
      expect(peak).toBe(1);
      expect(order).toEqual(["start-0", "start-1"]);
    } finally {
      await controller.dispose();
    }
  });
});
