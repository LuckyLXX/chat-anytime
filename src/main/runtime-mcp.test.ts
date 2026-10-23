import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { McpServerConfigDraft } from "../shared/protocol.js";
import {
  mcpConfigPathsFor,
  mcpConfigEntry,
  normalizeMcpHeaders,
  parseMcpStatusText,
  piMcpConfigFor,
  mcpOauthEligible,
  buildMcpSummaries,
  authorizedMcpServers,
  mcpCredentialKeysFor,
  planMcpServerSave,
  PI_MCP_CALL_TIMEOUT_SECONDS,
  type ParsedMcpServerState
} from "./runtime-mcp.js";
import type { ConfiguredMcpServer } from "./mcp-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function server(name: string, entry: Record<string, unknown>, scope: "project" | "global" = "global"): ConfiguredMcpServer {
  return { name, entry: entry as ConfiguredMcpServer["entry"], scope };
}

describe("mcpConfigPathsFor / mcpConfigEntry / normalizeMcpHeaders（迁移后保留的纯函数）", () => {
  it("双作用域路径：项目随工作区、全局在 agentDir", () => {
    const paths = mcpConfigPathsFor("/w", "/agent");
    expect(paths.project.endsWith(join("w", ".mcp.json"))).toBe(true);
    expect(paths.global).toBe(join("/agent", "mcp.json"));
    const noWorkspace = mcpConfigPathsFor(undefined, "/agent");
    expect(noWorkspace.project).toBe(join("/agent", ".mcp.json"));
  });

  it("stdio 草稿校验：缺命令报错；args/env 透传", () => {
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "stdio" } as McpServerConfigDraft)).toThrow("启动命令");
    const entry = mcpConfigEntry({ name: "x", scope: "global", transport: "stdio", command: "npx", args: ["-y", "s"], env: { K: "V" } });
    expect(entry).toEqual({ command: "npx", args: ["-y", "s"], env: { K: "V" } });
  });

  it("HTTP 草稿校验：URL 协议、bearer env 必填、header 注入拦截", () => {
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "ftp://a" } as McpServerConfigDraft)).toThrow("http://");
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", auth: "bearer-env" } as McpServerConfigDraft)).toThrow("Bearer");
    expect(() => normalizeMcpHeaders({ "Bad Name": "v" })).toThrow("请求头名称无效");
    expect(() => normalizeMcpHeaders({ "X-A": "a\r\nb" })).toThrow("换行");
  });

  it("Bearer 环境变量名不合法时硬拦（填成令牌本身会静默 401）", () => {
    // 合法名：字母/下划线开头，字母数字下划线
    expect(mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", auth: "bearer-env", bearerTokenEnv: "EXA_TOKEN" }).bearerTokenEnv).toBe("EXA_TOKEN");
    // 直接粘令牌 → 报错并说清「填变量名」（否则 Bearer ${sk-xxx} 会被当字面量发出去）
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", auth: "bearer-env", bearerTokenEnv: "sk-abc123" })).toThrow("变量名");
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", auth: "bearer-env", bearerTokenEnv: "1TOKEN" })).toThrow("变量名");
  });

  it("OAuth 高级选项校验：空值丢弃、回环回调、https 元数据、端口范围、注册方式枚举", () => {
    // 空对象 → 不产生 oauth 字段
    expect(mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", oauth: {} }).oauth).toBeUndefined();
    // 合法值归一化（trim + 丢弃空串）
    const ok = mcpConfigEntry({
      name: "x", scope: "global", transport: "http", url: "https://a",
      oauth: { clientId: " cid ", clientSecret: "", callbackPort: 1456, scope: "a b", clientRegistration: "cimd" }
    });
    expect(ok.oauth).toEqual({ clientId: "cid", callbackPort: 1456, scope: "a b", clientRegistration: "cimd" });
    // 回调地址必须回环 http（允许 localhost / 127.0.0.1 / [::1]）
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", oauth: { callbackUrl: "https://evil.example/cb" } })).toThrow("localhost");
    expect(mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", oauth: { callbackUrl: "http://127.0.0.1:1456/callback" } }).oauth?.callbackUrl).toBe("http://127.0.0.1:1456/callback");
    // 端口范围与注册方式
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", oauth: { callbackPort: 70000 } })).toThrow("65535");
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", oauth: { clientRegistration: "bad" as never } })).toThrow("dcr");
    // 元数据地址必须 https（回环除外）
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", oauth: { authServerMetadataUrl: "http://as.example/.well-known" } })).toThrow("https");
  });

  it("timeout 校验：1–3600 整数；空值不写入；stdio 与 HTTP 都接受", () => {
    expect(mcpConfigEntry({ name: "x", scope: "global", transport: "stdio", command: "npx" }).timeout).toBeUndefined();
    expect(mcpConfigEntry({ name: "x", scope: "global", transport: "stdio", command: "npx", timeout: 300 }).timeout).toBe(300);
    expect(mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", timeout: 30 }).timeout).toBe(30);
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", timeout: 0 })).toThrow("1–3600");
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", timeout: 3601 })).toThrow("1–3600");
    expect(() => mcpConfigEntry({ name: "x", scope: "global", transport: "http", url: "https://a", timeout: 1.5 })).toThrow("1–3600");
  });
});

describe("piMcpConfigFor：方言 → Pi McpServerConfig", () => {
  it("stdio 条目：command/args/env 透传，exposure/timeout 由调用方决定", () => {
    const config = piMcpConfigFor(server("fs", { command: "npx", args: ["-y", "s"], env: { K: "V" } }), "direct");
    expect(config).toEqual({
      type: "stdio", command: "npx", args: ["-y", "s"], env: { K: "V" },
      exposure: "direct", timeout: PI_MCP_CALL_TIMEOUT_SECONDS
    });
    expect(piMcpConfigFor(server("fs", { command: "npx" }), "hidden").exposure).toBe("hidden");
  });

  it("bearerTokenEnv → headers.Authorization（Bearer ${NAME}），且覆盖同名手写头", () => {
    const config = piMcpConfigFor(server("exa", { url: "https://e/mcp", bearerTokenEnv: "EXA_KEY", headers: { Authorization: "manual", "X-Other": "1" } }), "direct");
    if (config.type !== "http") throw new Error("应为 http 配置");
    expect(config.headers).toEqual({ Authorization: "Bearer ${EXA_KEY}", "X-Other": "1" });
  });

  it("OAuth 高级选项与 timeout 原样透传给 Pi（字段名与 McpOAuthConfig 对齐）", () => {
    const config = piMcpConfigFor(server("exa", { url: "https://e/mcp", auth: "oauth", timeout: 300, oauth: { clientId: "cid", clientSecret: "${SECRET}", callbackUrl: "http://127.0.0.1:1456/callback", scope: "read" } }), "direct");
    if (config.type !== "http") throw new Error("应为 http 配置");
    expect(config.timeout).toBe(300);
    expect(config.oauth).toEqual({ clientId: "cid", clientSecret: "${SECRET}", callbackUrl: "http://127.0.0.1:1456/callback", scope: "read" });
    // 未配置 timeout → 旧缺省 120s
    const dflt = piMcpConfigFor(server("a", { url: "https://a" }), "direct");
    expect(dflt.timeout).toBe(PI_MCP_CALL_TIMEOUT_SECONDS);
  });

  it("auth:oauth 压过手写的 Authorization 头（Pi 以头的有无决定是否挂 OAuth，不能在翻译层让它静默失效）", () => {
    const forced = piMcpConfigFor(server("forced", { url: "https://f/mcp", auth: "oauth", headers: { Authorization: "Bearer manual", "X-Other": "1" } }), "direct");
    if (forced.type !== "http") throw new Error("应为 http 配置");
    expect(forced.headers).toEqual({ "X-Other": "1" });
    // 未声明 auth:oauth 时，手写的 Authorization 保留（并因此不走 OAuth）
    const manual = piMcpConfigFor(server("manual", { url: "https://m/mcp", headers: { Authorization: "Bearer manual" } }), "direct");
    if (manual.type !== "http") throw new Error("应为 http 配置");
    expect(manual.headers).toEqual({ Authorization: "Bearer manual" });
  });

  it("bearerTokenEnv 覆盖任意大小写变体的 Authorization，不留重复键（fetch Headers 会合并成逗号串）", () => {
    const config = piMcpConfigFor(server("g", { url: "https://g/mcp", bearerTokenEnv: "TOKEN", headers: { authorization: "Bearer manual", "X-A": "1" } }), "direct");
    if (config.type !== "http") throw new Error("应为 http 配置");
    expect(config.headers).toEqual({ "X-A": "1", Authorization: "Bearer ${TOKEN}" });
  });

  it("auth:oauth → 无显式 OAuth 配置（Pi 隐式：无 Authorization 头的 HTTP 服务器自动 OAuth）", () => {
    const config = piMcpConfigFor(server("exa", { url: "https://e/mcp", auth: "oauth" }), "direct");
    if (config.type !== "http") throw new Error("应为 http 配置");
    expect(config.headers).toBeUndefined();
  });

  it("缺 command 与 url 的坏条目显式报错", () => {
    expect(() => piMcpConfigFor(server("bad", {}), "direct")).toThrow("无法连接");
  });

  it("mcpOauthEligible 与迁移前 supports() 判定一致", () => {
    expect(mcpOauthEligible(server("a", { url: "https://a" }))).toBe(true);
    expect(mcpOauthEligible(server("b", { url: "https://b", auth: "oauth" }))).toBe(true);
    expect(mcpOauthEligible(server("c", { url: "https://c", bearerTokenEnv: "K" }))).toBe(false);
    expect(mcpOauthEligible(server("d", { url: "https://d", headers: { authorization: "Bearer x" } }))).toBe(false);
    expect(mcpOauthEligible(server("e", { command: "npx" }))).toBe(false);
  });
});

describe("parseMcpStatusText：/mcp 状态板解析（格式对齐 Pi 1.4.0 formatStatus）", () => {
  it("connected 带工具数；needs-auth；config error 行跳过", () => {
    const text = [
      "poc: connected, 1 tools (direct)",
      "exa: needs sign-in, run /mcp login exa (direct)",
      "config error: /x/mcp.json: server \"bad\" needs \"command\" or \"url\"",
      "overridden: local"
    ].join("\n");
    const parsed = parseMcpStatusText(text);
    expect(parsed.get("poc")).toMatchObject({ state: "connected", toolCount: 1 });
    expect(parsed.get("exa")).toMatchObject({ state: "needs-auth" });
    expect(parsed.has("config error")).toBe(false);
  });

  it("失败详情的 4 空格缩进续行合并回上一台服务器", () => {
    const text = ["bad: failed (direct)", "    spawn ENOENT", "    at some (file:1:1)", "ok: connected, 3 tools (direct)"].join("\n");
    const parsed = parseMcpStatusText(text);
    expect(parsed.get("bad")).toMatchObject({ state: "failed" });
    expect(parsed.get("bad")?.error).toContain("spawn ENOENT");
    expect(parsed.get("bad")?.error).toContain("at some");
    expect(parsed.get("ok")).toMatchObject({ state: "connected", toolCount: 3 });
  });

  it("starting / connecting / disconnected 各归各态；解析失败行不致命", () => {
    const parsed = parseMcpStatusText("a: starting (direct)\nb: connecting (direct)\nc: disconnected, reconnects on next call (direct)\n完全不像状态板的行");
    expect(parsed.get("a")?.state).toBe("starting");
    expect(parsed.get("b")?.state).toBe("connecting");
    expect(parsed.get("c")?.state).toBe("disconnected");
    expect(parsed.size).toBe(3);
  });
});

describe("buildMcpSummaries：配置投影 + 解析态合成", () => {
  const configured = [
    server("fs", { command: "npx", args: ["-y", "s"] }),
    server("exa", { url: "https://e/mcp", auth: "oauth" }),
    server("off", { url: "https://o/mcp", disabled: true })
  ];

  it("未注册/未解析 → not-connected；停用 → disabled 且不参与连接", () => {
    const summaries = buildMcpSummaries({ configured, parsed: new Map(), authPending: new Set(), authorized: new Set() });
    expect(summaries.find((s) => s.name === "fs")).toMatchObject({ status: "not-connected", toolCount: 0, transport: "stdio" });
    expect(summaries.find((s) => s.name === "off")).toMatchObject({ status: "disabled", disabled: true });
    expect(summaries.find((s) => s.name === "exa")).toMatchObject({ authState: "idle", auth: "oauth" });
  });

  it("解析态映射：connected/needs-auth/failed + toolCount；连接成功不等于已授权", () => {
    const parsed = new Map<string, ParsedMcpServerState>([
      ["fs", { name: "fs", state: "connected", toolCount: 7 }],
      ["exa", { name: "exa", state: "needs-auth" }]
    ]);
    const summaries = buildMcpSummaries({ configured, parsed, authPending: new Set(["exa"]), authorized: new Set() });
    expect(summaries.find((s) => s.name === "fs")).toMatchObject({ status: "connected", toolCount: 7 });
    expect(summaries.find((s) => s.name === "exa")).toMatchObject({ status: "needs-auth", authState: "pending" });
    // 非登录中的 needs-auth = 凭据失效
    const cleared = buildMcpSummaries({ configured, parsed, authPending: new Set(), authorized: new Set() });
    expect(cleared.find((s) => s.name === "exa")).toMatchObject({ authState: "failed" });
  });

  it("已连接但凭据文件里没有 tokens → authState 仍为 idle（非 OAuth 服务器不得显示「清除凭据」）", () => {
    const parsed = new Map<string, ParsedMcpServerState>([
      ["exa", { name: "exa", state: "connected", toolCount: 3 }]
    ]);
    const summaries = buildMcpSummaries({ configured, parsed, authPending: new Set(), authorized: new Set() });
    expect(summaries.find((s) => s.name === "exa")).toMatchObject({ status: "connected", authState: "idle" });
  });

  it("凭据文件里存有 tokens → authorized", () => {
    const parsed = new Map<string, ParsedMcpServerState>([["exa", { name: "exa", state: "connected" }]]);
    const summaries = buildMcpSummaries({ configured, parsed, authPending: new Set(), authorized: new Set(["exa"]) });
    expect(summaries.find((s) => s.name === "exa")).toMatchObject({ authState: "authorized" });
  });

  it("配置投影字段完整回填（表单明文往返）", () => {
    const withAdvanced = [server("ent", { url: "https://ent/mcp", auth: "oauth", timeout: 300, oauth: { clientId: "cid", callbackPort: 1456, scope: "read" } })];
    const summaries = buildMcpSummaries({ configured: [...configured, ...withAdvanced], parsed: new Map(), authPending: new Set(), authorized: new Set() });
    expect(summaries.find((s) => s.name === "fs")).toMatchObject({ command: "npx", args: ["-y", "s"], scope: "global" });
    expect(summaries.find((s) => s.name === "exa")).toMatchObject({ url: "https://e/mcp", transport: "http" });
    // OAuth 高级选项与 timeout 随摘要回填（编辑表单预填用）
    expect(summaries.find((s) => s.name === "ent")).toMatchObject({ timeout: 300, oauth: { clientId: "cid", callbackPort: 1456, scope: "read" } });
  });
});

describe("authorizedMcpServers：以 Pi 凭据文件里的 tokens 判定「真的授权过」", () => {
  const configured = [server("exa", { url: "https://mcp.exa.ai/mcp?tools=web_search_exa%20web_fetch_exa", auth: "oauth" })];

  it("只有 clientInformation（未完成登录的残留）不算授权——用户机 2026-10-15 实测形态", () => {
    const content = JSON.stringify({
      "mcp__exa|https://mcp.exa.ai/mcp?tools=web_search_exa%20web_fetch_exa": { serverUrl: "https://mcp.exa.ai/mcp", clientInformation: { client_id: "x" } }
    });
    expect(authorizedMcpServers(content, configured).size).toBe(0);
  });

  it("存有 tokens → 命中（含只有 URL 的旧键）", () => {
    const url = "https://mcp.exa.ai/mcp?tools=web_search_exa%20web_fetch_exa";
    const byName = JSON.stringify({ [`mcp__exa|${url}`]: { tokens: { access_token: "a" } } });
    expect([...authorizedMcpServers(byName, configured)]).toEqual(["exa"]);
    const legacy = JSON.stringify({ [url]: { tokens: { access_token: "a" } } });
    expect([...authorizedMcpServers(legacy, configured)]).toEqual(["exa"]);
  });

  it("服务器名里的连字符按 Pi 的命名空间规则变下划线；文件损坏/缺失一律按未授权处理", () => {
    const dashed = [server("my-tools", { url: "https://a/mcp", auth: "oauth" })];
    const content = JSON.stringify({ "mcp__my_tools|https://a/mcp": { tokens: { access_token: "a" } } });
    expect([...authorizedMcpServers(content, dashed)]).toEqual(["my-tools"]);
    expect(authorizedMcpServers(undefined, dashed).size).toBe(0);
    expect(authorizedMcpServers("{ not json", dashed).size).toBe(0);
    expect(authorizedMcpServers("[]", dashed).size).toBe(0);
  });
});

describe("planMcpServerSave（迁移后保留：编辑/迁移/停用态随行）", () => {
  it("切换作用域 = 迁移（旧位置删除）", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-plan-"));
    temporaryDirectories.push(root);
    const project = join(root, "project.json");
    const global = join(root, "global.json");
    await writeFile(global, JSON.stringify({ mcpServers: { old: { command: "npx" } } }), "utf8");
    const plan = planMcpServerSave({ project, global }, { name: "new", scope: "project", transport: "stdio", command: "npx" }, { name: "old", scope: "global" });
    expect(plan.targetPath).toBe(project);
    expect(plan.remove).toEqual({ path: global, name: "old" });
    expect(plan.entry).toEqual({ command: "npx" });
  });

  it("编辑停用中的服务器：disabled 随行不被重启用", async () => {
    const root = await mkdtemp(join(tmpdir(), "mcp-plan-"));
    temporaryDirectories.push(root);
    const global = join(root, "global.json");
    await writeFile(global, JSON.stringify({ mcpServers: { a: { command: "npx", disabled: true } } }), "utf8");
    const plan = planMcpServerSave({ project: join(root, "p.json"), global }, { name: "a", scope: "global", transport: "stdio", command: "node" });
    expect(plan.entry).toEqual({ command: "node", disabled: true });
  });
});
