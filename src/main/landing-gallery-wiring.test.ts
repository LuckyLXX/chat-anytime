import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 空态首页作品墙开关（`appearance.showGalleryWall`）的**接线回归网**。
 *
 * 为什么必须有：这个开关的纯逻辑（`lib/landing-gallery.ts` 的缺省口径）在渲染端
 * 单测里钉住了，但「App 有没有真的用它」没有任何测试能挡——判定函数被写对、
 * 却被漏接一个渲染点（App 有两个 ConversationPane 注入点：分屏格子与单窗口），
 * 现象是「分屏下开关失效」，而且只在用户手动开分屏时才复现。这类**静默失效**
 * 是本仓库一贯要给回归网的地方（先例：`jev-activation.test.ts`、`settings-save-contract.test.ts`）。
 *
 * 用源码断言而不是渲染 App：App 依赖整个 IPC/store/预览面板栈，单测里起不来。
 * 本文件放 src/main 是因为只有 node 侧的 tsconfig 带 node 类型（`node:fs`）；
 * 渲染端测试里读不到源码文件。
 */
const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8");

const appSource = read("../renderer/src/App.tsx");
const paneSource = read("../renderer/src/ConversationPane.tsx");
const generalSource = read("../renderer/src/GeneralSettings.tsx");

describe("空态作品墙开关的接线", () => {
  it("判定只此一处，两个渲染点共用同一个值", () => {
    // 先钉「判定只有一处」：如果将来在别处另写一份 `showGalleryWall !== false`，
    // 缺省口径就有了第二个副本，改一处忘另一处即静默不一致。
    expect([...appSource.matchAll(/showGalleryWallLanding\(/gu)]).toHaveLength(1);
    expect(appSource).toContain("const landingGallery = showGalleryWallLanding(settings.appearance) ? renderGalleryLanding : undefined;");
    // 注入点恰好两处，且都用被开关判过的那个值（漏一处 = 分屏下开关失效）。
    expect([...appSource.matchAll(/renderLanding=/gu)]).toHaveLength(2);
    expect([...appSource.matchAll(/renderLanding=\{landingGallery\}/gu)]).toHaveLength(2);
  });

  it("关掉后仍有默认空态可退（ConversationPane 的兜底分支未被删）", () => {
    // 「关掉 = 退回今天想开发什么？」是用户明确选定的行为，靠的是 renderLanding
    // 可选 + 兜底分支；这里两条都钉住。
    expect(paneSource).toContain("renderLanding?(): ReactNode;");
    expect(paneSource).toContain("renderLanding ? renderLanding() : <div className=\"empty-conversation\" data-pane=\"landing\"");
  });

  it("设置页开关写回同一字段，并随 appearance 整包提交（不需要新增镜像）", () => {
    expect(generalSource).toContain("showGalleryWall: event.target.checked");
    // 缺省 = 展示：老配置没有这个字段时开关也必须显示为开。
    expect(generalSource).toContain("checked={settings.appearance.showGalleryWall !== false}");
    // 为什么放进 appearance 而不是新增顶层字段：appearance 已在 settings.save 的
    // Pick 里整包传，无需在渲染端载荷 / index.ts / pi-runtime.ts 三处再镜像一遍
    // （那三处漏一个就是静默丢配置，见 settings-save-contract.test.ts）。
    const submit = generalSource.slice(generalSource.indexOf('type: "settings.save"'));
    expect(submit.slice(0, submit.indexOf("}"))).toContain("appearance: nextSettings.appearance");
  });
});
