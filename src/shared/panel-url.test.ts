import { describe, expect, it } from "vitest";
import { panelWorkHost, panelWorkUrl, parsePanelWorkUrl, isPanelWorkHost } from "./protocol.js";
import { PANEL_MEASURE_PAGE, isPanelMeasurePath, isPanelStatePath } from "./panel.js";

/**
 * 面板作品 origin 的契约（2026-10-10 根因修复）。
 *
 * 这些纯函数是「面板数据不再随重启丢」的全部依据：host 必须**由作品 id 唯一决定且
 * 跨启动稳定**（否则 origin 变了，存储又换锁），URL 必须**按目录语义**承载入口路径
 * （否则面板里的相对资源全 404），解析必须拒绝越界与别的 host（否则 theme/preview
 * 两条既有通路会被误吞）。
 */

describe("panelWorkHost", () => {
  it("app 生成的 id 直接用可读 host（便于在 DevTools / profile 里对号）", () => {
    expect(panelWorkHost("g-0b5c16e7f1e9")).toBe("w-g-0b5c16e7f1e9");
    expect(panelWorkHost("g-ff05d72161ae")).toBe("w-g-ff05d72161ae");
  });

  it("同一 id 永远同一 host，不同 id 不同 host", () => {
    const a = panelWorkHost("g-0b5c16e7f1e9");
    expect(panelWorkHost("g-0b5c16e7f1e9")).toBe(a);
    expect(panelWorkHost("g-ff05d72161ae")).not.toBe(a);
    // 前后空白也要归一（渲染端传值不可全信）
    expect(panelWorkHost("  g-0b5c16e7f1e9  ")).toBe(a);
  });

  it("非法 host 字符的 id 退到哈希，且永不产出非法 host", () => {
    for (const id of ["Foo Bar", "作品", "G-ABC", "-leading", "trailing-", "a".repeat(60), ""]) {
      const host = panelWorkHost(id);
      expect(host).toMatch(/^w-[0-9a-f]{16}$/u);
      expect(isPanelWorkHost(host)).toBe(true);
      expect(panelWorkHost(id)).toBe(host);
    }
    // 哈希是「同串同值、异串异值」，两个不同的怪 id 不该共用同一个数据桶
    expect(panelWorkHost("Foo Bar")).not.toBe(panelWorkHost("foo bar"));
  });
});

describe("isPanelWorkHost", () => {
  it("只认面板 host 前缀，不吞 theme / preview", () => {
    expect(isPanelWorkHost("w-g-0b5c16e7f1e9")).toBe(true);
    for (const host of ["preview", "theme", "w-", "w--x", "W-g-abc", "g-abc", ""]) {
      expect(isPanelWorkHost(host)).toBe(false);
    }
  });
});

describe("panelWorkUrl / parsePanelWorkUrl", () => {
  it("段间保留真实斜杠（相对资源靠它按目录解析）", () => {
    expect(panelWorkUrl("w-g-abc", "canvas/index.html")).toBe("pidesktop-file://w-g-abc/canvas/index.html");
    // 反斜杠归一、前导 / 与 ./ 段丢掉
    expect(panelWorkUrl("w-g-abc", "\\canvas\\sub\\index.html")).toBe("pidesktop-file://w-g-abc/canvas/sub/index.html");
    expect(panelWorkUrl("w-g-abc", "/canvas/index.html")).toBe("pidesktop-file://w-g-abc/canvas/index.html");
  });

  it("段内特殊字符逐段编码", () => {
    const url = panelWorkUrl("w-g-abc", "面板 目录/a b.html");
    expect(url).toBe("pidesktop-file://w-g-abc/%E9%9D%A2%E6%9D%BF%20%E7%9B%AE%E5%BD%95/a%20b.html");
  });

  it("往返一致（含中文与嵌套目录）", () => {
    for (const relative of ["index.html", "sub/deep/index.html", "面板 目录/主页.html", "a+b&c/d.html"]) {
      const parsed = parsePanelWorkUrl(panelWorkUrl("w-g-abc", relative));
      expect(parsed).toEqual({ host: "w-g-abc", relativePath: relative });
    }
  });

  it("拒绝别的 host、别的 scheme 与越界段", () => {
    expect(parsePanelWorkUrl("pidesktop-file://preview/D%3A%2Fws/a.png")).toBeUndefined();
    expect(parsePanelWorkUrl("pidesktop-file://theme/current/a.png")).toBeUndefined();
    expect(parsePanelWorkUrl("http://127.0.0.1:1234/w/tok/1/a.png")).toBeUndefined();
    expect(parsePanelWorkUrl("pidesktop-file://w-g-abc/")).toBeUndefined();
    // 编码过的分隔符解码后夹带 "/"：必须在解析层就拒（不能交给下游去猜）
    expect(parsePanelWorkUrl("pidesktop-file://w-g-abc/a%2Fb/c.html")).toBeUndefined();
    // 点段（字面 `..` 与编码 `%2e%2e`）在 URL 解析阶段就被规范化掉，根本走不到遍历：
    // 结果永远落在挂载根内。这里把它钉成行为契约（不是靠下游兜底）。
    expect(parsePanelWorkUrl("pidesktop-file://w-g-abc/../secret.txt")).toEqual({ host: "w-g-abc", relativePath: "secret.txt" });
    expect(parsePanelWorkUrl("pidesktop-file://w-g-abc/%2e%2e/secret.txt")).toEqual({ host: "w-g-abc", relativePath: "secret.txt" });
  });
});

describe("虚拟端点路径判定", () => {
  it("状态端点与量测页都只看最后一段", () => {
    expect(isPanelStatePath("/canvas/__pidesktop_state.json")).toBe(true);
    expect(isPanelStatePath("__pidesktop_state.json")).toBe(true);
    expect(isPanelStatePath("/canvas/__pidesktop_state.json.bak")).toBe(false);
    expect(isPanelMeasurePath("/canvas/__pidesktop_measure.html")).toBe(true);
    expect(isPanelMeasurePath("__pidesktop_measure.html")).toBe(true);
    expect(isPanelMeasurePath(`/canvas/${PANEL_MEASURE_PAGE}.bak`)).toBe(false);
    // 两个端点互不串门
    expect(isPanelStatePath(`/${PANEL_MEASURE_PAGE}`)).toBe(false);
    expect(isPanelMeasurePath("/__pidesktop_state.json")).toBe(false);
  });
});
