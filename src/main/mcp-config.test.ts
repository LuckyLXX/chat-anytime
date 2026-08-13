import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfiguredMcpServers, removeMcpServerConfig, setMcpServerDisabled, upsertMcpServerConfig } from "./mcp-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryConfig(name = ".mcp.json"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-mcp-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

describe("mcp config", () => {
  it("creates a standard mcpServers entry", async () => {
    const path = await temporaryConfig();
    upsertMcpServerConfig(path, "docs", { command: "npx", args: ["-y", "docs-mcp"] });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      mcpServers: { docs: { command: "npx", args: ["-y", "docs-mcp"] } }
    });
  });

  it("preserves existing JSONC settings and replaces a server", async () => {
    const path = await temporaryConfig();
    await writeFile(path, '{\n  // keep the adapter setting\n  "settings": { "toolPrefix": "short", },\n  "mcpServers": { "old": { "url": "https://old.example/mcp" } }\n}\n', "utf8");
    upsertMcpServerConfig(path, "old", { url: "https://new.example/mcp", auth: "oauth" });

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      settings: { toolPrefix: "short" },
      mcpServers: { old: { url: "https://new.example/mcp", auth: "oauth" } }
    });
  });

  it("rejects a malformed server map", async () => {
    const path = await temporaryConfig();
    await writeFile(path, '{ "mcpServers": [] }', "utf8");

    expect(() => upsertMcpServerConfig(path, "broken", { url: "https://example.com/mcp" })).toThrow("必须是对象");
  });

  it("reads merged project + global servers with project taking precedence", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-desktop-proj-"));
    const globalDir = await mkdtemp(join(tmpdir(), "pi-desktop-glob-"));
    temporaryDirectories.push(projectDir, globalDir);
    const projectPath = join(projectDir, ".mcp.json");
    const globalPath = join(globalDir, "mcp.json");
    upsertMcpServerConfig(globalPath, "shared", { url: "https://global.example/mcp" });
    upsertMcpServerConfig(globalPath, "global-only", { command: "npx", args: ["g"] });
    upsertMcpServerConfig(projectPath, "shared", { url: "https://project.example/mcp" });

    const servers = readConfiguredMcpServers(projectPath, globalPath);
    expect(servers.map((server) => server.name)).toEqual(["global-only", "shared"]);
    expect(servers.find((server) => server.name === "shared")).toMatchObject({ scope: "project", entry: { url: "https://project.example/mcp" } });
  });

  it("removes and disables servers", async () => {
    const path = await temporaryConfig();
    upsertMcpServerConfig(path, "docs", { command: "npx", args: ["docs-mcp"] });
    upsertMcpServerConfig(path, "weather", { url: "https://weather.example/mcp" });

    expect(setMcpServerDisabled(path, "docs", true)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers.docs).toMatchObject({ disabled: true });

    expect(setMcpServerDisabled(path, "docs", false)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers.docs).not.toMatchObject({ disabled: true });

    expect(removeMcpServerConfig(path, "weather")).toBe(true);
    expect(removeMcpServerConfig(path, "missing")).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8")).mcpServers).toEqual({ docs: { command: "npx", args: ["docs-mcp"] } });
  });
});
