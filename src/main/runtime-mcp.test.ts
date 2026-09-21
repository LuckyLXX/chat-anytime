import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfiguredMcpServers, upsertMcpServerConfig } from "./mcp-config.js";
import { planMcpServerSave, serverToolNamesFrom } from "./runtime-mcp.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function paths(): Promise<{ project: string; global: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-mcp-plan-"));
  temporaryDirectories.push(directory);
  return { project: join(directory, ".mcp.json"), global: join(directory, "mcp.json") };
}

describe("planMcpServerSave", () => {
  it("writes a new entry to the requested scope without touching the other file", async () => {
    const configPaths = await paths();
    const plan = planMcpServerSave(configPaths, { name: "docs", scope: "global", transport: "stdio", command: "npx", args: ["-y", "docs-mcp"] });

    expect(plan.targetPath).toBe(configPaths.global);
    expect(plan.remove).toBeUndefined();
    expect(plan.entry).toEqual({ command: "npx", args: ["-y", "docs-mcp"] });
  });

  it("preserves the disabled flag when editing an entry in place", async () => {
    const configPaths = await paths();
    upsertMcpServerConfig(configPaths.project, "docs", { command: "npx", disabled: true });

    const plan = planMcpServerSave(configPaths, { name: "docs", scope: "project", transport: "stdio", command: "node", args: ["server.js"] }, { name: "docs", scope: "project" });

    expect(plan.remove).toBeUndefined();
    expect(plan.entry).toEqual({ command: "node", args: ["server.js"], disabled: true });
  });

  it("moves the entry when the scope changes and carries the disabled flag along", async () => {
    const configPaths = await paths();
    upsertMcpServerConfig(configPaths.project, "docs", { url: "https://old.example/mcp", disabled: true });

    const plan = planMcpServerSave(configPaths, { name: "docs", scope: "global", transport: "http", url: "https://new.example/mcp", auth: "none" }, { name: "docs", scope: "project" });

    expect(plan.targetPath).toBe(configPaths.global);
    expect(plan.remove).toEqual({ path: configPaths.project, name: "docs" });
    expect(plan.entry).toEqual({ url: "https://new.example/mcp", disabled: true });
  });

  it("treats a rename as a move even inside the same file", async () => {
    const configPaths = await paths();
    const plan = planMcpServerSave(configPaths, { name: "renamed", scope: "project", transport: "stdio", command: "npx" }, { name: "docs", scope: "project" });

    expect(plan.remove).toEqual({ path: configPaths.project, name: "docs" });
  });

  it("keeps the project copy when editing a name that also exists in the global scope", async () => {
    const configPaths = await paths();
    upsertMcpServerConfig(configPaths.global, "shared", { url: "https://global.example/mcp" });
    upsertMcpServerConfig(configPaths.project, "shared", { url: "https://project.example/mcp", disabled: true });

    const plan = planMcpServerSave(configPaths, { name: "shared", scope: "project", transport: "http", url: "https://edited.example/mcp", auth: "none" }, { name: "shared", scope: "project" });

    expect(plan.remove).toBeUndefined();
    expect(plan.entry).toEqual({ url: "https://edited.example/mcp", disabled: true });
    // 计划是纯函数：不落盘，只描述要写哪里
    expect(readConfiguredMcpServers(configPaths.project, configPaths.global).find((server) => server.name === "shared")?.entry.url).toBe("https://project.example/mcp");
  });
});

describe("serverToolNamesFrom", () => {
  it("按原始服务器名分组，工具名经 mcpToolName 生成（角色级 mcp:<server> overlay 的过滤依据）", () => {
    const map = serverToolNamesFrom([
      { serverName: "exa", toolName: "web_search", description: "", inputSchema: {} },
      { serverName: "exa", toolName: "web_fetch", description: "", inputSchema: {} },
      { serverName: "deveco-mcp", toolName: "check", description: "", inputSchema: {} }
    ]);
    expect(map.get("exa")).toEqual(["mcp__exa__web_search", "mcp__exa__web_fetch"]);
    // 连字符在 mcpToolName 的白名单内（[^A-Za-z0-9_-]），服务器名含 - 时原样保留。
    expect(map.get("deveco-mcp")).toEqual(["mcp__deveco-mcp__check"]);
  });

  it("同名工具去重（与 buildToolDefinitions 的 seen 规则同源）", () => {
    const map = serverToolNamesFrom([
      { serverName: "s", toolName: "dup", description: "", inputSchema: {} },
      { serverName: "s", toolName: "dup", description: "", inputSchema: {} }
    ]);
    expect(map.get("s")).toEqual(["mcp__s__dup"]);
    expect(serverToolNamesFrom([]).size).toBe(0);
  });
});
