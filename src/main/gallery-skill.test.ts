import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 内置 skill「作品发布」（gallery-publish）的回归网。
 *
 * 为什么用源码断言而不是跑运行时：skill 是文档型资产（SKILL.md 不进编译、
 * 不进工具链），它的失效形态是**静默漂移**——关键边界句被改写/目录改名后
 * 没有任何报错，下次模型读到的就是缺了核心事实的版本；同时 gallery_publish
 * 工具描述里有一行指针指向这个 skill，skill 改名会让指针指向空气。这里钉三件事：
 *
 * 1. skill 文件存在、frontmatter 合法（name/description——系统提示里只挂这两行，
 *    description 丢了等于触发条件全失）；
 * 2. 正文必须保留三条硬边界（面板放宽 / 内置浏览器不放宽 / file 才考虑代理）——
 *    这是 2026-09-28 canvas 会话踩过的真实坑（模型在内置浏览器实测被 CORS 拦，
 *    为本可直连 panel 的作品自建了本地代理）；
 * 3. 工具描述的指针与 skill 目录名一致（同 gallery-activation.test.ts 的先例：
 *    源码断言防「顺手统一/改名」造成的静默断裂）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(here, "..", "..", "resources", "skills", "gallery-publish", "SKILL.md");
const skill = readFileSync(skillPath, "utf8");
const runtimeGallery = readFileSync(join(here, "runtime-gallery.ts"), "utf8");

describe("内置 skill gallery-publish", () => {
  it("frontmatter 合法：有 name 与 description（系统提示靠它触发）", () => {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(skill);
    expect(match, "SKILL.md 缺 frontmatter（--- 包裹的头）").toBeDefined();
    expect(match![1]).toMatch(/^name:\s*\S+/mu);
    expect(match![1]).toMatch(/^description:\s*\S+/mu);
    // description 是唯一常驻成本，也是触发条件：必须覆盖「做作品/发布」与「直连外部 API」两类场景。
    expect(match![1]).toMatch(/发布/u);
    expect(match![1]).toMatch(/外部\s*API/u);
  });

  it("正文保留三条跨域硬边界（canvas 会话踩坑的实体）", () => {
    // ① 面板有平台放宽，别写代理
    expect(skill).toContain("不要为面板作品写本地代理");
    // ② 内置浏览器是「正常浏览器」语义，不放宽是刻意设计
    expect(skill).toContain("「正常浏览器」语义");
    // ③ 只有 file（离线单文件）+ 无 CORS 接口才落到本地代理这条退路
    expect(skill).toContain("才写本地代理");
  });

  it("形态选择规则与验证口径在场（决策依据不可缺）", () => {
    expect(skill).toContain("首选 panel");
    // 验证口径：内置浏览器被拦 ≠ 运行时被拦
    expect(skill).toContain("不等于");
  });

  it("gallery_publish 工具描述的指针与 skill 目录名一致", () => {
    expect(runtimeGallery).toContain("先读 skill gallery-publish");
  });
});
