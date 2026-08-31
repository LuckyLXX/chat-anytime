/**
 * 排队消息的图片镜像（纯函数，可单测）。
 *
 * Pi 的 steering/followUp 队列（agent-core PendingMessageQueue）完整保存带图
 * 消息，但 AgentSession 对外只暴露纯文本数组（getSteeringMessages/
 * getFollowUpMessages）——图片只在 agent-core 内部，编辑/删除/立即发送的
 * 「整队清空重建」会把它悄悄丢掉。因此 app 侧维护一份与 Pi 文本数组 index
 * 严格对齐的镜像（record.steeringImages / record.followUpImages，无图项为空
 * 数组），所有队列操作都经过本模块，保证镜像与 Pi 队列同步演化。
 *
 * 对齐规则：Pi 队列只从头部消费（agent-loop 每回合 drain 一条），镜像只会
 * 比 Pi 数组长；read 时按 Pi 数组长度截断即可（多出的头部 = 已注入回合的
 * 项），截断幂等、无需写回。
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { QueuedMessage } from "../shared/protocol.js";

/** 与 Pi 队列文本数组 index 对齐的图片镜像；无图项 = 空数组。 */
export interface QueueImageMirror {
  steeringImages: ImageContent[][];
  followUpImages: ImageContent[][];
}

/** 一次完整对齐后的队列状态视图（文本 + 镜像，永不过长）。 */
export interface QueueState extends QueueImageMirror {
  steeringTexts: string[];
  followUpTexts: string[];
}

/** 重放参数：整队重建时按顺序调 steer/followUp 即可还原队列（含图片）。 */
export interface QueueReplayItem {
  kind: "steering" | "followUp";
  text: string;
  images: ImageContent[];
}

/** 镜像按 Pi 队列当前长度对齐：队列只从头部消费，镜像只会更长，丢头部保尾
 * 部（多出的头部 = 已注入回合的项）；镜像意外更短时以空数组补齐（防御，
 * 保证返回的镜像与 texts 严格等长，下游 splice/寻址安全）。 */
function alignImages(texts: readonly string[], images: readonly ImageContent[][]): ImageContent[][] {
  const surplus = images.length - texts.length;
  const aligned = surplus > 0 ? images.slice(surplus) : images;
  return texts.map((_text, index) => aligned[index] ?? []);
}

export function alignQueueState(
  steeringTexts: readonly string[],
  followUpTexts: readonly string[],
  mirror: QueueImageMirror
): QueueState {
  return {
    steeringTexts: [...steeringTexts],
    followUpTexts: [...followUpTexts],
    steeringImages: alignImages(steeringTexts, mirror.steeringImages),
    followUpImages: alignImages(followUpTexts, mirror.followUpImages)
  };
}

/**
 * 排队消息的入队文本：纯图片排队（无正文）时返回占位文本。Pi 的队列显示
 * 数组按非空文本寻址移除（agent-session 对 contentText 空串跳过删除），空串
 * 会残留成幽灵队列项，之后任何整队重建还会把它连同图片重新入队重复投递。
 */
export function queuedMessageText(text: string, imageCount: number): string {
  return imageCount > 0 && !text.trim() ? "（图片）" : text;
}

/** 快照组装（steering 在前，与既有队列展示顺序一致）；镜像里的图片只投影为数量。 */
export function queueSnapshotMessages(state: QueueState): QueuedMessage[] {
  return [
    ...state.steeringTexts.map((text, index) => ({
      kind: "steering" as const,
      index,
      text,
      ...(state.steeringImages[index]?.length ? { imageCount: state.steeringImages[index]!.length } : {})
    })),
    ...state.followUpTexts.map((text, index) => ({
      kind: "followUp" as const,
      index,
      text,
      ...(state.followUpImages[index]?.length ? { imageCount: state.followUpImages[index]!.length } : {})
    }))
  ];
}

/** 按 kind+index+text 定位某一队列项；文本校验失败即抛错（同既有拒绝语义）。 */
function locateTarget(state: QueueState, kind: QueuedMessage["kind"], index: number, text: string): {
  texts: string[];
  images: ImageContent[][];
} {
  const texts = kind === "steering" ? state.steeringTexts : state.followUpTexts;
  if (texts[index] !== text) throw new Error("待发送列表已变化，请重试");
  return { texts, images: kind === "steering" ? state.steeringImages : state.followUpImages };
}

/** 移除某一队列项：Pi 文本数组与图片镜像同步 splice。 */
export function removeQueueMessage(state: QueueState, kind: QueuedMessage["kind"], index: number, text: string): QueueState {
  const target = locateTarget(state, kind, index, text);
  const removedTexts = [...target.texts];
  const removedImages = [...target.images];
  removedTexts.splice(index, 1);
  removedImages.splice(index, 1);
  return {
    ...state,
    steeringTexts: kind === "steering" ? removedTexts : state.steeringTexts,
    followUpTexts: kind === "followUp" ? removedTexts : state.followUpTexts,
    steeringImages: kind === "steering" ? removedImages : state.steeringImages,
    followUpImages: kind === "followUp" ? removedImages : state.followUpImages
  };
}

export interface PromoteOutcome {
  /** 操作后的队列状态；非 busy 时与入参相同（目标未移动）。 */
  state: QueueState;
  /** 被提升（或定位）的目标项；undefined 表示目标不存在/校验失败已抛错之外的分支。 */
  target: { text: string; images: ImageContent[] } | undefined;
}

/**
 * 「立即发送」：先移除目标项（镜像同步 splice），busy 时再把目标提升为
 * steering 追加到队尾（等效 Pi 的 steer 注入——当前回合下一次模型调用前
 * 即可见）；回合已结束（busy=false）时目标不提升、由调用方直接发出。
 */
export function promoteQueueMessage(
  state: QueueState,
  kind: QueuedMessage["kind"],
  index: number,
  text: string,
  busy: boolean
): PromoteOutcome {
  const target = locateTarget(state, kind, index, text);
  const targetItem = { text: target.texts[index]!, images: [...(target.images[index] ?? [])] };
  const removed = removeQueueMessage(state, kind, index, text);
  if (!busy) {
    return { state: removed, target: targetItem };
  }
  return {
    state: {
      ...removed,
      steeringTexts: [...removed.steeringTexts, targetItem.text],
      steeringImages: [...removed.steeringImages, targetItem.images]
    },
    target: targetItem
  };
}

/** 整队重建的重放序列：先全部 steering、再全部 followUp，与既有重建顺序一致。 */
export function replayQueueArgs(state: QueueState): QueueReplayItem[] {
  return [
    ...state.steeringTexts.map((text, index) => ({ kind: "steering" as const, text, images: state.steeringImages[index] ?? [] })),
    ...state.followUpTexts.map((text, index) => ({ kind: "followUp" as const, text, images: state.followUpImages[index] ?? [] }))
  ];
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

/** 排队图片转 PromptAttachment（回合已结束时直接发送用）：占位文件名 + mime 推导扩展名。 */
export function imageAttachmentsFrom(images: readonly ImageContent[]): { kind: "image"; name: string; mimeType: string; size: number; data: string }[] {
  return images.map((image, index) => {
    const padding = image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0;
    return {
      kind: "image" as const,
      name: `图片 ${index + 1}.${IMAGE_EXT_BY_MIME[image.mimeType] ?? "png"}`,
      mimeType: image.mimeType,
      size: Math.floor((image.data.length * 3) / 4) - padding,
      data: image.data
    };
  });
}