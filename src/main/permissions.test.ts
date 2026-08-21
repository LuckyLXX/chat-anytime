import { describe, expect, it } from "vitest";
import { pathLeavesWorkspace, permissionAction, permissionNeedsApproval, permissionScope, toolRisk } from "./permissions.js";

describe("desktop tool permissions", () => {
  const workspace = "D:\\projects\\sample";

  it("allows read-only paths inside the selected workspace", () => {
    expect(pathLeavesWorkspace(workspace, "src/index.ts")).toBe(false);
    expect(toolRisk(workspace, "read", { path: "src/index.ts" })).toBeUndefined();
  });

  it("requires approval for paths outside the selected workspace", () => {
    expect(pathLeavesWorkspace(workspace, "..\\secrets.txt")).toBe(true);
    expect(toolRisk(workspace, "read", { path: "..\\secrets.txt" })).toBe("outside-workspace");
  });

  it("separates ordinary write approval from outside-workspace approval", () => {
    const writeScope = permissionScope("write", toolRisk(workspace, "write", { path: "src/new.ts" })!);
    const outsideScope = permissionScope("write", toolRisk(workspace, "write", { path: "..\\new.ts" })!);
    expect(writeScope).toBe("write:write");
    expect(outsideScope).toBe("write:outside-workspace");
    expect(writeScope).not.toBe(outsideScope);
  });

  it("requires approval for every command scope", () => {
    expect(toolRisk(workspace, "bash", { command: "npm test" })).toBe("command");
  });

  it("keeps the default mode asking for every risky operation", () => {
    expect(permissionNeedsApproval("ask", "bash", "command")).toBe(true);
    expect(permissionNeedsApproval("ask", "write", "write")).toBe(true);
    expect(permissionNeedsApproval("ask", "read", "outside-workspace")).toBe(true);
  });

  it("automatically allows workspace file writes but still asks for commands and outside paths", () => {
    expect(permissionAction("workspace", "write", "write")).toBe("allow");
    expect(permissionAction("workspace", "bash", "command")).toBe("ask");
    expect(permissionAction("workspace", "read", "outside-workspace")).toBe("ask");
  });

  it("blocks mutating tools in read-only mode", () => {
    expect(permissionAction("read-only", "write", "write")).toBe("deny");
    expect(permissionAction("read-only", "edit", "write")).toBe("deny");
    expect(permissionAction("read-only", "bash", "command")).toBe("deny");
    expect(permissionAction("read-only", "read", "outside-workspace")).toBe("ask");
  });

  it("does not request approval in full access mode", () => {
    expect(permissionNeedsApproval("full", "bash", "command")).toBe(false);
    expect(permissionNeedsApproval("full", "write", "write")).toBe(false);
    expect(permissionNeedsApproval("full", "read", "outside-workspace")).toBe(false);
  });

  it("treats MCP calls as command-risk operations", () => {
    expect(toolRisk(workspace, "mcp", { tool: "search" })).toBe("command");
    expect(toolRisk(workspace, "server_docs_search", {})).toBe("command");
    expect(permissionAction("read-only", "mcp", "command")).toBe("deny");
    expect(permissionNeedsApproval("ask", "mcp", "command")).toBe(true);
  });

  it("gates browser navigation through the browse risk", () => {
    expect(toolRisk(workspace, "browser_navigate", { url: "https://example.com" })).toBe("browse");
    expect(toolRisk(workspace, "browser_snapshot", {})).toBeUndefined();
    expect(toolRisk(workspace, "browser_click", { ref: "@e1" })).toBeUndefined();
    expect(permissionAction("ask", "browser_navigate", "browse")).toBe("ask");
    expect(permissionAction("read-only", "browser_navigate", "browse")).toBe("deny");
    expect(permissionAction("full", "browser_navigate", "browse")).toBe("allow");
    // 工作区模式不覆盖网络动作：仍需询问。
    expect(permissionAction("workspace", "browser_navigate", "browse")).toBe("ask");
  });

  it("gates write-mode browser eval but lets read-mode eval through", () => {
    expect(toolRisk(workspace, "browser_eval", { expression: "document.title", mode: "read" })).toBeUndefined();
    expect(toolRisk(workspace, "browser_eval", { expression: "document.body.remove()", mode: "write" })).toBe("browse");
    expect(permissionAction("read-only", "browser_eval", "browse")).toBe("deny");
    expect(permissionNeedsApproval("ask", "browser_eval", "browse")).toBe(true);
  });
});
