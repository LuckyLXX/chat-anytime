import type { RuntimeCommand } from "../shared/protocol.js";

/**
 * 命令级失败归属于哪个会话 —— 命令分发 catch 里唯一需要判断的东西。
 *
 * 为什么必须有：`runtime:send` 是「发了就不回」的通道（main 侧 `ipcMain.handle`
 * 同步返回 void），渲染端 `await window.piDesktop.send(...)` 对命令级失败
 * **永不 reject**；被拒的 prompt（会话记录已被回收 / 该话题正在执行 / 工作区或模型
 * 缺失）过去只会弹一条全局 toast，而渲染端在发送前就设下的乐观「待回复」状态
 * 没有任何清除路径，于是留下一条假的「正在努力输出中」+ 一直跳的耗时读数，
 * 要等到该格 busy 翻转（常常是被别的事件带着翻）才消失。
 *
 * 缺省语义：命令不带会话时返回 `undefined`，渲染端只认「真实相等的 sessionId」，
 * 因此缺省值绝不命中任何一格（宁可只弹 toast，也不误收别格的 pending）。
 */
export function commandSessionId(command: RuntimeCommand): string | undefined {
  return "sessionId" in command && typeof command.sessionId === "string" ? command.sessionId : undefined;
}
