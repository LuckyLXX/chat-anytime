// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceCatalog, RuntimeCommand, SkillDetail, SkillSummary } from "../../shared/protocol";
import { SkillSettings } from "./ResourceSettings";
import { useDesktopStore } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Skill 页回归网（2026-11-24 重排）：
 * ① 左栏标题不再带 `/skill:` 前缀，徽标是作用域（停用项才显示「停用」）；
 * ② 选中条目时发 `skill.inspect`，详情按 `skill-detail` 归位后渲染 SKILL.md 与附件清单；
 * ③ 预览视图吃掉 frontmatter、源码视图保留原文；
 * ④ 标题条上的启用开关仍然发 skill.toggle（命令载荷不变）。
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useDesktopStore.setState({ skillDetails: {} });
  vi.unstubAllGlobals();
});

const SKILLS: SkillSummary[] = [
  {
    id: "skill:computer",
    name: "电脑控制",
    description: "操作桌面上的其他应用窗口",
    source: "随应用分发",
    scope: "bundled",
    filePath: "C:/skills/computer-use/SKILL.md",
    defaultEnabled: true,
    enabled: true,
    toggleable: true,
    disableModelInvocation: false
  },
  {
    id: "skill:notes",
    name: "project-notes",
    description: "整理项目文档",
    source: "当前项目",
    scope: "project",
    filePath: "C:/work/.pidesktop-skills/project-notes/SKILL.md",
    defaultEnabled: true,
    enabled: false,
    toggleable: true,
    disableModelInvocation: true
  }
];

const DETAIL: SkillDetail = {
  id: "skill:computer",
  filePath: "C:/skills/computer-use/SKILL.md",
  content: "---\nname: 电脑控制\ndescription: 操作桌面上的其他应用窗口\n---\n\n# 电脑控制\n\n先枚举窗口，再截图。\n",
  files: [
    { path: "references/notes.md", size: 120 },
    { path: "scripts/run.py", size: 2048 }
  ]
};

async function render(skills: SkillSummary[] = SKILLS): Promise<ReturnType<typeof vi.fn>> {
  const send = vi.fn(async (_command: RuntimeCommand) => undefined);
  // matchMedia 必须给：SKILL.md 预览走 RichContent，主题 token 读取会问系统深浅色偏好。
  vi.stubGlobal("window", { ...globalThis.window, matchMedia: vi.fn().mockReturnValue({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }), piDesktop: { send } });
  const resources = { mcpServers: [], skills, commands: [], diagnostics: [] } as unknown as ResourceCatalog;
  await act(async () => {
    root.render(<SkillSettings resources={resources} />);
  });
  return send;
}

describe("Skill 页", () => {
  it("左栏不带 /skill: 前缀，徽标显示作用域与停用态", async () => {
    await render();
    const rail = [...container.querySelectorAll(".resource-split-rail-item")];
    expect(rail).toHaveLength(2);
    expect(rail[0]?.querySelector("strong")?.textContent).toBe("电脑控制");
    expect(rail[0]?.querySelector(".resource-split-rail-badge")?.textContent).toBe("内置");
    expect(rail[1]?.querySelector(".resource-split-rail-badge")?.textContent).toBe("停用");
    expect(rail[1]?.className).toContain("is-muted");
    // 整页左栏里不应再出现 /skill: 前缀（调用名只出现在右栏概览）
    expect(rail.map((item) => item.textContent ?? "").join(" ")).not.toContain("/skill:");
  });

  it("选中条目时按需读取，回执到达后渲染 SKILL.md 与附件清单", async () => {
    const send = await render();
    expect(send).toHaveBeenCalledWith({ type: "skill.inspect", id: "skill:computer" });

    await act(async () => {
      useDesktopStore.setState({ skillDetails: { [DETAIL.id]: DETAIL } });
    });

    // 标题条 = Skill 名称；概览里保留调用名
    expect(container.querySelector(".resource-split-detail-title strong")?.textContent).toBe("电脑控制");
    expect(container.querySelector(".skill-meta")?.textContent).toContain("/skill:电脑控制");

    // 预览吃掉了 frontmatter，正文照常渲染
    const preview = container.querySelector(".skill-content-body .rich-content");
    expect(preview?.textContent).toContain("先枚举窗口，再截图。");
    expect(preview?.textContent).not.toContain("description: 操作桌面上的其他应用窗口");

    // 附件清单：相对路径 + 大小
    const files = [...container.querySelectorAll(".skill-file-list li")];
    expect(files.map((item) => item.querySelector("code")?.textContent)).toEqual(["references/notes.md", "scripts/run.py"]);
    expect(files[1]?.querySelector("em")?.textContent).toBe("2.0 KB");
    expect(container.querySelector(".skill-files-card .resource-card-head small")?.textContent).toContain("2 个文件");
  });

  it("切到源码保留原文（含 frontmatter）", async () => {
    await render();
    await act(async () => {
      useDesktopStore.setState({ skillDetails: { [DETAIL.id]: DETAIL } });
    });

    const sourceButton = [...container.querySelectorAll(".skill-view-switch button")].find((button) => button.textContent === "源码");
    expect(sourceButton).toBeTruthy();
    await act(async () => {
      sourceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const source = container.querySelector(".skill-source");
    expect(source?.textContent).toContain("---\nname: 电脑控制");
    expect(container.querySelector(".skill-content-body .rich-content")).toBeNull();
  });

  it("标题条上的开关仍然发 skill.toggle", async () => {
    const send = await render();
    const toggle = container.querySelector(".resource-switch input") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => {
      toggle.click();
    });
    expect(send).toHaveBeenCalledWith({ type: "skill.toggle", id: "skill:computer", enabled: false });
  });

  it("读取失败时在内容卡里给出原因，不留静默空态", async () => {
    await render();
    await act(async () => {
      useDesktopStore.setState({
        skillDetails: { [DETAIL.id]: { id: DETAIL.id, filePath: "", content: "", files: [], error: "读取 SKILL.md 失败：ENOENT" } }
      });
    });
    expect(container.querySelector(".skill-error")?.textContent).toContain("读取 SKILL.md 失败");
  });

  it("点击「重载资源」清掉详情缓存，选中效应会重新读取", async () => {
    const send = await render();
    await act(async () => {
      useDesktopStore.setState({ skillDetails: { [DETAIL.id]: DETAIL } });
    });
    send.mockClear();

    const reload = container.querySelector('[data-control="resource-reload"]') as HTMLButtonElement;
    await act(async () => {
      reload.click();
    });

    expect(send).toHaveBeenCalledWith({ type: "resources.reload" });
    expect(useDesktopStore.getState().skillDetails).toEqual({});
    expect(send).toHaveBeenCalledWith({ type: "skill.inspect", id: "skill:computer" });
  });
});
