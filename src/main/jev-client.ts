// TypeSafe（Jev）HTTP 客户端：一次请求问出「操作 + 目标」的全部答案。
//
// 协议（官方 API 与网关一致）：
//   POST {baseUrl}/systemone          ← baseUrl 已含 /v1
//   Authorization: Bearer <key>
//   { model, state, questions }  →  { model, answers, usage }
//
// 客户端只做两件事：把网络/HTTP 错误转成可行动的中文错误，以及把响应体交回给
// jev-action-space 做**形状校验**（校验不通过就不执行任何动作，见那里的 validateChoice）。
//
// 注入 `fetchJev` 而不是直接用 fetch：单测不打网络也能覆盖退避与错误映射。

const RETRYABLE_STATUS = new Set([429, 503, 529]);
const MAX_ATTEMPTS = 3;

export interface JevAnswerBundle {
  answers: Record<string, unknown>;
  /** 实际回答的模型版本（alias 请求时也可能是具体版本；日志/回执用）。 */
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** 本次请求耗时（毫秒）。 */
  latencyMs: number;
}

export type JevFetch = (url: string, body: unknown, apiKey: string, signal?: AbortSignal) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export const defaultJevFetch: JevFetch = async (url, body, apiKey, signal) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  });
  return { status: response.status, json: () => response.json() as Promise<unknown>, text: () => response.text() };
};

export interface JevQuery {
  baseUrl: string;
  apiKey: string;
  model: string;
  state: unknown;
  questions: Record<string, unknown>;
}

/**
 * 连通性探测的**固定问法**：两个选项，期望 Jev 选 `connect`。
 *
 * 为什么不能拿一个空对象/假问题去测：那只能证明「服务器回了 200」，证明不了
 * 「我们的请求形状与响应形状对得上」。真实用途下的失败大多出在这一层——地址对了、
 * 密钥也对了，但网关换了一版、响应字段改了，于是每一步都报「无效响应，不执行任何
 * 动作」。所以探测必须走**同一套校验**（`validateChoice`），并且固定正确答案，
 * 这样「连得上」「答得对」「答得能过校验」三件事一次问清。
 */
export const JEV_PROBE_QUESTION = "jev-connectivity-probe";
export const JEV_PROBE_SYSTEM = "This is a connectivity check for the Typesafe/jev API. Pick the option that means the request arrived.";
export const JEV_PROBE_EXPECTED = "connect";

/** 探测请求体（与业务问法同一个 `questions` 形状，故能真实验证协议兼容性）。 */
export function buildJevProbe(model: string): { model: string; state: unknown; questions: Record<string, unknown> } {
  return {
    model,
    state: "connectivity probe",
    questions: {
      [JEV_PROBE_QUESTION]: {
        type: "choice",
        criteria: { connect: "the request reached the Typesafe API and this question is answered by jev", disconnect: "the request did not reach the API" },
        instructions: { system: JEV_PROBE_SYSTEM }
      }
    }
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从错误响应体里抽出人类可读的一句原因。
 *
 * 形状来自**真实端点实测**（2026-09-21）：缺少密钥回 403、密钥不对回 401，两者都是
 * `{"detail":{"error_type":"authentication_error","message":"…"}}`。
 * 直接把整包 JSON 丢给用户/模型看既不友好也不可操作，所以优先取
 * `detail.message` → `message` → `error.message`，都取不到才回落原文截断。
 */
export function extractErrorDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const detail = parsed.detail && typeof parsed.detail === "object" ? (parsed.detail as Record<string, unknown>) : undefined;
    for (const candidate of [detail?.message, parsed.message, (parsed.error as Record<string, unknown> | undefined)?.message]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 300);
    }
  } catch {
    // 不是 JSON（网关的 HTML 错误页等）——用原文。
  }
  return trimmed.slice(0, 300);
}

/**
 * 发一次决策请求。5xx/429/529 退避重试（最多 3 次），其余错误立刻抛出。
 *
 * 重要：**请求本身不重试页面动作**——重试的只是「问一次决策」。页面从不由这个
 * 函数触碰，所以重试不可能导致重复点击（jev 的「Never retry a browser mutation」
 * 在 PiDesktop 里由工具层的「先记录再观察」纪律承接）。
 */
export async function askJev(query: JevQuery, fetchJev: JevFetch = defaultJevFetch, signal?: AbortSignal, delay: (ms: number) => Promise<void> = sleep): Promise<JevAnswerBundle> {
  const url = `${query.baseUrl.replace(/\/+$/, "")}/systemone`;
  const body = { model: query.model, state: query.state, questions: query.questions };
  let lastError = "TypeSafe 请求失败";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    let response: Awaited<ReturnType<JevFetch>>;
    try {
      response = await fetchJev(url, body, query.apiKey, signal);
    } catch (error) {
      // 网络层错误（DNS/连接/TLS）不重试：内网环境失败一次就够，重试只是拖时间。
      throw new Error(`无法连接 TypeSafe（${url}）：${error instanceof Error ? error.message : String(error)}。请检查接口地址与网络——离线环境请关闭 Jev 快速决策。`);
    }
    if (response.status === 401 || response.status === 403) {
      // 官方端点实测（2026-09-21）：未带密钥 → 403，密钥不对 → 401，两者都是
      // `{"detail":{"error_type":"authentication_error","message":…}}`。把上游那句
      // 原话带上：它能区分「没填密钥」「密钥被吊销」「额度用完」，比笼统的「密钥被拒」有用。
      const detail = extractErrorDetail(await response.text().catch(() => ""));
      throw new Error(`TypeSafe 拒绝了 API Key（HTTP ${response.status}）${detail ? `：${detail}` : ""}。请在设置的 Jev 快速决策里检查密钥。`);
    }
    if (RETRYABLE_STATUS.has(response.status)) {
      lastError = `TypeSafe 暂时不可用（HTTP ${response.status}）`;
      if (attempt < MAX_ATTEMPTS - 1) {
        await delay(500 * 2 ** attempt);
        continue;
      }
      // 最后一次仍失败：直接给出「已重试 N 次」的终态，不再落到笼统的 HTTP 错误上
      // ——模型/用户据此能区分「临时故障」与「请求本身不对」。
      throw new Error(`${lastError}（已重试 ${MAX_ATTEMPTS} 次）。`);
    }
    if (response.status >= 400) {
      const detail = extractErrorDetail(await response.text().catch(() => ""));
      throw new Error(`TypeSafe 返回 HTTP ${response.status}${detail ? `：${detail}` : ""}。`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new Error("TypeSafe 返回的不是合法 JSON，本次不执行任何动作。");
    }
    const envelope = (parsed ?? {}) as { answers?: unknown; model?: unknown; usage?: unknown };
    if (!envelope.answers || typeof envelope.answers !== "object") {
      throw new Error("TypeSafe 响应里没有 answers 字段，本次不执行任何动作。");
    }
    return {
      answers: envelope.answers as Record<string, unknown>,
      ...(typeof envelope.model === "string" ? { model: envelope.model } : {}),
      ...(envelope.usage && typeof envelope.usage === "object" ? { usage: envelope.usage as JevAnswerBundle["usage"] } : {}),
      latencyMs: Date.now() - started
    };
  }
  throw new Error(`${lastError}（已重试 ${MAX_ATTEMPTS} 次）`);
}

/**
 * 敏感页面启发式刹车。
 *
 * 这是**启发式**，不是安全边界：它只负责在明显需要用户本人的地方（登录、验证码、
 * 支付、身份验证）主动停下并把事实交给用户与主模型。漏判的后果是「Jev 继续按普通
 * 页面处理」，不是越权——真正的授权边界仍是工具入口那一次权限确认。
 * 命中即停，也不消耗一次 TypeSafe 请求。
 *
 * 为什么中文不匹配裸的「登录」：**几乎每个网站导航栏都有一个「登录」链接**，裸匹配会
 * 让循环在最普通的页面上停下（比不停更糟）。所以只匹配带语境的写法（「请/立即/马上
 * （先）登录」「登录后」「登录账号」）以及「密码/验证码/扫码」这类强信号。英文同理，
 * 只匹配短语（`sign in with` / `log in to` / `please sign in`）而不是裸词。
 */
const SENSITIVE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /(验证码|校验码|短信码|动态码|图形码|滑块验证|扫码登录)/, reason: "页面要求验证码/扫码验证" },
  { pattern: /(请登录|先登录|立即登录|马上登录|登录后|登录账号|账号登录|注册账号|密码|口令)/, reason: "页面要求登录或输入密码" },
  { pattern: /(支付|付款|结算|收银台|确认下单|立即购买|提交订单)/, reason: "页面涉及支付/下单" },
  { pattern: /(验证你的身份|双重验证|二次验证|身份验证|verify your identity)/i, reason: "页面要求身份验证" },
  { pattern: /(please sign in|please log in|sign in to|log in to|sign in with|password|captcha|verification code|two-factor|2fa)/i, reason: "页面要求登录或验证码（英文界面）" },
  { pattern: /(payment|checkout|pay now|place order|confirm purchase|credit card)/i, reason: "页面涉及支付/下单（英文界面）" }
];

/** 命中即返回原因（写进回执），否则 undefined。 */
export function detectSensitivePage(page: { title?: string; pageText?: string; items?: { label?: string }[] }): string | undefined {
  const labels = (page.items ?? []).map((item) => item.label ?? "").join(" ");
  const haystack = `${page.title ?? ""} ${labels} ${page.pageText ?? ""}`;
  for (const { pattern, reason } of SENSITIVE_PATTERNS) {
    if (pattern.test(haystack)) return reason;
  }
  return undefined;
}
