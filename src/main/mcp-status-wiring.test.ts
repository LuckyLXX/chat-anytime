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
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pi-runtime.ts"), "utf8").replace(/\r\n?/g, "\n");
const bridgeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "mcp-bridge.ts"), "utf8").replace(/\r\n?/g, "\n");

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

/**
 * 2026-10-23 修复「切 exposure 后面板工具 token 不变」的接线回归网。
 * 两个根因都是读源码很容易看错、错了却静默失效的：
 *  1. 控制柄在工厂期交付（那时 record 尚不存在）→ 被丢弃 → 热切换全部走空；
 *  2. 工具段从注册表 getAllTools() 过滤 → 不是 Pi 真正下发的声明（没经
 *     prepareLoadout 投影），且缓存键只有工具名 → 同名定义变化不失效。
 */
describe("MCP 热切换与工具估算接线", () => {
  it("控制柄在 session_start 交付（工厂期 record 尚不存在，早期交付会被丢弃）", () => {
    expect(bridgeSource).toContain('pi.on("session_start", () => {');
    expect(bridgeSource).toContain("deps.onApi?.(control);");
    // 工厂体内不得再直接交付（否则回到旧行为）
    const factoryBody = bridgeSource.slice(bridgeSource.indexOf("    factory(pi) {"));
    expect(factoryBody.indexOf("deps.onApi?.(control);")).toBeGreaterThan(factoryBody.indexOf('pi.on("session_start"'));
  });

  it("工具段以 session.state.tools（真实声明）为源，不再从 getAllTools 过滤", () => {
    const body = functionBody("function refreshContextBreakdown(");
    expect(body).toContain("session.state.tools.map");
    expect(body).not.toContain("getAllTools()");
    expect(body).toContain("contextBreakdown.cachedToolTokens(");
  });

  it("工具段缓存按声明指纹失效（不是工具名 join）", () => {
    const body = functionBody("function refreshContextBreakdown(");
    expect(body).not.toContain('names.join(",")');
    expect(source).toContain("toolTokensCache?: contextBreakdown.ToolTokensCache;");
  });

  it("固定延时猜测已删除：不再有 scheduleToolSetSettle", () => {
    expect(source).not.toContain("scheduleToolSetSettle");
    // 临时诊断（同步磁盘日志）一并清掉
    expect(source).not.toContain("dumpMcpDebug");
    expect(source).not.toContain("mcp-debug.log");
  });

  it("工具落地由 Pi 公开工具 API 的通知驱动（registerTool/setActiveTools）", () => {
    expect(bridgeSource).toContain("export function observeToolSetApi(");
    expect(bridgeSource).toContain('pi.registerTool(tool);');
    expect(bridgeSource).toContain('pi.setActiveTools(toolNames);');
    expect(source).toContain("onToolSetChange: scheduleToolSetRefresh");
  });

  it("通知消费前校验 record 仍在 liveSessions 且是同一实例（晚到通知不复活会话）", () => {
    const body = functionBody("const scheduleToolSetRefresh = (): void => {");
    expect(body).toContain("queueMicrotask");
    expect(body).toContain("liveSessions.get(record.session.sessionId) !== record");
    expect(body).toContain("applyToolSetChange(record)");
  });

  it("热重载监听用会话自己的工作区（不读别的会话的项目配置）", () => {
    const body = functionBody("function watchMcpConfigFiles(");
    expect(body).toContain("mcpConfigPaths(record.workspace)");
    // 桥接的配置路径同样按 recordWorkspace
    expect(source).toContain("configPaths: () => mcpConfigPaths(recordWorkspace),");
  });

  it("热重载/命令路径统一走 applyToolSetChange（归位 + 重算 + 推帧）", () => {
    const body = functionBody("function applyToolSetChange(");
    expect(body).toContain("toolNamesFor(record");
    expect(body).toContain("setActiveToolsByName(desired)");
    expect(body).toContain("refreshContextBreakdown(record)");
    expect(body).toContain("emitPaneStateFor(record)");
    expect(body).toContain("if (record === activeRuntime) emitState();");
    expect(functionBody("async function applyMcpToolChanges(")).toContain("applyToolSetChange(record)");
  });

  it("归位保留 Pi 的共享 resource 工具（不带 mcp__ 前缀，不在 toolNamesFor 的 MCP 分支内）", () => {
    expect(source).toContain('const PI_MCP_RESOURCE_TOOL_NAMES = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);');
    // 保留必须落在 toolNamesFor 本体：所有归位路径（模型切换、能力总闸、
    // regenerate、MCP 热更新）共用同一不变量。只写在 applyToolSetChange 里
    // 会让其它路径把 Pi 的合法活动项摘掉，而 Pi 不会自动补回。
    const body = functionBody("function toolNamesFor(");
    expect(body).toContain("PI_MCP_RESOURCE_TOOL_NAMES.has(name)");
  });

  it("会话就绪后显式兜底一次（初始化窗口的通知可能被 liveSessions 校验挡掉）", () => {
    const index = source.indexOf("liveSessions.set(result.session.sessionId, record);");
    expect(index).toBeGreaterThan(-1);
    expect(source.slice(index, index + 600)).toContain("applyToolSetChange(record)");
  });
});
