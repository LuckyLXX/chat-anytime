// Jev（TypeSafe）通路的动态动作空间与响应校验（纯逻辑，无 Electron/Pi 依赖）。
//
// 设计取自 D:\开源仓库\jev-ultrafast 的 model.py：
// 一次观察 → 一张「元素索引表」；**一个元素只占一个索引**（即使它既能点又能输入）；
// 每个 operation 有**自己**的合法目标集合（`targets[operation][targetKey]`），
// 一次请求同时问出 operation 与各 operation 的目标，代码只消费被选中 operation 的
// 那一个 head。于是「操作 + 目标」两次决策 = 一次网络往返。
//
// 两条硬纪律（都是 jev 的既有取舍，不可放宽）：
// 1. 目标只能映射到**已观察到的元素**与受支持的操作；模型永不产出选择器、坐标或代码。
// 2. 响应必须通过 `validateChoice` 校验（编号集合一致、概率有限且归一、choice 为最大
//    概率项），否则**不执行任何动作**——宁可报错，也不拿一个可疑的决策去点页面。

import type { JevAction, JevObserveItem, JevObservePage } from "../shared/protocol.js";
import { NEXT_ACTION, TARGET } from "./jev-questions.js";

/** 受支持的操作。CLICK/TYPE_TEXT/SELECT 需要目标，其余是页面级控制。 */
export type JevOperation = "CLICK" | "TYPE_TEXT" | "SELECT" | "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" | "DONE" | "BLOCKED";

/** 一个已绑定到具体元素的目标。 */
export interface JevTargetInfo {
  nodeId: number;
  action: JevAction;
  /** 菜单里给模型看的文案（`[3] 搜索框`）。 */
  label: string;
  /** 元素当前值（模型据此避免重复填写）。 */
  currentValue: string;
  role: string;
  checked?: boolean | null;
  selected?: boolean | null;
  expanded?: boolean | null;
}

/** 送给 Jev 的元素表条目。 */
export interface JevElementEntry {
  index: string;
  label: string;
  role: string;
  value?: string;
  checked?: boolean | null;
  selected?: boolean | null;
  expanded?: boolean | null;
  operations: JevOperation[];
}

export interface JevActionSpace {
  elements: JevElementEntry[];
  /** operation → 该操作的说明（criteria 文案）。 */
  operations: Record<string, string>;
  /** operation → targetKey → 目标信息。 */
  targets: Record<string, Record<string, JevTargetInfo>>;
}

/** 一次决策的历史条目（只保留模型真正需要的事实）。 */
export interface JevHistoryEntry {
  action: string;
  kind: string;
  text?: string | null;
  page_changed?: boolean | null;
}

/** SELECT 目标键形状：`<元素索引>:<选项序号>`（jev 同款）。 */
export function selectTargetKey(index: number, option: number): string {
  return `${index}:${option}`;
}

const OPERATION_LABELS: Record<string, string> = {
  CLICK: "点击一个元素、按钮、菜单项、自动补全建议或日历日期。",
  TYPE_TEXT: "在可编辑字段里输入或替换文本（值由一个小模型按目标生成）。",
  SELECT: "选择一个已观察到的下拉选项。",
  WAIT: "等待页面更新（仅在所需控件缺失/禁用，或提交后的结果仍在加载时使用）。",
  DONE: "所有要求都已有可见证据地满足。",
  BLOCKED: "没有任何受支持的操作能继续推进。"
};

/** 可以点击的角色（其余角色只能通过各自的操作触达）。 */
const CLICKABLE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemradio", "option", "gridcell"
]);

/**
 * 一帧观察 → 动态动作空间。索引与 `page.items` 的次序一一对应（1 起，与回执里的 `[N]` 一致）。
 *
 * 被判定「被遮挡」的元素**不进目标集**：点了也会被执行阶段拒绝，给它一个目标等于
 * 白烧一次模型往返（jev 的 README 也把「遮挡的控件不硬点」列为设计要点）。
 */
export function buildActionSpace(page: JevObservePage): JevActionSpace {
  const elements: JevElementEntry[] = [];
  const targets: Record<string, Record<string, JevTargetInfo>> = {};

  page.items.forEach((item, position) => {
    const index = position + 1;
    const operations: JevOperation[] = [];
    const obstructed = Boolean(item.obstructedBy);
    if (!obstructed) {
      if (item.editable) {
        operations.push("TYPE_TEXT");
        group(targets, "TYPE_TEXT")[String(index)] = target(item, index, { kind: "fill" });
      }
      if (item.editable || CLICKABLE_ROLES.has(item.role) || item.role === "combobox") {
        operations.push("CLICK");
        group(targets, "CLICK")[String(index)] = target(item, index, { kind: "click" });
      }
      if (item.options && item.options.length > 0) {
        operations.push("SELECT");
        item.options.forEach((option, optionIndex) => {
          const key = selectTargetKey(index, optionIndex + 1);
          // 选项的 index 字段本身就是 `eN:k` 形状；这里只用序号，键由本模块统一生成，
          // 免得两处各写一套格式后漂移。
          group(targets, "SELECT")[String(key)] = {
            nodeId: item.nodeId,
            action: { kind: "select", optionIndex: optionIndex + 1 },
            label: `${labelOf(item)} → ${option.label || option.value}`,
            currentValue: item.value ?? "",
            role: item.role,
            checked: item.checked,
            selected: item.selected,
            expanded: item.expanded
          };
        });
      }
    }
    elements.push({
      index: String(index),
      label: labelOf(item),
      role: item.role,
      ...(item.value ? { value: item.value } : {}),
      ...(item.checked !== undefined ? { checked: item.checked } : {}),
      ...(item.selected !== undefined ? { selected: item.selected } : {}),
      ...(item.expanded !== undefined ? { expanded: item.expanded } : {}),
      operations
    });
  });

  const operations: Record<string, string> = {};
  for (const key of Object.keys(targets)) operations[key] = OPERATION_LABELS[key]!;
  operations.WAIT = OPERATION_LABELS.WAIT!;
  operations.DONE = OPERATION_LABELS.DONE!;
  operations.BLOCKED = OPERATION_LABELS.BLOCKED!;
  if (page.scroll.y > 0) operations.SCROLL_UP = "向上滚动页面以查看上方内容。";
  // canDown 由页面自己算（滚动位置 + 视口 + 文档高度），比在工具层重算可靠：
  // 重算需要 viewH，而缺 viewH 时会把「已在底部」误判成还能下滚。
  if (page.scroll.canDown === true) operations.SCROLL_DOWN = "向下滚动页面以查看下方内容。";
  return { elements, operations, targets };
}

function group(targets: Record<string, Record<string, JevTargetInfo>>, operation: JevOperation): Record<string, JevTargetInfo> {
  targets[operation] ??= {};
  return targets[operation]!;
}

function labelOf(item: JevObserveItem): string {
  return item.label || item.role;
}

function target(item: JevObserveItem, index: number, action: JevAction): JevTargetInfo {
  return {
    nodeId: item.nodeId,
    action,
    label: `[${index}] ${labelOf(item)}`,
    currentValue: item.value ?? "",
    role: item.role,
    checked: item.checked,
    selected: item.selected,
    expanded: item.expanded
  };
}

/**
 * TypeSafe 的单次请求体。`questions` 一次问出 operation 与每个 operation 的目标；
 * 状态用**同一帧**观察，让各问题共享同一份上下文（jev 的 speculative fan-out）。
 *
 * 历史只带最近 10 条：足够的「别重复」信息，且不会让每次请求的输入无界增长。
 */
export function buildJevRequest(
  goal: string,
  page: JevObservePage,
  space: JevActionSpace,
  history: JevHistoryEntry[]
): { state: unknown; questions: Record<string, unknown> } {
  const questions: Record<string, unknown> = {
    operation: {
      type: "choice",
      criteria: { ...space.operations },
      instructions: { goal, rules: NEXT_ACTION }
    }
  };
  for (const [operation, candidates] of Object.entries(space.targets)) {
    const criteria: Record<string, unknown> = {};
    for (const [key, info] of Object.entries(candidates)) {
      criteria[key] = {
        element: info.label,
        current_value: info.currentValue,
        role: info.role,
        ...(info.checked !== undefined && info.checked !== null ? { checked: info.checked } : {}),
        ...(info.selected !== undefined && info.selected !== null ? { selected: info.selected } : {}),
        ...(info.expanded !== undefined && info.expanded !== null ? { expanded: info.expanded } : {})
      };
    }
    questions[`${operation.toLowerCase()}_target`] = {
      type: "choice",
      criteria,
      instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] }
    };
  }
  return {
    state: {
      page: { url: page.url, title: page.title, text: page.pageText },
      elements: space.elements,
      recent_actions: history.slice(-10)
    },
    questions
  };
}

/** `validateChoice` 的形状要求（供调用方构造测试数据）。 */
export interface JevChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/**
 * 校验一个 Choice 响应。任何不符即抛错——**调用方必须让这个异常终止本次操作**，
 * 不能退化成「用一个概率为 0 的选项继续」。
 *
 * 逐条对齐 jev 的 `validate_choice`：choice ∈ ids、概率键集完全一致、数值有限且
 * 在 [0,1]、和 ≈ 1（±0.02）、choice 是最大概率项。
 */
export function validateChoice(answer: unknown, ids: string[]): JevChoiceAnswer {
  const candidate = answer as Partial<JevChoiceAnswer> | undefined;
  let valid = false;
  let probabilities: Record<string, number> = {};
  let choice = "";
  let confidence = 0;
  if (candidate && typeof candidate.choice === "string" && typeof candidate.confidence === "number" && candidate.probabilities && typeof candidate.probabilities === "object") {
    choice = candidate.choice;
    confidence = candidate.confidence;
    probabilities = candidate.probabilities as Record<string, number>;
    const numbers = [...Object.values(probabilities), confidence];
    const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
    valid =
      ids.includes(choice) &&
      sameKeys(probabilities, ids) &&
      numbers.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) &&
      Math.abs(sum - 1) < 0.02 &&
      (probabilities[choice] ?? -1) >= Math.max(...Object.values(probabilities)) - 1e-6;
  }
  if (!valid) throw new Error("TypeSafe 返回了无效的选择（编号不匹配/概率未归一），本次不执行任何动作。");
  return { choice, confidence, probabilities };
}

function sameKeys(record: Record<string, number>, ids: string[]): boolean {
  const keys = Object.keys(record);
  return keys.length === ids.length && ids.every((id) => Object.prototype.hasOwnProperty.call(record, id));
}

/** 一次决策的落地结果（工具层据此执行，或收尾）。 */
export interface JevDecision {
  operation: JevOperation;
  /** 需要目标的操作才有。 */
  target?: JevTargetInfo;
  /** 页面级控制操作的收尾标记。 */
  terminal?: "DONE" | "BLOCKED";
  scroll?: number;
  wait?: boolean;
  confidence: number;
  probabilities: Record<string, number>;
  operationProbabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
}

/**
 * 消费一次 TypeSafe 响应：校验 operation，**只**校验被选中 operation 对应的那个
 * target head（其余 head 的答案即使形状不对也不能影响执行——jev 的取舍）。
 */
export function resolveDecision(answers: unknown, space: JevActionSpace): JevDecision {
  const map = (answers ?? {}) as Record<string, unknown>;
  const operationIds = Object.keys(space.operations);
  const operationAnswer = validateChoice(map.operation, operationIds);
  const operation = operationAnswer.choice as JevOperation;
  const base = {
    operation,
    confidence: operationAnswer.confidence,
    probabilities: {},
    operationProbabilities: operationAnswer.probabilities,
    targetProbabilities: {}
  };
  const candidates = space.targets[operation];
  if (candidates) {
    const keys = Object.keys(candidates);
    if (keys.length === 0) throw new Error(`TypeSafe 选了 ${operation}，但当前页面没有可用的目标。`);
    // 概率按 nodeId 归并（jev 的 probabilities 以元素 id 为键，便于展示与调试）。
    const answer = validateChoice(map[`${operation.toLowerCase()}_target`], keys);
    const chosen = candidates[answer.choice]!;
    return {
      ...base,
      target: chosen,
      probabilities: { [String(chosen.nodeId)]: answer.probabilities[answer.choice]! },
      targetProbabilities: answer.probabilities
    };
  }
  if (operation === "SCROLL_UP" || operation === "SCROLL_DOWN") {
    return { ...base, scroll: operation === "SCROLL_DOWN" ? 1 : -1 };
  }
  if (operation === "WAIT") return { ...base, wait: true };
  if (operation === "DONE" || operation === "BLOCKED") return { ...base, terminal: operation };
  throw new Error(`TypeSafe 返回了不受支持的操作：${String(operation)}`);
}
