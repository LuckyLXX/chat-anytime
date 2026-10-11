import * as nodePty from "node-pty";
import { describe, expect, it } from "vitest";
import { TerminalManager, type PtyProcess, type PtySpawnOptions } from "./terminal-pty.js";

/**
 * 真实 node-pty（不桩 spawnPty）的 kill 幂等回归网 —— 2026-10-11 真机崩溃（0xC0000374）。
 *
 * 根因（node-pty#983 完全同型）：Windows 上**对同一个 PTY 调两次 `kill()`** 会把
 * `ClosePseudoConsole` 执行两次 → 堆损坏 → 进程直接消失（不是 JS 异常，try/catch 拦不住，
 * 也没有错误可读，只有一份 minidump：异常码 `0xC0000374`、崩在 ntdll、进程里加载着
 * `conpty.node`）。
 *
 * 为什么应用里会出现第二次 kill：面板作品的服务终端由**主进程**在窗口 `closed` 时 kill
 * 一次（平台为面板起的本地服务），渲染端随后收到 `gallery.panel-closed` 去关那个标签、
 * 又发一次 `terminal({type:"kill"})`；而 `terminals` 表里的记录要等**异步的**退出回调
 * （`handleExit`）才删除，中间的窗口期足够让第二条 kill 打到同一个 ConPTY 上。
 *
 * 这个用例的断言就是「跑得完」：旧实现在第二个 `handle({type:"kill"})` 处整个 vitest
 * worker 直接死掉，拿不到任何失败信息。
 */

/** 真实 PTY：直接用 node-pty，与生产同一条代码路径。 */
function spawnRealPty(file: string, args: string[], options: PtySpawnOptions): PtyProcess {
  return nodePty.spawn(file, args, options) as unknown as PtyProcess;
}

/** 一个只会等着被杀的进程（不输出、不退出）。 */
function idleShell(): { file: string; args: string[] } {
  return { file: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("TerminalManager：真实 PTY 的 kill 幂等", () => {
  it("同一终端连 kill 两次不会崩（第二次必须是 no-op）", async () => {
    const manager = new TerminalManager({ spawnPty: spawnRealPty, publish: () => {}, resolveShell: idleShell });
    expect(manager.handle({ type: "create", terminalId: "pty-twice", cols: 80, rows: 24 })).toBeUndefined();
    await wait(500);
    // 记录此刻仍在表里（退出回调是异步的）——正是第二条 kill 能打到同一 ConPTY 的原因
    expect(manager.status("pty-twice").alive).toBe(true);

    manager.handle({ type: "kill", terminalId: "pty-twice" });
    // 平台为面板起的服务就是这个形状：主进程 kill 一次，渲染端关标签再 kill 一次
    manager.handle({ type: "kill", terminalId: "pty-twice" });
    await wait(500);

    // 走到这里就说明进程活着；再确认一下生命周期确实走完了（记录已被退出回调清掉）
    expect(manager.status("pty-twice").alive).toBe(false);
  });

  it("kill 之后紧跟的 resize / input 不能打到已关闭的 ConPTY（真实崩溃现场）", async () => {
    // 时间线：主进程在面板窗口 closed 时 kill 服务 PTY → 渲染端那个标签还在，
    // 用户回到主界面、界面重排 → xterm 发 `resize`（有时还有 `input`）→ 主进程
    // 仍能从表里拿到记录（删除要等异步的退出回调）→ resize 打向已 ClosePseudoConsole
    // 的句柄 ⇒ 原生层访存已释放内存 ⇒ 0xC0000374。
    const manager = new TerminalManager({ spawnPty: spawnRealPty, publish: () => {}, resolveShell: idleShell });
    manager.handle({ type: "create", terminalId: "pty-touch", cols: 80, rows: 24 });
    await wait(500);

    manager.handle({ type: "kill", terminalId: "pty-touch" });
    manager.handle({ type: "resize", terminalId: "pty-touch", cols: 120, rows: 40 });
    manager.handle({ type: "input", terminalId: "pty-touch", data: "echo hi\r" });
    manager.handle({ type: "kill", terminalId: "pty-touch" });
    await wait(500);

    expect(true).toBe(true);
  });

  it("disposeAll 也不重复 kill（退出应用时与已 kill 的记录叠加同样会崩）", async () => {
    const manager = new TerminalManager({ spawnPty: spawnRealPty, publish: () => {}, resolveShell: idleShell });
    manager.handle({ type: "create", terminalId: "pty-dispose", cols: 80, rows: 24 });
    await wait(500);
    manager.handle({ type: "kill", terminalId: "pty-dispose" });
    manager.disposeAll();
    await wait(300);
    expect(true).toBe(true);
  });
});
