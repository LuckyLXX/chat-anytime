import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * gallery_publish 的「deferred 暴露 + tool_search 按需声明」回归网。
 *
 * （实验分支 feat/codemode-toolsearch，2026-10-02 起语义变更：原先的「无条件
 * 激活」改为偶发动作型工具的 deferred 暴露。）
 *
 * 为什么用源码断言而不是跑运行时：`pi-runtime.ts` 是 utility 进程入口（顶层
 * `process.parentPort` 缺失即抛），单测里无法 import；而 `toolNamesFor` /
 * `applyActiveToolNames` 是活动工具集的唯一计算处。本测试钉住三件事：
 *
 * 1. **注册不缺席**：gallery 工具仍进 customTools 注册集——deferred 工具若没
 *    注册，tool_search 永远搜不到（静默消失，无任何报错）；
 * 2. **不自动声明**：toolNamesFor 不含 gallery（前缀成本归零交给 deferred）；
 * 3. **已加载不丢失**：reconcile 全量重算时经 deferredSearchableToolNames 并集
 *    保留 tool_search 已加载的工具。
 *
 * 与 design 的对照仍是重点：design 依旧是条件分支激活（它的开关还牵着渲染端
 * 画布状态），gallery/computer/automation 走 deferred——两套语义并存，防止有人
 * 把两者统一成同一种写法而弄丢任一侧的保障。
 */

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pi-runtime.ts"), "utf8");
const gallerySource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "runtime-gallery.ts"), "utf8");

/** 取出 `toolNamesFor` 的函数体（从签名到下一个顶层 `}` 前的闭合花括号）。 */
function toolNamesForBody(): string {
  const start = source.indexOf("function toolNamesFor(");
  expect(start, "找不到 toolNamesFor（重命名了？此测试需要同步更新）").toBeGreaterThan(-1);
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

describe("toolNamesFor 的 gallery deferred 策略（源码回归网）", () => {
  const body = toolNamesForBody();

  it("gallery 工具不进自动声明的活动集（deferred：前缀成本交给 tool_search）", () => {
    expect(body).not.toContain("record.galleryTools.map");
    expect(body).not.toContain("record.automationTools.map");
    expect(body).not.toContain("record.computerTools.map");
  });

  it("gallery 仍在注册集里（注册是 deferred 工具可被搜索到的前提）", () => {
    const buildStart = source.indexOf("function buildRecordTools(");
    expect(buildStart).toBeGreaterThan(-1);
    const buildBody = source.slice(buildStart, source.indexOf("\n}", buildStart));
    expect(buildBody).toContain("...record.galleryTools");
    expect(buildBody).toContain("...record.computerTools");
    expect(buildBody).toContain("...record.automationTools");
  });

  it("gallery_publish 的定义标记了 deferred 暴露", () => {
    const nameIndex = gallerySource.indexOf('name: "gallery_publish"');
    expect(nameIndex).toBeGreaterThan(-1);
    // exposure 行紧随 name 行之后（5 行容差内）
    const window = gallerySource.slice(nameIndex, nameIndex + 120);
    expect(window).toContain('exposure: "deferred"');
  });

  it("reconcile 并集保留已加载的 deferred 工具（deferredSearchableToolNames 覆盖三簇）", () => {
    const helper = source.indexOf("function deferredSearchableToolNames(");
    expect(helper).toBeGreaterThan(-1);
    const helperBody = source.slice(helper, source.indexOf("\n}", helper));
    expect(helperBody).toContain("record.computerTools");
    expect(helperBody).toContain("record.automationTools");
    expect(helperBody).toContain("record.galleryTools");
    // 三个调用点都不得绕过 applyActiveToolNames 直呼 setActiveToolsByName(toolNamesFor(
    expect(source).not.toContain("setActiveToolsByName(toolNamesFor");
  });

  it("对照：design 仍然是条件分支（design 开关还牵着渲染端画布，不随本实验改）", () => {
    const line = body.split("\n").find((candidate) => candidate.includes("record.designTools.map"));
    expect(line).toBeDefined();
    expect(line!.trim().startsWith("?")).toBe(true);
    expect(body).toContain("shouldActivateDesignTools");
  });
});
