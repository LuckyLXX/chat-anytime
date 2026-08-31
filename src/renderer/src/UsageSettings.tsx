// 设置页「用量统计」tab：跨助手 token 用量聚合（usage.stats.request 按需拉取，
// usage-stats-result 推送；数据源是会话 JSONL 的 assistant usage，按文件缓存增量扫描）。

import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { UsageDayEntry, UsageStats, UsageTotals } from "../../shared/protocol";
import { buildUsageHeatmap, formatCost, formatDayLabel, formatHitRate, formatLastUsed, formatTokenCount, todayLocalDate, windowTotalsFromDays } from "./lib/usage-format";
import { useDesktopStore } from "./store";

/** 总览卡：标签 + 请求次数，输入/输出大数字，其余指标收进脚注行。 */
function UsageSummaryCard({ label, totals }: { label: string; totals: UsageTotals }): ReactNode {
  return (
    <div className="usage-summary-card" data-role="usage-summary">
      <header><strong>{label}</strong><span>{totals.requests} 次请求</span></header>
      <dl className="usage-summary-hero">
        <div><dt>输入</dt><dd>{formatTokenCount(totals.input + totals.cacheWrite)}</dd></div>
        <div><dt>输出</dt><dd>{formatTokenCount(totals.output)}</dd></div>
      </dl>
      <footer className="usage-summary-foot">
        <span>缓存读 {formatTokenCount(totals.cacheRead)}</span>
        <span>命中率 {formatHitRate(totals.cacheHitRate)}</span>
        <span>成本 {formatCost(totals.cost)}</span>
      </footer>
    </div>
  );
}

/** 左侧星期标签只标 一/三/五/日，其余行留空（与列对齐交给 grid 布局）。 */
const HEATMAP_WEEKDAY_LABELS: (string | null)[] = ["一", null, "三", null, "五", null, "日"];

/** 按天活跃热力图：周列网格（周一开头），强度 = 当日请求次数相对峰值分档，悬浮显示当日明细。 */
function UsageHeatmap({ byDay, today }: { byDay: readonly UsageDayEntry[]; today: string }): ReactNode {
  const layout = useMemo(() => buildUsageHeatmap(byDay, today), [byDay, today]);
  if (layout.weeks.length === 0) return null;
  return (
    <div className="usage-heatmap">
      <div className="usage-heatmap-scroll">
        <div className="usage-heatmap-grid" style={{ gridTemplateColumns: `auto repeat(${layout.weeks.length}, 13px)` }}>
          {HEATMAP_WEEKDAY_LABELS.map((label, day) => label && (
            <span key={label} className="usage-heatmap-wday" style={{ gridColumn: 1, gridRow: day + 2 }}>{label}</span>
          ))}
          {layout.monthLabels.map(({ column, label }) => (
            <span key={column} className="usage-heatmap-month" style={{ gridColumn: `${column + 2} / span ${Math.min(3, layout.weeks.length - column)}`, gridRow: 1 }}>{label}</span>
          ))}
          {layout.weeks.map((week, weekIndex) => week.map((cell, day) => {
            const style = { gridColumn: weekIndex + 2, gridRow: day + 2 };
            if (!cell) return <span key={`blank-${weekIndex}-${day}`} className="usage-heatmap-cell" data-blank style={style} />;
            const detail = `${formatDayLabel(cell.date, today)}：${cell.requests} 次请求 · 输入 ${formatTokenCount(cell.input)} · 输出 ${formatTokenCount(cell.output)} · 成本 ${formatCost(cell.cost)}`;
            return <span key={cell.date} className="usage-heatmap-cell" data-level={cell.level} data-today={cell.date === today || undefined} title={detail} style={style} />;
          }))}
        </div>
      </div>
      <footer className="usage-heatmap-foot">
        <span>按请求次数，颜色越深用量越大</span>
        <span className="usage-heatmap-legend">少{[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}多</span>
      </footer>
    </div>
  );
}

function UsageTable({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }): ReactNode {
  if (rows.length === 0) return <p className="panel-empty">{empty}</p>;
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead><tr>{head.map((cell) => <th key={cell}>{cell}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsageSettings(): ReactNode {
  const usageStats = useDesktopStore((state) => state.usageStats);
  const usageStatsLoading = useDesktopStore((state) => state.usageStatsLoading);
  const requestUsageStats = useDesktopStore((state) => state.requestUsageStats);
  const agents = useDesktopStore((state) => state.settings.agents);
  // 助手筛选：undefined = 全部助手。切换即重新请求（utility 端过滤后重聚合，缓存命中零重扫）。
  const [agentFilter, setAgentFilter] = useState<string>("");
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);

  useEffect(() => {
    requestUsageStats(agentFilter || undefined);
  }, [agentFilter, requestUsageStats]);

  const today = todayLocalDate();
  const todayTotals = useMemo(() => (usageStats ? windowTotalsFromDays(usageStats.byDay, today, 1) : undefined), [usageStats, today]);
  const weekTotals = useMemo(() => (usageStats ? windowTotalsFromDays(usageStats.byDay, today, 7) : undefined), [usageStats, today]);
  const scanMeta = usageStats && (
    usageStats.byDay.length > 0 ? `覆盖 ${formatDayLabel(usageStats.byDay[0]!.date, today)} 起` : "暂无用量数据"
  ) + (usageStats.byDay.length > 1 ? ` 至 ${formatDayLabel(usageStats.byDay[usageStats.byDay.length - 1]!.date, today)}` : "")
    + ` · 本次扫描 ${usageStats.scannedFiles} 个文件 · ${usageStats.scanMs}ms`;

  return (
    <div className="usage-settings">
      <div className="usage-toolbar">
        <label>
          范围
          <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} data-control="usage-agent-filter">
            <option value="">全部助手</option>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
        <button className="secondary-button" type="button" disabled={usageStatsLoading} onClick={() => requestUsageStats(agentFilter || undefined)}>
          <RefreshCw size={13} className={usageStatsLoading ? "spinning" : undefined} />
          {usageStatsLoading ? "统计中…" : "刷新"}
        </button>
        {scanMeta && <p className="usage-scan-meta">{scanMeta}</p>}
      </div>
      {usageStats && todayTotals && weekTotals && (
        <div className="usage-summary-row">
          <UsageSummaryCard label="今日" totals={todayTotals} />
          <UsageSummaryCard label="近 7 天" totals={weekTotals} />
          <UsageSummaryCard label="累计" totals={usageStats.total} />
        </div>
      )}
      {usageStats && usageStats.byDay.length > 0 && (
        <section className="usage-section">
          <h4>活跃热力</h4>
          <UsageHeatmap byDay={usageStats.byDay} today={today} />
        </section>
      )}
      {usageStats && (
        <>
          <section className="usage-section">
            <h4>按天</h4>
            <UsageTable
              head={["日期", "请求", "输入", "输出", "缓存读", "成本"]}
              empty="暂无用量数据——发起对话后这里会按本地日期累计。"
              rows={[...usageStats.byDay].reverse().map((day) => [
                formatDayLabel(day.date, today),
                String(day.requests),
                formatTokenCount(day.input + day.cacheWrite),
                formatTokenCount(day.output),
                formatTokenCount(day.cacheRead),
                formatCost(day.cost)
              ])}
            />
          </section>
          <section className="usage-section">
            <h4>按模型</h4>
            <UsageTable
              head={["模型", "请求", "输入", "输出", "缓存读", "最近使用"]}
              empty="暂无模型用量。"
              rows={usageStats.byModel.map((model) => [
                <span key="m" className="usage-model-cell"><strong>{model.model}</strong><small>{model.provider}</small></span>,
                String(model.requests),
                formatTokenCount(model.input + model.cacheWrite),
                formatTokenCount(model.output),
                formatTokenCount(model.cacheRead),
                formatLastUsed(model.lastAt)
              ])}
            />
          </section>
          <section className="usage-section">
            <h4>最近会话</h4>
            <UsageTable
              head={["会话", "助手", "请求", "输入", "输出", "最近使用"]}
              empty="暂无会话用量。"
              rows={usageStats.bySession.map((session) => [
                <span key="t" className="usage-session-cell" title={session.sessionPath}>{session.title}</span>,
                agentNames.get(session.agentId) ?? session.agentId,
                String(session.requests),
                formatTokenCount(session.input + session.cacheWrite),
                formatTokenCount(session.output),
                formatLastUsed(session.lastAt)
              ])}
            />
          </section>
        </>
      )}
    </div>
  );
}
