import { describe, expect, it } from "vitest";
import { parsePiCliArgs } from "./pi-cli-host.js";

describe("Pi CLI compatibility arguments", () => {
  it("accepts the arguments emitted by the official subagent extension", () => {
    expect(parsePiCliArgs([
      "--mode", "json",
      "-p",
      "--session", "C:/tmp/subagent/session.jsonl",
      "--model", "claude-haiku-4-5",
      "--tools", "read,grep,find,bash",
      "--extension", "C:/extensions/subagent-prompt-runtime.ts",
      "--append-system-prompt", "C:/tmp/prompt.md",
      "Task: inspect the auth flow"
    ])).toEqual({
      mode: "json",
      sessionFile: "C:/tmp/subagent/session.jsonl",
      model: "claude-haiku-4-5",
      tools: ["read", "grep", "find", "bash"],
      extensions: ["C:/extensions/subagent-prompt-runtime.ts"],
      appendSystemPrompts: ["C:/tmp/prompt.md"],
      prompt: "Task: inspect the auth flow"
    });
  });

  it("rejects contradictory session persistence switches", () => {
    expect(() => parsePiCliArgs(["--no-session", "--session", "C:/tmp/session.jsonl", "task"])).toThrow("不能与");
  });

  it("rejects unsupported flags instead of silently changing semantics", () => {
    expect(() => parsePiCliArgs(["--mode", "json", "--interactive"])).toThrow("暂不支持");
  });

  it("accepts Pi's standard model and tool switches without enabling extensions", () => {
    expect(parsePiCliArgs([
      "--mode", "json",
      "--provider", "openai",
      "--model", "gpt-4o:high",
      "--thinking", "low",
      "-t", "read,grep",
      "-xt", "grep",
      "--append-system-prompt", "one",
      "--append-system-prompt", "two",
      "--no-extensions",
      "-p",
      "task"
    ])).toMatchObject({
      mode: "json",
      provider: "openai",
      model: "gpt-4o:high",
      thinking: "low",
      tools: ["read", "grep"],
      excludeTools: ["grep"],
      appendSystemPrompts: ["one", "two"],
      prompt: "task"
    });
  });
});
