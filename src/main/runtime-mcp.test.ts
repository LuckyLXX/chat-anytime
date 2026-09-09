import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfiguredMcpServers, upsertMcpServerConfig } from "./mcp-config.js";
import { planMcpServerSave } from "./runtime-mcp.js";

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
