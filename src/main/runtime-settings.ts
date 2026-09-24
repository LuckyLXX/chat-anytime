// Pi 会话 SettingsManager 的组装辅助（utility 进程内共用）。
//
// 背景：Pi 0.86.0 引入 prompt 缓存保温（cacheWarming），缺省 "streaming"——
// 长工具运行期间自发保温请求，消耗真实 token（含 cache_write 计费）。PiDesktop
// 的自动化定时任务无人值守运行，且 PiDesktop 从未提供保温配置 UI——上游缺省
// 的钱不能替用户花。因此这里把应用侧 SettingsManager 一律包一层
// getCacheWarmingMode() => "off"，行为对齐升级前；不写盘（对 Pi 的
// settings.json 零污染），未来若暴露保温 UI，删掉这层包装即可恢复上游缺省。
//
// 注意：SettingsManager 上的方法多、且未来版本可能继续增减，逐方法白名单式
// 包装会在升级时静默丢新方法。因此用 Proxy 只改写 getCacheWarmingMode 这一个
// 读取点，其余成员原样透传（方法绑回原对象）。

import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/** 单一覆盖点：缓存保温一律读作 "off"（其余成员透传，详见模块注释）。 */
export function withCacheWarmingOff(manager: SettingsManager): SettingsManager {
  return new Proxy(manager, {
    get(target, property, receiver) {
      if (property === "getCacheWarmingMode") return () => "off" as const;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  }) as SettingsManager;
}
