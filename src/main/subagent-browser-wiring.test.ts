import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { childBrowserToolsFor } from "./subagent.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * 「子智能体浏览器能力」的接线契约（源码断言型测试，2026-10-09）。
 *
 * 为什么必须是源码断言：这条链路的每个环节都跑不进 vitest（真实委派要起一个
 * 子 AgentSession + 主进程浏览器控制器），而**每一处漏接都是静默失效**：
 *  1. 协议加了 browserTools 字段、设置页有开关，但 runDelegation 不给
 *     createAgentSession 传 customTools → 定义开了浏览器、子代理却拿不到工具，
 *     无报错、无提示；
 *  2. 传了 customTools 但 setActiveToolsByName 不并入工具名 → 注册≠激活，
 *     工具永远不出现在子会话的请求前缀里，同样静默；
 *  3. pi-runtime 不提供 buildBrowserTools 构建器 → 定义声明被 childBrowserToolsFor
 *     静默降级为空数组（缺 builder = 能力不存在，行为与旧版完全一致）。
 * 同先例：subagent-thinking-wiring.test.ts、panel-wiring.test.ts。
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n/gu, "\n");

const runtime = read("pi-runtime.ts");
const subagent = read("subagent.ts");
const panel = read("../renderer/src/SubagentSettings.tsx");

describe("childBrowserToolsFor（纯函数）", () => {
  const fakeTool = (): ReturnType<typeof defineTool> => defineTool({
    name: "browser_navigate",
    label: "导航",
    description: "测试用",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} })
  });

  it("定义声明 + 构建器存在时返回工具族", () => {
    expect(childBrowserToolsFor({ browserTools: true }, () => [fakeTool()])).toHaveLength(1);
  });

  it("任一条件缺失都返回空数组（缺省定义、未接线、显式关闭）", () => {
    expect(childBrowserToolsFor({}, () => [fakeTool()])).toEqual([]);
    expect(childBrowserToolsFor({ browserTools: false }, () => [fakeTool()])).toEqual([]);
    expect(childBrowserToolsFor({ browserTools: true }, undefined)).toEqual([]);
    expect(childBrowserToolsFor({}, undefined)).toEqual([]);
  });
});

describe("子智能体浏览器能力的接线", () => {
  it("runDelegation 用 childBrowserToolsFor 决策，并把工具挂进子会话（注册 + 激活两处）", () => {
    expect(subagent).toMatch(/const childBrowserTools = childBrowserToolsFor\(subagentDef, ctx\.buildBrowserTools\);/u);
    // 注册：customTools 只在非空时传入（空数组保持与旧版字节行为一致）。
    expect(subagent).toMatch(/\.\.\.\(childBrowserTools\.length > 0 \? \{ customTools: childBrowserTools \} : \{\}\)/u);
    // 激活：原生工具 + 浏览器工具名合并进 setActiveToolsByName（注册≠激活，必须两处都有）。
    expect(subagent).toMatch(/child\.setActiveToolsByName\(\[\.\.\.enabledBuiltinTools, \.\.\.childBrowserTools\.map\(\(tool\) => tool\.name\)\]\)/u);
  });

  it("主进程侧提供构建器：sessionKey 用父会话、总闸实时读、截图/上传按父工作区", () => {
    expect(runtime).toMatch(/buildBrowserTools: \(\) => runtimeBrowser\.buildBrowserTools\(\{/u);
    expect(runtime).toMatch(/request: \(op\) => requestBrowserAutomation\(sessionId \?\? "", op\)/u);
    expect(runtime).toMatch(/enabled: \(\) => settings\?\.browser\?\.enabled !== false/u);
    expect(runtime).toMatch(/saveScreenshot: \(data, mimeType\) => saveBrowserScreenshot\(record\.workspace, data, mimeType\)/u);
  });

  it("设置页表单读得到 browserTools、保存时写回、有独立开关", () => {
    expect(panel).toMatch(/setBrowserTools\(subagent\.browserTools === true\)/u);
    expect(panel).toMatch(/\.\.\.\(browserTools \? \{ browserTools: true \} : \{\}\)/u);
    expect(panel).toMatch(/data-control="subagent-browser-tools"/u);
  });
});
