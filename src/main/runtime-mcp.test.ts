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

describe("parseMcpStatusText：/mcp 状态板解析（格式对齐 Pi 1.2.0 formatStatus）", () => {
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
    const summaries = buildMcpSummaries({ configured, parsed: new Map(), authPending: new Set() });
    expect(summaries.find((s) => s.name === "fs")).toMatchObject({ status: "not-connected", toolCount: 0, transport: "stdio" });
    expect(summaries.find((s) => s.name === "off")).toMatchObject({ status: "disabled", disabled: true });
    expect(summaries.find((s) => s.name === "exa")).toMatchObject({ authState: "idle", auth: "oauth" });
  });

  it("解析态映射：connected/needs-auth/failed + toolCount + authState 联动", () => {
    const parsed = new Map<string, ParsedMcpServerState>([
      ["fs", { name: "fs", state: "connected", toolCount: 7 }],
      ["exa", { name: "exa", state: "needs-auth" }]
    ]);
    const summaries = buildMcpSummaries({ configured, parsed, authPending: new Set(["exa"]) });
    expect(summaries.find((s) => s.name === "fs")).toMatchObject({ status: "connected", toolCount: 7 });
    expect(summaries.find((s) => s.name === "exa")).toMatchObject({ status: "needs-auth", authState: "pending" });
    // 非登录中的 needs-auth = 凭据失效
    const cleared = buildMcpSummaries({ configured, parsed, authPending: new Set() });
    expect(cleared.find((s) => s.name === "exa")).toMatchObject({ authState: "failed" });
  });

  it("配置投影字段完整回填（表单明文往返）", () => {
    const summaries = buildMcpSummaries({ configured, parsed: new Map(), authPending: new Set() });
    expect(summaries.find((s) => s.name === "fs")).toMatchObject({ command: "npx", args: ["-y", "s"], scope: "global" });
    expect(summaries.find((s) => s.name === "exa")).toMatchObject({ url: "https://e/mcp", transport: "http" });
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
