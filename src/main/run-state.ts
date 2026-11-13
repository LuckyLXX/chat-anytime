/**
 * 「这个会话还在跑吗」的唯一口径（2026-11-13 内网用户报「绘画还没完成，输入框就
 * 变成已完成，回车却提示还在跑」）。
 *
 * 现场症状：会话气泡已按回合结束显示「已处理 14 秒」，输入框右边的停止按钮变回
 * 发送按钮（占位符也退回空闲文案），但一按回车就冒出一条英文错误：
 * `Agent is already processing. Specify streamingBehavior ('steer' or 'followUp')
 * to queue the message.`
 *
 * 根因是**两个终点被混成一个**：Pi 的 `agent_end` 只是底层 run 边界（官方
 * docs/json.md：`agent_end` closes one low-level agent run. Automatic retry,
 * overflow recovery, compaction retry, steering, or follow-up work can still
 * continue），自动重试、阈值/溢出压缩恢复、排队的 followUp、`agent_before_settle`
 * 之后 Pi 还会继续跑；真正的会话级终点是 `agent_settled`。旧实现一见 `agent_end`
 * 就 `busy = false` + 回合定稿，于是「收尾窗口」里：
 *   1. UI 说空闲（发送按钮、占位符、上下文/模型按钮全部解锁），
 *   2. 回车走普通发送 → `session.prompt()` 在 `isStreaming` 时直接拒收（英文原
 *      文），
 *   3. 那条被拒的消息还把**正在跑**的回合标成失败（顺手清掉 busy、写终态圆点），
 *      于是用户看到「回答耗时 等待输出 · 总耗时 14ms」这种假回合。
 * 内网模型首 token 37s、整轮 2min 的场景下，压缩/重试这次"收尾"可以长达几分钟，
 * 所以不算偶发竞态。
 *
 * 因此所有「忙 / 空闲」判定（快照的 busy 字段、发送/重生成/压缩/资源操作的守卫、
 * 会话驱逐与空话题判定）都必须带 `session.isStreaming`（Pi 的权威状态），只信
 * 我们自己的 `record.busy` 一定会在收尾窗口里说谎。纯读、零副作用，随快照每帧
 * 调用也没有成本。
 */
export function runActive(record: { busy: boolean; session: { isStreaming: boolean } }): boolean {
  return record.busy || record.session.isStreaming;
}
