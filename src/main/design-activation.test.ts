import { describe, expect, it } from "vitest";
import { shouldActivateDesignTools } from "./runtime-design.js";

/**
 * 工具激活判据的回归网。这个函数决定 8 个 design_* 定义（≈1.5K tokens）是否
 * 进入每请求前缀，两边都必须钉住：漏激活 = 设计会话无法工作；误激活 = 非设计
 * 会话白付前缀成本。
 */
describe("shouldActivateDesignTools", () => {
  it("仅当会话开关与全局总闸同时打开时激活", () => {
    expect(shouldActivateDesignTools({ sessionEnabled: true, globalEnabled: true })).toBe(true);
  });

  it("非设计会话不注入（本功能的核心收益：普通编码会话省下 prefix）", () => {
    expect(shouldActivateDesignTools({ sessionEnabled: false, globalEnabled: true })).toBe(false);
  });

  it("全局总闸关闭时任何会话都不注入（总闸优先于会话开关）", () => {
    expect(shouldActivateDesignTools({ sessionEnabled: true, globalEnabled: false })).toBe(false);
    expect(shouldActivateDesignTools({ sessionEnabled: false, globalEnabled: false })).toBe(false);
  });

  it("自动化后台会话（无对应状态文件 → sessionEnabled=false）默认不注入", () => {
    // runAutomationTask 每次触发都是全新 session id，读盘即 false——
    // 这行断言把「定时任务拿不到 design_*」的取舍固定在测试里。
    expect(shouldActivateDesignTools({ sessionEnabled: false, globalEnabled: true })).toBe(false);
  });
});
