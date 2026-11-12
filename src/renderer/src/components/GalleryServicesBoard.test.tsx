import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GalleryServiceRecord } from "../../../shared/gallery";
import { formatServiceUptime, GalleryServicesBoard, serviceStatusText } from "./GalleryServicesBoard";

/**
 * 后台服务看板（2026-11-12）：服务进程改到主进程后台之后，这里是它唯一的可见入口。
 *
 * 结构钩子的完整清单在 GalleryWall.test.tsx 里钉住（它还覆盖卡片角标与顶栏计数）；
 * 这里只钉**纯判定**——时间与状态文案是看板上唯一有分支的展示逻辑，写错了不会有任何
 * 报错，只会让用户读到一句假话（「运行中」但其实端口没通、或者「3 秒」其实跑了三小时）。
 */

function service(patch: Partial<GalleryServiceRecord> = {}): GalleryServiceRecord {
  return {
    id: "s1",
    appId: "g1",
    title: "反代",
    command: "node proxy.js",
    cwd: "D:/ws/proxy",
    status: "running",
    ready: true,
    startedAt: 1_000,
    ...patch
  };
}

describe("formatServiceUptime", () => {
  it("秒级 / 分钟级 / 小时级三档，分钟与秒补零", () => {
    expect(formatServiceUptime(0, 5_000)).toBe("5 秒");
    expect(formatServiceUptime(0, 59_000)).toBe("59 秒");
    expect(formatServiceUptime(0, 65_000)).toBe("1:05");
    expect(formatServiceUptime(0, 3_725_000)).toBe("1:02:05");
  });

  it("已结束的服务用 endedAt 截断（否则停掉的记录时长会一直往上跑）", () => {
    expect(formatServiceUptime(0, 600_000, 65_000)).toBe("1:05");
  });

  it("时钟倒退（系统时间被改）不会出现负数", () => {
    expect(formatServiceUptime(10_000, 1_000)).toBe("0 秒");
  });
});

describe("serviceStatusText", () => {
  it("运行中但端口没通要额外说明（否则用户以为能用了）", () => {
    expect(serviceStatusText({ status: "running", ready: true })).toBe("运行中");
    expect(serviceStatusText({ status: "running", ready: false })).toBe("运行中 · 端口未通");
    expect(serviceStatusText({ status: "starting", ready: false })).toBe("启动中");
    expect(serviceStatusText({ status: "failed", ready: false })).toBe("启动失败");
    expect(serviceStatusText({ status: "stopped", ready: false })).toBe("已停止");
  });
});

describe("GalleryServicesBoard 渲染", () => {
  it("没有记录时整块不渲染（空态 landing 已经很满，不该多一行「暂无」）", () => {
    expect(renderToStaticMarkup(<GalleryServicesBoard services={[]} onOpenPage={() => {}} onStop={() => {}} onRestart={() => {}} />)).toBe("");
  });

  it("活着的服务没有 url 时不渲染「打开」按钮（没有页面可开）", () => {
    const markup = renderToStaticMarkup(<GalleryServicesBoard services={[service()]} onOpenPage={() => {}} onStop={() => {}} onRestart={() => {}} />);
    expect(markup).not.toContain('data-control="gallery-service-open"');
    const withUrl = renderToStaticMarkup(<GalleryServicesBoard services={[service({ url: "http://127.0.0.1:8787" })]} onOpenPage={() => {}} onStop={() => {}} onRestart={() => {}} />);
    expect(withUrl).toContain('data-control="gallery-service-open"');
  });

  it("面板的本地服务不带「打开」（它的 url 是探活地址，开出来只会是 404）", () => {
    const markup = renderToStaticMarkup(<GalleryServicesBoard services={[service({ url: "http://127.0.0.1:8791/api/health", ownerPanelId: "g1" })]} onOpenPage={() => {}} onStop={() => {}} onRestart={() => {}} />);
    expect(markup).not.toContain('data-control="gallery-service-open"');
  });

  it("已结束的记录按钮语义换成「移出 / 重起」（停止一个已经停了的进程没有意义）", () => {
    const markup = renderToStaticMarkup(<GalleryServicesBoard services={[service({ status: "failed", ready: false, endedAt: 2_000, exitCode: 1 })]} onOpenPage={() => {}} onStop={() => {}} onRestart={() => {}} />);
    expect(markup).toContain(">移出</button>");
    expect(markup).toContain(">重起</button>");
    expect(markup).toContain("退出码 1");
  });
});
