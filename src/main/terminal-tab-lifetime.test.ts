import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 终端标签生命周期契约（源码断言型测试，2026-10-07）。
 *
 * 语义（用户选定）：终端标签「关标签才销毁」——与浏览器/SSH 标签对齐，跨会话、
 * 跨工作区一律存活；kill 只发生在用户显式关标签（closePreviewTab）时。
 *
 * 为什么是源码断言：行为横跨渲染端 effect、preview 状态与 IPC，渲染 App.tsx 需要
 * 一整套 store/IPC 假件（成本与价值不成比例）。同先例：gallery-run-wiring.test.ts、
 * agent-settings-style.test.ts。
 *
 * 钉的是一次真实事故（用户报「切换会话时终端标签被关闭」）：旧实现里
 * `activeWorkspace` 变化的 effect 会 kill 全部无 cwd 的终端标签，而**跨工作区切换
 * 会话**（侧边栏「最近工作区」分组、分屏聚焦跨工作区格子）会连带切换全局工作区
 * 镜像——用户心智里只是切了个会话，终端却全没了。该 effect 已删除；本测试防止
 * 同类「以工作区变化为由自动 kill 终端」的实现悄悄回来。
 */

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "../renderer/src/App.tsx"), "utf8");

describe("终端标签生命周期", () => {
  it("渲染端不存在随 activeWorkspace 变化自动 kill 终端的逻辑（跨工作区切换会话的事故源）", () => {
    expect(app).not.toContain("previousWorkspaceRef");
    // 「retire them all」是旧清理 effect 的注释措辞，一并钉死不让措辞复活
    expect(app).not.toContain("retire them all");
  });

  it("终端 kill 只有一个触发点：用户显式关标签（closePreviewTab）", () => {
    const kills = app.match(/window\.piDesktop\.terminal\(\{ type: "kill"/gu) ?? [];
    expect(kills.length).toBe(1);
    expect(app).toContain('void window.piDesktop.terminal({ type: "kill", terminalId: id });');
  });

  it("会话切换保留终端标签：只清会话级标签（artifact/diff）", () => {
    expect(app).toContain(
      'const keepTabs = preview.tabs.filter((tab) => tab.target.type !== "artifact" && tab.target.type !== "diff");'
    );
  });
});
