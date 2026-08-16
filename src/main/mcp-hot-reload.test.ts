import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DefaultResourceLoader,
  SettingsManager,
  createAgentSession,
  defineTool,
  type AgentSession,
  type ExtensionAPI,
  type InlineExtension,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Pins the hot-reload mechanics applyMcpToolChanges() relies on against the
 * real Pi session: customTools are stored by reference, registerTool()
 * triggers a registry rebuild that re-reads the mutated array, and the active
 * tool list stays controllable afterwards.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function makeTool(name: string, marker: string): ToolDefinition {
  return defineTool({
    name,
    label: name,
    description: `${marker}`,
    promptSnippet: `${name}: ${marker}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: marker }], details: {} })
  });
}

function capturingExtension(sink: { api?: ExtensionAPI }): InlineExtension {
  return { name: "test-capture", hidden: true, factory: (pi) => { sink.api = pi; } };
}

async function makeSession(customTools: ToolDefinition[], extension: InlineExtension): Promise<AgentSession> {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-hotreload-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [extension]
  });
  await resourceLoader.reload();
  const result = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, customTools });
  await result.session.bindExtensions({ onError: () => {} });
  return result.session;
}

describe("customTools hot reload (real AgentSession)", () => {
  it("registerTool on a live session rebuilds the registry from the mutated customTools array", async () => {
    const customTools: ToolDefinition[] = [makeTool("mcp__old__tool", "v1"), makeTool("todo_list", "todo")];
    const sink: { api?: ExtensionAPI } = {};
    const session = await makeSession(customTools, capturingExtension(sink));
    try {
      session.setActiveToolsByName(["mcp__old__tool", "todo_list"]);
      expect(session.getActiveToolNames().sort()).toEqual(["mcp__old__tool", "todo_list"]);

      // Simulate applyMcpToolChanges: replace the MCP portion in place…
      const replacement = makeTool("mcp__new__tool", "v2");
      const replacement2 = makeTool("mcp__new__tool2", "v2");
      customTools.length = 0;
      customTools.push(replacement, replacement2, makeTool("todo_list", "todo"));
      // …then re-register every MCP tool, which triggers the registry refresh.
      for (const tool of [replacement, replacement2]) sink.api!.registerTool(tool);
      session.setActiveToolsByName(["mcp__new__tool", "mcp__new__tool2", "todo_list"]);

      const names = new Set(session.getAllTools().map((tool) => tool.name));
      expect(names.has("mcp__new__tool")).toBe(true);
      expect(names.has("mcp__new__tool2")).toBe(true);
      // The array no longer holds mcp__old__tool and no extension registration
      // keeps it alive, so the rebuilt registry drops it.
      expect(names.has("mcp__old__tool")).toBe(false);
      expect(names.has("todo_list")).toBe(true);
      expect(session.getActiveToolNames().sort()).toEqual(["mcp__new__tool", "mcp__new__tool2", "todo_list"]);
    } finally {
      await session.dispose();
    }
  });

  it("same-name replacement updates the tool definition the registry serves", async () => {
    const customTools: ToolDefinition[] = [makeTool("mcp__srv__query", "old-description")];
    const sink: { api?: ExtensionAPI } = {};
    const session = await makeSession(customTools, capturingExtension(sink));
    try {
      const updated = makeTool("mcp__srv__query", "new-description");
      customTools.length = 0;
      customTools.push(updated);
      sink.api!.registerTool(updated);
      expect(session.getToolDefinition("mcp__srv__query")?.description).toBe("new-description");
    } finally {
      await session.dispose();
    }
  });
});
