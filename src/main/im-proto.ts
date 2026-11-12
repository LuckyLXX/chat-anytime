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
  /** 1: uint64 */
  seqId: number;
  /** 2: uint64 */
  logId: number;
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

function writeVarint(value: number, out: number[]): void {
  let rest = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  do {
    let byte = rest % 128;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | undefined {
  let value = 0;
  let shift = 1;
  let index = offset;
  while (index < bytes.length) {
    const byte = bytes[index++]!;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { value, next: index };
    shift *= 128;
    // uint64 会超过 JS 安全整数：这类值（超长 LogID）不参与任何判定，按坏帧处理。
    if (shift > Number.MAX_SAFE_INTEGER) return undefined;
  }
  return undefined;
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
  const out: number[] = [];
  if (header.key) writeStringField(1, header.key, out);
  if (header.value) writeStringField(2, header.value, out);
  return Uint8Array.from(out);
}

/** 编码一帧（只写必要字段；payload 为空时不落字段，与官方 SDK 一致）。 */
export function encodeFrame(frame: PbFrame): Uint8Array {
  const out: number[] = [];
  if (frame.seqId) {
    writeVarint((FIELD_SEQ_ID << 3) | WIRE_VARINT, out);
    writeVarint(frame.seqId, out);
  }
  if (frame.logId) {
    writeVarint((FIELD_LOG_ID << 3) | WIRE_VARINT, out);
    writeVarint(frame.logId, out);
  }
  if (frame.service) {
    writeVarint((FIELD_SERVICE << 3) | WIRE_VARINT, out);
    writeVarint(frame.service, out);
  }
  if (frame.method) {
    writeVarint((FIELD_METHOD << 3) | WIRE_VARINT, out);
    writeVarint(frame.method, out);
  }
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
    const field = tag.value >>> 3;
    const wire = tag.value & 0x07;
    if (wire === WIRE_LENGTH) {
      const length = readVarint(bytes, offset);
      if (!length) return undefined;
      const end = length.next + length.value;
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
      const field = tag.value >>> 3;
      const wire = tag.value & 0x07;
      if (wire === WIRE_VARINT) {
        const value = readVarint(bytes, offset);
        if (!value) return undefined;
        offset = value.next;
        if (field === FIELD_SEQ_ID) frame.seqId = value.value;
        else if (field === FIELD_LOG_ID) frame.logId = value.value;
        else if (field === FIELD_SERVICE) frame.service = value.value;
        else if (field === FIELD_METHOD) frame.method = value.value;
        continue;
      }
      if (wire === WIRE_LENGTH) {
        const length = readVarint(bytes, offset);
        if (!length) return undefined;
        const end = length.next + length.value;
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
