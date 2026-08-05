import { describe, expect, it } from "vitest";
import { workspaceRelativeAttachment } from "./attachments.js";

describe("attachment path validation", () => {
  it("returns stable workspace-relative paths", () => {
    expect(workspaceRelativeAttachment("C:/work/demo", "C:/work/demo/src/index.ts")).toBe("src/index.ts");
  });

  it("rejects paths outside the workspace", () => {
    expect(() => workspaceRelativeAttachment("C:/work/demo", "C:/work/other/file.ts")).toThrow();
  });

  it("rejects the workspace directory itself", () => {
    expect(() => workspaceRelativeAttachment("C:/work/demo", "C:/work/demo")).toThrow();
  });

  it("normalizes nested separators", () => {
    expect(workspaceRelativeAttachment("C:/work/demo", "C:/work/demo/src\\main.ts")).toBe("src/main.ts");
  });
});
