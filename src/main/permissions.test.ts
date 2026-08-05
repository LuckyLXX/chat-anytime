import { describe, expect, it } from "vitest";
import { pathLeavesWorkspace, permissionScope, toolRisk } from "./permissions.js";

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
});
