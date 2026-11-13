import type { ContextPromptBlock } from "../shared/protocol.js";

/**
 * 系统提示词 preamble 的「应用注入块」切分（上下文中心，2026-11-13）。
 *
 * 为什么需要它：Pi 的系统提示词以结构化 sections 保存，但本应用的
 * `systemPromptOverride` 把「助手人设 + 技能清单 + 工具编排 + 输出格式 + 子智能体 +
 * 记忆 + Div 规范」拼成一个 preamble 字符串交给 Pi——到了转录里就只剩一整段。
 * 上下文页要回答「这段话是谁注入的」，只能按构建器标记在这段真实文本里定位。
 *
 * 纪律：
 * - 只在**上一个边界之后**找下一个标记，标记乱序或缺失时跳过该块（绝不回头猜）；
 * - 切出来的是会话创建时**冻结的真实文本**，不是按当前配置重算的版本；
 * - 找不到标记的块 `present:false`（配置里有、本会话没注入），展示重算文本但由 UI
 *   明确标注，不冒充成模型看到的内容；
 * - 不做模糊匹配：标记变了就报未命中，让测试先红，而不是把正文切错。
 */

/** 每块的检索标记与展示文案。标记只用于定位，不参与展示。 */
export interface PromptBlockInput {
  id: string;
  label: string;
  /** 来源说明（构建器 / 开关来源），页面直接展示。 */
  origin: string;
  /** 该块在当前配置下会生成的文本（未注入时用于「当前配置」预览）。 */
  text: string;
  /**
   * 在 preamble 里定位该块开头的标记。缺省时用文本前 80 字符：
   * 助手人设是自由文本，没有稳定标题，只能靠开头匹配。
   */
  marker?: string;
}

export interface SegmentedPromptBlocks {
  blocks: ContextPromptBlock[];
  /** preamble 中第一个块之前的部分（通常为空；有自定义基础提示词时非空）。 */
  leading?: { chars: number; text: string };
}

/** 自由文本（助手人设）的标记长度：够长到不易误命中，短到正文小改仍能定位。 */
const FREE_TEXT_MARKER_CHARS = 80;

function markerOf(input: PromptBlockInput): string | undefined {
  const text = input.text;
  if (!text) return undefined;
  if (input.marker) return input.marker;
  return text.slice(0, FREE_TEXT_MARKER_CHARS);
}

/**
 * 按输入顺序切分 preamble。
 *
 * 每个命中块的文本范围 = 本块标记起点 → 下一个命中块起点（或文本结尾）。因此
 * 中间缺失的块不会影响前后块的完整文本——它本来就不在冻结提示词里。
 */
export function segmentPromptBlocks(preamble: string, inputs: readonly PromptBlockInput[]): SegmentedPromptBlocks {
  const source = preamble ?? "";
  interface Located {
    index: number;
    input: PromptBlockInput;
  }
  const located: Located[] = [];
  let cursor = 0;
  for (const input of inputs) {
    const marker = markerOf(input);
    if (!marker) continue;
    const index = source.indexOf(marker, cursor);
    if (index < 0) continue;
    located.push({ index, input });
    // 从标记之后继续找下一块：标记之间不可能重叠，且避免同一段文本被两块认领。
    cursor = index + marker.length;
  }

  const blocks: ContextPromptBlock[] = inputs.map((input) => {
    const hit = located.find((entry) => entry.input.id === input.id);
    if (!hit) {
      return {
        id: input.id,
        label: input.label,
        origin: input.origin,
        present: false,
        chars: input.text.length,
        text: input.text
      };
    }
    const next = located.find((entry) => entry.index > hit.index);
    const end = next ? next.index : source.length;
    const text = source.slice(hit.index, end).replace(/\s+$/u, "");
    return {
      id: input.id,
      label: input.label,
      origin: input.origin,
      present: true,
      chars: text.length,
      text
    };
  });

  const first = located[0];
  const leadingText = first ? source.slice(0, first.index) : source;
  const leading = leadingText.length > 0 ? { chars: leadingText.length, text: leadingText } : undefined;
  return { blocks, leading };
}
