import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * MCP 状态通道的接线回归网（源码断言）。
 *
 * 2026-10-15 迁移时踩过的坑：`/mcp` 命令的 notify 出的是**会话绑定的**
 * uiContext（`mcpUiContext` → `handleMcpNotify`）；在调用处另造一个 ctx 去捕获
 * 是收不到消息的——面板会永远停在配置投影的 `not-connected`。解析必须落在
 * notify sink 里。
 */
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pi-runtime.ts"), "utf8");

function functionBody(name: string): string {
  const start = source.indexOf(name);
  expect(start, `找不到 ${name}（重命名了？此测试需要同步更新）`).toBeGreaterThan(-1);
  // 参数里可能有对象字面量（如 options: {...} = {}），所以先定位参数表的闭括号，
  // 再从它之后找函数体花括号（不能从第一个 `{` 开始，也不能依赖 `): void` 后缀
  // —— async 函数的签名是 `): Promise<void>`）。
  const closeParen = source.indexOf(")", source.indexOf("(", start));
  const bodyStart = source.indexOf("{", closeParen);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}") {
      depth--;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error(`${name} 的函数体没有闭合`);
}

describe("MCP 状态板解析接线", () => {
  it("解析落在 handleMcpNotify（会话绑定的 notify sink）里，并重推目录", () => {
    const body = functionBody("function handleMcpNotify(");
    expect(body).toContain("parseMcpStatusText(message)");
    expect(body).toContain("mcpParsedState.set(");
    expect(body).toContain("rebuildMcpSummariesFromConfig();");
    expect(body).toContain("emitResourceCatalog();");
  });

  it("refreshMcpCatalog 不再自造 uiContext 捕获 notify（那是个收不到消息的死路）", () => {
    const body = functionBody("async function refreshMcpCatalog(");
    expect(body).not.toContain("buildMcpUiContext");
    expect(body).not.toContain("notifies");
    expect(body).toContain('record.session.prompt("/mcp"');
  });

  it("会话绑定 uiContext 用的是 handleMcpNotify（而不是空实现）", () => {
    expect(source).toContain("const mcpUiContext = buildMcpUiContext({ onNotify: handleMcpNotify });");
    expect(source).toContain("uiContext: mcpUiContext,");
    expect(source).toContain('mode: "rpc",');
  });

  it("销毁路径先 unregisterAll 再 dispose（否则 stdio 子进程泄漏）", () => {
    const body = functionBody("function disposeRecord(");
    const unregisterAt = body.indexOf("record.mcpBridgeControl?.unregisterAll()");
    const disposeAt = body.indexOf("record.session.dispose()");
    expect(unregisterAt).toBeGreaterThan(-1);
    expect(disposeAt).toBeGreaterThan(-1);
    expect(unregisterAt).toBeLessThan(disposeAt);
  });

  it("命令层用会话自己的控制柄（不是会串会话的全局单例）", () => {
    expect(source).toContain("record.mcpBridgeControl.reapply(name)");
    expect(source).not.toContain("let mcpBridgeControl");
  });
});
