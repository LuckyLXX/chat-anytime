import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveHookSessionTitle } from "./hooks-session-title.js";

/**
 * 钩子通知里 `{sessionTitle}` 的解析（2026-10-23 用户报「整个会话没完成就弹窗了」）。
 *
 * 实况：后台自动化会话 `01a16646-…`（自动化 · AI每日新闻日报）跑完 1 分 18 秒弹出
 * 「任务完成」，正文只有 `[01a16646-437f-720d-aca6-7fbb38bd64d16] 已完成本轮回复`；
 * 用户正在看的另一个会话还在跑（650 秒、排着待发消息），于是以为通知提前了。
 * 根因不是触发时机（挂在 agent_settled 上是对的），而是标题只剩「侧边栏标题」一档，
 * 而跨角色/后台会话永远不在当前 Agent 的会话列表里 ⇒ 裸 UUID。
 *
 * 断言口径：侧边栏标题优先（与侧边栏一致）→ 会话文件里的名字兜底 → 短 id 收尾。
 */

describe("resolveHookSessionTitle", () => {
  it("侧边栏有这条会话时用侧边栏标题（与侧边栏保持一致）", () => {
    expect(
      resolveHookSessionTitle({
        sessionId: "01a160b1-9314-72cd-8900-90ae60558ebd",
        sidebarTitle: "Pi 仓库发布更新日报",
        sessionName: "会话文件里的旧名字"
      })
    ).toBe("Pi 仓库发布更新日报");
  });

  it("侧边栏查不到（后台/跨角色自动化会话）时用会话文件里的名字，而不是裸 id", () => {
    // 用户当时看到的就是这一档缺失：正文里出现了完整的 UUID。
    expect(
      resolveHookSessionTitle({
        sessionId: "01a16646-437f-720d-aca6-7fbb38bd64d16",
        sessionName: "自动化 · AI每日新闻日报"
      })
    ).toBe("自动化 · AI每日新闻日报");
  });

  it("两档都空时退回 8 位短 id，不出现完整 UUID", () => {
    expect(resolveHookSessionTitle({ sessionId: "01a16646-437f-720d-aca6-7fbb38bd64d16" })).toBe("会话 01a16646");
  });

  it("空白标题/名字不算命中（trim 后为空继续往下退）", () => {
    expect(
      resolveHookSessionTitle({
        sessionId: "01a16646-437f-720d-aca6-7fbb38bd64d16",
        sidebarTitle: "   ",
        sessionName: "  "
      })
    ).toBe("会话 01a16646");
    expect(
      resolveHookSessionTitle({
        sessionId: "01a16646-437f-720d-aca6-7fbb38bd64d16",
        sidebarTitle: " 自动化 · AI每日新闻日报 "
      })
    ).toBe("自动化 · AI每日新闻日报");
  });
});

/**
 * 接线契约（源码断言型）：纯函数对了不等于用上了——两处 hooksDepsFor 调用点
 * （会话创建期 + session_end 销毁期）都必须把会话文件里的名字传进来，否则后台
 * 会话又退化成裸 UUID。纯函数本身测不出这种「没接线」。
 *
 * ⚠️ 多行/片段断言前先归一化行尾（CI 检出可能是 CRLF）。
 */
const here = dirname(fileURLToPath(import.meta.url));
const runtime = readFileSync(join(here, "pi-runtime.ts"), "utf8").replace(/\r\n/gu, "\n");

describe("hooks sessionTitle 接线契约", () => {
  it("会话创建期的钩子依赖带上会话文件里的名字", () => {
    expect(runtime).toContain("return hookSessionTitle(sessionId, () => recordBox?.session.sessionManager.getSessionName());");
  });

  it("session_end（销毁前）的钩子依赖带上会话文件里的名字", () => {
    expect(runtime).toContain("sessionTitle: () => hookSessionTitle(record.session.sessionId, () => record.session.sessionManager.getSessionName())");
  });

  it("不再有「只查侧边栏、否则裸会话 id」的旧写法", () => {
    expect(runtime).not.toContain("sessionTitle: () => currentSessions.find((item) => item.id === record.session.sessionId)?.title ?? record.session.sessionId");
    expect(runtime).not.toContain("?.title ?? sessionId");
  });
});
