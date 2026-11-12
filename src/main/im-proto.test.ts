import protobuf from "protobufjs";
import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, headerValue, payloadText, setHeader, setPayloadText, type PbFrame } from "./im-proto";

/**
 * pbbp2 帧编解码的回归网。
 *
 * 核心不是「自己编自己解能对上」（那样写错字段号也照样绿），而是**与 protobufjs
 * 现算的字节逐字节对比**：proto 定义照官方 SDK 的 pbbp2.proto 写（字段号就是
 * wire 契约），基准在测试里现生成，不硬编码容易手抄错的字节串。
 */

const PROTO = `
syntax = "proto2";
package pbbp2;
message Header {
  required string key = 1;
  required string value = 2;
}
message Frame {
  required uint64 SeqID = 1;
  required uint64 LogID = 2;
  required int32 service = 3;
  required int32 method = 4;
  repeated Header headers = 5;
  optional string payloadEncoding = 6;
  optional string payloadType = 7;
  optional bytes payload = 8;
  optional string LogIDNew = 9;
}
`;

function frameType() {
  const root = protobuf.parse(PROTO, { keepCase: true }).root;
  return root.lookupType("pbbp2.Frame");
}

const encoder = new TextEncoder();

function sampleFrame(): PbFrame {
  return {
    seqId: 3n,
    logId: 987654321n,
    service: 12,
    method: 1,
    headers: [
      { key: "type", value: "event" },
      { key: "message_id", value: "om_abc123" },
      { key: "sum", value: "1" },
      { key: "seq", value: "0" }
    ],
    payload: encoder.encode('{"schema":"2.0","header":{"event_type":"im.message.receive_v1"}}')
  };
}

describe("encodeFrame", () => {
  it("emits the same bytes as protobufjs for the official pbbp2.Frame schema", () => {
    const Frame = frameType();
    const frame = sampleFrame();
    const golden = Frame.encode(Frame.fromObject({
      SeqID: Number(frame.seqId),
      LogID: Number(frame.logId),
      service: frame.service,
      method: frame.method,
      headers: frame.headers,
      payload: frame.payload
    })).finish();
    expect(Buffer.from(encodeFrame(frame)).toString("hex")).toBe(Buffer.from(golden).toString("hex"));
  });

  it("always emits the proto2 required scalars, even when zero (a ping frame must be valid)", () => {
    // 官方 pbbp2.proto 是 proto2：SeqID/LogID/service/method 都是 required。按 proto3
    // 习惯省略 0 会让心跳帧整帧非法（实测：服务端从不回 pong、事件也永不投递）。
    const Frame = frameType();
    const frame: PbFrame = { seqId: 0, logId: 0, service: 42, method: 0, headers: [{ key: "type", value: "ping" }], payload: new Uint8Array(0) };
    const golden = Frame.encode(Frame.fromObject({ SeqID: 0, LogID: 0, service: 42, method: 0, headers: frame.headers })).finish();
    const bytes = encodeFrame(frame);
    expect(Buffer.from(bytes).toString("hex")).toBe(Buffer.from(golden).toString("hex"));
    // 形状固定：08 00（SeqID）+ 10 00（LogID）+ 18 2a（service=42）+ 20 00（method=0）+ headers
    expect(Buffer.from(bytes).toString("hex").startsWith("08001000182a2000")).toBe(true);
    expect(decodeFrame(bytes)).toEqual({ ...frame, seqId: 0n, logId: 0n });
  });
});

describe("decodeFrame", () => {
  it("decodes protobufjs-encoded bytes (round trip through the official schema)", () => {
    const Frame = frameType();
    const golden = Frame.encode(Frame.fromObject({
      SeqID: 7,
      LogID: 42,
      service: 9,
      method: 1,
      headers: [{ key: "type", value: "card" }, { key: "message_id", value: "om_1" }],
      payload: encoder.encode('{"schema":"2.0"}')
    })).finish();
    const decoded = decodeFrame(new Uint8Array(golden));
    expect(decoded).toMatchObject({ seqId: 7n, logId: 42n, service: 9, method: 1 });
    expect(decoded?.seqId).toBe(7n);
    expect(decoded?.logId).toBe(42n);
    expect(decoded?.headers).toEqual([{ key: "type", value: "card" }, { key: "message_id", value: "om_1" }]);
    expect(payloadText(decoded!)).toBe('{"schema":"2.0"}');
  });

  it("round-trips through our own encoder (JSON payloads with non-ASCII text)", () => {
    const frame: PbFrame = { seqId: 1n, logId: 2n, service: 3, method: 1, headers: [{ key: "type", value: "event" }], payload: encoder.encode('{"text":"你好，飞书"}') };
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded).toEqual(frame);
    expect(payloadText(decoded!)).toBe('{"text":"你好，飞书"}');
  });

  it("decodes frames whose uint64 LogID exceeds 2^53 (regression: every server frame was rejected)", () => {
    // 2026-11-12 真机抓包：我们发 ping 后服务端回的 pong，LogID ≈ 1.79e18（9 字节 varint），
    // 超出 Number.MAX_SAFE_INTEGER。旧实现遇到这种 varint 直接返回 undefined ⇒ 心跳收不到
    // pong（看门狗每 270s 重连一次）、**所有事件帧也被丢弃**，用户侧表现为「发消息完全没反应」。
    // 用 protobufjs 以十进制字符串精确构造同样的 uint64（不依赖抓包长度）。
    const Frame = frameType();
    const bigLogId = "111300000000000012"; // 任意 > 2^53 的 uint64
    const golden = Frame.encode(Frame.fromObject({
      SeqID: 0,
      LogID: bigLogId,
      service: 33554678,
      method: 0,
      headers: [{ key: "code", value: "0" }, { key: "type", value: "pong" }],
      payload: encoder.encode('{"PingInterval":90,"ReconnectNonce":25}')
    })).finish();
    const decoded = decodeFrame(new Uint8Array(golden));
    expect(decoded).toBeDefined();
    expect(decoded!.logId).toBe(BigInt(bigLogId));
    expect(decoded!.method).toBe(0);
    expect(decoded!.service).toBe(33554678);
    expect(headerValue(decoded!, "type")).toBe("pong");
    expect(payloadText(decoded!)).toBe('{"PingInterval":90,"ReconnectNonce":25}');
    // ACK 必须原样回显：重新编码后与原始字节逐字节相同（LogID 精度不能丢）。
    expect(Buffer.from(encodeFrame(decoded!)).toString("hex")).toBe(Buffer.from(golden).toString("hex"));
  });

  it("skips unknown fields instead of failing (platform may add fields)", () => {
    const Frame = frameType();
    const golden = Frame.encode(Frame.fromObject({
      SeqID: 1,
      LogID: 0,
      service: 1,
      method: 1,
      headers: [],
      payloadEncoding: "json",
      payloadType: "event",
      LogIDNew: "anything",
      payload: encoder.encode("{}")
    })).finish();
    const decoded = decodeFrame(new Uint8Array(golden));
    expect(decoded?.method).toBe(1);
    expect(payloadText(decoded!)).toBe("{}");
  });

  it("returns undefined for truncated or malformed bytes and never throws", () => {
    const bytes = encodeFrame(sampleFrame());
    // 从尾部少 3 个字节 = 切在 payload 的 length-delimited 中间，必须判坏帧
    // （切在字段边界上的「短帧」本身是合法的 protobuf，不在此列）。
    expect(decodeFrame(bytes.subarray(0, bytes.length - 3))).toBeUndefined();
    expect(decodeFrame(bytes.subarray(0, 1))).toBeUndefined();
    // 非法 wire type（7）：解码器必须拒绝而不是抛。
    expect(decodeFrame(new Uint8Array([0x0f, 0x01]))).toBeUndefined();
    expect(decodeFrame(new Uint8Array(0))).toBeDefined(); // 空帧是合法 protobuf（全默认值）
    expect(() => decodeFrame(new Uint8Array([0xff, 0xff, 0xff]))).not.toThrow();
  });
});

describe("frame helpers", () => {
  it("reads a header value and appends/overwrites headers and payload text", () => {
    const frame = sampleFrame();
    expect(headerValue(frame, "message_id")).toBe("om_abc123");
    expect(headerValue(frame, "missing")).toBeUndefined();

    const acked = setPayloadText(setHeader(frame, "biz_rt", "12"), JSON.stringify({ code: 200 }));
    expect(headerValue(acked, "biz_rt")).toBe("12");
    expect(payloadText(acked)).toBe('{"code":200}');
    // 原帧不被修改（ACK 是「同一帧的副本」，不改收到的那份）。
    expect(headerValue(frame, "biz_rt")).toBeUndefined();

    const overwritten = setHeader(acked, "type", "card");
    expect(overwritten.headers.filter((header) => header.key === "type")).toEqual([{ key: "type", value: "card" }]);
  });
});
