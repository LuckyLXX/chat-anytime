// 图片请求体积治理（413 payload_too_large 防护）。
//
// 上游网关对请求体有字节上限（本机实测 8MB），而支持图片输入的会话会把历史中
// 的**所有**图片 base64 随每次请求全量上送：真机会话库统计的 3 个失败会话里，
// 失败时前缀内图片分别是 59/18/5 张、6.5~7.9MB，且图片主要来源是 AI 在同一轮
// 里反复 read 自己生成的截图（某个失败会话里用户消息 0 张图，会话内却有 148 张
// 图）。Pi 内建的图片压缩只保证「单张 ≤4.5MB / ≤2000px」，没有总量概念；其
// 上下文压缩又按固定 4800 字符/张折算 token，图片再多也触不到阈值——所以需要
// 在上游请求前做一次字节预算裁剪。
//
// 三层处理（顺序执行）：
//   ① 单张 >1.5MB → 降采样到 ≤1.5MB / ≤1600px（结果确定，可缓存）；
//   ② 图片 base64 总量 >6MB → 从最旧图片开始整块替换为**稳定占位符文本**；
//   ③ 任何失败 → fail-open 原样发送（绝不因裁剪器自身故障让请求再挂一次）。
//
// 只改「发往上游的副本」：会话转录、JSONL、界面渲染拿到的都是原始消息对象，
// 不受本模块影响。占位符**逐图字节稳定**（同一张图在任何请求里渲染出的文本
// 完全一致，且不携带省略张数等跨图状态），上游前缀缓存在每张图「从保留转为
// 省略」时最多失效一次，此后长期复用。
//
// 纯函数 + 注入依赖：photon 压缩与告警由调用方提供，单测不需要真实图片处理。
// 热路径（未超预算）返回同一 context 引用、零拷贝。

import { createHash } from "node:crypto";
import type { Context, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

/** 请求内图片 base64 总量上限（标准预算）：网关 8MB，留 2MB 给文本与 JSON 结构。 */
export const IMAGE_TOTAL_BUDGET_BYTES = 6 * 1024 * 1024;
/**
 * 上游网关的请求体字节上限。本机实测报错文本含 server.max_body_mb，默认 8MB；
 * 换成更小的网关时调这里（预算会随之自适应收紧）。
 */
export const GATEWAY_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
/** 为 JSON 结构、协议字段与估算误差预留的安全余量。 */
export const REQUEST_BODY_HEADROOM_BYTES = 512 * 1024;
/** 自适应后的图片预算下限：保证最新的图总能留下，即使文本已经很大。 */
export const IMAGE_MIN_BUDGET_BYTES = 1024 * 1024;
/** 单张图片压缩目标（压缩后的 base64 字节数）。 */
export const IMAGE_PER_IMAGE_BYTES = 1.5 * 1024 * 1024;
/** 单张图片压缩目标（长边像素）。 */
export const IMAGE_MAX_DIMENSION = 1600;
/** 低于此值不触发压缩（省 CPU）：与单图目标同值，压了也不会更小。 */
export const IMAGE_DOWNSAMPLE_MIN_BYTES = 1.5 * 1024 * 1024;

/** base64 文本≈解码字节数的 4/3；请求体的膨胀源就是这段文本，按文本长度计。 */
export function base64Bytes(data: string): number {
  return data.length;
}

/**
 * UTF-8 字节数的快速估算：ASCII 算 1，CJK/全角算 3，代理对（emoji）算 4。
 * 不为估算把整段文本转 Buffer（会话文本可达 MB 级，转换成本没必要付）。
 */
export function estimateUtf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * 每条消息的 JSON 结构开销（role/字段名/时间戳/usage/stopReason/toolCallId 等）。
 * 实测校准（会话 C，928 条消息）：非图片字节中扣除文本与工具参数后，剩 716
 * 字节/条——assistant 消息带 usage/cost 对象、toolResult 带 toolName/isError，
 * 都比想象中胖。取 800 留一点余量（宁紧勿松：低估会让请求撞网关）。
 *
 * 已知近似：系统提示词与工具 schema 那部分请求开销也会被摊进这个单价里，
 * 因此消息数少的会话会系统性低估（上限≈ systemPrompt + tools 未摊进的那部分，
 * 实际几十 KB 量级）。512KB 安全余量与单图≤1.5MB 压缩共同兜住这部分误差；
 * 如果未来系统提示词显著变大，应该单独统计一次并加进估算。
 */
const MESSAGE_STRUCTURE_BYTES = 800;

/**
 * 估算一次请求里**非图片**内容的字节数（文本/思考/工具参数 + 结构开销）。
 *
 * 刻意不统计图片——图片体积由 applyImageBudget 单独盘点（budget 就是给它的额度），
 * 两边都算会把图片扣两遍。
 *
 * 实测：会话 C 在首次 413 时的请求体 = 图片 6.52MB + 文本 2.01MB = 8.53MB
 * ——文本在大工具流的会话里能占到 2MB，光把图片压到 6MB 仍会卡在网关边缘，
 * 因此预算要据此自适应收紧。
 */
export function estimateContextTextBytes(context: Context): number {
  let bytes = 0;
  for (const message of context.messages) {
    bytes += MESSAGE_STRUCTURE_BYTES;
    if (message.role === "user" || message.role === "toolResult") {
      const content = message.content;
      if (typeof content === "string") {
        bytes += estimateUtf8Bytes(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part.type === "text") bytes += estimateUtf8Bytes(part.text);
      }
      continue;
    }
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") bytes += estimateUtf8Bytes(part.text);
        else if (part.type === "thinking") bytes += estimateUtf8Bytes(part.thinking);
        else if (part.type === "toolCall") {
          bytes += estimateUtf8Bytes(part.name);
          try {
            bytes += estimateUtf8Bytes(JSON.stringify(part.arguments ?? {}));
          } catch {
            bytes += MESSAGE_STRUCTURE_BYTES;
          }
        }
      }
    }
  }
  return bytes;
}

/**
 * 本次请求实际可用的图片预算：标准上限与「网关上限 − 文本 − 安全余量」取小，
 * 不低于 {@link IMAGE_MIN_BUDGET_BYTES}。文本小的会话享受完整 6MB；文本大的
 * 会话自动收紧，避免图片按满预算保留、加上文本反而撞线。
 */
export function imageBudgetForContext(context: Context): number {
  const textBytes = estimateContextTextBytes(context);
  const affordable = GATEWAY_BODY_LIMIT_BYTES - textBytes - REQUEST_BODY_HEADROOM_BYTES;
  return Math.max(IMAGE_MIN_BUDGET_BYTES, Math.min(IMAGE_TOTAL_BUDGET_BYTES, affordable));
}

/**
 * 从图片字节头部解析像素尺寸（PNG IHDR / JPEG SOF）。
 * 解析失败返回 undefined（占位符省略尺寸字段），绝不抛错。
 */
export function imagePixelSize(data: string, mimeType: string): { width: number; height: number } | undefined {
  const header = data.slice(0, Math.ceil((64 * 1024 * 4) / 3));
  let bytes: Buffer;
  try {
    bytes = Buffer.from(header, "base64");
  } catch {
    return undefined;
  }
  const isPng = mimeType === "image/png" || bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (isPng) {
    // PNG: 8 字节签名 + 4 字节长度 + "IHDR" + width(4) + height(4)。
    if (bytes.length >= 24 && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
      const width = bytes.readUInt32BE(16);
      const height = bytes.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
    return undefined;
  }
  const isJpeg = mimeType === "image/jpeg" || (bytes[0] === 0xff && bytes[1] === 0xd8);
  if (!isJpeg) return undefined;
  // JPEG: 顺序扫描段，找 SOFn（C0–CF，除 C4/C8/CC）里的宽高。
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xc4 || marker === 0xc8 || marker === 0xcc) return undefined;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf) {
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

/** 内容短哈希：稳定标识被省略的图片（同一张图永远同一值）。 */
export function imageShortHash(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 8);
}

export interface PlaceholderInfo {
  /** 工作区相对或绝对路径（能解析到时给出，模型可 read/recognize_images 回看）。 */
  path?: string;
  /** 像素尺寸（解析到时给出）。 */
  size?: { width: number; height: number };
}

/**
 * 被省略图片的占位符文本。字节稳定是硬约束：同一张图在任何请求里渲染出的
 * 文本必须逐字节一致（上游前缀缓存按字节前缀命中），因此这里只写「由这张图
 * 自身决定」的信息——不写时间、轮次、序号，也不写跨图状态（如省略张数），
 * 否则一张图被省略会让所有已省略图的占位符一起变，缓存整段失效。
 */
export function placeholderText(image: ImageContent, info: PlaceholderInfo): string {
  const parts = ["〔图片已省略（历史图片）"];
  if (info.size) parts.push(`${info.size.width}×${info.size.height}`);
  if (info.path) {
    parts.push(info.path);
    parts.push("如需查看请 read 该文件或调用 recognize_images");
  } else {
    parts.push(`内容标识 ${imageShortHash(image.data)}`);
    parts.push("如需查看请说明，或在工作区中重新找到该图片文件后 read");
  }
  return `${parts.join(" · ")}〕`;
}

/**
 * 解析某条含图消息对应的可回看路径（工作区相对或绝对），解析不到返回 undefined：
 *  ① toolResult.details.savedPath —— 截图工具（browser_ 与 computer_ 系列）都会带；
 *  ② 同 Context 里配对的 toolCall 参数 path —— read 工具读图的情形（按 toolCallId 匹配）。
 * 用户附件（剪贴板/拖拽）在消息里不留路径，走短哈希兜底。
 */
export function resolveImagePath(context: Context, message: Message): string | undefined {
  if (message.role !== "toolResult") return undefined;
  const details = message.details;
  if (details && typeof details === "object") {
    const savedPath = (details as { savedPath?: unknown }).savedPath;
    if (typeof savedPath === "string" && savedPath.trim()) return savedPath.trim();
  }
  for (const candidate of context.messages) {
    if (candidate.role !== "assistant") continue;
    for (const part of candidate.content) {
      if (part.type !== "toolCall" || part.id !== message.toolCallId) continue;
      const args = part.arguments;
      if (args && typeof args === "object") {
        const path = (args as { path?: unknown }).path;
        if (typeof path === "string" && path.trim()) return path.trim();
      }
      return undefined;
    }
  }
  return undefined;
}

/** 单张图片的压缩结果（注入依赖的返回形状）。 */
export interface DownsampleResult {
  data: string;
  mimeType: string;
}

export interface ImageBudgetStats {
  /** 裁剪前图片 base64 总字节。 */
  bytesBefore: number;
  /** 裁剪后图片 base64 总字节（含占位符文本）。 */
  bytesAfter: number;
  imagesTotal: number;
  imagesDownsampled: number;
  imagesOmitted: number;
  /** 本次生效的图片预算（自适应，见 imageBudgetForContext）。 */
  budget: number;
}

export interface ImageBudgetDeps {
  /**
   * 压缩单张图片；返回 undefined 表示压制失败（该图按原样保留）。
   * 缺省实现见 image-downsample.ts（Pi resizeImage + LRU 缓存）。
   */
  downsample: (image: ImageContent) => Promise<DownsampleResult | undefined>;
  warn: (message: string) => void;
}

export interface ImageBudgetResult {
  context: Context;
  stats: ImageBudgetStats;
}

/** 定位到的一张图片：消息下标 + 内容块下标。 */
interface ImageRef {
  messageIndex: number;
  partIndex: number;
  image: ImageContent;
}

function isImagePart(part: unknown): part is ImageContent {
  return Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "image"
    && typeof (part as { data?: unknown }).data === "string"
    && typeof (part as { mimeType?: unknown }).mimeType === "string");
}

function hasImageContent(message: Message): boolean {
  return (message.role === "user" || message.role === "toolResult")
    && Array.isArray(message.content)
    && message.content.some(isImagePart);
}

/**
 * 对一次上游请求的上下文做图片字节预算裁剪。
 *
 * 未超预算（或没有图片）时原样返回入参（同一引用，零拷贝）；超预算时从最新
 * 图片往旧累加，超出预算的图片整块替换为占位符文本。压缩失败与内部异常一律
 * fail-open（保留原图 / 返回原 context），只发告警——413 本身已经够糟，不能
 * 因为裁剪器故障让请求再挂一次。
 */
export async function applyImageBudget(context: Context, deps: ImageBudgetDeps): Promise<ImageBudgetResult> {
  const refs: ImageRef[] = [];
  for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex += 1) {
    const message = context.messages[messageIndex]!;
    if (!hasImageContent(message)) continue;
    const content = message.content as (TextContent | ImageContent)[];
    for (let partIndex = 0; partIndex < content.length; partIndex += 1) {
      const part = content[partIndex];
      if (isImagePart(part)) refs.push({ messageIndex, partIndex, image: part });
    }
  }
  const bytesBefore = refs.reduce((sum, ref) => sum + base64Bytes(ref.image.data), 0);
  if (refs.length === 0) {
    return {
      context,
      stats: { bytesBefore: 0, bytesAfter: 0, imagesTotal: 0, imagesDownsampled: 0, imagesOmitted: 0, budget: IMAGE_TOTAL_BUDGET_BYTES }
    };
  }
  // 先比满额预算：不超就免去自适应预算的全文扫描（纯文本/小图会话的常见路径）。
  if (bytesBefore <= IMAGE_TOTAL_BUDGET_BYTES) {
    const budget = imageBudgetForContext(context);
    if (bytesBefore <= budget) {
      return {
        context,
        stats: { bytesBefore, bytesAfter: bytesBefore, imagesTotal: refs.length, imagesDownsampled: 0, imagesOmitted: 0, budget }
      };
    }
  }
  // 自适应预算：文本越大的会话留给图片的空间越小（实测大工具流会话文本可达 2MB，
  // 若图片仍按满额 6MB 保留，加上文本就会重新撞上 8MB 网关）。
  const budget = imageBudgetForContext(context);
  const stats: ImageBudgetStats = {
    bytesBefore,
    bytesAfter: bytesBefore,
    imagesTotal: refs.length,
    imagesDownsampled: 0,
    imagesOmitted: 0,
    budget
  };
  if (bytesBefore <= budget) return { context, stats };

  const refKey = (ref: ImageRef): string => `${ref.messageIndex}:${ref.partIndex}`;
  // 每张图片的最终形态：保留（可能已压缩）或省略。从新到旧处理——最新的图片
  // 最可能是当前操作对象，优先保留；预算不足时最先牺牲最旧的图。
  const kept = new Map<string, DownsampleResult>();
  const omitted: string[] = [];
  try {
    let running = 0;
    for (let index = refs.length - 1; index >= 0; index -= 1) {
      const ref = refs[index]!;
      let candidate: DownsampleResult = { data: ref.image.data, mimeType: ref.image.mimeType };
      if (base64Bytes(ref.image.data) > IMAGE_DOWNSAMPLE_MIN_BYTES) {
        const resized = await deps.downsample(ref.image);
        if (resized) {
          candidate = resized;
          stats.imagesDownsampled += 1;
        }
      }
      const candidateBytes = base64Bytes(candidate.data);
      // 最新一张无条件保留（它已被压到 ≤1.5MB；若压缩失败则宁可放行也不能让
      // 模型连当前操作对象都看不到——超出部分由网关上限兜底）。
      if (running === 0 || running + candidateBytes <= budget) {
        kept.set(refKey(ref), candidate);
        running += candidateBytes;
        continue;
      }
      omitted.push(refKey(ref));
    }
  } catch (error) {
    deps.warn(`图片预算裁剪失败，按原样发送本次请求：${error instanceof Error ? error.message : String(error)}`);
    // 半途失败时 downsampled 可能已非 0，但请求实际是原样发出去的——归零后再
    // 上报，避免调用方按「压缩 N 张」打成功样式日志、误导排查。
    return { context, stats: { ...stats, bytesAfter: bytesBefore, imagesDownsampled: 0, imagesOmitted: 0 } };
  }

  const omittedKeys = new Set(omitted);
  stats.imagesOmitted = omitted.length;
  const replacement = new Map<string, string>();
  for (const ref of refs) {
    const key = refKey(ref);
    if (!omittedKeys.has(key)) continue;
    const size = imagePixelSize(ref.image.data, ref.image.mimeType);
    const path = resolveImagePath(context, context.messages[ref.messageIndex]!);
    replacement.set(key, placeholderText(ref.image, { ...(size ? { size } : {}), ...(path ? { path } : {}) }));
  }

  // 只对发生变化的 message 造新对象；其余保持引用（未受影响的旧消息零拷贝）。
  const messages: Message[] = context.messages.map((message, messageIndex) => {
    if (!hasImageContent(message)) return message;
    let changed = false;
    const content = (message.content as (TextContent | ImageContent)[]).map((part, partIndex) => {
      if (!isImagePart(part)) return part;
      const key = `${messageIndex}:${partIndex}`;
      const text = replacement.get(key);
      if (text !== undefined) {
        changed = true;
        return { type: "text" as const, text };
      }
      const resized = kept.get(key);
      if (!resized || resized.data === part.data) return part;
      changed = true;
      return { type: "image" as const, data: resized.data, mimeType: resized.mimeType };
    });
    // hasImageContent 已把角色限定在 user / toolResult（assistant 不携带 image part），
    // 这两类消息的 content 就是 (TextContent | ImageContent)[]，断言成立。
    return changed ? ({ ...message, content } as unknown as Message) : message;
  });
  // 统计口径 = 图片相关内容的字节（保留图按最终 base64、省略图按占位符文本）。
  stats.bytesAfter = refs.reduce((sum, ref) => {
    const text = replacement.get(refKey(ref));
    if (text !== undefined) return sum + text.length;
    return sum + base64Bytes((kept.get(refKey(ref)) ?? ref.image).data);
  }, 0);
  return { context: { ...context, messages }, stats };
}
