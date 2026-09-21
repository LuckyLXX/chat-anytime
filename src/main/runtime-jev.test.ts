import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BrowserAutomationRequest, BrowserAutomationResult, JevObservePage, JevSettings } from "../shared/protocol.js";
import { estimateToolTokens } from "./context-breakdown.js";
import { buildActionSpace } from "./jev-action-space.js";
import { JEV_WAIT_MS, buildJevTools, runJevLoop, type JevStep, type JevToolDeps } from "./runtime-jev.js";

const execute = (tool: { execute: (id: string, params: never, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> }, params: unknown, signal?: AbortSignal) =>
  tool.execute("test-call", params as never, signal, undefined, undefined as unknown as ExtensionContext);

const settings = (overrides: Partial<JevSettings> = {}): JevSettings => ({
  enabled: true,
  baseUrl: "https://api.typesafe.ai/v1",
  model: "jev-latest",
  textProvider: "openai-compatible",
  textModel: "helper",
  maxSteps: 30,
  autoPilot: true,
  ...overrides
});

function observePage(overrides: Partial<JevObservePage> = {}): JevObservePage {
  return {
    url: "https://example.com/",
    title: "示例",
    pageText: "页面文本",
    scroll: { y: 0, height: 900, viewH: 800, canDown: true },
    items: [
      { nodeId: 1, sig: "s1", role: "textbox", label: "搜索", value: "", editable: true, x: 10, y: 10 },
      { nodeId: 2, sig: "s2", role: "button", label: "提交", x: 10, y: 40 }
    ],
    ...overrides
  };
}

const choice = (keys: string[], selected: string) => ({
  choice: selected,
  confidence: 1,
  probabilities: Object.fromEntries(keys.map((key) => [key, key === selected ? 1 : 0]))
});

/**
 * 由页面算出真实动作空间后再构造决策。
 *
 * 不能手写操作名清单：`validateChoice` 要求概率键集与被问到的编号集**完全一致**，
 * 而那正是动作空间决定的（例如页面滚动到底时就没有 SCROLL_DOWN）。手写清单会让
 * 测试里的「合法响应」在真实校验下变成非法——测试必须用真实空间生成答案。
 */
function decisionFor(page: JevObservePage, operation: string, targetIndex?: number) {
  const space = buildActionSpace(page);
  const answer: Record<string, unknown> = { operation: choice(Object.keys(space.operations), operation) };
  const candidates = space.targets[operation];
  if (operation !== "DONE" && operation !== "BLOCKED" && operation !== "WAIT" && operation !== "SCROLL_UP" && operation !== "SCROLL_DOWN") {
    const keys = Object.keys(candidates ?? {});
    const picked = targetIndex === undefined ? keys[0]! : String(targetIndex);
    answer[`${operation.toLowerCase()}_target`] = choice(keys, picked);
  }
  return answer;
}

/**
 * 假依赖：按序回答决策脚本，并记录每一次浏览器原语调用。
 * `pages` 依次供给 jevObserve（最后一项重复使用）。
 */
function makeDeps(options: {
  decisions: Record<string, unknown>[];
  pages?: JevObservePage[];
  jev?: JevSettings;
  /** 缺省 "key"；false 表示「没有配置密钥」。 */
  apiKey?: string | false;
  text?: string;
  requestFails?: string;
}) {
  const calls: BrowserAutomationRequest[] = [];
  const textCalls: unknown[] = [];
  let observeCount = 0;
  let decisionIndex = 0;
  const pages = options.pages ?? [observePage()];
  const deps: JevToolDeps = {
    settings: () => options.jev ?? settings(),
    apiKey: () => (options.apiKey === false ? undefined : options.apiKey ?? "key"),
    request: async (op) => {
      calls.push(op);
      if (options.requestFails && op.op === options.requestFails) return { ok: false, error: "元素已不在页面中（页面已变化，请重新观察）" };
      if (op.op === "jevObserve") {
        const page = pages[Math.min(observeCount++, pages.length - 1)]!;
        return { ok: true, data: { kind: "jevObserve", page } };
      }
      if (op.op === "jevAct") return { ok: true, data: { kind: "jevAct", description: `已执行 ${op.action.kind}` } };
      if (op.op === "scroll") return { ok: true, data: { kind: "scroll", description: "已滚动" } };
      return { ok: true, data: { kind: "jevReset" } };
    },
    callJev: async () => {
      const answer = options.decisions[Math.min(decisionIndex++, options.decisions.length - 1)]!;
      return { answers: answer, latencyMs: 7 };
    },
    writeFieldText: async (request) => {
      textCalls.push(request);
      return options.text ?? "北京";
    },
    wait: async () => undefined
  };
  return { deps, calls, textCalls };
}

describe("jev loop", () => {
  it("executes the selected operation and returns a step trace", async () => {
    const { deps, calls } = makeDeps({
      // 第一次：点「提交」按钮（第 2 个元素）；第二次：DONE。
      decisions: [decisionFor(observePage(), "CLICK", 2), decisionFor(observePage(), "DONE")]
    });
    const result = await runJevLoop(deps, "提交表单", 10, undefined);
    expect(result.outcome).toBe("done");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]!.operation).toBe("CLICK");
    expect(result.steps[0]!.label).toContain("提交");
    expect(result.text).toContain("Jev 快速执行");
    expect(result.text).toContain("不是独立验证");
    // 决策之后必须真的发生一次 jevAct，且只对 #2 派发。
    const act = calls.find((call) => call.op === "jevAct") as Extract<BrowserAutomationRequest, { op: "jevAct" }>;
    expect(act.nodeId).toBe(2);
    expect(act.action).toEqual({ kind: "click" });
  });

  it("only asks the text helper on the TYPE_TEXT path", async () => {
    const { deps, textCalls, calls } = makeDeps({
      decisions: [decisionFor(observePage(), "CLICK", 2), decisionFor(observePage(), "DONE")]
    });
    await runJevLoop(deps, "点一下", 5, undefined);
    expect(textCalls).toHaveLength(0);
    // 反向验证的锚点：CLICK 路径不得产生任何文本生成调用。
    expect(calls.some((call) => call.op === "jevTypeText" as never)).toBe(false);
  });

  it("fills a field through the text helper and passes the generated value", async () => {
    const { deps, textCalls, calls } = makeDeps({
      decisions: [decisionFor(observePage(), "TYPE_TEXT", 1), decisionFor(observePage(), "DONE")],
      text: "上海"
    });
    const result = await runJevLoop(deps, "把搜索框填成上海", 5, undefined);
    expect(textCalls).toHaveLength(1);
    const act = calls.find((call) => call.op === "jevAct") as Extract<BrowserAutomationRequest, { op: "jevAct" }>;
    expect(act.action).toEqual({ kind: "fill" });
    expect(act.text).toBe("上海");
    expect(result.steps[0]!.text).toBe("上海");
    expect(result.steps[0]!.detail).toContain("已执行 fill");
  });

  it("stops without typing when the helper returns nothing", async () => {
    const { deps, calls } = makeDeps({
      decisions: [decisionFor(observePage(), "TYPE_TEXT", 1)],
      text: ""
    });
    const result = await runJevLoop(deps, "填一个说不清的值", 5, undefined);
    expect(result.outcome).toBe("blocked");
    expect(result.notice).toContain("推断出值");
    expect(calls.some((call) => call.op === "jevAct")).toBe(false);
  });

  it("honours the step budget instead of looping forever", async () => {
    const click = decisionFor(observePage(), "CLICK", 2);
    // 页面每次观察都略有不同：否则先撞上的是停滞启发式（那是另一个用例的断言），
    // 就测不到步数上限本身。
    const pages = [1, 2, 3, 4].map((n) => observePage({ pageText: `第 ${n} 次观察` }));
    const { deps, calls } = makeDeps({ decisions: [click], pages });
    const result = await runJevLoop(deps, "永远点", 3, undefined);
    expect(result.outcome).toBe("limit");
    expect(result.steps).toHaveLength(3);
    expect(calls.filter((call) => call.op === "jevAct")).toHaveLength(3);
    expect(result.text).toContain("已达步数上限（3 步）");
  });

  it("stops before deciding on a sensitive page without calling TypeSafe", async () => {
    let jevCalls = 0;
    const { deps, calls } = makeDeps({
      decisions: [decisionFor(observePage(), "DONE")],
      pages: [observePage({ pageText: "请登录后继续", title: "登录" })]
    });
    const spied: JevToolDeps = { ...deps, callJev: async () => { jevCalls += 1; throw new Error("不该被调用"); } };
    const result = await runJevLoop(spied, "登录后看看", 5, undefined);
    expect(result.outcome).toBe("sensitive");
    expect(jevCalls).toBe(0);
    expect(result.text).toContain("需要用户本人操作");
    // 敏感页也不该产生任何浏览器动作。
    expect(calls.some((call) => call.op === "jevAct")).toBe(false);
  });

  it("does not execute anything when TypeSafe answers with broken probabilities", async () => {
    const { deps, calls } = makeDeps({
      decisions: [{ operation: { choice: "CLICK", confidence: 1, probabilities: { CLICK: 0.5, DONE: 0.1 } } }]
    });
    await expect(runJevLoop(deps, "点一下", 5, undefined)).rejects.toThrow(/无效的选择/);
    expect(calls.some((call) => call.op === "jevAct")).toBe(false);
  });

  it("aborts at the next step boundary", async () => {
    const controller = new AbortController();
    const { deps, calls } = makeDeps({
      decisions: [decisionFor(observePage(), "CLICK", 2), decisionFor(observePage(), "DONE")]
    });
    const steps: JevStep[] = [];
    // 第一次动作之后就中止：下一轮循环开头必须立刻退出，不再发任何请求。
    const result = await runJevLoop(deps, "点一下", 10, controller.signal, (step) => {
      steps.push(step);
      controller.abort();
    });
    expect(result.outcome).toBe("aborted");
    expect(steps).toHaveLength(1);
    expect(calls.filter((call) => call.op === "jevAct")).toHaveLength(1);
  });

  it("records WAIT without touching the browser and keeps going", async () => {
    const { deps, calls } = makeDeps({
      decisions: [decisionFor(observePage(), "WAIT"), decisionFor(observePage(), "DONE")]
    });
    const result = await runJevLoop(deps, "等页面加载", 5, undefined);
    expect(result.steps[0]!.operation).toBe("WAIT");
    expect(result.steps[0]!.detail).toContain(`等待 ${JEV_WAIT_MS}ms`);
    expect(calls.some((call) => call.op === "jevAct" || call.op === "scroll")).toBe(false);
    expect(result.outcome).toBe("done");
  });

  it("maps a scroll decision onto the existing scroll primitive", async () => {
    const { deps, calls } = makeDeps({
      decisions: [decisionFor(observePage(), "SCROLL_DOWN"), decisionFor(observePage(), "DONE")]
    });
    const result = await runJevLoop(deps, "往下看", 5, undefined);
    expect(result.steps[0]!.operation).toBe("SCROLL_DOWN");
    expect(calls.find((call) => call.op === "scroll")).toMatchObject({ op: "scroll", direction: "down", amount: 560 });
  });

  it("stops when the page stops responding to actions (stall heuristic)", async () => {
    // 页面永远返回同一份文本 → pageChanged 恒为 false。
    const { deps } = makeDeps({ decisions: [decisionFor(observePage(), "CLICK", 2)], pages: [observePage()] });
    const result = await runJevLoop(deps, "点不动的按钮", 20, undefined);
    expect(result.outcome).toBe("blocked");
    expect(result.steps).toHaveLength(3);
    expect(result.notice).toContain("没有变化");
  });

  it("returns control after one step when autopilot is off", async () => {
    const { deps, calls } = makeDeps({
      jev: settings({ autoPilot: false }),
      decisions: [decisionFor(observePage(), "CLICK", 2)]
    });
    const result = await runJevLoop(deps, "一步一交回", 10, undefined);
    expect(result.outcome).toBe("manual");
    expect(result.steps).toHaveLength(1);
    expect(calls.filter((call) => call.op === "jevAct")).toHaveLength(1);
  });

  it("refuses to run without settings, api key, or text helper", async () => {
    const disabled = makeDeps({ jev: settings({ enabled: false }), decisions: [] });
    await expect(runJevLoop(disabled.deps, "x", 3, undefined)).rejects.toThrow(/未启用/);

    const noKey = makeDeps({ apiKey: false, decisions: [] });
    await expect(runJevLoop(noKey.deps, "x", 3, undefined)).rejects.toThrow(/API Key 未配置/);

    const noHelper = makeDeps({ jev: settings({ textProvider: "", textModel: "" }), decisions: [] });
    await expect(runJevLoop(noHelper.deps, "x", 3, undefined)).rejects.toThrow(/文本助手模型未配置/);
  });

  it("surfaces a browser-side rejection instead of pretending success", async () => {
    const { deps } = makeDeps({
      decisions: [decisionFor(observePage(), "CLICK", 2)],
      requestFails: "jevAct"
    });
    await expect(runJevLoop(deps, "点一下", 5, undefined)).rejects.toThrow(/已不在页面中/);
  });
});

describe("browser_jev_run tool", () => {
  const tool = (options: Parameters<typeof makeDeps>[0]) => {
    const made = makeDeps(options);
    return { ...made, tool: buildJevTools(made.deps).find((entry) => entry.name === "browser_jev_run")! };
  };

  it("registers exactly one tool and clamps maxSteps from the argument", async () => {
    const made = tool({ decisions: [decisionFor(observePage(), "DONE")] });
    expect(buildJevTools(made.deps)).toHaveLength(1);
    const result = (await execute(made.tool, { goal: "看看", maxSteps: 999 })) as { content: { text: string }[] };
    expect(result.content[0]!.text).toContain("Jev 快速执行");

    const capped = tool({ decisions: [decisionFor(observePage(), "CLICK", 2)] });
    const trace = (await execute(capped.tool, { goal: "永远点", maxSteps: 999 })) as { content: { text: string }[] };
    // 999 被夹到硬上限 100：这里只断言「没有按 999 跑」——轨迹行数不超过 100。
    expect(trace.content[0]!.text.split("\n").length).toBeLessThan(110);
  });

  it("rejects an empty goal before any browser call", async () => {
    const made = tool({ decisions: [] });
    await expect(execute(made.tool, { goal: "   " })).rejects.toThrow(/目标/);
    expect(made.calls).toHaveLength(0);
  });

  it("reports the disabled state without touching the browser", async () => {
    const made = tool({ jev: settings({ enabled: false }), decisions: [] });
    await expect(execute(made.tool, { goal: "x" })).rejects.toThrow(/未启用/);
    expect(made.calls).toHaveLength(0);
  });

  it("keeps the definition lean enough for a permanently-off switch", () => {
    // 这个工具只在开关打开时注入（关闭时前缀成本为 0），所以预算比常驻的
    // browser_* 宽松（它们的口径是 <200）；但仍要有上界，防止描述长成教程。
    const made = tool({ decisions: [] });
    const tokens = estimateToolTokens([{ name: made.tool.name, description: made.tool.description, parameters: made.tool.parameters }]);
    expect(tokens).toBeLessThan(400);
  });
});
