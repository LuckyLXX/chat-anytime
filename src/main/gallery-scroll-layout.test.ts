import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CSS Grid 的尺寸分配需要真实浏览器才能测试；happy-dom 不做布局。
 * 真实 Electron 复现：作品卡片 overflow:hidden 导致自动最小尺寸为 0，
 * 多行作品被等分压扁、滚动区高度等于内容高度，滚轮与滚动条均无行程。
 * 此处固定保证滚动的样式契约，真实窗口交互另做隔离冒烟验证。
 */
const styles = readFileSync(join(__dirname, "..", "renderer", "src", "styles.css"), "utf8");

function ruleBody(selector: string): string {
  const start = styles.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`找不到 CSS 规则：${selector}`);
  const open = styles.indexOf("{", start);
  const close = styles.indexOf("}", open);
  return styles.slice(open + 1, close);
}

describe("作品墙滚动布局", () => {
  it("卡片行按内容高度排列，容器而不是卡片承担溢出滚动", () => {
    const grid = ruleBody(".gallery-wall-grid");
    expect(grid).toMatch(/\bgrid-auto-rows\s*:\s*max-content\s*;/u);
    expect(grid).toMatch(/\balign-content\s*:\s*start\s*;/u);
    expect(grid).toMatch(/\boverflow\s*:\s*auto\s*;/u);
    // 卡片仍需裁剪封面边缘；不能靠移除裁剪掩盖被压扁的问题。
    expect(ruleBody(".gallery-card")).toMatch(/\boverflow\s*:\s*hidden\s*;/u);
    // 保留墙的高度约束，避免把首页滚动交还给聊天时间线的粘底逻辑。
    expect(ruleBody(".gallery-wall")).toMatch(/\bmax-height\s*:\s*100%\s*;/u);
  });
});
