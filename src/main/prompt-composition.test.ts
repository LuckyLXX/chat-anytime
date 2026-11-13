import { describe, expect, it } from "vitest";
import { segmentPromptBlocks, type PromptBlockInput } from "./prompt-composition.js";

/**
 * preamble 分块（上下文中心）。这些用例钉住三件事：
 * 1. 切出来的是**真实冻结文本**（起点是标记、终点是下一块起点），不是重算文本；
 * 2. 缺失的块不影响前后块的边界，且明确报 present=false；
 * 3. 标记只在上一个边界之后检索——乱序或提前出现的同名字样不会被回头认领。
 */

function block(id: string, text: string, marker?: string): PromptBlockInput {
  return { id, label: id.toUpperCase(), origin: `${id} 来源`, text, ...(marker ? { marker } : {}) };
}

const PERSONA = "你是黑鱼河，PiDesktop 项目的更新维护者。只做源码改动，不重启宿主应用。";
const SKILLS = "以下 Skill 可用，需要时先用 read 工具读取对应 SKILL.md 再按其中说明执行：\n- /skill:电脑控制 — 操作桌面窗口";
const ORCH = "【工具编排】并行读多个文件时优先用 codemode。";
const OUT = "【输出格式】所有围栏都必须写语言标注。";
const SUB = "以下自定义子智能体是 delegate_agent 的唯一委派对象：\n- code-reviewer（amber）";
const MEM = "【长期记忆（memory_* 工具）】\n索引是存在性索引。";
const DIV = "【Div 气泡模式：输出优先级】\n最终回复必须是一页气泡。";

const FULL_INPUTS = [
  block("agent", PERSONA),
  block("skills", SKILLS, "以下 Skill 可用"),
  block("orchestration", ORCH, "【工具编排】"),
  block("output", OUT, "【输出格式】"),
  block("subagents", SUB, "以下自定义子智能体是 delegate_agent 的唯一委派对象"),
  block("memory", MEM, "【长期记忆"),
  block("div", DIV, "【Div 气泡模式：")
];

describe("segmentPromptBlocks", () => {
  it("按顺序切出全部块，块文本是真实拼接文本，首尾空白被收口", () => {
    const preamble = [PERSONA, SKILLS, ORCH, OUT, SUB, MEM, DIV].join("\n\n");
    const result = segmentPromptBlocks(preamble, FULL_INPUTS);
    expect(result.leading).toBeUndefined();
    expect(result.blocks.map((entry) => entry.present)).toEqual([true, true, true, true, true, true, true]);
    expect(result.blocks[0]!.text).toBe(PERSONA);
    expect(result.blocks[1]!.text).toBe(SKILLS);
    expect(result.blocks[2]!.text).toBe(ORCH);
    expect(result.blocks[6]!.text).toBe(DIV);
    expect(result.blocks.map((entry) => entry.id)).toEqual(["agent", "skills", "orchestration", "output", "subagents", "memory", "div"]);
    // 块文本长度与实际字符数一致（用于页面上的 token 估算）
    expect(result.blocks[3]!.chars).toBe(OUT.length);
  });

  it("缺失的块报 present=false，用当前配置的文本，但不改变相邻块边界", () => {
    // 本会话创建时记忆关闭、Div 关闭：preamble 里没有这两块。
    const preamble = [PERSONA, SKILLS, ORCH, OUT, SUB].join("\n\n");
    const result = segmentPromptBlocks(preamble, FULL_INPUTS);
    const byId = Object.fromEntries(result.blocks.map((entry) => [entry.id, entry]));
    expect(byId.memory!.present).toBe(false);
    expect(byId.memory!.text).toBe(MEM);
    expect(byId.div!.present).toBe(false);
    // 最后一个存在块（子智能体）一直延到文本结尾
    expect(byId.subagents!.text).toBe(SUB);
    // 不存在的块不占 chars（chars 是当前配置文本的长度，供“未注入”提示用）
    expect(byId.div!.chars).toBe(DIV.length);
  });

  it("空 preamble：所有块 present=false，且没有 leading", () => {
    const result = segmentPromptBlocks("", FULL_INPUTS);
    expect(result.leading).toBeUndefined();
    expect(result.blocks.every((entry) => entry.present)).toBe(false);
    expect(result.blocks.every((entry) => entry.text.length > 0)).toBe(true);
  });

  it("自定义基础提示词会在第一个块之前形成 leading", () => {
    const base = "BASE PROMPT FROM FILE";
    const preamble = [base, PERSONA, SKILLS].join("\n\n");
    const result = segmentPromptBlocks(preamble, FULL_INPUTS);
    expect(result.leading?.text.trim()).toBe(base);
    expect(result.blocks[0]!.present).toBe(true);
    expect(result.blocks[0]!.text).toBe(PERSONA);
  });

  it("助手人设被编辑过（标记不再逐字匹配）时只报这一块未命中，不误伤后面的块", () => {
    const edited = "你是黑鱼河，但这段人设在会话创建后被改过。";
    const preamble = [edited, SKILLS, ORCH].join("\n\n");
    const result = segmentPromptBlocks(preamble, FULL_INPUTS);
    const byId = Object.fromEntries(result.blocks.map((entry) => [entry.id, entry]));
    expect(byId.agent!.present).toBe(false);
    // 未命中的自由文本整体落到 leading，而不是被下一块吞掉
    expect(result.leading?.text.trim()).toBe(edited);
    expect(byId.skills!.present).toBe(true);
    expect(byId.skills!.text).toBe(SKILLS);
  });

  it("乱序出现的标记不会被回头认领（只从上一个边界之后找）", () => {
    // 输出格式块被误放在技能块之前：按固定顺序应先找技能，技能之后的检索
    // 才会看到输出格式，因此它命中在技能块之后的位置；技能块完整保留。
    const preamble = [OUT, PERSONA, SKILLS].join("\n\n");
    const result = segmentPromptBlocks(preamble, FULL_INPUTS);
    const byId = Object.fromEntries(result.blocks.map((entry) => [entry.id, entry]));
    // 助手人设的标记在 OUT 之后，命中；技能在后，命中；输出格式标记在两者之前，
    // 检索输出格式时从技能标记之后开始，找不到 → present=false。
    expect(byId.output!.present).toBe(false);
    expect(byId.agent!.present).toBe(true);
    expect(byId.skills!.present).toBe(true);
    // OUT 落在 leading（因为它在第一个命中块之前）
    expect(result.leading?.text).toContain("【输出格式】");
  });

  it("同一段文本里的同名字样只被第一个块认领一次", () => {
    const preamble = [PERSONA, SKILLS, ORCH, ORCH].join("\n\n");
    const result = segmentPromptBlocks(preamble, FULL_INPUTS);
    const byId = Object.fromEntries(result.blocks.map((entry) => [entry.id, entry]));
    // 工具编排块命中第一处；第二处属于它自己的正文（块文本延伸到结尾）
    expect(byId.orchestration!.present).toBe(true);
    expect(byId.orchestration!.text.match(/【工具编排】/gu)).toHaveLength(2);
    expect(byId.output!.present).toBe(false);
  });

  it("自由文本块没有显式标记时用前 80 字符定位", () => {
    const longPersona = "甲".repeat(120);
    const preamble = [longPersona, SKILLS].join("\n\n");
    const result = segmentPromptBlocks(preamble, [block("agent", longPersona), block("skills", SKILLS, "以下 Skill 可用")]);
    expect(result.blocks[0]!.present).toBe(true);
    expect(result.blocks[0]!.text).toBe(longPersona);
  });
});
