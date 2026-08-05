import { describe, expect, it } from "vitest";
import { thinkingLevelLabels, toolLabel } from "./locale.js";

describe("简体中文界面文案", () => {
  it("为 Pi 思考级别提供中文名称", () => {
    expect(thinkingLevelLabels.off).toBe("关闭");
    expect(thinkingLevelLabels.medium).toBe("中");
    expect(thinkingLevelLabels.max).toBe("最高");
  });

  it("翻译内置工具名称并保留未知扩展工具名称", () => {
    expect(toolLabel("bash")).toBe("执行命令");
    expect(toolLabel("edit")).toBe("编辑文件");
    expect(toolLabel("custom_tool")).toBe("custom_tool");
  });
});
