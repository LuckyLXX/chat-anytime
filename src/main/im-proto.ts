/**
 * 飞书长连接帧协议（pbbp2.Frame）的手写 protobuf 编解码（2026-11-12）。
 *
 * 为什么手写而不引 protobufjs：整条链只用到 6 个字段（1 SeqID / 2 LogID /
 * 3 service / 4 method / 5 headers / 8 payload），varint + length-delimited 两种
 * wire type 就够；手写约 120 行、零运行时依赖、可直接对官方 SDK 的字节做黄金
 * 对比（`im-proto.test.ts` 用 protobufjs 现算基准，不硬编码容易写错的字节）。
 *
 * 形状来源：`larksuite/node-sdk` 的 `ws-client/*.ts`（官方实现）。额外字段
 * 6 payloadEncoding / 7 payloadType / 9 LogIDNew 我们不生成，但解码时**跳过**
 * （未知字段一律跳过而不是报错——平台侧加字段不能让我们断连）。
 *
 * 纪律：解码永不抛异常，坏帧返回 undefined（一行坏字节不能把长连接带崩）。
 */

export interface PbHeader {
  key: string;
  value: string;
}

export interface PbFrame {
  /**
   * 1: uint64。用 **bigint** 承载完整 64 位：服务端的 LogID 实测会超过 2^53
   * （例：`ac 81 8d f7 c9 9c cc f3 18` ≈ 1.79e18），用 number 解码会丢精度，
   * 而 ACK 是把原帧回显——精度一丢就等于换了一帧，平台不认。
   * 我们自建的帧（心跳）用 0 即可，number/bigint 都接受。
   */
  seqId: number | bigint;
  /** 2: uint64（同上：必须精确）。 */
  logId: number | bigint;
  /** 3: int32 */
  service: number;
  /** 4: int32（0=control，1=data） */
  method: number;
  /** 5: repeated Header */
  headers: PbHeader[];
  /** 8: bytes */
  payload: Uint8Array;
}

const FIELD_SEQ_ID = 1;
const FIELD_LOG_ID = 2;
const FIELD_SERVICE = 3;
const FIELD_METHOD = 4;
const FIELD_HEADERS = 5;
const FIELD_PAYLOAD = 8;

const WIRE_VARINT = 0;
const WIRE_LENGTH = 2;
const WIRE_FIXED64 = 1;
const WIRE_FIXED32 = 5;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** 写 varint：bigint 走精确路径，number 走快路径（负数/NaN 按 0 处理）。 */
function writeVarint(value: number | bigint, out: number[]): void {
  if (typeof value === "bigint") {
    let rest = value < 0n ? 0n : value;
    do {
      let byte = Number(rest & 0x7fn);
      rest >>= 7n;
      if (rest > 0n) byte |= 0x80;
      out.push(byte);
    } while (rest > 0n);
    return;
  }
  let rest = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
}

/**
 * 读 varint：一律返回 **bigint**。
 *
 * 为什么不能用 number 累加再判上限：服务端帧的 `LogID` 是完整 uint64（实测
 * 1.79e18 > 2^53），旧实现对超长 varint 直接返回 undefined，于是**每一帧都被判
 * 坏帧**——心跳收不到 pong（看门狗每 270 秒重连一次），事件也全部丢弃（用户看到
 * 的就是「发消息没反应」）。uint64 只能精确表示在 bigint 里。
 */
function readVarint(bytes: Uint8Array, offset: number): { value: bigint; next: number } | undefined {
  let value = 0n;
  let shift = 0n;
  let index = offset;
  while (index < bytes.length) {
    const byte = bytes[index++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift += 7n;
    // 超过 10 字节（64 位 varint 的物理上限）即编码本身有问题。
    if (shift > 63n) return undefined;
  }
  return undefined;
}

/** varint 解码值 → int32（service/method；越界按 0，避免负数 Tag 之类的脏值进逻辑）。 */
function toInt32(value: bigint): number {
  if (value > 0x7fffffffn) return 0;
  return Number(value);
}

function writeLengthDelimited(field: number, bytes: Uint8Array, out: number[]): void {
  writeVarint((field << 3) | WIRE_LENGTH, out);
  writeVarint(bytes.length, out);
  for (const byte of bytes) out.push(byte);
}

function writeStringField(field: number, value: string, out: number[]): void {
  writeLengthDelimited(field, textEncoder.encode(value), out);
}

function encodeHeader(header: PbHeader): Uint8Array {
  // Header 的两个字段同样是 proto2 `required`：空串也要写出来（省略会让整帧非法）。
  const out: number[] = [];
  writeStringField(1, header.key, out);
  writeStringField(2, header.value, out);
  return Uint8Array.from(out);
}

/**
 * 编码一帧。
 *
 * **标量字段 1–4 无论是否为 0 都必须写出**：官方 `pbbp2.proto` 是 **proto2**，四个字段
 * 都是 `required`，服务端解码缺字段的帧会直接判非法——按 proto3 习惯省略 0 会让
 * 我们发出去的心跳（method=0、SeqID=0、LogID=0）整帧作废。实测症状：服务端从不回
 * pong，看门狗每 3×PingInterval 判一次「假活」重连，事件也永远不投递
 * （2026-11-12 真机探针发现）。payload 是 `optional bytes`，空时省略。
 */
export function encodeFrame(frame: PbFrame): Uint8Array {
  const out: number[] = [];
  writeVarint((FIELD_SEQ_ID << 3) | WIRE_VARINT, out);
  writeVarint(frame.seqId, out);
  writeVarint((FIELD_LOG_ID << 3) | WIRE_VARINT, out);
  writeVarint(frame.logId, out);
  writeVarint((FIELD_SERVICE << 3) | WIRE_VARINT, out);
  writeVarint(frame.service, out);
  writeVarint((FIELD_METHOD << 3) | WIRE_VARINT, out);
  writeVarint(frame.method, out);
  for (const header of frame.headers) {
    writeLengthDelimited(FIELD_HEADERS, encodeHeader(header), out);
  }
  if (frame.payload && frame.payload.length > 0) {
    writeLengthDelimited(FIELD_PAYLOAD, frame.payload, out);
  }
  return Uint8Array.from(out);
}

function decodeHeader(bytes: Uint8Array): PbHeader | undefined {
  let key = "";
  let value = "";
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag) return undefined;
    offset = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 0x07n);
    if (wire === WIRE_LENGTH) {
      const length = readVarint(bytes, offset);
      if (!length) return undefined;
      const end = length.next + Number(length.value);
      if (end > bytes.length) return undefined;
      const slice = bytes.subarray(length.next, end);
      if (field === 1) key = textDecoder.decode(slice);
      else if (field === 2) value = textDecoder.decode(slice);
      offset = end;
      continue;
    }
    if (wire === WIRE_VARINT) {
      const skipped = readVarint(bytes, offset);
      if (!skipped) return undefined;
      offset = skipped.next;
      continue;
    }
    if (wire === WIRE_FIXED64) {
      offset += 8;
      continue;
    }
    if (wire === WIRE_FIXED32) {
      offset += 4;
      continue;
    }
    return undefined;
  }
  if (offset !== bytes.length) return undefined;
  return { key, value };
}

/** 解码一帧；截断/非法 wire type 返回 undefined（调用方只记日志）。 */
export function decodeFrame(bytes: Uint8Array): PbFrame | undefined {
  try {
    const frame: PbFrame = { seqId: 0, logId: 0, service: 0, method: 0, headers: [], payload: new Uint8Array(0) };
    let offset = 0;
    while (offset < bytes.length) {
      const tag = readVarint(bytes, offset);
      if (!tag) return undefined;
      offset = tag.next;
      const field = Number(tag.value >> 3n);
      const wire = Number(tag.value & 0x07n);
      if (wire === WIRE_VARINT) {
        const value = readVarint(bytes, offset);
        if (!value) return undefined;
        offset = value.next;
        if (field === FIELD_SEQ_ID) frame.seqId = value.value;
        else if (field === FIELD_LOG_ID) frame.logId = value.value;
        else if (field === FIELD_SERVICE) frame.service = toInt32(value.value);
        else if (field === FIELD_METHOD) frame.method = toInt32(value.value);
        continue;
      }
      if (wire === WIRE_LENGTH) {
        const length = readVarint(bytes, offset);
        if (!length) return undefined;
        const end = length.next + Number(length.value);
        if (end > bytes.length) return undefined;
        const slice = bytes.subarray(length.next, end);
        offset = end;
        if (field === FIELD_HEADERS) {
          const header = decodeHeader(slice);
          if (header) frame.headers.push(header);
        } else if (field === FIELD_PAYLOAD) {
          frame.payload = slice.slice();
        }
        // 6/7/9 等字符串字段（payloadEncoding/payloadType/LogIDNew）与未知字段：
        // 读掉长度后跳过——未来平台加字段不该让我们断连。
        continue;
      }
      if (wire === WIRE_FIXED64) {
        offset += 8;
        continue;
      }
      if (wire === WIRE_FIXED32) {
        offset += 4;
        continue;
      }
      return undefined;
    }
    return frame;
  } catch {
    // 任何意外（越界 subarray、解码器异常）都按坏帧处理。
    return undefined;
  }
}

/** 取某个 header 的值（重复 key 取第一个，与官方实现一致）。 */
export function headerValue(frame: Pick<PbFrame, "headers">, key: string): string | undefined {
  for (const header of frame.headers) {
    if (header.key === key) return header.value;
  }
  return undefined;
}

/** 追加/覆盖一个 header（不存在则追加，存在则就地更新）。 */
export function setHeader(frame: PbFrame, key: string, value: string): PbFrame {
  const headers = frame.headers.map((header) => (header.key === key ? { key, value } : header));
  if (!headers.some((header) => header.key === key)) headers.push({ key, value });
  return { ...frame, headers };
}

/** 把 payload 换成一段 UTF-8 文本（ACK 的 `{code:200}` / 卡片回执）。 */
export function setPayloadText(frame: PbFrame, text: string): PbFrame {
  return { ...frame, payload: textEncoder.encode(text) };
}

/** payload → UTF-8 文本（事件体/心跳体都是 JSON）。 */
export function payloadText(frame: Pick<PbFrame, "payload">): string {
  return textDecoder.decode(frame.payload);
}
