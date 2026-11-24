import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Skill 详情按需读取的接线契约（源码断言型，2026-11-24）。
 *
 * `skill-inspect.test.ts` 只证明「读盘逻辑对」、`ResourceSettings.skill.test.tsx`
 * 只证明「拿到数据会画」。中间这条链路任何一环掉了都会静默失效（utility 的命令
 * switch 没有 default 分支：拼错的 case 会被无声吞掉）：
 * 协议 → utility 命令分支 → store 认领 → 设置页发起请求 → 样式存在。
 * 反向验证：删掉任意一处，对应用例转红。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

const protocol = read("src/shared/protocol.ts");
const runtime = read("src/main/pi-runtime.ts");
const store = read("src/renderer/src/store.ts");
const settingsPage = read("src/renderer/src/ResourceSettings.tsx");
const styles = read("src/renderer/src/styles.css");

/** 取分支体的粗略切片：从标记开始到指定长度，够做「里面有没有」断言。 */
function sliceFrom(source: string, marker: string, length = 900): string {
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`缺少标记：${marker}`);
  return source.slice(index, index + length);
}

describe("Skill 详情接线", () => {
  it("协议同时声明详情类型、命令与回推消息", () => {
    expect(protocol).toContain("export interface SkillDetail {");
    expect(protocol).toContain("export interface SkillFileEntry {");
    expect(protocol).toContain('{ type: "skill.inspect"; id: string }');
    expect(protocol).toContain('{ type: "skill-detail"; detail: SkillDetail }');
  });

  it("utility 只认目录里的 id（不接受任意路径），失败也走同一条推送", () => {
    const body = sliceFrom(runtime, 'case "skill.inspect":', 900);
    expect(body).toContain("nativeSkills.find((item) => item.id === command.id)");
    expect(body).toContain("inspectSkill(skill)");
    expect(body).toContain('type: "skill-detail"');
    expect(body).toContain("找不到该 Skill");
    expect(runtime).toContain('import { inspectSkill } from "./skill-inspect.js"');
  });

  it("store 按 id 归位回执，并提供重载前的清缓存入口", () => {
    const body = sliceFrom(store, 'case "skill-detail":', 320);
    expect(body).toContain("[message.detail.id]: message.detail");
    expect(store).toContain("skillDetails: {}");
    expect(store).toContain("export function clearSkillDetails(): void");
  });

  it("设置页发起按需读取，并同时提供预览/源码与附件清单", () => {
    expect(settingsPage).toContain('type: "skill.inspect"');
    expect(settingsPage).toContain("MarkdownPreviewContent");
    expect(settingsPage).toContain("skill-file-list");
    expect(settingsPage).toContain("stripFrontmatter");
    expect(settingsPage).toContain("clearSkillDetails()");
    // 左栏标题不再带 /skill: 前缀（调用名只在右栏概览的「调用」chip 里）
    expect(settingsPage).toContain("title={skill.name}");
    expect(settingsPage).not.toContain("title={`/skill:");
  });

  it("样式：三段式卡片、附件行与标题条开关都有规则", () => {
    for (const selector of [".skill-detail {", ".skill-meta > span", ".skill-view-switch", ".skill-file-list li", ".skill-rules", ".resource-switch input"]) {
      expect(styles).toContain(selector);
    }
  });
});
