import { useState, type ReactNode } from "react";
import { Bot, User } from "lucide-react";
import type { TurnSummary } from "../lib/turn-summary";

interface TurnMinimapProps {
  turns: TurnSummary[];
  /** 当前粘底/可视轮次的 key，用于高亮。 */
  activeKey?: string;
  /** 点击某个 shrunk 块时回调，父级负责滚动到对应轮。 */
  onNavigate(key: string): void;
}

/**
 * 会话时间线右侧贴边的「轮次缩略导航」（minimap 风格）。每个缩略块对应一
 * 轮；鼠标移到块上会放大成一张浮出卡片，展示该轮的用户输入与 AI 输出摘要。
 * 点击块滚动到该轮首条消息。纯展示 + 回调，不持有滚动逻辑。
 *
 * hover 卡片用 transform/opacity 进场（遵循 styles.css 的动效规范），向左
 * 浮出避免遮挡时间线。仅当至少 2 轮时才渲染（单轮无导航价值，由父级判断）。
 */
export function TurnMinimap({ turns, activeKey, onNavigate }: TurnMinimapProps): ReactNode {
  const [hovered, setHovered] = useState<string | undefined>();

  return (
    <div className="turn-minimap" data-pane="turn-minimap" aria-label="对话轮次缩略导航" role="navigation">
      {turns.map((turn) => {
        const active = turn.key === activeKey;
        const hover = hovered === turn.key;
        const cls = `turn-thumb${active ? " active" : ""}${hover ? " hover" : ""}`;
        return (
          <div
            className={cls}
            key={turn.key}
            data-turn-index={turn.index}
            data-turn-active={active || undefined}
            onMouseEnter={() => setHovered(turn.key)}
            onMouseLeave={() => setHovered((current) => (current === turn.key ? undefined : current))}
            onFocus={() => setHovered(turn.key)}
            onBlur={() => setHovered((current) => (current === turn.key ? undefined : current))}
            onClick={() => onNavigate(turn.key)}
            tabIndex={0}
            role="button"
            aria-label={`第 ${turn.index + 1} 轮：${turn.userText || "（图片/无文本）"}`}
            title={`第 ${turn.index + 1} 轮：${turn.userText || "（图片/无文本）"}`}
          >
            <span className="turn-thumb-index">{turn.index + 1}</span>
            {hover && (
              <div className="turn-thumb-pop">
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
            )}
          </div>
        );
      })}
    </div>
  );
}
