import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * gallery_publish 的「无条件激活」回归网。
 *
 * 为什么用源码断言而不是跑运行时：`pi-runtime.ts` 是 utility 进程入口（顶层
 * `process.parentPort` 缺失即抛），单测里无法 import；而 `toolNamesFor` 是
 * 活动工具集的唯一计算处，把 gallery 那一行删掉 / 改成条件分支，会让发布工具
 * 在所有会话里静默消失（模型再也不会发布作品，且没有任何报错）。
 *
 * 与 design/computer 的对照是本测试的重点：那两者**应当**是条件激活（前缀成本
 * 纪律），只有 gallery 是无条件——所以这里同时钉住「design 仍是条件分支」，
 * 防止有人顺手把两者统一成同一种写法。
 *
 * 同类先例：发布流程里的 asar 字节流内容断言（见 docs/迭代记录 的发版条目）。
 */

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pi-runtime.ts"), "utf8");

/** 取出 `toolNamesFor` 的函数体（从签名到下一个顶层 `}` 前的闭合花括号）。 */
function toolNamesForBody(): string {
  const start = source.indexOf("function toolNamesFor(");
  expect(start, "找不到 toolNamesFor（重命名了？此测试需要同步更新）").toBeGreaterThan(-1);
  // 从签名起点取到函数体的闭合：找签名后的第一个 `{`，再匹配到同缩进层级的 `}`。
  const bodyStart = source.indexOf("{", source.indexOf("): string[] {", start));
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error("toolNamesFor 函数体没闭合");
}

describe("toolNamesFor 的 gallery 激活策略（源码回归网）", () => {
  const body = toolNamesForBody();

  it("gallery 工具无条件进入活动集（1 个轻量定义，不设会话开关）", () => {
    expect(body).toContain("record.galleryTools.map((tool) => tool.name)");
  });

  it("gallery 那一行不在任何条件分支里（不是 ...(cond ? … : []) 的形状）", () => {
    const line = body.split("\n").find((candidate) => candidate.includes("record.galleryTools.map"));
    expect(line).toBeDefined();
    expect(line!.trim().startsWith("...(")).toBe(false);
    expect(line!).not.toContain("shouldActivate");
  });

  it("对照：design 仍然是条件分支（防止有人把两者统一成无条件）", () => {
    const line = body.split("\n").find((candidate) => candidate.includes("record.designTools.map"));
    expect(line).toBeDefined();
    // 条件三元的两半分别带 `?` / `:` 前缀；无条件展开则是裸 `...record.x`。
    expect(line!.trim().startsWith("?")).toBe(true);
    expect(body).toContain("shouldActivateDesignTools");
  });

  it("gallery 与 design 都在注册集里（注册 ≠ 激活：注册是激活的前提）", () => {
    const buildStart = source.indexOf("function buildRecordTools(");
    expect(buildStart).toBeGreaterThan(-1);
    const buildBody = source.slice(buildStart, source.indexOf("\n}", buildStart));
    expect(buildBody).toContain("...record.galleryTools");
    expect(buildBody).toContain("...record.designTools");
  });
});
