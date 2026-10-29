import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 源码断言：Range 的行为在 workspace-preview.test.ts 里单测，这里只钉「协议处理器
// 真的把请求头交进去了」。纯逻辑全绿、接线漏一处是这一类改动最常见的失效形态
// （旧实现就是自己 new Response(整份流)，视频永远不能 seek 却没人报错）。
const previewHandler = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("workspace preview protocol wiring", () => {
  it("hands Range and method to the range-aware response builder", () => {
    expect(previewHandler).toContain("previewFileResponse(");
    expect(previewHandler).toContain('rangeHeader: request.headers.get("range")');
    expect(previewHandler).toContain("method: request.method");
    // 旧的整份响应路径不得复活：它没有 Accept-Ranges，媒体栈只能整文件缓冲。
    expect(previewHandler).not.toContain("createReadStream(candidate)");
  });
});
