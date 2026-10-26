import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 输出格式提示块的源码回归网。
 *
 * 2026-10-23 用户报「代码块全是 TEXT」：统计本机会话里 assistant 写的围栏，
 * 无语言标注 928 次、带标注约 350 次——渲染端只对**已知语言**着色，所以根因是
 * 模型不写标注。渲染端已做兜底（lib/code-language.ts），这个静态提示块是根因修复：
 * 少一句、或被拼进 `${}` 动态内容，都会静默失效（前者模型继续不标注，后者破坏
 * 系统提示词前缀缓存）。utility 入口无法 import，只能钉源码结构。
 */

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pi-runtime.ts"), "utf8");

describe("输出格式提示块（源码回归网）", () => {
  it("要求所有围栏带语言标注，并给出 text / bash 的口径", () => {
    const start = source.indexOf("const OUTPUT_FORMAT_PROMPT_BLOCK");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('].join("")', start));
    expect(block).toContain("围栏");
    expect(block).toContain("语言标注");
    expect(block).toContain("纯文本");
    // 模型最容易漏的两类：命令输出与测试结果
    expect(block).toContain("bash");
    expect(block).toContain("text");
    // 气泡内的代码写法（与 div-prompt 的类名契约一致）
    expect(block).toContain("language-语言");
  });

  it("是静态常量（不含插值），系统提示词前缀缓存因此逐字节稳定", () => {
    const start = source.indexOf("const OUTPUT_FORMAT_PROMPT_BLOCK");
    const block = source.slice(start, source.indexOf('].join("")', start));
    expect(block).not.toContain("${");
    // 每一句都要付费：块体积钉住，后续改动不会静默膨胀
    expect(block.length).toBeLessThanOrEqual(400);
  });

  it("接入了 systemPromptOverride", () => {
    const override = source.indexOf("systemPromptOverride:");
    expect(override).toBeGreaterThan(-1);
    expect(source.slice(override, override + 500)).toContain("OUTPUT_FORMAT_PROMPT_BLOCK");
  });
});
