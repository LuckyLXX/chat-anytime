import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager, createAgentSession, defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Pins the Pi mechanic this feature relies on, against a REAL AgentSession:
 * a customTool registered at session creation but left OUT of the active set
 * can be activated later by setActiveToolsByName() without recreating the
 * session (and deactivated again). If this ever breaks, toggling design mode
 * would need a session rebuild and the whole "activate on demand" plan fails.
 */

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function makeTool(name: string): ToolDefinition {
  return defineTool({
    name,
    label: name,
    description: `desc-${name}`,
    promptSnippet: `snippet-${name}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} })
  });
}

async function makeSession(customTools: ToolDefinition[]) {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-design-activation-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.create(root, agentDir);
  const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const result = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, customTools });
  await result.session.bindExtensions({ onError: () => {} });
  return result.session;
}

describe("design tool activation (real AgentSession)", () => {
  it("a registered-but-inactive tool becomes active on demand, without a rebuild", async () => {
    const designTools = [makeTool("design_list"), makeTool("design_update")];
    const session = await makeSession([makeTool("bash_like"), ...designTools]);
    try {
      // 非设计会话：设计工具已注册（getAllTools 可见）但不在活动集里。
      session.setActiveToolsByName(["bash_like"]);
      expect(session.getActiveToolNames()).toEqual(["bash_like"]);
      expect(session.getAllTools().map((tool) => tool.name)).toContain("design_update");
      // 注册但不激活 ⇒ 工具定义不进工具数组（前缀里没有它的 schema）。
      expect(session.state.tools.map((tool) => tool.name)).toEqual(["bash_like"]);

      // 打开设计模式：同一会话、无重建，设计工具进活动集。
      session.setActiveToolsByName(["bash_like", "design_list", "design_update"]);
      expect(session.getActiveToolNames().sort()).toEqual(["bash_like", "design_list", "design_update"]);
      expect(session.state.tools.map((tool) => tool.name).sort()).toEqual(["bash_like", "design_list", "design_update"]);

      // 退出设计模式：同一会话再撤回。
      session.setActiveToolsByName(["bash_like"]);
      expect(session.state.tools.map((tool) => tool.name)).toEqual(["bash_like"]);
    } finally {
      await session.dispose();
    }
  });
});
