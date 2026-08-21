import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserAutomationRequest, BrowserAutomationResult } from "../shared/protocol.js";
import { buildBrowserTools, type BrowserToolDeps } from "./runtime-browser.js";

type OkResult = Extract<BrowserAutomationResult, { ok: true }>;

function okResult(data: OkResult["data"]): BrowserAutomationResult {
  return { ok: true, data };
}

/** Run a tool with the Pi 5-arg execute signature; our closures never read the trailing context args. */
const execute = (tool: { execute: (id: string, params: never, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }, params: unknown) =>
  tool.execute("test-call", params as never, undefined, undefined, undefined as unknown as ExtensionContext);

function toolsWith(responses: Record<string, BrowserAutomationResult>, enabled = true) {
  const calls: BrowserAutomationRequest[] = [];
  const deps: BrowserToolDeps = {
    enabled: () => enabled,
    request: async (op) => {
      calls.push(op);
      const response = responses[op.op];
      if (!response) throw new Error(`没有为 ${op.op} 准备响应`);
      return response;
    }
  };
  return { tools: buildBrowserTools(deps), calls };
}

const toolNames = ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_select", "browser_upload", "browser_press", "browser_scroll", "browser_eval", "browser_screenshot", "browser_screenshot_full", "browser_wait", "browser_get", "browser_tabs"];

describe("browser tool cluster", () => {
  it("registers the full browser_* tool set", () => {
    const { tools } = toolsWith({});
    expect(tools.map((tool) => tool.name).sort()).toEqual([...toolNames].sort());
  });

  it("reports the disabled state through every tool without a request", async () => {
    const { tools, calls } = toolsWith({}, false);
    const navigate = tools.find((tool) => tool.name === "browser_navigate")!;
    await expect(execute(navigate, { url: "https://example.com" })).rejects.toThrow(/停用/);
    expect(calls).toHaveLength(0);
  });

  it("navigates and reports the landing page", async () => {
    const { tools, calls } = toolsWith({
      navigate: okResult({ kind: "navigate", url: "https://example.com/", title: "Example" })
    });
    const navigate = tools.find((tool) => tool.name === "browser_navigate")!;
    const result = await execute(navigate, { url: " https://example.com " });
    expect(calls[0]).toEqual({ op: "navigate", url: "https://example.com" });
    expect(JSON.stringify(result)).toContain("https://example.com/");
  });

  it("rejects a navigate call without a url before any request", async () => {
    const { tools, calls } = toolsWith({});
    const navigate = tools.find((tool) => tool.name === "browser_navigate")!;
    await expect(execute(navigate, {})).rejects.toThrow(/URL/);
    expect(calls).toHaveLength(0);
  });

  it("passes snapshot text through to the model", async () => {
    const { tools } = toolsWith({
      snapshot: okResult({ kind: "snapshot", text: "@e1 <button> \"确定\"", refCount: 1, truncated: false })
    });
    const snapshot = tools.find((tool) => tool.name === "browser_snapshot")!;
    const result = await execute(snapshot, {});
    expect(JSON.stringify(result)).toContain("@e1");
  });

  it("defaults type mode to fill and keeps append", async () => {
    const { tools, calls } = toolsWith({
      type: okResult({ kind: "type", description: "<input>" })
    });
    const type = tools.find((tool) => tool.name === "browser_type")!;
    await execute(type, { ref: "@e2", text: "hello" });
    expect(calls[0]).toEqual({ op: "type", ref: "@e2", text: "hello", mode: "fill" });
    await execute(type, { ref: "@e2", text: "world", mode: "append" });
    expect(calls[1]).toEqual({ op: "type", ref: "@e2", text: "world", mode: "append" });
  });

  it("defaults eval mode to read and keeps write", async () => {
    const { tools, calls } = toolsWith({
      eval: okResult({ kind: "eval", value: "42" })
    });
    const evalTool = tools.find((tool) => tool.name === "browser_eval")!;
    await execute(evalTool, { expression: "document.title" });
    expect(calls[0]).toEqual({ op: "eval", expression: "document.title", mode: "read" });
    await execute(evalTool, { expression: "document.body.remove()", mode: "write" });
    expect(calls[1]).toEqual({ op: "eval", expression: "document.body.remove()", mode: "write" });
  });

  it("maps browser_wait parameters to wait conditions", async () => {
    const { tools, calls } = toolsWith({
      wait: okResult({ kind: "wait", description: "页面加载完成（网络空闲）" })
    });
    const wait = tools.find((tool) => tool.name === "browser_wait")!;
    await execute(wait, { what: "load" });
    expect(calls[0]).toEqual({ op: "wait", wait: { kind: "load", timeoutMs: 15000 } });
    await execute(wait, { what: "selector", value: "#result", timeoutMs: 5000 });
    expect(calls[1]).toEqual({ op: "wait", wait: { kind: "selector", selector: "#result", timeoutMs: 5000 } });
    await execute(wait, { what: "url", value: "**/dashboard" });
    expect(calls[2]).toEqual({ op: "wait", wait: { kind: "url", pattern: "**/dashboard", timeoutMs: 15000 } });
    await execute(wait, { what: "time", value: "2000" });
    expect(calls[3]).toEqual({ op: "wait", wait: { kind: "ms", ms: 2000 } });
  });

  it("rejects invalid wait parameters before any request", async () => {
    const { tools, calls } = toolsWith({});
    const wait = tools.find((tool) => tool.name === "browser_wait")!;
    await expect(execute(wait, { what: "selector" })).rejects.toThrow(/CSS 选择器/);
    await expect(execute(wait, { what: "time", value: "0" })).rejects.toThrow(/毫秒/);
    await expect(execute(wait, { what: "time", value: "abc" })).rejects.toThrow(/毫秒/);
    expect(calls).toHaveLength(0);
  });

  it("returns the screenshot as an image part for multimodal models", async () => {
    const { tools } = toolsWith({
      screenshot: okResult({ kind: "screenshot", data: "iVBORw0KGgo=", width: 800, height: 600, mimeType: "image/png" })
    });
    const screenshot = tools.find((tool) => tool.name === "browser_screenshot")!;
    const result = await execute(screenshot, {}) as { content: Array<{ type: string }> };
    expect(result.content.some((part) => part.type === "image")).toBe(true);
  });

  it("lists tabs with the bound tab marked", async () => {
    const { tools } = toolsWith({
      tabs: okResult({
        kind: "tabs",
        tabs: [
          { id: "default", url: "https://example.com", title: "Example", active: false },
          { id: "pi-browser-1", url: "", title: "新标签页", active: true }
        ]
      })
    });
    const tabs = tools.find((tool) => tool.name === "browser_tabs")!;
    const result = await execute(tabs, { action: "list" });
    expect(JSON.stringify(result)).toContain("当前绑定");
  });

  it("surfaces main-process errors as tool errors", async () => {
    const { tools } = toolsWith({
      click: { ok: false, error: "@e3 与快照不匹配（页面已变化）：请重新调用 browser_snapshot 后再操作" }
    });
    const click = tools.find((tool) => tool.name === "browser_click")!;
    await expect(execute(click, { ref: "@e3" })).rejects.toThrow(/browser_snapshot/);
  });
});
