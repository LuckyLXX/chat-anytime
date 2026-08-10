import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolExecution } from "../../../shared/protocol";
import { changedFilesForMessage } from "./changed-files";

const message: ChatMessage = {
  id: "reply",
  role: "assistant",
  timestamp: 1,
  blocks: [
    { type: "tool-call", id: "edit-1", name: "edit", arguments: {} },
    { type: "tool-call", id: "write-1", name: "write", arguments: {} }
  ]
};

function execution(id: string, relativePath: string, status: ToolExecution["status"] = "completed"): ToolExecution {
  return { id, name: "edit", args: {}, status, startedAt: 1, changedFile: { relativePath } };
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

  it("does not attach files to user messages", () => {
    expect(changedFilesForMessage({ ...message, role: "user" }, [execution("edit-1", "src/App.tsx")])).toEqual([]);
  });
});
