import type { ThinkingLevel, ThinkingLevelMap } from "./protocol.js";

/**
 * 思考等级能力的单一真源（主进程与渲染端共用）。
 *
 * 背景（2026-09-16 用户反馈「模型不支持对应思考等级时切不过去」）：Pi 的
 * `getSupportedThinkingLevels(model)` 只在模型**显式声明** `thinkingLevelMap`
 * 时才放行 `xhigh`/`max`，未声明就只能到 `high`；而 PiDesktop 注册的自定义/
 * 中转服务商模型从不声明该映射，于是「很高/最高」在中转站模型上永远选不到，
 * 而这类模型（qwen3.8-27b 等）恰恰只认 `xhigh`——菜单点了没反应（会话内被
 * 静默 clamp 回 high），随后请求带着 `reasoning_effort=high` 打出去被上游
 * 400 拒。修法：把这件事变成用户可声明的设置项，并让菜单如实反映能力。
 *
 * 本模块与 Pi 的口径逐条对齐（改这里前先读 node_modules 的 models.js）：
 * - `reasoning === false` → 只支持 `["off"]`（Pi 原话：非推理模型只给 off）；
 * - 未声明 `xhigh`/`max` 键 → 这两档不可用（`mapped !== undefined` 才放行）；
 * - 声明为 `null` → 该档位不可用；声明为字符串 → 可用，且该字符串就是发给
 *   上游的取值。
 */

/** 七档固定顺序（UI 与 clamp 的方向都以它为准）。 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 「跟随运行时缺省」的映射（Pi 的未声明口径）：推理模型关闭…高可用、很高/最高
 * 不可用（缺键即不可用）；非推理模型只留关闭。
 *
 * 注意语义：`null` = 显式声明「不支持」，**缺键**才由本函数说话——低档位缺键算
 * 支持、xhigh/max 缺键算不支持（与 Pi 的 getSupportedThinkingLevels 逐行对齐）。
 */
export function defaultThinkingLevelMapFor(reasoning: boolean | undefined): ThinkingLevelMap {
  if (reasoning === false) return { minimal: null, low: null, medium: null, high: null, xhigh: null, max: null };
  return {};
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * 规范化一份思考等级映射：只保留合法档位键，取值只接受非空字符串或 `null`
 * （空串/数字等非法值丢弃 = 该档位回到未声明状态）。无有效键时返回 undefined。
 */
export function normalizeThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const entries = Object.entries(source).filter(([level, mapped]) => isThinkingLevel(level) && (mapped === null || (typeof mapped === "string" && mapped.trim().length > 0)));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([level, mapped]) => [level, mapped === null ? null : String(mapped).trim()])) as ThinkingLevelMap;
}

/**
 * 该模型实际可选的思考等级（档位顺序同 THINKING_LEVELS）。
 *
 * `explicit` = 用户或目录声明的映射；缺省时按 Pi 的未声明口径推导。
 */
export function supportedThinkingLevels(explicit: ThinkingLevelMap | undefined, reasoning?: boolean): ThinkingLevel[] {
  const map = explicit ?? defaultThinkingLevelMapFor(reasoning);
  return THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * 档位 → 发给上游的取值：命中映射用映射值，未命中的档位用同名取值（与 Pi 的
 * `model.thinkingLevelMap?.[level] ?? level` 同口径）。
 */
export function upstreamThinkingValue(explicit: ThinkingLevelMap | undefined, level: ThinkingLevel): string | undefined {
  if (explicit?.[level] === null) return undefined;
  const mapped = explicit?.[level];
  return typeof mapped === "string" ? mapped : level;
}

/**
 * Pi `clampThinkingLevel` 的等价实现：请求档位不可用时，先向上找、再向下找
 * 最近的可选档位。菜单置灰靠的就是「可选项之外的档位会被降级到哪一档」。
 */
export function clampThinkingLevel(available: readonly ThinkingLevel[], requested: ThinkingLevel): ThinkingLevel {
  if (available.includes(requested)) return requested;
  const requestedIndex = THINKING_LEVELS.indexOf(requested);
  if (requestedIndex === -1) return available[0] ?? "off";
  for (let i = requestedIndex; i < THINKING_LEVELS.length; i += 1) {
    const level = THINKING_LEVELS[i]!;
    if (available.includes(level)) return level;
  }
  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    const level = THINKING_LEVELS[i]!;
    if (available.includes(level)) return level;
  }
  return available[0] ?? "off";
}

/** 思考菜单渲染项：7 档全列出，不支持的置灰并可说明原因（用户 2026-09-16 选定口径）。 */
export interface ThinkingLevelOption {
  level: ThinkingLevel;
  supported: boolean;
  /** 不支持时，请求该档位会被降级到哪一档；null = 该模型没有可选档位。 */
  fallback?: ThinkingLevel | null;
}

/**
 * 生成思考等级菜单：固定 7 行，「支持与否」由模型声明推导（与 Pi 同口径），
 * 不支持的档位带降级目标供 UI 提示。
 */
export function thinkingLevelMenu(explicit: ThinkingLevelMap | undefined, reasoning?: boolean): ThinkingLevelOption[] {
  const available = supportedThinkingLevels(explicit, reasoning);
  return THINKING_LEVELS.map((level) => available.includes(level)
    ? { level, supported: true }
    : { level, supported: false, fallback: available.length > 0 ? clampThinkingLevel(available, level) : null });
}

/**
 * 思考菜单的便捷入口：模型未选中（落地页/尚未落位）时按运行时缺省口径生成。
 */
export function thinkingLevelMenuFor(model: { thinkingLevelMap?: ThinkingLevelMap; reasoning?: boolean } | undefined): ThinkingLevelOption[] {
  return thinkingLevelMenu(model?.thinkingLevelMap, model?.reasoning);
}

/**
 * 把设置里的「档位白名单」应用到某模型的支持集合：两者取交集；白名单未配置
 * （undefined）时保持原集合。
 *
 * 用在设置页「思考等级」编辑器的「按上游取值生成默认勾选」下面：模型能力描述
 * 「上游认哪些取值」，而用户还需要表达偏好——某类中转站只吃 `low/medium/high`
 * 时，把菜单收敛到这三档比每次手动避开可用得多。交集保证菜单里出现的档位既在
 * 上游能力内、也在用户白名单内。
 */
export function narrowThinkingLevelsByAllowList(available: readonly ThinkingLevel[], allowList: readonly ThinkingLevel[] | undefined): ThinkingLevel[] {
  if (!allowList || allowList.length === 0) return [...available];
  const allowed = new Set(allowList);
  const narrowed = available.filter((level) => allowed.has(level));
  // 交集为空时保留原集合：宁可展示「上游支持但用户没勾」的档位，也不给空菜单
  //（空菜单 = 切不了思考等级，比放宽白名单更糟）。
  return narrowed.length > 0 ? narrowed : [...available];
}

/** 规范化档位白名单：过滤非法档位、按固定顺序去重；空数组/全选 = 跟随全开（返回 undefined）。 */
export function normalizeThinkingLevelAllowList(value: unknown): ThinkingLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const picked = THINKING_LEVELS.filter((level) => value.includes(level));
  return picked.length > 0 && picked.length < THINKING_LEVELS.length ? picked : undefined;
}

/** 设置页「思考等级」编辑器的草稿形状：勾选与否 + 每档自定义上游取值（空 = 用同名）。 */
export interface ThinkingLevelDraft {
  enabled: Record<ThinkingLevel, boolean>;
  values: Record<ThinkingLevel, string>;
}

/**
 * 从一份生效映射生成编辑器草稿：`map` 为 undefined 时按运行时缺省（关闭…高）。
 * 取值框回显声明的自定义取值（未声明 = 空，占位符提示同名值）。
 */
export function thinkingLevelDraftFrom(map: ThinkingLevelMap | undefined, reasoning?: boolean): ThinkingLevelDraft {
  // 先按运行时缺省铺底，再让声明覆盖——这样「未声明的低档位」显示为可用（Pi 口径），
  // 而「被显式声明为 null 的档位」显示为不可用。
  const effective = { ...defaultThinkingLevelMapFor(reasoning), ...map };
  const enabled = {} as Record<ThinkingLevel, boolean>;
  const values = {} as Record<ThinkingLevel, string>;
  for (const level of THINKING_LEVELS) {
    const mapped = effective[level];
    const isHighTier = level === "xhigh" || level === "max";
    enabled[level] = mapped === null ? false : isHighTier ? mapped !== undefined : true;
    values[level] = typeof mapped === "string" ? mapped : "";
  }
  return { enabled, values };
}

/**
 * 把编辑器草稿回收成一份映射：只写入用户真正声明的档位。
 *
 * 两条硬规则（写错就会误伤能力面）：① 勾上 `xhigh`/`max` 才能声明（Pi 只放行
 * 已声明的这两档）；② 关掉 `off`…`high` 里的某一档要显式写 `null`，否则缺键
 * 会被 Pi 当成「默认可用」。低档位勾选且取值非空 → 写自定义取值，否则返回
 * undefined（= 不声明，运行时按缺省口径）。
 */
export function thinkingLevelMapFromDraft(draft: ThinkingLevelDraft): ThinkingLevelMap | undefined {
  const entries: [ThinkingLevel, string | null][] = [];
  for (const level of THINKING_LEVELS) {
    const isHighTier = level === "xhigh" || level === "max";
    const enabled = draft.enabled[level] === true;
    if (isHighTier) {
      if (!enabled) continue;
      const custom = draft.values[level]?.trim();
      // 很高/最高未填自定义取值时显式用同名档位（undefined 等于没声明 = 仍不可用）。
      entries.push([level, custom && custom !== level ? custom : level]);
      continue;
    }
    if (!enabled) {
      entries.push([level, null]);
      continue;
    }
    const custom = draft.values[level]?.trim();
    if (custom && custom !== level) entries.push([level, custom]);
  }
  return entries.length > 0 ? (Object.fromEntries(entries) as ThinkingLevelMap) : undefined;
}
