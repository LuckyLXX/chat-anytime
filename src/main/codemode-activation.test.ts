import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * codemode 接线（feat/codemode-toolsearch 分支最终保留部分）的源码回归网。
 *
 * codemode 上游「注册即不激活」：漏掉 extensionFactories 里的工厂、或漏掉
 * toolNamesFor 里的显式点名，模型就永远看不到它——没有任何报错，只是静默消失。
 * 与 gallery-activation / browser-activation 同类：utility 入口无法 import，只能
 * 钉源码结构。
 *
 * tool_search 与 deferred 暴露本批撤回（缓存 bust 代价与搜索可靠性等上游迭代），
 * 完整实现留在分支历史 5569137 / 2bcfe45，恢复时 cherry-pick + 还原本文件的
 * 对应断言即可。
 */

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pi-runtime.ts"), "utf8");

describe("codemode 接线（源码回归网）", () => {
  it("extensionFactories 里注册了 codemode 扩展工厂（且不再挂 tool_search）", () => {
    const factoriesStart = source.indexOf("extensionFactories: [");
    expect(factoriesStart).toBeGreaterThan(-1);
    const factoriesBody = source.slice(factoriesStart, source.indexOf("],", factoriesStart));
    expect(factoriesBody).toContain("createCodemodeExtension()");
    expect(factoriesBody).not.toContain("createToolSearchExtension");
  });

  it("toolNamesFor 显式点名 codemode（注册即不激活，必须点名）", () => {
    const start = source.indexOf("function toolNamesFor(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain('"codemode"');
    expect(body).not.toContain('"tool_search"');
  });

  it("系统提示词内置工具编排块（codemode 主动使用提示）并接入 systemPromptOverride", () => {
    const start = source.indexOf("const TOOL_ORCHESTRATION_PROMPT_BLOCK");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('].join("")', start));
    expect(block).toContain("codemode");
    expect(block).not.toContain("tool_search");
    const override = source.indexOf("systemPromptOverride:");
    expect(override).toBeGreaterThan(-1);
    expect(source.slice(override, override + 400)).toContain("TOOL_ORCHESTRATION_PROMPT_BLOCK");
  });
});
