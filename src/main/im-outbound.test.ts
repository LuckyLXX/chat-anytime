import { describe, expect, it } from "vitest";
import { IM_DIV_FALLBACK, toImMarkdown } from "./im-outbound.js";

/**
 * IM 出站整形（2026-11-12）：飞书卡片不渲染 HTML，Div 气泡必须在出站前压平。
 *
 * 这一层的失败是「静默的难看」：标签原样出现在手机上，但没有报错、没有状态码——
 * 所以逐条钉住「正文顺序、样式丢弃、列表/表格/代码块形状、纯文本零改动」。
 */

const bubble = (inner: string): string => `<assistant_html>\n<div>\n${inner}\n</div>\n</assistant_html>`;

describe("toImMarkdown", () => {
  it("纯 markdown 回复逐字节不变（零风险路径）", () => {
    const text = "## 结论\n\n- 全部通过\n- 用时 3s\n\n```bash\nnpm test\n```";
    expect(toImMarkdown(text)).toBe(text);
    expect(toImMarkdown("")).toBe("");
  });

  it("气泡压平成正文，标签一个不剩", () => {
    const result = toImMarkdown(bubble("<h2>验证结果</h2>\n<p>npm test <strong>全绿</strong></p>"));
    expect(result).toBe("验证结果\n\nnpm test 全绿");
    expect(result).not.toContain("<");
    expect(result).not.toContain("assistant_html");
  });

  it("style/script 整段丢弃（CSS 全文是最刺眼的部分）", () => {
    const result = toImMarkdown(bubble("<style>.a { color: #fff; }</style>\n<div>正文</div>\n<script>console.log(1)</script>"));
    expect(result).toBe("正文");
  });

  it("列表、换行、表格与代码块都换成手机端能读的形状", () => {
    const result = toImMarkdown(bubble([
      "<ul><li>第一项</li><li>第二项</li></ul>",
      "<table><tr><th>项</th><th>值</th></tr><tr><td>测试</td><td>3645</td></tr></table>",
      "<pre><code class=\"language-ts\">const a = 1 &lt; 2;</code></pre>"
    ].join("")));
    expect(result).toContain("- 第一项\n- 第二项");
    expect(result).toContain("项 | 值");
    expect(result).toContain("测试 | 3645");
    // 行尾不悬空
    expect(result).not.toMatch(/\|[ \t]*$/mu);
    // 代码块有围栏，转义字符被还原成文本
    expect(result).toContain("```\nconst a = 1 < 2;\n```");
  });

  it("只有样式没有正文时给一条可读兜底（不发空卡片）", () => {
    expect(toImMarkdown(bubble("<style>.a{}</style>"))).toBe(IM_DIV_FALLBACK);
    expect(toImMarkdown("<assistant_html><div></div></assistant_html>")).toBe(IM_DIV_FALLBACK);
  });

  it("大小写、属性与行尾空白变体同样处理，且不叠出连续空行", () => {
    const result = toImMarkdown("<ASSISTANT_HTML>\n<DIV class=\"card\" >\n\n\n<p>一段话</p>\n\n\n<p>另一段</p>\n</DIV>\n</ASSISTANT_HTML>");
    expect(result).toBe("一段话\n\n另一段");
  });

  it("气泡外的前后文字保留（模型多写了几句也不丢）", () => {
    const result = toImMarkdown(`先说一句：\n${bubble("<div>气泡正文</div>")}\n再补一句。`);
    expect(result).toContain("先说一句：");
    expect(result).toContain("气泡正文");
    expect(result).toContain("再补一句。");
  });
});
