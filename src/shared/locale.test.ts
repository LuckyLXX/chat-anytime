import { describe, expect, it } from "vitest";
import { extensionCalloutTitle, thinkingLevelLabels, toolLabel } from "./locale.js";

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

  it("为钩子上下文 callout 带上规则名，其余扩展消息保持原样", () => {
    expect(extensionCalloutTitle("pidesktop-hook-context", { rule: "git防火墙", event: "tool_call" })).toBe("钩子上下文 · git防火墙");
    expect(extensionCalloutTitle("pidesktop-hook-context", undefined)).toBe("钩子上下文");
    expect(extensionCalloutTitle("pidesktop-hook-context", { rule: "  " })).toBe("钩子上下文");
    expect(extensionCalloutTitle("some-other-extension", { rule: "x" })).toBe("some-other-extension");
    expect(extensionCalloutTitle(undefined, undefined)).toBe("扩展消息");
  });
});
