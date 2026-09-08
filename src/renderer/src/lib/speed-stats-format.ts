import type { SpeedStats } from "../../../shared/protocol";

/**
 * dsh（deepseek-harness）StatsLine 的展示层格式化：
 * `1轮·65步｜LLM 11m42s·工具调用 8m23s｜首 token 平均 1.6s·118 tok/s｜
 * 缓存命中 99%｜输入 7.3M tok·输出 70.6K tok`
 * 组间 `｜`、组内 `·`；无数据的组整组省略；K/M 缩写三位数内保留 1 位小数。
 */

/** 45_230 → `45.2s`；162_000 → `2m42s`（秒不补零）。 */
export function formatSpeedDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** 517 → `517`；12_240 → `12.2K`；517_000 → `517K`；1_230_000 → `1.2M`。 */
export function formatSpeedTokens(value: number): string {
  const scaled = (scaled: number) => (scaled >= 100 ? String(Math.round(scaled)) : String(Math.round(scaled * 10) / 10));
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${scaled(value / 1000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

/** ≥10 取整；<10 保 1 位小数（8.3）。 */
export function formatTokensPerSecond(tokensPerSecond: number): string {
  return tokensPerSecond >= 10 ? String(Math.round(tokensPerSecond)) : String(Math.round(tokensPerSecond * 10) / 10);
}

/** 实时读数的显示门槛：等待计时至少 0.3s（避免闪现）、速度窗口至少 0.8s 且 ≥8 个估算 token（避免开局狂跳）。 */
const LIVE_WAIT_MIN_MS = 300;
const LIVE_SPEED_MIN_MS = 800;
const LIVE_SPEED_MIN_TOKENS = 8;

/**
 * 组装状态行分组（空组省略）。计数组 gate 在 steps（usage 口径）上；耗时/
 * 速度组独立展示——中转站不报 usage 时 steps 恒 0，但计时读数仍然有效。
 * 流式期间行首附带实时组（等待首 token 计时 / ~N tok/s），收步后被累计
 * 口径接管。缓存命中率不驻留在 SpeedStats 里（它属于
 * ContextUsage.cacheHitRate），作为参数合入——与 chip 同源同口径。
 */
export function speedStatsGroups(stats: SpeedStats | undefined, cacheHitRate: number | null | undefined, now = Date.now()): string[] {
  if (!stats) return [];
  const groups: string[] = [];
  if (stats.live) {
    const { live } = stats;
    if (live.firstTokenAt === undefined) {
      const waiting = now - live.startedAt;
      if (waiting > LIVE_WAIT_MIN_MS) groups.push(`首 token ${formatSpeedDuration(waiting)}…`);
    } else {
      const window = now - live.firstTokenAt;
      if (window >= LIVE_SPEED_MIN_MS && live.tokens >= LIVE_SPEED_MIN_TOKENS) {
        groups.push(`~${formatTokensPerSecond(live.tokens / (window / 1000))} tok/s`);
      }
    }
  }
  if (stats.steps > 0) groups.push(`${stats.turns}轮·${stats.steps}步`);
  const durations: string[] = [];
  if (stats.llmMs > 0) durations.push(`LLM ${formatSpeedDuration(stats.llmMs)}`);
  if (stats.toolMs > 0) durations.push(`工具调用 ${formatSpeedDuration(stats.toolMs)}`);
  if (durations.length > 0) groups.push(durations.join(" · "));
  const speeds: string[] = [];
  if (stats.ttftSteps > 0) speeds.push(`首 token 平均 ${formatSpeedDuration(stats.ttftMs / stats.ttftSteps)}`);
  if (stats.decodeMs > 0) speeds.push(`${formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1000))} tok/s`);
  if (speeds.length > 0) groups.push(speeds.join(" · "));
  if (stats.promptTokens > 0 || stats.outputTokens > 0) {
    if (cacheHitRate != null) groups.push(`缓存命中 ${Math.round(cacheHitRate)}%`);
    groups.push(`输入 ${formatSpeedTokens(stats.promptTokens)} tok · 输出 ${formatSpeedTokens(stats.outputTokens)} tok`);
  }
  return groups;
}
