// 导航结果判定（纯函数）：把 `loadURL` 的三种现实结局判成「完成 / 仍在加载 / 真失败」。
//
// 为什么需要这一层（2026-09-16 真 Electron 探针实测，见 docs 迭代记录与记忆
// 「PiDesktop 浏览器 CDP 探针事实」）：
//
// 1. **`loadURL` 可能永不 settle**。服务器只发响应头与部分正文、永不结束响应时
//    （长轮询 / 流式页 / 卡死的 dev server），探针实测 `loadURL` 挂住 >15 秒且
//    `contents.isLoading() === true`。此前没有独立预算，只能等 110 秒的通用看门狗，
//    回执只说「浏览器操作超时」——模型既不知道页面其实已经开始渲染，也不知道该干
//    什么。判定为「仍在加载」后回执能给出可执行的下一步（wait/snapshot）。
//
// 2. **`ERR_ABORTED (-3)` 不是失败**。同一标签上还有一次进行中的导航时再导航，
//    两条 `loadURL` 会互相 abort：探针实测「第二次导航」的 promise 以 -3 拒绝、
//    且错误文案里写的是**第一次**的 url；而标签最终稳稳停在第二次的目标 url 上
//    （`getURL()` = 目标、标题已更新）。这个假失败在真实会话里表现为「导航失败：
//    ERR_ABORTED」紧跟一次无意义的成功重试（审计里 2026-09-14 与 09-16 各一次）。
//    判据用**标签的真实落点**（currentUrl）而不是错误文案——文案里的 url 是不可信的。
//
// 3. 「仍在加载」与「失败」都必须与「完成」区分，但都**不是**错误：页面可能只是慢。

/** 一次导航等待 `loadURL` 落定的预算。超时按「仍在加载」放行，由看门狗兜底重活。 */
export const NAVIGATE_BUDGET_MS = 30_000;

export type NavigateOutcome = "done" | "still-loading" | "failed";

/**
 * 给 `loadURL` 一个独立预算。超时**不**取消导航（页面可能只是慢，取消反而把它弄成
 * 真失败——探针实测 `stop()` 会把一个正常加载中的页面变成 -3 拒绝），只把控制权
 * 还给调用方：导航在后台继续，`did-navigate` / `did-stop-loading` 照旧推进面板状态。
 * `onTimeout` 让调用方记下「这次是超时放行」，从而走「仍在加载」而不是「失败」。
 */
export async function withNavigationBudget(
  promise: Promise<unknown>,
  onTimeout: () => void,
  budgetMs = NAVIGATE_BUDGET_MS
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
  });
  try {
    const winner = await Promise.race([promise.then(() => "settled" as const), timeout]);
    if (winner === "timeout") onTimeout();
  } finally {
    clearTimeout(timer);
    // 逾期 settle 不能泄成 unhandled rejection。
    promise.catch(() => undefined);
  }
}

/** 归一化到可比较的 href（无效/空值原样返回，两侧同时无效即相等）。 */
function comparableUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

/**
 * 两个地址是否指向同一处。忽略末尾斜杠差异（`http://a:1` 与 `http://a:1/` 是同一页，
 * 而 `normalizeBrowserUrl` 会把后者作为规范形式返回）。
 */
export function sameUrl(a: string, b: string): boolean {
  const left = comparableUrl(a);
  const right = comparableUrl(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const strip = (value: string): string => value.replace(/\/+$/u, "");
  return strip(left) === strip(right);
}

/** `loadURL` 的拒绝是否有「其实已经到位」的可能（Chromium 的导航被抢占信号）。 */
export function isAbortedNavigation(message: string): boolean {
  return /ERR_ABORTED|\(-3\)|\baborted\b/iu.test(message);
}

/**
 * 判定一次导航的结局。`currentUrl` / `loading` 是**标签的真实状态**（来自
 * `WebContents.getURL()` / `isLoading()`），不是承诺的返回值——这是本模块存在的意义。
 */
export function resolveNavigateOutcome(input: {
  timedOut: boolean;
  error?: string;
  /** 本次导航的目标地址（已 normalize）。 */
  targetUrl: string;
  /** 标签此刻的真实 URL。 */
  currentUrl: string;
  /** 标签此刻是否仍在加载。 */
  loading: boolean;
}): NavigateOutcome {
  const { timedOut, error, targetUrl, currentUrl, loading } = input;
  if (timedOut) return "still-loading";
  if (!error) return "done";
  // 只有「被抢占」这一类错误值得回查真实落点：其他错误（证书、DNS、代理拒连）
  // 即便 url 侥幸相同也确实是失败，不能靠 url 相等洗白。
  if (!isAbortedNavigation(error)) return "failed";
  if (sameUrl(currentUrl, targetUrl)) return "done";
  if (loading) return "still-loading";
  return "failed";
}

/**
 * 把结局渲染成给模型的回执文案（含下一步建议）。失败返回 undefined，由调用方
 * 走既有错误路径；其余两种都算「已放行」，只是如实说明页面还在不在加载。
 *
 * 文案与旧版保持一致：done 仍是「已导航到 X（标题）。页面可能仍在加载，建议先
 * browser_wait…」——只多出一种 pending 变体，不改掉模型已经熟悉的措辞。
 */
export function describeNavigateOutcome(
  outcome: NavigateOutcome,
  url: string,
  title: string | undefined,
  seconds: number
): string | undefined {
  if (outcome === "failed") return undefined;
  const named = `${url}（${title || "标题未知"}）`;
  if (outcome === "done") {
    return `已导航到 ${named}。页面可能仍在加载，建议先 browser_wait（页面加载）再 browser_snapshot。`;
  }
  return `已导航到 ${named}，但页面在 ${seconds} 秒内仍未加载完（服务器在慢响应、或页面持续加载中）——已放行，未视为失败。可稍后用 browser_wait（页面加载）或 browser_snapshot 查看当前渲染出来的内容。`;
}
