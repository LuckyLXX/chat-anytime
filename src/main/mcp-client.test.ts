import { describe, expect, it } from "vitest";
import { configHash, convertMcpResult, mcpToolName, toTypeBoxSchema } from "./mcp-client.js";

describe("mcp-client helpers", () => {
  it("names tools as mcp__<server>__<tool> with sanitized segments", () => {
    expect(mcpToolName("context7", "resolve-library-id")).toBe("mcp__context7__resolve-library-id");
    expect(mcpToolName("My Server!", "do it")).toBe("mcp__My_Server___do_it");
  });

  it("passes object input schemas through and falls back to empty object otherwise", () => {
    const objectSchema = toTypeBoxSchema({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
    expect(objectSchema).toMatchObject({ type: "object", properties: { q: { type: "string" } } });

    expect(toTypeBoxSchema({ type: "string" })).toMatchObject({ type: "object", properties: {} });
    expect(toTypeBoxSchema(undefined)).toMatchObject({ type: "object", properties: {} });
  });

  it("hashes config by value, ignoring env key order", () => {
    const a = configHash({ command: "npx", args: ["x"], env: { A: "1", B: "2" } });
    const b = configHash({ command: "npx", args: ["x"], env: { B: "2", A: "1" } });
    expect(a).toBe(b);
    expect(configHash({ command: "npx" })).not.toBe(configHash({ command: "node" }));
  });

  it("converts MCP callTool results into Pi AgentToolResult content", () => {
    const result = convertMcpResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "embedded", resource: { uri: "x" } }
      ]
    });
    expect(result.content).toEqual([
      { type: "text", text: "hello" },
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "text", text: expect.stringContaining("embedded") }
    ]);
    expect(result.details).toMatchObject({ content: expect.any(Array) });
  });

  it("flattens structuredContent and flags MCP errors", () => {
    const result = convertMcpResult({ isError: true, structuredContent: { ok: 1 } });
    expect(result.content[0]).toMatchObject({ type: "text", text: "MCP 工具返回 isError=true。" });
    expect(result.content.some((block) => block.type === "text" && block.text.includes("structuredContent"))).toBe(true);
  });

  it("emits a fallback text block when the result is empty", () => {
    const result = convertMcpResult({});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");
  });
});
