import { describe, expect, it } from "vitest";
import type { BrowserAutomationRequest, BrowserAutomationResult, JevObservePage } from "../shared/protocol.js";
import { buildActionSpace } from "./jev-action-space.js";
import { JEV_NAVIGATION_RETRIES, pageChangedBetween, runJevLoop, type JevToolDeps } from "./runtime-jev.js";

/**
 * 与 jev（`D:\开源仓库\jev-ultrafast`）对标时暴露的两个缺口，以及它们的回归网。
 *
 * 这两个缺口都不是「功能没写完」，而是**判断口径**错了，而且都只在特定页面上才现形：
 *
 * 1. 页面变化只看 URL + 可见文本 → 勾选复选框/切开关/换 tab **不改文本**，于是被判成
 *    「这一步没起作用」，连着几次就被停滞启发式误判为「走不通」而提前收场。
 *    jev 的口径是 `fingerprint = sha256(url, text, actions, scroll)`——元素状态算在内。
 * 2. 观察撞上导航 → `Runtime.evaluate` 报「Cannot find context with specified id」→
 *    旧实现让整次运行以异常收场（工具报错），而 jev 的做法是重新观察。
 *
 * 夹具纪律：假页面必须**像真页面一样对动作作出反应**（勾选后勾选态真的翻转）。
 * 否则测试断言的是一个不存在的场景——第一版夹具恒定返回「未勾选」，于是
 * 「勾选态变了」这件事在夹具里从未发生，测试永远红（且红得没有意义）。
 */

const settings = { enabled: true, baseUrl: "https://api.ts/v1", model: "jev-latest", textProvider: "p", textModel: "m", maxSteps: 30, autoPilot: true };

const choice = (keys: string[], selected: string) => ({ choice: selected, confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 1 : 0])) });

/** 页面文本**不随勾选态变化**——这正是缺口 A 的关键（文本相同但状态不同）。 */
function checkboxPage(checked: boolean): JevObservePage {
  return {
    url: "https://example.com/form",
    title: "表单",
    pageText: "请选择服务条款",
    scroll: { y: 0, height: 100, viewH: 100, canDown: false },
    items: [
      { nodeId: 1, sig: `input||checkbox|t1||||on|${checked ? "t" : "f"}`, role: "checkbox", label: "同意条款", checked, x: 10, y: 10 }
    ]
  };
}

/** 决策脚本：永远点那个复选框（用它把「状态变了但文本没变」这一路径打出来）。 */
function depsFor(options: {
  observe: (call: number) => Promise<BrowserAutomationResult>;
  onAct?: (request: Extract<BrowserAutomationRequest, { op: "jevAct" }>) => void;
  decisions?: number;
}): JevToolDeps {
  let call = 0;
  return {
    settings: () => settings,
    apiKey: () => "k",
    request: async (op) => {
      if (op.op === "jevObserve") return options.observe(call++);
      if (op.op === "jevAct") {
        options.onAct?.(op);
        return { ok: true, data: { kind: "jevAct", description: "已点击" } };
      }
      return { ok: true, data: { kind: "jevReset" } };
    },
    callJev: async () => {
      const space = buildActionSpace(checkboxPage(false));
      return { answers: { operation: choice(Object.keys(space.operations), "CLICK"), click_target: choice(Object.keys(space.targets.CLICK!), "1") }, latencyMs: 5 };
    },
    writeFieldText: async () => "x",
    wait: async () => undefined
  };
}

describe("页面变化判定（对齐 jev 的 fingerprint 口径）", () => {
  it("纯函数口径：勾选态/值/展开态变化都算变化，且不把顺序与坐标搅进来", () => {
    expect(pageChangedBetween(checkboxPage(false), checkboxPage(true))).toBe(true);
    // 文本没变、URL 没变、只有 value 变（输入框）同样要算变化。
    const filled = checkboxPage(false);
    const typed: JevObservePage = { ...filled, items: [{ ...filled.items[0]!, value: "北京" }] };
    expect(pageChangedBetween(filled, typed)).toBe(true);
    // 真没变就不能算变化——否则停滞启发式永远不触发（比误停更糟：会一直空转）。
    expect(pageChangedBetween(checkboxPage(false), checkboxPage(false))).toBe(false);
    // 坐标/遮挡本来就是瞬时的，不参与判定（与 elementSignature 同一取舍）。
    const moved: JevObservePage = { ...filled, items: [{ ...filled.items[0]!, x: 999, y: 999 }] };
    expect(pageChangedBetween(filled, moved)).toBe(false);
  });

  it("缺口 A：勾选复选框（只改勾选态、不改可见文本）不该被判成「页面没有变化」而提前 blocked", async () => {
    // 有状态的假页面：每次点击翻转勾选态（真页面就是这样）。
    let checked = false;
    const result = await runJevLoop(depsFor({
      observe: async () => ({ ok: true, data: { kind: "jevObserve", page: checkboxPage(checked) } }),
      onAct: () => { checked = !checked; }
    }), "勾选同意条款", 10, undefined);
    expect(result.steps.length, "应当真的走出多步（而不是第 3 步就被判停滞）").toBeGreaterThan(0);
    expect(result.steps.some((step) => step.pageChanged === true), `每一步都应被记为「页面已变化」，实际：${result.steps.map((s) => String(s.pageChanged)).join(",")}`).toBe(true);
    expect(result.outcome).not.toBe("blocked");
  });

  it("反向守卫：页面**真的**没有变化时，停滞判定必须照旧生效", async () => {
    // 若把变化判定放宽成「恒定 true」，这条会红——它防止为了修缺口 A 而废掉刹车。
    const result = await runJevLoop(depsFor({
      observe: async () => ({ ok: true, data: { kind: "jevObserve", page: checkboxPage(false) } })
    }), "勾选同意条款", 10, undefined);
    expect(result.outcome).toBe("blocked");
    expect(result.notice ?? "").toContain("没有变化");
  });
});

describe("观察撞上导航（对齐 jev 的 StalePage 重试口径）", () => {
  it("缺口 C：导航中的一次观察失败应当重试并继续，而不是让整次运行以异常收场或提前收场", async () => {
    let calls = 0;
    let checked = false;
    const acts: number[] = [];
    const deps = depsFor({
      observe: async () => {
        calls += 1;
        // 第 2 次观察（点击后紧接着的那次）恰好撞上导航，主进程会回 ok:false。
        if (calls === 2) return { ok: false, error: "页面脚本执行失败：Cannot find context with specified id" };
        return { ok: true, data: { kind: "jevObserve", page: checkboxPage(checked) } };
      },
      onAct: (request) => { acts.push(request.nodeId); checked = !checked; }
    });
    const result = await runJevLoop(deps, "点击后跳转", 6, undefined);
    // 关键断言是「恢复了」而不是「没抛异常」：重试没生效时也会以 blocked 收场（不抛），
    // 只断言 resolves 会让「直接放弃」与「重试成功」看不出区别（实测过这个假绿）。
    expect(result.notice ?? "", `不该因读不到页面而停：${result.notice ?? ""}`).not.toContain("无法读取页面");
    // 恢复后确实又发起了下一次动作（第 2 个决策步）。
    expect(acts.length, "应当走出至少两步（首次点击 + 恢复后的下一次点击）").toBeGreaterThanOrEqual(2);
    // 且确实多付了一次观察（两次失败之间的重试）。
    expect(calls).toBeGreaterThanOrEqual(3);
    // 恢复后那一步的变化判定也应当正常（勾选态真的翻了）。
    expect(result.steps.some((step) => step.pageChanged === true)).toBe(true);
  });

  it("重试耗尽时如实停止（blocked），而不是抛异常或假装页面没变", async () => {
    let observeCalls = 0;
    const acts: string[] = [];
    const deps = depsFor({
      observe: async () => {
        observeCalls += 1;
        // 首次观察正常（否则循环还没开始），之后页面永远不可读。
        return observeCalls === 1
          ? { ok: true, data: { kind: "jevObserve", page: checkboxPage(false) } }
          : { ok: false, error: "页面脚本执行失败：Cannot find context with specified id" };
      },
      onAct: (request) => acts.push(String(request.nodeId))
    });
    const result = await runJevLoop(deps, "点击后跳转", 6, undefined);
    expect(result.outcome).toBe("blocked");
    expect(result.notice ?? "").toContain("无法读取页面");
    // 重试确实发生了（1 次成功 + 4 次失败 = 1 + (1 + JEV_NAVIGATION_RETRIES)）。
    expect(observeCalls).toBe(2 + JEV_NAVIGATION_RETRIES);
    // 已发生的执行事实不能因为之后读不到页面而丢失。
    expect(acts).toEqual(["1"]);
    expect(result.steps.at(-1)?.pageChanged).toBeNull();
  });
});
