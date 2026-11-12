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
    seqId: 3,
    logId: 987654321,
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
      SeqID: frame.seqId,
      LogID: frame.logId,
      service: frame.service,
      method: frame.method,
      headers: frame.headers,
      payload: frame.payload
    })).finish();
    expect(Buffer.from(encodeFrame(frame)).toString("hex")).toBe(Buffer.from(golden).toString("hex"));
  });

  it("skips zero-valued scalars (proto3-style omission, matching the official SDK)", () => {
    const bytes = encodeFrame({ seqId: 0, logId: 0, service: 0, method: 0, headers: [{ key: "type", value: "ping" }], payload: new Uint8Array(0) });
    // 只有 headers 字段（field 5, wire 2 = tag 0x2a），没有 seqId/logId/service/method/payload。
    expect(bytes[0]).toBe(0x2a);
    expect(decodeFrame(bytes)).toEqual({ seqId: 0, logId: 0, service: 0, method: 0, headers: [{ key: "type", value: "ping" }], payload: new Uint8Array(0) });
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
    expect(decoded).toMatchObject({ seqId: 7, logId: 42, service: 9, method: 1 });
    expect(decoded?.headers).toEqual([{ key: "type", value: "card" }, { key: "message_id", value: "om_1" }]);
    expect(payloadText(decoded!)).toBe('{"schema":"2.0"}');
  });

  it("round-trips through our own encoder (JSON payloads with non-ASCII text)", () => {
    const frame: PbFrame = { seqId: 1, logId: 2, service: 3, method: 1, headers: [{ key: "type", value: "event" }], payload: encoder.encode('{"text":"你好，飞书"}') };
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded).toEqual(frame);
    expect(payloadText(decoded!)).toBe('{"text":"你好，飞书"}');
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
