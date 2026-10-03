import { describe, expect, it } from "vitest";
import { buildComputerTools, shouldActivateComputerTools } from "./runtime-computer.js";
import { estimateToolTokens } from "./context-breakdown.js";

/**
 * 工具激活判据的回归网。这个函数决定五个 computer_* 定义是否进入每请求前缀；
 * 两边都必须钉住：漏激活 = 开了电脑控制模式的会话用不了；误激活 = 每个普通会话
 * 白付 ≈580 tokens 的前缀成本（本功能存在的全部理由）。
 */
describe("shouldActivateComputerTools", () => {
  it("仅当会话开关与全局总闸同时打开时激活", () => {
    expect(shouldActivateComputerTools({ sessionEnabled: true, globalEnabled: true })).toBe(true);
  });

  it("普通会话不注入（核心收益：省下 ≈580 tokens/请求的前缀）", () => {
    expect(shouldActivateComputerTools({ sessionEnabled: false, globalEnabled: true })).toBe(false);
  });

  it("全局总闸关闭时任何会话都不注入（总闸 = 能力下架，优先于会话开关）", () => {
    expect(shouldActivateComputerTools({ sessionEnabled: true, globalEnabled: false })).toBe(false);
    expect(shouldActivateComputerTools({ sessionEnabled: false, globalEnabled: false })).toBe(false);
  });

  it("自动化后台会话（无对应状态文件 → sessionEnabled=false）默认不注入", () => {
    expect(shouldActivateComputerTools({ sessionEnabled: false, globalEnabled: true })).toBe(false);
  });
});

/**
 * 前缀成本的数字是这套判据的论据本身，所以钉在测试里：守卫的 promptSnippet/
 * description 一旦变重（例如把长尾操作教程写进 description），这条会先亮——
 * 「教模型」要落回执尾部（对话尾部），不是每请求的 tools 数组。
 */
describe("computer 工具前缀成本", () => {
  it("五个定义合计仍在 ~400–900 tokens 量级、绝没被写成教程", () => {
    const tools = buildComputerTools({ workspace: () => "/ws", enabled: () => true, locateScriptDir: () => "/skill-dir" });
    expect(tools.map((tool) => tool.name)).toEqual(["computer_windows", "computer_screenshot", "computer_click", "computer_type", "computer_press"]);
    const tokens = estimateToolTokens(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })));
    expect(tokens).toBeGreaterThan(300);
    expect(tokens).toBeLessThan(900);
  });
});
