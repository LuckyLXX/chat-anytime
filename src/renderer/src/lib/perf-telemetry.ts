/**
 * 开发构建的性能观测钩子（生产构建不加载）。
 *
 * 只做低成本的 `longtask` 采样：超过 80ms 的主线程任务会打印一条带 start/duration
 * 的警告，方便在长时间流式/切会话后确认是渲染、markdown 解析还是 IPC 反序列化。
 * 不常驻上报、不写 localStorage，避免观测本身影响被测对象。
 */
const LONG_TASK_THRESHOLD_MS = 80;

export function startPerfTelemetry(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_THRESHOLD_MS) continue;
        console.warn(`[perf] long task ${entry.duration.toFixed(1)}ms @ ${Math.round(entry.startTime)}ms`, entry.name);
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    // 某些 Chromium/测试环境不支持 longtask：静默跳过。
  }
}
