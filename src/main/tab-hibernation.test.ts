import { describe, expect, it } from "vitest";
import { TAB_HIBERNATE_IDLE_MS, TAB_HIBERNATE_KEEP_LIVE, planTabHibernation, type TabHibernationCandidate } from "./tab-hibernation";

/**
 * 标签休眠策略（T12a）。
 *
 * 实测动机：7 个 renderer 合计 890MB，闲置预览标签约 157MB（每个标签一个渲染进程，
 * 隐藏只 `setVisible(false)`、不释放内存）。策略要保守到「日常两三个标签零感知」，
 * 同时把真正闲置的那些内存还回去——所以四条硬约束（正在显示 / 被 AI 用着 /
 * 没有可恢复地址 / 自动化标签）与两条阈值（空闲时长 / 存活下限）都要钉死。
 */

function candidate(patch: Partial<TabHibernationCandidate> & { tabId: string }): TabHibernationCandidate {
  return { automation: false, hibernated: false, rendered: false, inUse: false, restorable: true, idleMs: 0, ...patch };
}

describe("tab hibernation policy", () => {
  it("存活数不超过 keepLive 时完全不动手", () => {
    expect(TAB_HIBERNATE_KEEP_LIVE).toBeGreaterThan(1);
    const candidates = [
      candidate({ tabId: "a", idleMs: 60 * 60 * 1000 }),
      candidate({ tabId: "b", idleMs: 60 * 60 * 1000 })
    ];
    expect(planTabHibernation(candidates)).toEqual([]);
  });

  it("正在显示的标签永不休眠", () => {
    const candidates = [
      candidate({ tabId: "visible", rendered: true, idleMs: 10 * 60 * 60 * 1000 }),
      ...Array.from({ length: 5 }, (_, index) => candidate({ tabId: `t${index}`, idleMs: 60 * 60 * 1000 }))
    ];
    expect(planTabHibernation(candidates)).not.toContain("visible");
  });

  it("被 AI 绑定 / 正在执行工具的标签永不休眠", () => {
    const candidates = [
      candidate({ tabId: "ai", inUse: true, idleMs: 10 * 60 * 60 * 1000 }),
      ...Array.from({ length: 5 }, (_, index) => candidate({ tabId: `t${index}`, idleMs: 60 * 60 * 1000 }))
    ];
    expect(planTabHibernation(candidates)).not.toContain("ai");
  });

  it("没有可恢复地址的标签不休眠（保留记录没意义）", () => {
    const candidates = [
      candidate({ tabId: "blank", restorable: false, idleMs: 10 * 60 * 60 * 1000 }),
      ...Array.from({ length: 5 }, (_, index) => candidate({ tabId: `t${index}`, idleMs: 60 * 60 * 1000 }))
    ];
    expect(planTabHibernation(candidates)).not.toContain("blank");
  });

  it("自动化标签不参与（原有清扫负责关闭它们）", () => {
    const candidates = [
      candidate({ tabId: "pi-browser-1", automation: true, idleMs: 10 * 60 * 60 * 1000 }),
      ...Array.from({ length: 5 }, (_, index) => candidate({ tabId: `t${index}`, idleMs: 60 * 60 * 1000 }))
    ];
    expect(planTabHibernation(candidates)).not.toContain("pi-browser-1");
  });

  it("未达空闲阈值的不休眠", () => {
    const candidates = [
      candidate({ tabId: "fresh", idleMs: TAB_HIBERNATE_IDLE_MS - 1000 }),
      ...Array.from({ length: 5 }, (_, index) => candidate({ tabId: `t${index}`, idleMs: 60 * 60 * 1000 }))
    ];
    expect(planTabHibernation(candidates)).not.toContain("fresh");
  });

  it("按最久未用优先，且只休眠到存活数降到 keepLive", () => {
    const candidates = [
      candidate({ tabId: "oldest", idleMs: 9 * 60 * 60 * 1000 }),
      candidate({ tabId: "old", idleMs: 5 * 60 * 60 * 1000 }),
      candidate({ tabId: "mid", idleMs: 2 * 60 * 60 * 1000 }),
      candidate({ tabId: "recent", idleMs: 40 * 60 * 1000 }),
      candidate({ tabId: "fresh", idleMs: 60 * 1000 })
    ];
    // 5 个存活、下限 4 → 只休眠 1 个，且必须是最久未用的那个
    expect(planTabHibernation(candidates)).toEqual(["oldest"]);
    // 下限 2 → 休眠 3 个，按 LRU 顺序
    expect(planTabHibernation(candidates, { keepLive: 2 })).toEqual(["oldest", "old", "mid"]);
  });

  it("已休眠的不重复计数、重复处理", () => {
    const candidates = [
      candidate({ tabId: "sleeping", hibernated: true, idleMs: 9 * 60 * 60 * 1000 }),
      ...Array.from({ length: 5 }, (_, index) => candidate({ tabId: `t${index}`, idleMs: 60 * 60 * 1000 }))
    ];
    const planned = planTabHibernation(candidates, { keepLive: 5 });
    expect(planned).not.toContain("sleeping");
    expect(planned).toHaveLength(0); // 存活 5 个已达下限
  });

  it("阈值可注入（便于按真实内存压力调参）", () => {
    const candidates = [candidate({ tabId: "a", idleMs: 10 * 60 * 1000 }), candidate({ tabId: "b", idleMs: 10 * 60 * 1000 })];
    expect(planTabHibernation(candidates, { idleMs: 5 * 60 * 1000, keepLive: 1 })).toEqual(["a"]);
    expect(planTabHibernation(candidates, { idleMs: 30 * 60 * 1000, keepLive: 1 })).toEqual([]);
  });
});
