import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 会话切换增量恢复协议的**接线契约**（源码级断言，同 run-active-wiring /
 * recent-completions-wiring 的形态）。
 *
 * 为什么必须钉源码：`snapshot-emit.test.ts`、`snapshot-baselines.test.ts`、
 * `store.test.ts` 分别证明了三个进程里的纯逻辑是对的，但证明不了它们真的被接上：
 * 少接一处（比如 main 退回把补丁套到 `latestSnapshot`、renderer 不再发 `state.recover`），
 * 现象是「切回长会话时又重传整段历史」或「切回后画面停在旧会话」——都是只在真机
 * 长对话里才看得出来、单元测试全绿的那类退化。
 *
 * 源码行尾在本地工作区（LF）与 CI 检出（CRLF）之间不一致：读入即归一化。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

const protocol = read("../shared/protocol.ts");
const runtime = read("pi-runtime.ts");
const mainIndex = read("index.ts");
const panelState = read("panel-state.ts");
const store = read("../renderer/src/store.ts");
const emit = read("snapshot-emit.ts");
const baselineCache = read("../shared/session-baseline-cache.ts");

describe("会话切换增量恢复协议的接线", () => {
  it("协议里三种帧齐全（resume 帧 / 定向恢复命令 / 定向恢复响应）", () => {
    expect(protocol).toContain('type: "state.resume.patch"');
    expect(protocol).toContain("baseRevision: number");
    expect(protocol).toContain('{ type: "state.recover"; sessionId: string; requestId: string }');
    expect(protocol).toContain('type: "state.recovery"; requestId: string; sessionId: string; snapshot: RuntimeSnapshot');
  });

  it("utility 用 keyed 发帧器（不再回退成单一 lastActiveEmit 基线）", () => {
    expect(runtime).toContain("createActiveEmitter()");
    expect(runtime).toContain("activeEmit.plan(snapshot())");
    expect(runtime).not.toContain("lastActiveEmit");
    // 基线释放必须对**所有**会话生效（active 与 parked 一视同仁）：被 LRU 驱逐或删除的
    // 后台会话不能被基线钉住，也不能在重建后被旧基线凑合。
    const dropIdx = runtime.indexOf("activeEmit.drop(record.session.sessionId)");
    const activeOnlyIdx = runtime.indexOf("if (activeRuntime === record) {");
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(activeOnlyIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeLessThan(activeOnlyIdx);
    // 发帧决策里三种帧都要能出现，且 resume 只认目标基线 revision。
    expect(emit).toContain('type: "state.resume.patch"');
    expect(emit).toContain("baseRevision: previous.revision");
    expect(emit).toContain('type: "state.patch"');
  });

  it("utility 认领 state.recover，且只对仍 active 的目标回全量恢复帧", () => {
    const from = runtime.indexOf('case "state.recover":');
    expect(from).toBeGreaterThanOrEqual(0);
    const block = runtime.slice(from, from + 1200);
    expect(block).toContain("target !== activeRuntime");
    expect(block).toContain("forceFull: true");
    expect(block).toContain('post({ type: "state.recovery"');
  });

  it("main 用按会话键控的快照缓存（bootstrap 不把跨会话差量算到当前快照上）", () => {
    expect(mainIndex).toContain("snapshotBaselines.ingest(message)");
    expect(mainIndex).toContain("activeIngest.recover");
    // 旧写法（把补丁直接套到 latestSnapshot / 失败即清空并拉 state.sync）不得回流。
    expect(mainIndex).not.toContain("applyRuntimeStatePatch(latestSnapshot");
    expect(mainIndex).not.toContain('latestSnapshot = undefined;\n          runtimeProcess?.postMessage({ type: "state.sync"');
    // 恢复帧不只有 response 关系可认（渲染端直接发的 state.recover 自带 requestId），
    // 因此缓存要无条件刷新目标会话基线；而断档必须转成定向恢复而不是硬套差量。
    const baselines = read("snapshot-baselines.ts");
    expect(baselines).toContain("remember(snapshot)");
    expect(baselines).toContain("revision !== baseline.revision + 1");
  });

  it("面板作品跟得上 active 切换（resume / recovery 帧都要更新 activeSessionId）", () => {
    expect(panelState).toContain('message.type === "state.resume.patch"');
    expect(panelState).toContain("activeSessionId = message.sessionId");
    expect(panelState).toContain('message.type === "state.recovery"');
  });

  it("renderer 有独立于 paneStates/parkedPanels 的 active 基线，并按 requestId 认领恢复", () => {
    expect(store).toContain("createSessionBaselineCache<ActiveSessionBaseline>");
    expect(store).toContain('case "state.resume.patch"');
    expect(store).toContain('case "state.recovery"');
    expect(store).toContain("requestTargetedRecovery");
    expect(store).toContain('type: "state.recover"');
    // 普通补丁跨会话一律不套用；断档不再退回全体 state.sync（pane 通道仍用）。
    expect(store).toContain("applyResumeStatePatch");
  });

  it("三个进程共用同一份有界基线缓存（键、容量、LRU 规则只有一份实现）", () => {
    expect(baselineCache).toContain("MAX_SESSION_BASELINES");
    expect(emit).toContain("createSessionBaselineCache");
    expect(store).toContain("createSessionBaselineCache");
    // main 侧经 snapshot-baselines.ts 复用同一 helper。
    expect(read("snapshot-baselines.ts")).toContain("createSessionBaselineCache");
  });
});
