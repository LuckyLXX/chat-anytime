/**
 * 面板作品（Gallery kind = "panel"）的数据契约与纯逻辑。
 *
 * 作者视角的契约只有一条：面板 HTML **相对自己**取 `./__pidesktop_state.json`，
 * 就能拿到本机的会话执行状态（只读），并可用 POST + `{action:"show-main"}` 唤回主界面。
 * 相对路径是刻意的——作者不需要知道静态服务的端口与 token，页面放在工作区任何
 * 子目录里都能解析到同一个端点（见 browser-static-server 的虚拟端点拦截）。
 *
 * 与本模块的分工：类型在 `shared/protocol.ts`（它属于运行时协议），这里只放
 * 「端点名 + 白名单动作 + 三个纯函数」，让 main、utility 与单测共用同一份判定。
 */

import type { PanelSessionLive, Todo } from "./protocol.js";

/**
 * 虚拟端点的**文件名**（不是完整路径）。
 *
 * 端点由 loopback 静态服务在 `stat` 之前拦截，与面板页面同源同 token，因此
 * `fetch("./__pidesktop_state.json")` 在任何挂载目录下都成立。取名带 `__pidesktop_`
 * 前缀是为了让「工作区里真恰好有个同名文件」的概率低到可以忽略；真撞上时端点优先，
 * 面板拿到的仍是状态 JSON（这是有意的取舍：面板的可用性比文件可达性重要）。
 */
export const PANEL_STATE_ENDPOINT = "__pidesktop_state.json";

/** 端点允许的动作。**只有白名单里的动作能被执行**，其余一律 403。 */
export const PANEL_ACTIONS = ["show-main"] as const;

export type PanelAction = (typeof PANEL_ACTIONS)[number];

/** 请求体体积上限：端点只接受一个短动作，超过即拒绝（避免被当成上传通道）。 */
export const PANEL_ACTION_MAX_BYTES = 4096;

/** 面板展示的 todo 上限：面板是概览不是任务面板，超过只截断。 */
export const PANEL_TODO_LIMIT = 50;

/**
 * 解析 POST body 里的动作（纯函数）。非法输入一律 undefined（调用方回 403），
 * 不做「猜一个默认动作」这种兜底——一个能被随便猜出动作的写入口不值得存在。
 */
export function parsePanelAction(body: unknown): PanelAction | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const action = (body as Record<string, unknown>).action;
  if (typeof action !== "string") return undefined;
  const normalized = action.trim();
  return (PANEL_ACTIONS as readonly string[]).includes(normalized) ? (normalized as PanelAction) : undefined;
}

/**
 * 请求路径是否命中虚拟端点。
 *
 * `rel` 是静态服务解出的挂载相对路径（以 `/` 开头，可能带任意层子目录）。
 * 只按**最后一段**精确匹配，所以同名前缀的文件（`__pidesktop_state.json.bak`）
 * 不会被误判成端点。
 */
export function isPanelStatePath(rel: string): boolean {
  const normalized = rel.startsWith("/") ? rel : `/${rel}`;
  return normalized === `/${PANEL_STATE_ENDPOINT}` || normalized.endsWith(`/${PANEL_STATE_ENDPOINT}`);
}

/** todo 进度汇总（面板进度条与计数）。 */
export function summarizeTodos(todos: readonly Todo[]): PanelSessionLive["todoSummary"] {
  let completed = 0;
  let inProgress = 0;
  for (const todo of todos) {
    if (todo.status === "completed") completed += 1;
    else if (todo.status === "in_progress") inProgress += 1;
  }
  return { total: todos.length, completed, inProgress };
}

/**
 * 面板入口的扩展名白名单：面板是一个**网页**，不是任意文件。
 * 与缩略图资格（galleryThumbEligible）同一个正则口径，故意重复一处是有主的：
 * 这里拦的是「开一个窗口」，那里决定的是「要不要截图」。
 */
export function isPanelEntryFile(filePath: string): boolean {
  return /\.(?:html?|svg)$/iu.test(filePath);
}

/**
 * 面板页面的开发提示（拼进「继续开发」的注入文本）：把数据接口写清楚，
 * 否则下一次接手改面板的模型只能靠猜。
 */
export function panelDevHint(): string {
  return `面板型作品：入口网页会被开成独立小窗口（脱离主界面存活）。数据接口：相对自己 fetch("./${PANEL_STATE_ENDPOINT}") 得到只读状态 JSON；POST 同一地址 {"action":"show-main"} 唤回主界面。面板里**可以直接 fetch 外部 http(s) API**（包括没有 CORS 的自建/中转模型服务）：跨域由平台在主进程统一处理，不要自己搭本地代理。`;
}
