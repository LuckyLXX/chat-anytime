import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolExecution } from "../../../shared/protocol";
import { artifactKindForPath, changedFilesForMessage } from "./changed-files";

const message: ChatMessage = {
  id: "reply",
  role: "assistant",
  timestamp: 1,
  blocks: [
    { type: "tool-call", id: "edit-1", name: "edit", arguments: {} },
    { type: "tool-call", id: "write-1", name: "write", arguments: {} },
    { type: "tool-call", id: "bash-1", name: "bash", arguments: {} }
  ]
};

function execution(id: string, relativePath: string, status: ToolExecution["status"] = "completed"): ToolExecution {
  return { id, name: "edit", args: {}, status, startedAt: 1, changedFile: { relativePath } };
}

function executionWithArtifacts(id: string, changedFiles: string[], status: ToolExecution["status"] = "completed"): ToolExecution {
  return { id, name: "bash", args: {}, status, startedAt: 1, changedFiles: changedFiles.map((relativePath) => ({ relativePath })) };
}

describe("reply changed files", () => {
  it("keeps only successful changed files called by the reply and removes duplicates", () => {
    expect(changedFilesForMessage(message, [
      execution("edit-1", "src/App.tsx"),
      execution("write-1", "src/app.tsx"),
      execution("other", "README.md"),
      execution("failed", "broken.ts", "error")
    ])).toMatchObject([{ relativePath: "src/app.tsx", execution: { id: "write-1" } }]);
  });

  it("collects multiple artifacts from changedFiles, image paths marked as image kind", () => {
    const result = changedFilesForMessage(message, [
      executionWithArtifacts("bash-1", ["outputs/fox.png", "docs/说明.md"])
    ]);
    expect(result).toMatchObject([
      { relativePath: "outputs/fox.png", kind: "image", execution: { id: "bash-1" } },
      { relativePath: "docs/说明.md", kind: "file", execution: { id: "bash-1" } }
    ]);
    expect(result[0]?.execution.changedFiles).toEqual([
      { relativePath: "outputs/fox.png" },
      { relativePath: "docs/说明.md" }
    ]);
  });

  it("falls back to the single changedFile when changedFiles is absent", () => {
    expect(changedFilesForMessage(message, [execution("edit-1", "src/App.tsx")])).toMatchObject([
      { relativePath: "src/App.tsx", kind: "file" }
    ]);
  });

  it("classifies image extensions as image kind", () => {
    expect(artifactKindForPath("a/b/photo.PNG")).toBe("image");
    expect(artifactKindForPath("a/b/diagram.svg")).toBe("image");
    expect(artifactKindForPath("a/b/README.md")).toBe("file");
  });

  it("does not attach files to user messages", () => {
    expect(changedFilesForMessage({ ...message, role: "user" }, [execution("edit-1", "src/App.tsx")])).toEqual([]);
  });
});
