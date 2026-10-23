// 钩子上下文里的会话标题（`{sessionTitle}` 占位符）解析。
//
// 优先级与面板投影（pi-runtime 的 buildLiveSessions）保持同一套：
// 侧边栏标题 → 会话文件里的名字（session_info 的 name）→ 短 id。
//
// **为什么不能只查侧边栏**（2026-10-23 用户报「整个会话没完成就弹窗了」的误判
// 来源）：侧边栏列表只覆盖「当前激活角色 + 当前工作区」的会话目录，跨角色 /
// 后台自动化会话跑在自己的 agent 目录里，永远查不到 ⇒ 通知正文退化成裸 UUID：
//
//   PiDesktop：任务完成
//   [01a16646-437f-720d-aca6-7fbb38bd64d16] 已完成本轮回复（1 分 18 秒）
//
// 用户当时正在看的是另一个还在跑的会话（650 秒、还排着一条待发消息），把这行
// 读成了「我这个会话没跑完就弹窗」。会话文件里的名字由自动化运行时写入
// （pi-runtime 的 `appendSessionInfo("自动化 · <任务名>")`），正好补上这一段，
// 通知因此能自证「是哪个会话跑完了」。
export interface HookSessionTitleInput {
  sessionId: string;
  /** 侧边栏列表里的标题（currentSessions）；列表里没有这条会话时为 undefined。 */
  sidebarTitle?: string;
  /** 会话文件里的名字（SessionManager.getSessionName()）。 */
  sessionName?: string;
}

/** 解析钩子通知里展示的会话标题；三档全空时退回 8 位短 id（与面板同款）。 */
export function resolveHookSessionTitle(input: HookSessionTitleInput): string {
  for (const candidate of [input.sidebarTitle, input.sessionName]) {
    const text = candidate?.trim();
    if (text) return text;
  }
  return `会话 ${input.sessionId.slice(0, 8)}`;
}
