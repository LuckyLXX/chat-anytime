import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * codemode + tool_search 实验接线（feat/codemode-toolsearch）的源码回归网。
 *
 * 两者上游均为「注册即不激活」的内建扩展：漏掉 extensionFactories 里的工厂、或
 * 漏掉 toolNamesFor 里的显式点名，模型就永远看不到它们——没有任何报错，只是
 * 静默消失。与 gallery-activation / browser-activation 同类：utility 入口无法
 * import，只能钉源码结构。
 */

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pi-runtime.ts"), "utf8");

describe("codemode / tool_search 接线（源码回归网）", () => {
  it("extensionFactories 里注册了两个内建扩展工厂", () => {
    const factoriesStart = source.indexOf("extensionFactories: [");
    expect(factoriesStart).toBeGreaterThan(-1);
    const factoriesBody = source.slice(factoriesStart, source.indexOf("],", factoriesStart));
    expect(factoriesBody).toContain("createCodemodeExtension()");
    expect(factoriesBody).toContain("createToolSearchExtension()");
  });

  it("toolNamesFor 显式点名 codemode 与 tool_search（注册即不激活，必须点名）", () => {
    const start = source.indexOf("function toolNamesFor(");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain('"codemode"');
    expect(body).toContain('"tool_search"');
  });

  it("三簇 deferred 工具的源文件都标记了 exposure", () => {
    for (const [file, marker] of [
      ["runtime-computer.ts", 'name: "computer_'],
      ["automation-tools.ts", 'name: "automation_'],
      ["runtime-gallery.ts", 'name: "gallery_']
    ] as const) {
      const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8");
      const names = [...text.matchAll(new RegExp(marker.replace("_", "_") + '[a-z_]+"', "gu"))];
      expect(names.length, `${file} 里没找到工具定义`).toBeGreaterThan(0);
      // 每个工具 name 行之后的 80 字符窗口内必须有 exposure: "deferred"
      for (const match of names) {
        const window = text.slice(match.index ?? 0, (match.index ?? 0) + match[0].length + 80);
        expect(window, `${file} 的 ${match[0]} 缺 exposure: "deferred"`).toContain('exposure: "deferred"');
      }
    }
  });

  it("活动集统一走 applyActiveToolNames（并集保留 tool_search 已加载工具）", () => {
    expect(source).toContain("function applyActiveToolNames(");
    const helper = source.slice(source.indexOf("function applyActiveToolNames("), source.indexOf("\n}", source.indexOf("function applyActiveToolNames(")));
    expect(helper).toContain("deferredSearchableToolNames");
    expect(helper).toContain("getActiveToolNames()");
    expect(source).not.toContain("setActiveToolsByName(toolNamesFor");
  });

  it("系统提示词内置工具编排块（codemode 主动使用 + deferred 恢复路径）并接入 systemPromptOverride", () => {
    const start = source.indexOf("const TOOL_ORCHESTRATION_PROMPT_BLOCK");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("].join(\"\")", start));
    expect(block).toContain("codemode");
    expect(block).toContain("tool_search");
    const override = source.indexOf("systemPromptOverride:");
    expect(override).toBeGreaterThan(-1);
    expect(source.slice(override, override + 400)).toContain("TOOL_ORCHESTRATION_PROMPT_BLOCK");
  });

  it("两个配套内置 skill 的入口教了 tool_search 恢复路径（实验分支配套改动）", () => {
    for (const slug of ["automation", "computer-use"]) {
      const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "resources", "skills", slug, "SKILL.md"), "utf8");
      expect(text, `${slug}/SKILL.md 应提到 tool_search`).toContain("tool_search");
    }
  });
});
