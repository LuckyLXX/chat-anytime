import { ExternalLink, RotateCw, Server, Square, TerminalSquare } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import {
  GALLERY_SERVICE_STATUS_LABELS,
  galleryServiceLive,
  type GalleryServiceRecord
} from "../../../shared/gallery";

/**
 * 作品墙顶部的「运行中的服务」看板（2026-11-12）。
 *
 * 存在的理由只有一个：服务型作品的进程现在跑在**主进程的后台**（不占标签页、关掉页面
 * 也不会停），于是必须有一个地方能看见它们、能把它们停掉、能在起不来时看到输出。这里
 * 就是那个地方——作品墙（空态 landing 与弹窗两处共用同一个 GalleryWall）与顶栏下拉的
 * 计数都指向它。
 *
 * 结构钩子（`data-pane="gallery-services"` 与 `data-control="gallery-service-*"`）与
 * 作品墙其余钩子同口径：它们是公开主题 API（docs/theme-guide.md 与主题创建器 skill
 * 里都有清单），改名要同步五处。
 */

/**
 * 运行时长：秒级用「N 秒」，分钟级 `M:SS`，超过一小时 `H:MM:SS`。
 * 已结束的服务用 endedAt 截断（否则停掉的服务时长会一直往上跑）。
 */
export function formatServiceUptime(startedAt: number, now: number, endedAt?: number): string {
  const end = endedAt ?? now;
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** 状态文字：运行中但要补一句「端口还没通」，否则用户会以为能用了。 */
export function serviceStatusText(service: Pick<GalleryServiceRecord, "status" | "ready">): string {
  const label = GALLERY_SERVICE_STATUS_LABELS[service.status];
  if (service.status === "running" && !service.ready) return `${label} · 端口未通`;
  return label;
}

export interface GalleryServicesBoardProps {
  services: GalleryServiceRecord[];
  /** 打开页面（有 url 的服务才有这个入口）。 */
  onOpenPage(service: GalleryServiceRecord): void;
  /** 停止进程树；已结束的记录会被移出看板（按钮文案是「移出」）。 */
  onStop(service: GalleryServiceRecord): void;
  onRestart(service: GalleryServiceRecord): void;
}

function ServiceRow({ service, now, expanded, onToggleLog, onOpenPage, onStop, onRestart }: {
  service: GalleryServiceRecord;
  now: number;
  expanded: boolean;
  onToggleLog(): void;
  onOpenPage(): void;
  onStop(): void;
  onRestart(): void;
}): ReactNode {
  const live = galleryServiceLive(service);
  return (
    <li className={`gallery-service-row${live ? " is-live" : " is-dead"}`} data-gallery-service-id={service.id} data-service-status={service.status}>
      <div className="gallery-service-line">
        <span className="gallery-service-dot" data-status={service.status} aria-hidden="true" />
        <div className="gallery-service-main">
          <strong title={service.title}>{service.title}</strong>
          <span className="gallery-service-meta">
            {serviceStatusText(service)}
            {live && service.pid ? ` · PID ${service.pid}` : ""}
            {` · ${formatServiceUptime(service.startedAt, now, live ? undefined : service.endedAt)}`}
            {service.exitCode !== undefined && !live ? ` · 退出码 ${service.exitCode}` : ""}
          </span>
          <code className="gallery-service-command" title={`${service.cwd} ｜ ${service.command}`}>{service.command}</code>
        </div>
        <div className="gallery-service-actions">
          {/* 面板的本地服务不带「打开」：它的 url 是探活地址（多半是 API 端点），
              在浏览器里打开只会得到 404，那不是用户想要的入口。 */}
          {live && service.url && !service.ownerPanelId && (
            <button type="button" data-control="gallery-service-open" title={service.url} onClick={onOpenPage}><ExternalLink size={11} />打开</button>
          )}
          <button type="button" data-control="gallery-service-log" title="展开/收起输出" aria-expanded={expanded} onClick={onToggleLog}>
            <TerminalSquare size={11} />日志
          </button>
          <button type="button" data-control="gallery-service-restart" title={live ? "停掉再起" : "重新启动"} onClick={onRestart}><RotateCw size={11} />{live ? "重启" : "重起"}</button>
          <button type="button" data-control="gallery-service-stop" title={live ? "结束整棵进程树" : "从看板移出这条记录"} onClick={onStop}><Square size={10} />{live ? "停止" : "移出"}</button>
        </div>
      </div>
      {service.note && !expanded && <p className="gallery-service-note">{service.note}</p>}
      {expanded && (
        <div className="gallery-service-log-panel">
          {service.note && <p className="gallery-service-note">{service.note}</p>}
          <pre className="gallery-service-log" data-control="gallery-service-log-body">{service.log?.trim() ? service.log : "（还没有输出）"}</pre>
        </div>
      )}
    </li>
  );
}

export function GalleryServicesBoard({ services, onOpenPage, onStop, onRestart }: GalleryServicesBoardProps): ReactNode {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(() => Date.now());
  const live = services.filter(galleryServiceLive);
  const dead = services.filter((service) => !galleryServiceLive(service));

  // 只在本轮有活着的服务时每秒刷新（没有活服务时不需要任何计时器）。
  useEffect(() => {
    if (live.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live.length]);

  // 看板只在有记录时出现（空态 landing 已经够满，不该再挂一行「暂无」）。
  if (services.length === 0) return null;

  return (
    <section className="gallery-services" data-pane="gallery-services">
      <header className="gallery-services-head">
        <Server size={13} />
        <strong>运行中的服务</strong>
        <span className="gallery-services-count">
          {live.length > 0 ? `${live.length} 个在后台` : "没有在跑的"}
          {dead.length > 0 ? ` · ${dead.length} 个已结束` : ""}
        </span>
        <small className="gallery-services-hint">后台进程：关掉页面不会停，应用退出时全部停止。</small>
      </header>
      <ul className="gallery-services-list">
        {services.map((service) => (
          <ServiceRow
            key={service.id}
            service={service}
            now={now}
            expanded={expanded[service.id] === true}
            onToggleLog={() => setExpanded((current) => ({ ...current, [service.id]: current[service.id] !== true }))}
            onOpenPage={() => onOpenPage(service)}
            onStop={() => onStop(service)}
            onRestart={() => onRestart(service)}
          />
        ))}
      </ul>
    </section>
  );
}

/** 卡片/菜单上的「服务运行中」小标记（纯展示，不带动作）。 */
export function GalleryServiceBadge({ count }: { count: number }): ReactNode {
  if (count <= 0) return null;
  return (
    <span className="gallery-service-badge" title={`这个作品有 ${count} 个服务在后台运行`}>
      <Server size={10} />服务运行中
    </span>
  );
}
