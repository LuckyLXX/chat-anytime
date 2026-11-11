import { describe, expect, it } from "vitest";
import { isSoftwareRenderer, readWebglRenderer, resolveBlurEnabled } from "./graphics-tier";

/**
 * 图形档位判定（2026-11-11）。这些字符串全部来自真实机器：
 * - `Microsoft Basic Render Driver` 是本机 `--disable-gpu` 下 ANGLE/WARP 的 unmasked renderer；
 * - 虚拟机的 Microsoft Basic Display Adapter、RDP 会话走的是同一条 WARP 路径；
 * - SwiftShader / llvmpipe 是 Chromium 的软件 GL 兜底。
 * 判错方向的代价不对称：误判为软件渲染 = 白白摘掉毛玻璃（可手动开回），
 * 漏判 = 低配机继续 12fps（用户报的正是这个），所以宁可宽一点匹配。
 */
describe("isSoftwareRenderer", () => {
  it("识别 WARP / 基本显示适配器的 ANGLE renderer", () => {
    expect(isSoftwareRenderer("ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(true);
    expect(isSoftwareRenderer("Microsoft Basic Render Driver")).toBe(true);
  });

  it("识别 SwiftShader / llvmpipe / softpipe", () => {
    expect(isSoftwareRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)")).toBe(true);
    expect(isSoftwareRenderer("Google SwiftShader")).toBe(true);
    expect(isSoftwareRenderer("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(isSoftwareRenderer("Gallium 0.4 on softpipe")).toBe(true);
  });

  it("真实显卡不误伤", () => {
    expect(isSoftwareRenderer("ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001681) Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(false);
    expect(isSoftwareRenderer("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(false);
    expect(isSoftwareRenderer("Apple M2 Pro")).toBe(false);
    expect(isSoftwareRenderer("Intel(R) UHD Graphics 630")).toBe(false);
  });

  it("空值/未知不降级（宁可保留毛玻璃）", () => {
    expect(isSoftwareRenderer(undefined)).toBe(false);
    expect(isSoftwareRenderer(null)).toBe(false);
    expect(isSoftwareRenderer("")).toBe(false);
    expect(isSoftwareRenderer("   ")).toBe(false);
  });
});

describe("resolveBlurEnabled", () => {
  it("缺省与 auto 都由检测结果决定", () => {
    expect(resolveBlurEnabled(undefined, false)).toBe(true);
    expect(resolveBlurEnabled("auto", false)).toBe(true);
    expect(resolveBlurEnabled(undefined, true)).toBe(false);
    expect(resolveBlurEnabled("auto", true)).toBe(false);
  });

  it("on / off 是用户强制，压过检测结果", () => {
    expect(resolveBlurEnabled("on", true)).toBe(true);
    expect(resolveBlurEnabled("on", false)).toBe(true);
    expect(resolveBlurEnabled("off", false)).toBe(false);
    expect(resolveBlurEnabled("off", true)).toBe(false);
  });
});

describe("readWebglRenderer", () => {
  function fakeDocument(renderer: string | null, options: { withExtension?: boolean; noContext?: boolean } = {}): Document {
    const { withExtension = true, noContext = false } = options;
    const context = {
      getExtension: (name: string) => {
        if (name === "WEBGL_debug_renderer_info") return withExtension ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null;
        if (name === "WEBGL_lose_context") return { loseContext: () => undefined };
        return null;
      },
      getParameter: (parameter: number) => (parameter === 0x9246 ? renderer : "WebKit WebGL")
    };
    return {
      createElement: () => ({
        getContext: () => (noContext ? null : context)
      })
    } as unknown as Document;
  }

  it("优先取 unmasked renderer", () => {
    expect(readWebglRenderer(fakeDocument("ANGLE (Microsoft, Microsoft Basic Render Driver, D3D11)"))).toBe("ANGLE (Microsoft, Microsoft Basic Render Driver, D3D11)");
  });

  it("没有调试扩展时退回 RENDERER", () => {
    expect(readWebglRenderer(fakeDocument("ignored", { withExtension: false }))).toBe("WebKit WebGL");
  });

  it("拿不到 WebGL 上下文或抛错时返回 undefined（调用方按未检测处理）", () => {
    expect(readWebglRenderer(fakeDocument("x", { noContext: true }))).toBeUndefined();
    const throwing = { createElement: () => { throw new Error("boom"); } } as unknown as Document;
    expect(readWebglRenderer(throwing)).toBeUndefined();
  });

  it("与 isSoftwareRenderer 串起来：真实 WARP 字符串判定为软件渲染", () => {
    expect(isSoftwareRenderer(readWebglRenderer(fakeDocument("ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)")))).toBe(true);
  });
});
