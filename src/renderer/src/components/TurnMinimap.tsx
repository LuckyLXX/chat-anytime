import { useState, type ReactNode } from "react";
import { Bot, User } from "lucide-react";
import type { TurnSummary } from "../lib/turn-summary";

interface TurnMinimapProps {
  turns: TurnSummary[];
  /** 当前粘底/可视轮次的 key，用于高亮。 */
  activeKey?: string;
  /** 点击某个缩略横杠时回调，父级负责滚动到对应轮。 */
  onNavigate(key: string): void;
}

/** hover 浮出的内容卡片：固定在缩略列容器上垂直居中，内容取当前 hover 的一轮。 */
function TurnPopCard({ turn }: { turn: TurnSummary }): ReactNode {
  return (
    <div className="turn-thumb-pop" data-turn-pop>
      <div className="turn-thumb-pop-head">
        <User size={12} />
        <span className="turn-thumb-pop-label">用户</span>
      </div>
      <p className="turn-thumb-pop-text">{turn.userText || "（仅图片/无文本）"}</p>
      {turn.aiText && (
        <>
          <div className="turn-thumb-pop-head ai">
            <Bot size={12} />
            <span className="turn-thumb-pop-label">回复</span>
          </div>
          <p className="turn-thumb-pop-text">{turn.aiText}</p>
        </>
      )}
    </div>
  );
}

/**
 * 会话时间线左缘的「轮次缩略导航」（minimap 风格）。每个缩略块对应一轮，
 * 显示为一根小横杠；鼠标移到某条横杠上会放大一点，并展开一张浮出卡片，
 * 展示该轮的用户输入与 AI 输出摘要。点击横杠滚动到该轮首条消息。
 * 纯展示 + 回调，不持有滚动逻辑。
 *
 * hover 卡片固定在缩略列容器上垂直居中（不随 hover 的横杠上下跳动），
 * 向右浮出避免遮挡时间线。仅当至少 2 轮时才渲染（单轮无导航价值，由父级判断）。
 */
export function TurnMinimap({ turns, activeKey, onNavigate }: TurnMinimapProps): ReactNode {
  const [hoveredKey, setHoveredKey] = useState<string | undefined>();
  const hovered = hoveredKey === undefined ? undefined : turns.find((turn) => turn.key === hoveredKey);

  return (
    <div className="turn-minimap" data-pane="turn-minimap" aria-label="对话轮次缩略导航" role="navigation">
      {turns.map((turn) => {
        const active = turn.key === activeKey;
        const hover = turn.key === hoveredKey;
        const cls = `turn-thumb${active ? " active" : ""}${hover ? " hover" : ""}`;
        return (
          <div
            className={cls}
            key={turn.key}
            data-turn-index={turn.index}
            data-turn-active={active || undefined}
            onMouseEnter={() => setHoveredKey(turn.key)}
            onMouseLeave={() => setHoveredKey((current) => (current === turn.key ? undefined : current))}
            onFocus={() => setHoveredKey(turn.key)}
            onBlur={() => setHoveredKey((current) => (current === turn.key ? undefined : current))}
            onClick={() => onNavigate(turn.key)}
            tabIndex={0}
            role="button"
            aria-label={`第 ${turn.index + 1} 轮：${turn.userText || "（图片/无文本）"}`}
            title={`第 ${turn.index + 1} 轮：${turn.userText || "（图片/无文本）"}`}
          >
            <span className="turn-thumb-bar" />
          </div>
        );
      })}
      {hovered && <TurnPopCard turn={hovered} />}
    </div>
  );
}
