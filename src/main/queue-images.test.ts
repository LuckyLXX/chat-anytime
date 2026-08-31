import { describe, expect, it } from "vitest";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  alignQueueState,
  imageAttachmentsFrom,
  promoteQueueMessage,
  queuedMessageText,
  queueSnapshotMessages,
  removeQueueMessage,
  replayQueueArgs,
  type QueueState
} from "./queue-images.js";

function image(data: string, mimeType = "image/png"): ImageContent {
  return { type: "image", data, mimeType };
}

function state(overrides: Partial<QueueState> = {}): QueueState {
  return {
    steeringTexts: [],
    followUpTexts: [],
    steeringImages: [],
    followUpImages: [],
    ...overrides
  };
}

describe("alignQueueState", () => {
  it("keeps mirrors exactly aligned with the Pi text arrays", () => {
    const aligned = alignQueueState(["s0", "s1"], ["f0"], {
      steeringImages: [[image("a")], []],
      followUpImages: [[image("b"), image("c")]]
    });
    expect(aligned.steeringImages).toEqual([[image("a")], []]);
    expect(aligned.followUpImages).toEqual([[image("b"), image("c")]]);
  });

  it("truncates mirror heads already consumed by Pi (drain happens head-first)", () => {
    // Pi 队列消费了一条 followUp（agent_end 后注入回合）：文本数组只剩 f1，
    // 镜像还留有 f0 的图——读侧对齐必须把多出的头部丢掉。
    const aligned = alignQueueState([], ["f1"], {
      steeringImages: [],
      followUpImages: [[image("consumed")], [image("kept")]]
    });
    expect(aligned.followUpImages).toEqual([[image("kept")]]);
  });

  it("pads missing mirror entries with empty arrays (no image items)", () => {
    const aligned = alignQueueState(["s0"], ["f0"], { steeringImages: [], followUpImages: [] });
    expect(aligned.steeringImages).toEqual([[]]);
    expect(aligned.followUpImages).toEqual([[]]);
  });
});

describe("queuedMessageText", () => {
  it("keeps non-empty text untouched", () => {
    expect(queuedMessageText("看图", 1)).toBe("看图");
    expect(queuedMessageText("hello", 0)).toBe("hello");
  });

  it("replaces empty text with a placeholder when images are queued (Pi display-array ghost guard)", () => {
    expect(queuedMessageText("", 1)).toBe("（图片）");
    expect(queuedMessageText("   \n", 2)).toBe("（图片）");
    expect(queuedMessageText("", 0)).toBe("");
  });
});

describe("queueSnapshotMessages", () => {
  it("projects images only as imageCount, steering before followUp", () => {
    const messages = queueSnapshotMessages(state({
      steeringTexts: ["s0"],
      steeringImages: [[image("a"), image("b")]],
      followUpTexts: ["f0", "f1"],
      followUpImages: [[], [image("c")]]
    }));
    expect(messages).toEqual([
      { kind: "steering", index: 0, text: "s0", imageCount: 2 },
      { kind: "followUp", index: 0, text: "f0" },
      { kind: "followUp", index: 1, text: "f1", imageCount: 1 }
    ]);
  });

  it("returns an empty list for an empty queue", () => {
    expect(queueSnapshotMessages(state())).toEqual([]);
  });
});

describe("removeQueueMessage", () => {
  it("removes the target text together with its image mirror entry", () => {
    const next = removeQueueMessage(
      state({
        steeringTexts: ["a", "b"],
        steeringImages: [[], [image("bimg")]],
        followUpTexts: ["c"],
        followUpImages: [[image("cimg")]]
      }),
      "steering", 1, "b"
    );
    expect(next.steeringTexts).toEqual(["a"]);
    expect(next.steeringImages).toEqual([[]]);
    // 删除后 followUp 保持原样。
    expect(next.followUpTexts).toEqual(["c"]);
    expect(next.followUpImages).toEqual([[image("cimg")]]);
  });

  it("reindexes the remaining items in the same kind", () => {
    const next = removeQueueMessage(state({ followUpTexts: ["x", "y", "z"], followUpImages: [[], [image("yimg")], []] }), "followUp", 1, "y");
    expect(next.followUpTexts).toEqual(["x", "z"]);
    expect(next.followUpImages).toEqual([[], []]);
  });

  it("rejects when the snapshot text no longer matches (queue already drifted)", () => {
    expect(() => removeQueueMessage(state({ followUpTexts: ["new"] }), "followUp", 0, "old")).toThrow("待发送列表已变化，请重试");
  });
});

describe("promoteQueueMessage", () => {
  it("busy: moves the target to the steering tail with its images", () => {
    const outcome = promoteQueueMessage(
      state({
        steeringTexts: ["s0"],
        steeringImages: [[]],
        followUpTexts: ["f0", "f1"],
        followUpImages: [[image("f0img")], []]
      }),
      "followUp", 0, "f0", true
    );
    expect(outcome.state.steeringTexts).toEqual(["s0", "f0"]);
    expect(outcome.state.steeringImages).toEqual([[], [image("f0img")]]);
    expect(outcome.state.followUpTexts).toEqual(["f1"]);
    expect(outcome.state.followUpImages).toEqual([[]]);
    expect(outcome.target).toEqual({ text: "f0", images: [image("f0img")] });
  });

  it("busy: promoting a steering item re-appends it to the steering tail", () => {
    const outcome = promoteQueueMessage(state({ steeringTexts: ["a", "b"], steeringImages: [[image("a")], []] }), "steering", 0, "a", true);
    expect(outcome.state.steeringTexts).toEqual(["b", "a"]);
    expect(outcome.state.steeringImages).toEqual([[], [image("a")]]);
  });

  it("idle: removes the target and returns it for direct sending (no promotion)", () => {
    const outcome = promoteQueueMessage(
      state({ followUpTexts: ["f0", "f1"], followUpImages: [[image("f0img")], []] }),
      "followUp", 0, "f0", false
    );
    expect(outcome.state.followUpTexts).toEqual(["f1"]);
    expect(outcome.state.followUpImages).toEqual([[]]);
    expect(outcome.target).toEqual({ text: "f0", images: [image("f0img")] });
  });

  it("rejects when the target text drifted", () => {
    expect(() => promoteQueueMessage(state({ followUpTexts: ["new"] }), "followUp", 0, "old", true)).toThrow("待发送列表已变化，请重试");
  });
});

describe("replayQueueArgs", () => {
  it("replays steering first then followUp, carrying images inline", () => {
    const items = replayQueueArgs(state({
      steeringTexts: ["s0"],
      steeringImages: [[image("simg")]],
      followUpTexts: ["f0", "f1"],
      followUpImages: [[], [image("fimg")]]
    }));
    expect(items).toEqual([
      { kind: "steering", text: "s0", images: [image("simg")] },
      { kind: "followUp", text: "f0", images: [] },
      { kind: "followUp", text: "f1", images: [image("fimg")] }
    ]);
  });
});

describe("imageAttachmentsFrom", () => {
  it("derives placeholder names and sizes from the image content", () => {
    const attachments = imageAttachmentsFrom([image("AA==", "image/png"), image("BBBB", "image/jpeg")]);
    expect(attachments).toEqual([
      { kind: "image", name: "图片 1.png", mimeType: "image/png", size: 1, data: "AA==" },
      { kind: "image", name: "图片 2.jpg", mimeType: "image/jpeg", size: 3, data: "BBBB" }
    ]);
  });
});