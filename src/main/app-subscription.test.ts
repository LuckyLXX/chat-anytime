import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * App 的 executions 订阅收窄（2026-09-25 性能 P0）的**源码断言**。
 *
 * 为什么用源码断言：`App.tsx` 依赖 preload 注入的 `window.piDesktop`，单测里无法
 * 渲染（同 `settings-save-contract.test.ts` / `agent-settings-style.test.ts` 的
 * 先例），而这条改动的收益又完全是接线层面的——直接订阅 executions 数组会让
 * App 在工具输出期间以 ~20 fps 重建整棵子树（store 的身份保留只保证「内容未变
 * 时引用不变」，而正在跑的 execution 每帧 output 都在变）。派生选择器的纯函数
 * 行为由 `src/renderer/src/lib/execution-select.test.ts` 覆盖，这里只钉接线：
 * 不许回到整数组订阅、必须用两个派生值、需要数组的回调内部现取。
 */

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(here, "../renderer/src/App.tsx"), "utf8");

describe("App 的 executions 订阅收窄", () => {
  it("不再把 executions 数组直接订阅进渲染闭包", () => {
    expect(appSource).not.toMatch(/useDesktopStore\(\s*\(state\)\s*=>\s*state\.snapshot\.executions\s*\)/u);
  });

  it("改用两个派生原始值选择器（execution-select.ts）", () => {
    expect(appSource).toContain("lastReviewExecutionId(state.snapshot.executions)");
    expect(appSource).toContain("lastCompletedChangedExecutionId(state.snapshot.executions)");
    expect(appSource).toContain('import { lastCompletedChangedExecutionId, lastReviewExecutionId } from "./lib/execution-select";');
  });

  it("「查看最新变更」的可用态读派生值，而不是整数组", () => {
    expect(appSource).toContain("reviewAvailable={Boolean(lastReviewId)}");
    expect(appSource).not.toContain("reviewAvailable={Boolean(latestReviewExecution)}");
  });

  it("需要整数组的回调/effect 在体内用 getState() 现取", () => {
    expect(appSource).toContain("useDesktopStore.getState().snapshot.executions");
  });

  it("文件同步 effect 的依赖是派生原始值（不是 executions 数组）", () => {
    expect(appSource).toContain("}, [lastChangedExecutionId, preview]);");
    expect(appSource).not.toContain("}, [executions, preview]);");
  });
});
