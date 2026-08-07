import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertMcpServerConfig } from "./mcp-config";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryConfig(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-mcp-"));
  temporaryDirectories.push(directory);
  return join(directory, ".mcp.json");
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
});

