// Jev（TypeSafe 快速决策通路）工具簇（utility 进程）。
//
// 与现有 browser_* 的关系：**并行**，不替代。browser_* 是「主模型逐步决策」的
// 通路（@eN 索引 + 签名）；本簇是「Jev 逐步决策、主模型只给一次目标」的通路，
// 元素身份用页面侧 WeakMap 分配的稳定 nodeId。两者各自独立演进，互不依赖。
//
// 为什么是**一个**工具 + 内部循环：Jev 的价值就在于「每步一次网络往返且由它决策」，
// 若每步都回主模型，省下的往返立刻又付回去。所以循环跑在工具层，主模型只在入口处
// 看到目标、在出口处看到轨迹；每一步都通过 RPC 落到主进程的 CDP 控制器，因此每次
// 操作各自计时（不会被单次请求的 110/120 秒上限绑住）。
//
// 循环形状对齐 jev-ultrafast/agent.py：**观察 → 决策 → 执行 → 再观察**，且后一次
// 观察同时充当下一轮决策的输入（不为「看变化」额外付一次观察）。
//
// 四道刹车（全部可被单测钉住）：
// 1. 步数上限（默认 30，可配 1–100）；
// 2. 敏感页面启发式（登录/验证码/支付）——命中即停，且**不消耗** TypeSafe 请求；
// 3. TypeSafe 响应的形状校验（概率未归一/编号不匹配 → 不执行任何动作）；
// 4. AbortSignal（用户按「停止」在下一步边界生效）。
//
// 权限：工具入口（toolRisk）走 browse 轴一次确认；循环内部不再逐次过门——那一次
// 确认就是用户的授权边界。这一点必须写在工具描述里让模型与用户都看得见。

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { JEV_DEFAULT_MAX_STEPS, JEV_MAX_STEPS_LIMIT, type BrowserAutomationRequest, type BrowserAutomationResult, type JevObservePage, type JevSettings } from "../shared/protocol.js";
import { buildActionSpace, buildJevRequest, resolveDecision, validateChoice, type JevHistoryEntry, type JevOperation } from "./jev-action-space.js";
import { askJev, buildJevProbe, detectSensitivePage, JEV_PROBE_EXPECTED, JEV_PROBE_QUESTION, type JevAnswerBundle, type JevFetch } from "./jev-client.js";
import { TEXT_VALUE } from "./jev-questions.js";

/** 文本助手的系统提示（从 jev-questions 转出，便于接线处直接引用）。 */
export const TEXT_VALUE_PROMPT = TEXT_VALUE;

export { JEV_DEFAULT_MAX_STEPS, JEV_MAX_STEPS_LIMIT };
/** 页面级 WAIT 的时长（jev 用 100ms；这里保留同一量级，避免白等）。 */
export const JEV_WAIT_MS = 100;
/** 连续多少次「页面没变化」的非等待动作后判定阻塞（jev 同款启发式）。 */
export const JEV_STALL_LIMIT = 3;
/** 在导航中（求值暂时不可用）时的重试次数；超出则如实停止，不假装页面没变。 */
export const JEV_NAVIGATION_RETRIES = 3;
/** 两次导航重试之间的等待（页面通常在一帧到几百毫秒内可用）。 */
export const JEV_NAVIGATION_RETRY_MS = 250;

export interface JevTextRequest {
  goal: string;
  action: { label?: string; role?: string; value?: string };
  page: { title: string; text: string };
  recentActions: JevHistoryEntry[];
}

export interface JevToolDeps {
  /** 转发一个浏览器原语到主进程（jevObserve / jevAct / jevReset / scroll）。 */
  request: (op: BrowserAutomationRequest) => Promise<BrowserAutomationResult>;
  /** 读当前 Jev 配置（缺省/未配置 → 抛可读错误）。 */
  settings: () => JevSettings | undefined;
  /** TypeSafe 密钥（未配置时抛可读错误）。 */
  apiKey: () => string | undefined;
  /** 走一次 TypeSafe 决策（注入以便单测完全离线）。 */
  callJev: (query: { model: string; state: unknown; questions: Record<string, unknown> }) => Promise<JevAnswerBundle>;
  /** 为 TYPE_TEXT 生成字段值（注入以便单测完全离线）。 */
  writeFieldText: (request: JevTextRequest) => Promise<string>;
  /** 等待（注入让单测不必真的睡）。 */
  wait?: (ms: number) => Promise<void>;
  /** 总开关（settings.jev.enabled === true 才算开；工具本身只在开启时注入，这里再兜一层）。 */
  enabled?: () => boolean;
}

export const JEV_DISABLED_TEXT = "Jev 快速决策未启用（设置 › 通用 › Jev 快速决策）。内网环境通常没有 TypeSafe，请保持关闭或改用 browser_snapshot / browser_click 手动路径。";

function requireSettings(deps: JevToolDeps): JevSettings {
  const jev = deps.settings();
  if (!jev?.enabled) throw new Error(JEV_DISABLED_TEXT);
  if (!jev.textProvider || !jev.textModel) {
    throw new Error("Jev 的文本助手模型未配置（设置 › 通用 › Jev 快速决策）：TYPE_TEXT 需要一个已配置的模型来写字段值，Jev 本身只做选择。");
  }
  return jev;
}

function requireKey(deps: JevToolDeps): string {
  const key = deps.apiKey();
  if (!key) throw new Error("TypeSafe API Key 未配置（设置 › 通用 › Jev 快速决策）：请填写密钥后再使用。");
  return key;
}

const ok = (result: BrowserAutomationResult): Extract<BrowserAutomationResult, { ok: true }> => {
  if (!result.ok) throw new Error(result.error);
  return result;
};

/** 一步的执行轨迹（回执与 details 共用）。 */
export interface JevStep {
  index: number;
  operation: JevOperation;
  label: string;
  confidence: number;
  text?: string;
  detail: string;
  pageChanged: boolean | null;
  latencyMs: number;
  elapsedMs: number;
}

export type JevOutcome = "done" | "blocked" | "limit" | "aborted" | "sensitive" | "manual";

export interface JevRunResult {
  text: string;
  steps: JevStep[];
  outcome: JevOutcome;
  notice?: string;
}

/**
 * 跑完整循环。返回回执文本与结构化轨迹（不分进程边界，便于单测直接断言）。
 *
 * 顺序纪律（jev 的既有取舍）：
 * - 先观察再决策，决策只引用这一帧的编号；
 * - 执行后**立刻**记录这一步（再观察），页面导航也不丢记录；
 * - 文本只在 TYPE_TEXT 时生成一次，且生成后复核页面未变（变了就丢，不硬塞）。
 */
export async function runJevLoop(
  deps: JevToolDeps,
  goal: string,
  maxSteps: number,
  signal: AbortSignal | undefined,
  onStep?: (step: JevStep) => void
): Promise<JevRunResult> {
  const jev = requireSettings(deps);
  requireKey(deps);
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const history: JevHistoryEntry[] = [];
  const steps: JevStep[] = [];
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  let reason: string | undefined;

  const observe = async (): Promise<JevObservePage> => {
    const observed = ok(await deps.request({ op: "jevObserve" }));
    return observed.data.kind === "jevObserve" ? observed.data.page : (() => {
      throw new Error("Jev 观察返回了意外结果");
    })();
  };
  /**
   * 观察一帧，容忍「页面正在导航」。
   *
   * 为什么要容忍：点击链接/提交表单后紧接着的观察**必然会**撞上导航中的那一刻，
   * 主进程的 `Runtime.evaluate` 那时会以「页面脚本执行失败：Cannot find context with
   * specified id」收场（jev 侧对应的是 `StalePage("Document is navigating")`，它的处理是
   * **重新观察**而不是终结整次运行）。这里同理：短暂等待后重试，重试仍失败才把
   * 「反复观察不到页面」当作不可恢复的状态上报——不假装页面没变、也不静默丢弃这一步。
   */
  const observeSettled = async (): Promise<{ page: JevObservePage } | { failure: string }> => {
    let lastError = "页面不可读取";
    for (let attempt = 0; attempt <= JEV_NAVIGATION_RETRIES; attempt++) {
      try {
        return { page: await observe() };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < JEV_NAVIGATION_RETRIES) await wait(JEV_NAVIGATION_RETRY_MS);
      }
    }
    return { failure: lastError };
  };
  const finish = (outcome: JevOutcome): JevRunResult => ({
    text: [`【Jev 快速执行】目标：${goal}`, steps.length > 0 ? steps.map(renderStep).join("\n") : "（尚未执行任何动作）", outcomeText(outcome, steps.length, maxSteps, reason)].join("\n"),
    steps,
    outcome,
    ...(reason ? { notice: reason } : {})
  });
  const record = (step: JevStep): void => {
    steps.push(step);
    onStep?.(step);
  };

  let initial = await observeSettled();
  if ("failure" in initial) {
    reason = `无法读取当前页面：${initial.failure}。请确认内置浏览器里有已打开的页面后重试。`;
    return finish("blocked");
  }
  let page = initial.page;
  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) return finish("aborted");

    // 敏感页面刹车放在**决策之前**：这类页面不该让 Jev 参与，也省一次请求。
    const sensitive = detectSensitivePage(page);
    if (sensitive) {
      reason = `页面需要用户本人操作：${sensitive}。已把控制权交回，请手动完成这一步后再继续。`;
      return finish("sensitive");
    }

    const space = buildActionSpace(page);
    const hasControl = space.operations.SCROLL_UP !== undefined || space.operations.SCROLL_DOWN !== undefined;
    if (Object.keys(space.targets).length === 0 && !hasControl) {
      reason = "当前页面没有可操作的元素（也没有可滚动内容），且上游要求不得凭猜测继续。";
      return finish("blocked");
    }
    const requestBody = buildJevRequest(goal, page, space, history);
    // 注意：这里只问决策，绝不触碰页面——所以请求重试不可能导致重复点击。
    const answer = await deps.callJev({ model: jev.model, state: requestBody.state, questions: requestBody.questions });
    const decision = resolveDecision(answer.answers, space);

    if (decision.terminal === "DONE") {
      record({ index: step, operation: "DONE", label: "—", confidence: decision.confidence, detail: "Jev 判定全部要求已满足", pageChanged: null, latencyMs: answer.latencyMs, elapsedMs: elapsed() });
      return finish("done");
    }
    if (decision.terminal === "BLOCKED") {
      reason = "Jev 判定当前页面上没有任何受支持的操作能推进目标（可能是页面不支持，或需要的能力超出范围）。";
      record({ index: step, operation: "BLOCKED", label: "—", confidence: decision.confidence, detail: reason, pageChanged: null, latencyMs: answer.latencyMs, elapsedMs: elapsed() });
      return finish("blocked");
    }
    if (decision.wait) {
      await wait(JEV_WAIT_MS);
      record({ index: step, operation: "WAIT", label: "—", confidence: decision.confidence, detail: `等待 ${JEV_WAIT_MS}ms`, pageChanged: null, latencyMs: answer.latencyMs, elapsedMs: elapsed() });
      history.push({ action: "等待", kind: "wait", page_changed: null });
      const next = await observeSettled();
      if ("failure" in next) {
        reason = `等待后无法读取页面：${next.failure}。`;
        return finish("blocked");
      }
      page = next.page;
      continue;
    }
    if (decision.scroll !== undefined) {
      const direction = decision.scroll > 0 ? "down" : "up";
      ok(await deps.request({ op: "scroll", direction, amount: 560 }));
      record({ index: step, operation: direction === "down" ? "SCROLL_DOWN" : "SCROLL_UP", label: "—", confidence: decision.confidence, detail: `页面滚动：${direction === "down" ? "向下" : "向上"} 560px`, pageChanged: null, latencyMs: answer.latencyMs, elapsedMs: elapsed() });
      history.push({ action: `滚动（${direction === "down" ? "下" : "上"}）`, kind: "scroll", page_changed: null });
      const next = await observeSettled();
      if ("failure" in next) {
        reason = `滚动后无法读取页面：${next.failure}。`;
        return finish("blocked");
      }
      page = next.page;
      continue;
    }

    const target = decision.target!;
    let text: string | undefined;
    if (decision.operation === "TYPE_TEXT") {
      // 文本生成前后各复核一次 URL：生成耗时可能跨到页面已导航，这时不该硬塞。
      const before = page.url;
      const generated = await deps.writeFieldText({
        goal,
        action: { label: target.label, role: target.role, value: target.currentValue },
        page: { title: page.title, text: page.pageText },
        recentActions: history
      });
      const value = typeof generated === "string" ? generated.trim() : "";
      if (!value) {
        reason = `无法为字段「${target.label}」推断出值（文本助手返回空）。请把该值写进目标后重试。`;
        return finish("blocked");
      }
      if (page.url !== before) {
        reason = "生成字段值期间页面已变化，已放弃该次输入（不硬塞）。";
        return finish("blocked");
      }
      text = value;
    }
    const executed = await deps.request({
      op: "jevAct",
      nodeId: target.nodeId,
      action: target.action,
      ...(text !== undefined ? { text } : {})
    });
    const applied = ok(executed);
    const detail = applied.data.kind === "jevAct" ? applied.data.description : target.label;
    const stepRecord: JevStep = {
      index: step,
      operation: decision.operation,
      label: target.label,
      confidence: decision.confidence,
      ...(text !== undefined ? { text } : {}),
      detail,
      // 先记录再观察：下一步观察若遇到导航，这一步的执行事实不会丢。
      pageChanged: null,
      latencyMs: answer.latencyMs,
      elapsedMs: elapsed()
    };
    history.push({ action: target.label, kind: target.action.kind, text: text ?? null, page_changed: null });
    // 执行后立刻观察：它同时是「这一步有没有改变页面」的证据与下一轮的输入（jev 同款，
    // 不为「看变化」额外付一次往返）。
    const after = await observeSettled();
    if ("failure" in after) {
      // 连重试都读不到页面：把**已发生的执行事实**先入库（记录纪律：执行先于观察），
      // 再如实停止，而不是静默丢掉这一步。
      stepRecord.pageChanged = null;
      record(stepRecord);
      reason = `已执行「${target.label}」，但之后无法读取页面：${after.failure}。请重新观察页面后决定是否继续。`;
      return finish("blocked");
    }
    stepRecord.pageChanged = pageChangedBetween(page, after.page);
    history[history.length - 1]!.page_changed = stepRecord.pageChanged;
    record(stepRecord);

    // 停滞启发式（jev 同款）：连续多次动作都没让页面变化，这条路走不通。
    const recent = steps.slice(-JEV_STALL_LIMIT);
    if (recent.length === JEV_STALL_LIMIT && recent.every((item) => item.pageChanged === false)) {
      reason = `连续 ${JEV_STALL_LIMIT} 次操作页面都没有变化，判定无法继续推进。`;
      return finish("blocked");
    }
    page = after.page;
    if (jev.autoPilot === false) return finish("manual");
  }
  return finish("limit");
}

/**
 * 两个观察帧之间「页面变了吗」。
 *
 * 为什么不能只看 URL + 可见文本（旧实现的缺陷）：**点击复选框、切换开关、选中 tab
 * 都不改页面文本**，于是那一步会被判成「没有变化」；连着几次就被停滞启发式误判为
 * 「这条路走不通」而提前 blocked。关键是这个缺陷**只在等待步不参与判断时才会暴露**
 * ——jev 原版正是用 `all(h["kind"] != "wait")` 把那类步排除掉，同时它的 `fingerprint()`
 * 把 `actions`（每个元素的当前值/勾选态/展开态）一并算进摘要，所以「勾选态翻转」
 * 在它那里**就是**页面变化。
 *
 * 这里补上后者（元素状态）：与结构无关，只比逐项的 nodeId + 值，顺序变了也不误报。
 * 不把坐标/遮挡算进来——它们随滚动与悬停瞬时变化（与 `elementSignature` 同一取舍）。
 */
export function pageChangedBetween(before: JevObservePage, after: JevObservePage): boolean {
  if (before.url !== after.url || before.pageText !== after.pageText) return true;
  if (before.items.length !== after.items.length) return true;
  for (let index = 0; index < before.items.length; index += 1) {
    const left = before.items[index]!;
    const right = after.items[index]!;
    if (left.nodeId !== right.nodeId || left.role !== right.role) return true;
    if ((left.value ?? "") !== (right.value ?? "")) return true;
    if ((left.checked ?? null) !== (right.checked ?? null)) return true;
    if ((left.selected ?? null) !== (right.selected ?? null)) return true;
    if ((left.expanded ?? null) !== (right.expanded ?? null)) return true;
  }
  return false;
}

function renderStep(step: JevStep): string {
  const targeted = step.operation === "CLICK" || step.operation === "TYPE_TEXT" || step.operation === "SELECT";
  const confidence = step.operation === "DONE" || step.operation === "BLOCKED" ? "" : ` 置信度 ${(step.confidence * 100).toFixed(0)}%`;
  const text = step.text ? ` 填入：${JSON.stringify(step.text.slice(0, 60))}` : "";
  return `${step.index}. ${step.operation}${targeted ? ` ${step.label}` : ""}${text}${confidence} — ${step.detail}（决策 ${step.latencyMs}ms，累计 ${step.elapsedMs}ms）`;
}

function outcomeText(outcome: JevOutcome, count: number, maxSteps: number, reason?: string): string {
  switch (outcome) {
    case "done":
      // jev 的既有纪律：DONE 是选择，不是证明。独立复核留给主模型。
      return "结果：Jev 判定目标已达成。注意：DONE 只是 Jev 的判断，**不是独立验证**——如需确认，请用 browser_get / browser_snapshot 复核页面。";
    case "blocked":
      return `结果：已停止（第 ${count} 步）。${reason ?? ""}`;
    case "limit":
      return `结果：已达步数上限（${maxSteps} 步）仍未结束。可调大设置里的上限后重试，或用 browser_* 手动继续。`;
    case "aborted":
      return `结果：被用户中止（第 ${count} 步）。已执行的动作不会回滚，页面停留在当前状态。`;
    case "sensitive":
      return `结果：主动停下（第 ${count} 步）。${reason ?? ""}`;
    case "manual":
      return "结果：自动驾驶已关闭，走完一步后交回。请查看页面现状后决定是否再次调用 browser_jev_run 继续。";
    default:
      return "";
  }
}

/** 工具入口：解析参数 → 跑循环 → 渲染回执。 */
export function buildJevTools(deps: JevToolDeps): ToolDefinition[] {
  return [
    defineTool({
      name: "browser_jev_run",
      label: "Jev 快速浏览器执行",
      description: [
        "用 Jev（TypeSafe）快速决策通路在内置浏览器里连续执行一个目标：它每步自己做「操作 + 目标」的选择（一次网络往返决定一步，比主模型逐步操作快得多），你只需给出目标。",
        "返回逐步轨迹（每步的操作、元素、置信度、耗时）。四种情况会主动停下并交回控制权：需要登录/验证码/支付、Jev 判定阻塞、步数上限、用户停止。",
        "授权范围：调用本工具一次即授权它对当前标签页连续操作（前置条件：设置里已启用 Jev 并填好 TypeSafe 密钥、配好文本助手模型）。",
        "适用：结构清晰、字段可枚举的页面（搜索、筛选、填表、多步导航）。不适用：需要登录/验证码/支付、canvas 或复杂键盘交互、跨标签页、需要独立复核的场景——那些用 browser_snapshot + browser_click 手动做。",
        "Jev 的结论只是它的判断，不是独立验证；要求「确认结果」时请再用 browser_get / browser_snapshot 复核。"
      ].join(""),
      promptSnippet: "browser_jev_run: 让 Jev 连续操作浏览器完成一个目标（需在设置里启用）",
      parameters: Type.Object({
        goal: Type.String({ description: "要完成的完整目标（自然语言，写清全部要求，例如「把出发地设为北京、目的地上海、日期 2026-10-01，然后搜索」）" }),
        maxSteps: Type.Optional(Type.Integer({ description: `本次最多执行多少步（默认取设置值，上限 ${JEV_MAX_STEPS_LIMIT}）`, minimum: 1, maximum: JEV_MAX_STEPS_LIMIT }))
      }),
      execute: async (_id, params, signal, onUpdate) => {
        if (deps.enabled && !deps.enabled()) throw new Error(JEV_DISABLED_TEXT);
        const jev = requireSettings(deps);
        const goal = typeof params?.goal === "string" ? params.goal.trim() : "";
        if (!goal) throw new Error("请提供要完成的目标");
        const requested = typeof params?.maxSteps === "number" && Number.isFinite(params.maxSteps) ? Math.round(params.maxSteps) : undefined;
        const maxSteps = Math.min(JEV_MAX_STEPS_LIMIT, Math.max(1, requested ?? jev.maxSteps));
        const result = await runJevLoop(deps, goal, maxSteps, signal, (step) => {
          // 每步流式上报：用户能在时间线上看到 Jev 走到哪了（details 只在结束时给全量）。
          onUpdate?.({
            content: [{ type: "text", text: `Jev ${step.index}. ${step.operation}${step.label !== "—" ? ` ${step.label}` : ""}` }],
            details: { outcome: "running", steps: step.index }
          });
        });
        return {
          content: [{ type: "text", text: result.text }],
          details: { outcome: result.outcome, steps: result.steps.length, ...(result.notice ? { notice: result.notice } : {}) }
        };
      }
    })
  ];
}

/** 用注入的 askJev 组装 callJev（把配置解析留在纯模块里，便于单测）。 */
export function makeJevCaller(config: { baseUrl: string; apiKey: string }, fetchJev?: JevFetch) {
  return (query: { model: string; state: unknown; questions: Record<string, unknown> }) =>
    askJev({ ...query, baseUrl: config.baseUrl, apiKey: config.apiKey }, fetchJev);
}

export interface JevProbeResult {
  ok: boolean;
  /** 给人看的一句话（成功时也带模型与延迟，便于分辨「连不上」与「答得怪」）。 */
  message: string;
  model?: string;
  latencyMs?: number;
}

/**
 * 连通性探测（设置页的「测试连接」）。
 *
 * 只做一件事：拿用户填的地址与密钥发一次**真实的**决策请求，把响应过一遍
 * `validateChoice`。不碰页面、不读会话、不写真配置，也不要求先启用 Jev。
 *
 * 失败时把原因说清（网络不可达 / 密钥被拒 / 响应形状不对），因为这一步常见的三种
 * 失败在用户眼里长得很像，而后续行为完全不同：修网络、换密钥、或者改网关配置。
 * 内网拿不到 TypeSafe 是预期情况，所以提示里直接给出「保持关闭」的退路。
 */
export async function probeJev(
  config: { baseUrl: string; model: string; apiKey: string },
  fetchJev?: JevFetch,
  signal?: AbortSignal
): Promise<JevProbeResult> {
  const baseUrl = config.baseUrl.trim();
  const apiKey = config.apiKey.trim();
  const model = config.model.trim() || "jev-latest";
  if (!baseUrl) return { ok: false, message: "请先填写 TypeSafe 接口地址（例如 https://api.typesafe.ai/v1）。" };
  if (!apiKey) return { ok: false, message: "请先填写 TypeSafe API Key，否则无法验证连通性。" };
  let bundle: JevAnswerBundle;
  const probe = buildJevProbe(model);
  try {
    bundle = await askJev({ baseUrl, apiKey, model: probe.model, state: probe.state, questions: probe.questions }, fetchJev, signal);
  } catch (error) {
    // askJev 已经把网络/HTTP 错误转成了可行动的中文，直接转述。
    return { ok: false, message: `连接失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const answer = bundle.answers?.[JEV_PROBE_QUESTION];
  let choice: string;
  try {
    choice = validateChoice(answer, [JEV_PROBE_EXPECTED, "disconnect"]).choice;
  } catch (error) {
    return {
      ok: false,
      message: `已连上 TypeSafe，但响应不符合预期形状（${error instanceof Error ? error.message : String(error)}）。检查接口地址是否指向 TypeSafe 的 /v1，或网关是否改写了响应。`,
      latencyMs: bundle.latencyMs
    };
  }
  if (choice !== JEV_PROBE_EXPECTED) {
    return { ok: false, message: `已连上 TypeSafe，但模型答的不是预期的「已到达」选项（选了 ${choice}），请确认端点与模型名。`, latencyMs: bundle.latencyMs };
  }
  const answered = bundle.model ? `模型 ${bundle.model}` : `模型 ${model}`;
  return { ok: true, message: `连接成功（${answered}，${bundle.latencyMs}ms）。`, model: bundle.model ?? model, latencyMs: bundle.latencyMs };
}
