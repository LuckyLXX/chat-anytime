import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserAutomationRequest, BrowserAutomationResult } from "../shared/protocol.js";
import { buildBrowserTools, runWithBusyRetry, type BrowserToolDeps } from "./runtime-browser.js";

type OkResult = Extract<BrowserAutomationResult, { ok: true }>;

function okResult(data: OkResult["data"]): BrowserAutomationResult {
  return { ok: true, data };
}

/** Run a tool with the Pi 5-arg execute signature; our closures never read the trailing context args. */
const execute = (tool: { execute: (id: string, params: never, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }, params: unknown) =>
  tool.execute("test-call", params as never, undefined, undefined, undefined as unknown as ExtensionContext);

function toolsWith(responses: Record<string, BrowserAutomationResult>, enabled = true, saveScreenshot?: (data: string, mimeType: "image/png" | "image/jpeg") => Promise<string>) {
  const calls: BrowserAutomationRequest[] = [];
  const deps: BrowserToolDeps = {
    enabled: () => enabled,
    request: async (op) => {
      calls.push(op);
      const response = responses[op.op];
      if (!response) throw new Error(`没有为 ${op.op} 准备响应`);
      return response;
    },
    ...(saveScreenshot ? { saveScreenshot } : {})
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

  it("persists the screenshot and reports its path for text-only recognition", async () => {
    const saveScreenshot = vi.fn(async (_data: string, _mimeType: "image/png" | "image/jpeg") => ".pidesktop/screenshots/browser-20260902-101530-123.png");
    const { tools, calls } = toolsWith(
      { screenshot: okResult({ kind: "screenshot", data: "iVBORw0KGgo=", width: 800, height: 600, mimeType: "image/png" }) },
      true,
      saveScreenshot
    );
    const screenshot = tools.find((tool) => tool.name === "browser_screenshot")!;
    const result = await execute(screenshot, {}) as { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
    expect(calls[0]).toEqual({ op: "screenshot" });
    expect(saveScreenshot).toHaveBeenCalledWith("iVBORw0KGgo=", "image/png");
    expect(JSON.stringify(result.content)).toContain(".pidesktop/screenshots/browser-20260902-101530-123.png");
    expect(result.content.some((part) => part.type === "image")).toBe(true);
    expect(result.details.savedPath).toBe(".pidesktop/screenshots/browser-20260902-101530-123.png");
  });

  it("keeps the screenshot call alive when persisting fails", async () => {
    const saveScreenshot = vi.fn(async () => { throw new Error("disk full"); });
    const { tools } = toolsWith(
      { screenshot: okResult({ kind: "screenshot", data: "iVBORw0KGgo=", width: 800, height: 600, mimeType: "image/png" }) },
      true,
      saveScreenshot
    );
    const screenshot = tools.find((tool) => tool.name === "browser_screenshot")!;
    const result = await execute(screenshot, {}) as { content: Array<{ type: string }>; details: Record<string, unknown> };
    expect(result.content.some((part) => part.type === "image")).toBe(true);
    expect(result.details.savedPath).toBeUndefined();
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

describe("busy-tab retry", () => {
  const busy = { ok: false, error: "浏览器操作失败：该浏览器标签页正忙（另一个会话正在操作）" } as const;

  it("retries busy-tab failures with backoff and succeeds", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await runWithBusyRetry({ op: "get", what: "title" }, () => {
      calls += 1;
      return Promise.resolve(calls < 3 ? busy : okResult({ kind: "get", value: "标题" }));
    }, (ms) => {
      delays.push(ms);
      return Promise.resolve();
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(delays).toEqual([1500, 3000]);
  });

  it("gives up after the third retry and returns the busy error", async () => {
    let calls = 0;
    const result = await runWithBusyRetry({ op: "get", what: "title" }, () => {
      calls += 1;
      return Promise.resolve(busy);
    }, () => Promise.resolve());
    expect(result.ok).toBe(false);
    expect(calls).toBe(4); // 1 initial + 3 retries
  });

  it("returns non-busy failures immediately without retrying", async () => {
    let calls = 0;
    const result = await runWithBusyRetry({ op: "get", what: "title" }, () => {
      calls += 1;
      return Promise.resolve({ ok: false, error: "导航失败：连接超时" });
    }, () => Promise.resolve());
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("transparently retries through a browser tool", async () => {
    let calls = 0;
    const deps: BrowserToolDeps = {
      enabled: () => true,
      request: async () => {
        calls += 1;
        return calls === 1 ? busy : okResult({ kind: "get", value: "标题" });
      }
    };
    const tools = buildBrowserTools(deps);
    const get = tools.find((tool) => tool.name === "browser_get")!;
    const result = await execute(get, { what: "title" }) as { content: Array<{ text: string }> };
    expect(calls).toBe(2);
    expect(result.content[0]!.text).toContain("页面标题");
  });

  it("passes the record workspace along on navigate", async () => {
    const calls: BrowserAutomationRequest[] = [];
    const deps: BrowserToolDeps = {
      enabled: () => true,
      workspace: () => "D:\\工作区",
      request: async (op) => {
        calls.push(op);
        return okResult({ kind: "navigate", url: "https://example.com", title: "Example" });
      }
    };
    const tools = buildBrowserTools(deps);
    const navigate = tools.find((tool) => tool.name === "browser_navigate")!;
    await execute(navigate, { url: "https://example.com" });
    expect(calls[0]).toEqual({ op: "navigate", url: "https://example.com", workspace: "D:\\工作区" });
  });
});

/** 回执里的下载提示：取消路径必须给改道指引，落盘路径必须给可读的文件位置。 */
describe("browser download receipts", () => {
  const clickWith = (notices?: OkResult["notices"]) => {
    const result: BrowserAutomationResult = notices
      ? { ok: true, data: { kind: "click", description: "<button> 导出" }, notices }
      : { ok: true, data: { kind: "click", description: "<button> 导出" } };
    const { tools } = toolsWith({ click: result });
    return tools.find((tool) => tool.name === "browser_click")!;
  };
  const clickText = async (notices?: OkResult["notices"]) => {
    const result = await execute(clickWith(notices), { ref: "@e1" }) as { content: Array<{ text: string }> };
    return result.content[0]!.text;
  };

  it("keeps the receipt byte-identical when no download happened", async () => {
    const text = await clickText();
    expect(text).toBe("已点击 @e1：<button> 导出。提示：使用 @eN 引用元素；页面导航或内容变化后引用会失效，操作报错时请重新调用 browser_snapshot。");
  });

  it("tells the model the download was cancelled and how to reroute", async () => {
    const text = await clickText([{ kind: "download", filename: "a.csv", url: "https://example.com/export", saved: false }]);
    expect(text).toContain("该操作触发了下载（a.csv）");
    expect(text).toContain("已取消下载");
    // 关键：必须给出改道方式，否则模型只知道失败不知道怎么做。
    expect(text).toContain("browser_eval");
    expect(text).toContain(".pidesktop/downloads/");
  });

  it("reports the workspace-relative path and size of a saved download", async () => {
    const text = await clickText([{ kind: "download", filename: "a.csv", url: "u", saved: true, bytes: 2048, relativePath: ".pidesktop/downloads/a.csv" }]);
    expect(text).toContain("`.pidesktop/downloads/a.csv`");
    expect(text).toContain("2.0 KB");
    expect(text).toContain("read/bash");
  });

  it("names the cap when further downloads are refused", async () => {
    const text = await clickText([{ kind: "download", filename: "a.csv", url: "u", saved: false, reason: "limit", limitReached: true }]);
    expect(text).toContain("已达上限");
    expect(text).toContain("20");
  });

  it("points at 目录不可写 for a failed save", async () => {
    const text = await clickText([{ kind: "download", filename: "a.csv", url: "u", saved: false, reason: "prepare-failed" }]);
    expect(text).toContain("目录不可写");
    expect(text).toContain("browser_eval");
  });

  it("says a slow download is unfinished rather than failed", async () => {
    const text = await clickText([{ kind: "download", filename: "big.zip", url: "u", saved: false, reason: "interrupted", relativePath: ".pidesktop/downloads/big.zip" }]);
    expect(text).toContain("尚未落盘完成");
    expect(text).toContain("不要当成失败");
  });
});

/**
 * browser_eval 大结果回执：超限时三要素缺一不可——总量、完整路径（或明确说
 * 未能保存）、可行动作。未超限时必须逐字不变。
 */
describe("browser eval overflow receipts", () => {
  const evalWith = async (data: OkResult["data"], workspace?: string) => {
    const deps: BrowserToolDeps = {
      enabled: () => true,
      ...(workspace ? { workspace: () => workspace } : {}),
      request: async () => okResult(data)
    };
    const tools = buildBrowserTools(deps);
    const evalTool = tools.find((tool) => tool.name === "browser_eval")!;
    return await execute(evalTool, { expression: "rows", mode: "read" }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  };

  it("keeps a small result byte-identical", async () => {
    const result = await evalWith({ kind: "eval", value: "42" });
    expect(result.content[0]!.text).toBe("执行结果（read）：\n42");
  });

  it("names the total size, the path and both actions when the result was spilled", async () => {
    const result = await evalWith({ kind: "eval", value: "[{\"id\":1}…（已截断）", totalChars: 24000, savedPath: ".pidesktop/eval/eval-20260913-101500-001.json" });
    const text = result.content[0]!.text;
    expect(text).toContain("24000 字符");
    expect(text).toContain("`.pidesktop/eval/eval-20260913-101500-001.json`");
    expect(text).toContain("read 工具分段读取");
    expect(text).toContain("调整表达式只取需要的字段");
    expect(result.details.savedPath).toBe(".pidesktop/eval/eval-20260913-101500-001.json");
  });

  it("says the spill failed instead of inventing a path", async () => {
    const result = await evalWith({ kind: "eval", value: "xxx…（已截断）", totalChars: 24000 });
    const text = result.content[0]!.text;
    expect(text).toContain("24000 字符");
    expect(text).toContain("未能保存到工作区");
    expect(text).not.toContain(".pidesktop/eval");
    expect(result.details.savedPath).toBeUndefined();
  });

  it("carries the record workspace so the main process can spill", async () => {
    const calls: BrowserAutomationRequest[] = [];
    const deps: BrowserToolDeps = {
      enabled: () => true,
      workspace: () => "D:\工作区",
      request: async (op) => {
        calls.push(op);
        return okResult({ kind: "eval", value: "1" });
      }
    };
    const tools = buildBrowserTools(deps);
    const evalTool = tools.find((tool) => tool.name === "browser_eval")!;
    await execute(evalTool, { expression: "1", mode: "read" });
    expect(calls[0]).toEqual({ op: "eval", expression: "1", mode: "read", workspace: "D:\工作区" });
  });
});

/**
 * 页面弹窗回执：自动应答之后必须把「页面弹过什么」告诉模型，否则它会在错误
 * 假设上继续决策；失败回执也要带（弹窗是超时/报错的最常见原因）。
 */
describe("browser dialog receipts", () => {
  const clickWithDialogs = async (dialogs?: OkResult["dialogs"]) => {
    const result: BrowserAutomationResult = dialogs
      ? { ok: true, data: { kind: "click", description: "<button> 删除" }, dialogs }
      : { ok: true, data: { kind: "click", description: "<button> 删除" } };
    const { tools } = toolsWith({ click: result });
    const click = tools.find((tool) => tool.name === "browser_click")!;
    const executed = await execute(click, { ref: "@e1" }) as { content: Array<{ text: string }> };
    return executed.content[0]!.text;
  };

  it("keeps the receipt byte-identical when no dialog appeared", async () => {
    expect(await clickWithDialogs()).toBe("已点击 @e1：<button> 删除。提示：使用 @eN 引用元素；页面导航或内容变化后引用会失效，操作报错时请重新调用 browser_snapshot。");
  });

  it("reports the dialog message and that it was auto-accepted", async () => {
    const text = await clickWithDialogs([{ type: "confirm", message: "确定要删除吗？", accepted: true }]);
    expect(text).toContain("页面弹出了 confirm：「确定要删除吗？」");
    expect(text).toContain("已自动确认");
    expect(text).toContain("未阻塞操作");
  });

  it("labels beforeunload in words a model can act on", async () => {
    const text = await clickWithDialogs([{ type: "beforeunload", message: "", accepted: true }]);
    expect(text).toContain("离站确认（beforeunload）");
    // 没有 message 时不要渲染出一个空引号对。
    expect(text).not.toContain("：「」");
  });

  it("appends dialogs to a failed operation so the cause is visible", async () => {
    const result: BrowserAutomationResult = {
      ok: false,
      error: "浏览器操作超时（110 秒无响应）",
      dialogs: [{ type: "alert", message: "请稍候", accepted: true }]
    };
    const { tools } = toolsWith({ click: result });
    const click = tools.find((tool) => tool.name === "browser_click")!;
    await expect(execute(click, { ref: "@e1" })).rejects.toThrow(/页面弹出了 alert：「请稍候」/);
  });
});
