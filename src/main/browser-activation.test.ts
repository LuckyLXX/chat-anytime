import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { shouldActivateBrowserTools, buildBrowserTools } from "./runtime-browser.js";
import { shouldActivateSshTools, buildSshTools } from "./runtime-ssh.js";
import { estimateToolTokens } from "./context-breakdown.js";

/**
 * 浏览器/SSH/MCP 角色级开关与总闸摘除的回归网（同 jev-activation 的理由：
 * `pi-runtime.ts` 是 utility 进程入口，单测无法 import；而这些接线一旦写错
 * 表现全是静默的——要么白付前缀成本，要么开关形同虚设）。
 *
 * 1. `toolNamesFor` 若不按总闸 + 角色 overlay 判断，总闸关了/角色禁了工具照样
 *    进每次请求的前缀（browser 16 个 ≈2.3K tokens，MCP 一台服务器动辄 2K+）；
 * 2. `settings.save` 若不遍历 liveSessions 重算，已开会话（含 parked 后台会话）
 *    要等重启才摘工具；
 * 3. MCP 过滤若手写 `mcp__` 模板串而不用 mcpToolName()，sanitize 规则漂移后
 *    键名对不上、禁用静默失效。
 */

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pi-runtime.ts"), "utf8");
const bridgeSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "mcp-bridge.ts"), "utf8");

function functionBody(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `找不到 ${signature}（重命名了？此测试需要同步更新）`).toBeGreaterThan(-1);
  const bodyStart = source.indexOf("{", start + signature.length);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error(`${signature} 的函数体没闭合`);
}

describe("shouldActivateBrowserTools / shouldActivateSshTools", () => {
  it("仅当全局总闸与角色 overlay 同时打开时激活", () => {
    expect(shouldActivateBrowserTools({ globalEnabled: true, agentEnabled: true })).toBe(true);
    expect(shouldActivateSshTools({ globalEnabled: true, agentEnabled: true })).toBe(true);
  });

  it("总闸关闭（能力下架）任何角色都不注入", () => {
    expect(shouldActivateBrowserTools({ globalEnabled: false, agentEnabled: true })).toBe(false);
    expect(shouldActivateSshTools({ globalEnabled: false, agentEnabled: true })).toBe(false);
  });

  it("角色禁用（toolOverrides 显式 false）时不注入——本功能的核心收益", () => {
    expect(shouldActivateBrowserTools({ globalEnabled: true, agentEnabled: false })).toBe(false);
    expect(shouldActivateSshTools({ globalEnabled: true, agentEnabled: false })).toBe(false);
    expect(shouldActivateBrowserTools({ globalEnabled: false, agentEnabled: false })).toBe(false);
  });
});

describe("toolNamesFor 的整族开关接线（源码回归网）", () => {
  it("browser/ssh 行按判据条件展开，不再无条件常驻", () => {
    const body = functionBody("function toolNamesFor(");
    expect(body).toContain("shouldActivateBrowserTools({ globalEnabled: settings?.browser?.enabled !== false, agentEnabled: record.agent.toolOverrides?.browser !== false })");
    expect(body).toContain("shouldActivateSshTools({ globalEnabled: settings?.ssh?.enabled !== false, agentEnabled: record.agent.toolOverrides?.ssh !== false })");
    expect(body).toContain("...(browserActive ? record.browserTools.map((tool) => tool.name) : [])");
    expect(body).toContain("...(sshActive ? record.sshTools.map((tool) => tool.name) : [])");
    // 旧的无条件展开必须消失（漂移回常驻 = 总闸摘除失效）。
    expect(body).not.toContain("...record.browserTools.map((tool) => tool.name),");
  });

  it("jev 工具叠加 browser 判据（它驱动的就是内置浏览器）", () => {
    expect(functionBody("function toolNamesFor(")).toContain("...(record.jevGlobalEnabled() && browserActive ? record.jevTools.map((tool) => tool.name) : [])");
  });

  it("MCP 行以「当前活动集」为源，注册表只用于校验 exposure（僵尸工具不回流）", () => {
    const body = functionBody("function toolNamesFor(");
    // 源：当前活动集
    expect(body).toContain("record.session.getActiveToolNames()");
    expect(body).toContain('name.startsWith("mcp__")');
    // 注册表只用于逐名校验 exposure：仍以 direct/model-only 声明的才保留。
    // （不能反过来「从 getAllTools 全量取」——那样会把 unregister 后留在注册表里的
    // 僵尸工具重新激活，也是「切换 exposure 后工具段越切越大」的入口。）
    expect(body).toContain('tool.exposure === "direct"');
    expect(body).not.toContain("getAllTools().map");
    // 旧的自建 customTools 路径必须消失（MCP 已迁 Pi 内置扩展）。
    expect(body).not.toContain("mcpTools.filter");
  });

  it("重新生成：navigateTree 之后必须按 toolNamesFor 归位（否则扩展工具被全量激活）", () => {
    const anchor = 'await regenerateSession.navigateTree(target.id);';
    const index = source.indexOf(anchor);
    expect(index).toBeGreaterThan(-1);
    // 紧随其后必须归位：上游 _restoreToolsFromTranscript 会把「转录里没提过」的
    // 扩展工具全部激活，不归位就是每次重新生成都白涨一批工具定义。
    expect(source.slice(index, index + 600)).toContain("reconcileActiveTools(record)");
  });

  it("角色 overlay 只在注册期决定 exposure（禁用→hidden，优先于配置的 codemode），不在活动集里重复过滤", () => {
    // 三态：禁用 > codemode > direct。disabled 必须排在最前，否则「停用」会被配置项绕过。
    expect(bridgeSource).toContain("deps.disabledServers().has(server.name)");
    expect(bridgeSource).toContain('? "hidden"');
    expect(bridgeSource).toContain('server.entry.exposure === "codemode"');
    expect(functionBody("function toolNamesFor(")).not.toContain("disabledMcp");
  });

  it("被禁服务器的工具以 hidden 暴露注册（零前缀成本兑底，见 mcp-bridge）", () => {
    expect(bridgeSource).toContain("deps.disabledServers().has(server.name)");
    expect(bridgeSource).toContain('? "hidden"');
  });

  it("注册集仍展开 browser/ssh（注册是激活的前提，摘除只摘活动集）", () => {
    expect(functionBody("function buildRecordTools(")).toContain("...record.browserTools");
    expect(functionBody("function buildRecordTools(")).toContain("...record.sshTools");
  });
});

describe("总闸翻转的实时生效（源码回归网）", () => {
  it("settings.save 里 browser/ssh 翻转遍历全部 live 会话重算（含 parked）", () => {
    expect(source).toContain("const browserSwitchChanged = (settings.browser?.enabled !== false) !== (command.settings.browser?.enabled !== false);");
    expect(source).toContain("const sshSwitchChanged = (settings.ssh?.enabled !== false) !== (command.settings.ssh?.enabled !== false);");
    expect(source).toContain("if (browserSwitchChanged || sshSwitchChanged) for (const record of liveSessions.values()) reconcileActiveTools(record);");
  });
});

/**
 * 前缀成本的数字是这套开关的论据本身（本次功能的动机：8.2K 里 browser ≈2.3K +
 * MCP ≈2.4K）：browser 工具族的 schema 一旦显著变重，说明有人把教程写进了
 * description——应该落工具结果尾部而不是每请求的 tools 数组。
 */
describe("browser/ssh 工具族前缀成本", () => {
  it("browser 整族仍在 ~1.5–3K tokens 量级（关掉的收益量级）", () => {
    const tools = buildBrowserTools({ request: async () => ({ ok: true }) as never, enabled: () => true });
    const tokens = estimateToolTokens(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
    expect(tokens).toBeGreaterThan(1500);
    expect(tokens).toBeLessThan(3000);
  });

  // 2026-10-14：先加 ssh_trust_fingerprint / ssh_host_save / ssh_host_delete（8 → 11，
  // 实测 968），同日再加 host_import / group_save / group_delete（11 → 14，实测 1329）。
  // 上界随之抬到 1.6K；描述仍只写「何时用 + 关键边界」，教程一律落首次回执。
  it("ssh 整族仍在 ~0.6–1.6K tokens 量级", () => {
    const tools = buildSshTools({ request: async () => ({ ok: true }) as never, enabled: () => true });
    const tokens = estimateToolTokens(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
    expect(tokens).toBeGreaterThan(600);
    expect(tokens).toBeLessThan(1600);
  });
});
