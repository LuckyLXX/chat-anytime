import type { DesktopSettings } from "../../../shared/protocol.js";

/**
 * 关闭设置弹窗时的回滚口径（2026-11-13，自定义通道「保存后退回设置就没了」修复）。
 *
 * 设置弹窗把「打开那一刻的 settings」存进 `initialSettingsRef`，关闭/取消时整包回滚——
 * 这是弹窗草稿的取消语义（GeneralSettings 等会把未提交的编辑先乐观写进 store）。
 *
 * 但有一类设置**不是弹窗草稿**：命令由主进程独占、调用即落盘。目前唯一一处是 IM 通道
 * （`im.channel.save` / `im.channel.delete` 写 settings.im，并经 `im.settings` 推送回
 * store）。它们已经生效在磁盘上，回滚成打开时的旧值会让用户看到「保存成功、退出设置
 * 重进就没了」，而且随后保存别的设置还会把这串旧值写回主进程（总开关被关、通道从面板
 * 上消失）。所以回滚只覆盖草稿键：主进程权威键（`im`）取 live 值。
 *
 * 为什么不用「把 im 从基线里删掉」：基线还用于 `markSettingsSaved` 之后的再次取消，
 * 保留 live 的 im 才能让「关闭 → 重开 → 再关闭」始终与磁盘一致。
 */
export function settingsAfterDialogClose(baseline: DesktopSettings, live: DesktopSettings): DesktopSettings {
  const restored = structuredClone(baseline);
  if (live.im) restored.im = structuredClone(live.im);
  else delete restored.im;
  return restored;
}
