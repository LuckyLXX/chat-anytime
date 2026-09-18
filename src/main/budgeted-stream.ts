// 图片预算的请求侧接线（可测的纯逻辑，不依赖 Electron）。
//
// 两个关注点：
//
// ① `createImageBudgetGate`：fail-open 的预算门。裁剪器任何异常都只记 warn 并
//    返回原 context——413 本身已经够糟，不能因为裁剪器自身故障让请求再挂一次。
//
// ② `budgetedStreamSimple`：「先同步返回流、再异步裁剪」的适配器。Pi 的调用方
//    同步消费 AssistantMessageEventStream（streamFunction 必须同步返回），而预
//    算裁剪是异步的（photon 压缩要在 worker 里跑）。用 Pi 自己的 lazyStream 把
//    两者接起来——setup 抛错会以 error event 结束流，与 Pi 内部
//    ModelRuntime.streamSimple 完全同款语义，不会静默丢请求。
//
// 这个模块从 pi-runtime.ts 抽出来是为了可测：pi-runtime 在模块顶层就要求
// Electron utility 进程的 parentPort，无法在 vitest 里导入。

import { lazyStream } from "@earendil-works/pi-ai";
import type { Api, AssistantMessageEventStream, Context, ImageContent, Model, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { applyImageBudget, type DownsampleResult } from "./request-image-budget.js";

/** 与 Pi 的 ModelRuntime.streamSimple 同形（同步返回流）。 */
export type StreamSimpleLike = (model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions) => AssistantMessageEventStream;

export interface ImageBudgetGateDeps {
  /** 单图压缩（缺省实现见 image-downsample.ts；测试注入假件）。 */
  downsample: (image: ImageContent) => Promise<DownsampleResult | undefined>;
  /** 告警（裁剪失败）。 */
  warn: (message: string) => void;
  /** 信息日志（真实发生裁剪时调用；缺省静默）。 */
  log?: (message: string) => void;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * 构造预算门：入参 context → 出参裁剪后的 context。未超预算时同一引用、零拷贝；
 * 任何异常 fail-open（记 warn 后返回原 context）。
 */
export function createImageBudgetGate(deps: ImageBudgetGateDeps): (context: Context) => Promise<Context> {
  return async (context: Context): Promise<Context> => {
    try {
      const { context: capped, stats } = await applyImageBudget(context, { downsample: deps.downsample, warn: deps.warn });
      if (stats.imagesDownsampled > 0 || stats.imagesOmitted > 0) {
        deps.log?.(`图片预算裁剪：${String(stats.imagesTotal)} 张 → 压缩 ${String(stats.imagesDownsampled)} 张、省略 ${String(stats.imagesOmitted)} 张，图片体积 ${formatMegabytes(stats.bytesBefore)} → ${formatMegabytes(stats.bytesAfter)}（本次预算 ${formatMegabytes(stats.budget)}）`);
      }
      return capped;
    } catch (error) {
      deps.warn(`图片预算裁剪失败，按原样发送本次请求：${error instanceof Error ? error.message : String(error)}`);
      return context;
    }
  };
}

/**
 * 把「异步裁剪 + 下游 streamSimple」包成一个同步返回流的 streamSimple。
 * 只用于支持图片输入的模型；文本模型走既有 stripContextImages 路径（同步、无 IO）。
 */
export function budgetedStreamSimple(stream: StreamSimpleLike, gate: (context: Context) => Promise<Context>): StreamSimpleLike {
  return (model, context, options) => lazyStream(model, async () => stream(model, await gate(context), options));
}
