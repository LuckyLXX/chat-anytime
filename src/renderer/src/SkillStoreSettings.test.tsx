// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCommand, SkillStoreResult, SkillStoreSkill } from "../../shared/protocol";
import { SkillStoreSettings } from "./SkillStoreSettings";
import { applySkillStoreResult, useDesktopStore, type SkillStoreState } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Skill 商店页的回归网。重点钉三类**静默失效**：
 * ① 命令载荷（requestId + query/scope）——字段写错面板永远停在「加载中」，没有报错；
 * ② requestId 认领规则——列表/详情并发时旧结果串台会让用户看到别的查询的内容；
 * ③ UI 契约钩子与「已安装 / 有更新」徽标——主题契约与用户判断是否重装都靠它。
 */

const EMPTY: SkillStoreState = {
  listLoading: false,
  listSkills: [],
  listTotal: 0,
  topSkills: [],
  topLoading: false,
  categories: [],
  categoriesLoading: false,
  detailLoading: false,
  detailVersions: [],
  detailFiles: [],
  detailTotalBytes: 0,
  installs: []
};

function skill(partial: Partial<SkillStoreSkill>): SkillStoreSkill {
  return {
    slug: "demo-skill",
    name: "示例技能",
    description: "demo",
    descriptionZh: "示例中文描述",
    tags: [],
    subCategories: [],
    downloads: 12345,
    stars: 678,
    installs: 0,
    score: 90,
    requiresApiKey: false,
    version: "1.0.0",
    ownerName: "tester",
    category: "dev-programming",
    ...partial
  };
}

let container: HTMLDivElement;
let root: Root;
let sent: RuntimeCommand[];

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sent = [];
  vi.stubGlobal("piDesktop", {
    send: async (command: RuntimeCommand) => {
      sent.push(command);
    }
  });
  useDesktopStore.setState({
    skillStore: { ...EMPTY, categories: [{ key: "dev-programming", name: "开发编程", sortOrder: 30 }] },
    resources: { skills: [], commands: [], mcpServers: [], todos: [], memory: [], subagents: [], hooks: [], hooksEnabled: true, automation: [], automationRuns: [], gallery: [], diagnostics: [] },
    snapshot: { ...useDesktopStore.getState().snapshot, workspace: "D:/ws" }
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<SkillStoreSettings />);
  });
}

function byControl(control: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[data-control="${control}"]`)];
}

describe("Skill 商店页", () => {
  it("挂载即拉分类与列表，命令带 requestId 与分页查询", async () => {
    await render();
    const kinds = sent.map((command) => command.type);
    expect(kinds).toContain("skill-store.categories");
    expect(kinds).toContain("skill-store.list");
    const list = sent.find((command) => command.type === "skill-store.list") as Extract<RuntimeCommand, { type: "skill-store.list" }>;
    expect(typeof list.requestId).toBe("string");
    expect(list.requestId.length).toBeGreaterThan(0);
    expect(list.query.page).toBe(1);
    expect(list.query.pageSize).toBe(20);
    expect(list.query.sortBy).toBe("score");
  });

  it("渲染主题契约钩子（data-pane / 关键 data-control）", async () => {
    await render();
    expect(container.querySelector('[data-pane="skill-store"]')).toBeTruthy();
    for (const control of ["skill-store-refresh", "skill-store-search", "skill-store-category", "skill-store-sort", "skill-store-top", "skill-store-page", "skill-store-scope"]) {
      expect(byControl(control).length).toBeGreaterThan(0);
    }
  });

  it("列表结果渲染卡片（中文描述优先、来源/分类/版本/下载数）", async () => {
    await render();
    const listRequestId = (useDesktopStore.getState().skillStore.listRequestId ?? "");
    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({
        type: "skill-store-result",
        result: { kind: "list", source: "public", requestId: listRequestId, ok: true, query: { sortBy: "score", order: "desc", page: 1, pageSize: 20 }, total: 1, skills: [skill({})], installs: [] }
      });
    });
    const card = container.querySelector('[data-skill-slug="demo-skill"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("示例技能");
    expect(card?.textContent).toContain("示例中文描述");
    expect(card?.textContent).toContain("开发编程");
    expect(card?.textContent).toContain("v1.0.0");
  });

  it("已安装 / 有更新徽标来自账本快照", async () => {
    await render();
    const listRequestId = (useDesktopStore.getState().skillStore.listRequestId ?? "");
    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({
        type: "skill-store-result",
        result: {
          kind: "list", source: "public",
          requestId: listRequestId,
          ok: true,
          query: { sortBy: "score", order: "desc", page: 1, pageSize: 20 },
          total: 1,
          skills: [skill({})],
          installs: [{ slug: "demo-skill", sourceId: "public", scope: "global", version: "1.0.0", installedAt: 1, installDir: "D:/agent/pidesktop-skills/demo-skill" }]
        }
      });
    });
    expect(container.textContent).toContain("已安装");

    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({
        type: "skill-store-result",
        result: {
          kind: "list", source: "public",
          requestId: listRequestId,
          ok: true,
          query: { sortBy: "score", order: "desc", page: 1, pageSize: 20 },
          total: 1,
          skills: [skill({})],
          installs: [{ slug: "demo-skill", sourceId: "public", scope: "global", version: "0.9.0", installedAt: 1, installDir: "D:/agent/pidesktop-skills/demo-skill" }]
        }
      });
    });
    expect(container.textContent).toContain("有更新");
  });

  it("错误结果内联展示，不靠 toast", async () => {
    await render();
    const listRequestId = (useDesktopStore.getState().skillStore.listRequestId ?? "");
    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({
        type: "skill-store-result",
        result: { kind: "list", source: "public", requestId: listRequestId, ok: false, error: "SkillHub 触发限流（429），请稍后重试" }
      });
    });
    expect(container.querySelector(".skill-store-error")?.textContent).toContain("429");
  });

  it("点卡片拉详情；详情按钮先展开确认汇总，再次点击才发安装命令（带作用域）", async () => {
    await render();
    const listRequestId = (useDesktopStore.getState().skillStore.listRequestId ?? "");
    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({
        type: "skill-store-result",
        result: { kind: "list", source: "public", requestId: listRequestId, ok: true, query: { sortBy: "score", order: "desc", page: 1, pageSize: 20 }, total: 1, skills: [skill({})], installs: [] }
      });
    });
    const card = container.querySelector<HTMLElement>('[data-skill-slug="demo-skill"]')!;
    await act(async () => {
      card.click();
    });
    const detailRequestId = (useDesktopStore.getState().skillStore.detailRequestId ?? "");
    expect(detailRequestId.length).toBeGreaterThan(0);
    expect(sent.some((command) => command.type === "skill-store.detail")).toBe(true);

    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({
        type: "skill-store-result",
        result: {
          kind: "detail", source: "public",
          requestId: detailRequestId,
          ok: true,
          detail: { ...skill({}), latestVersion: { version: "1.0.0", changelog: "首个版本" } },
          versions: [{ version: "1.0.0", changelog: "首个版本" }],
          files: [{ path: "SKILL.md", size: 120, sha256: "a".repeat(64) }],
          totalBytes: 120,
          installs: []
        }
      });
    });
    expect(container.querySelector('[data-control="skill-store-install"]')).toBeTruthy();

    // 第一次点「安装」只展开确认汇总，不发命令
    await act(async () => {
      byControl("skill-store-install")[0]!.click();
    });
    expect(container.querySelector('[aria-label="安装确认"]')).toBeTruthy();
    expect(sent.filter((command) => command.type === "skill-store.install")).toHaveLength(0);

    // 确认后才发命令
    await act(async () => {
      byControl("skill-store-confirm-install")[0]!.click();
    });
    const install = sent.find((command) => command.type === "skill-store.install") as Extract<RuntimeCommand, { type: "skill-store.install" }>;
    expect(install.slug).toBe("demo-skill");
    expect(install.scope).toBe("global");
  });

  it("未打开工作区时项目作用域选项禁用", async () => {
    useDesktopStore.setState({ snapshot: { ...useDesktopStore.getState().snapshot, workspace: undefined } });
    await render();
    const scopeSelect = byControl("skill-store-scope")[0] as HTMLSelectElement;
    const projectOption = [...scopeSelect.options].find((option) => option.value === "project");
    expect(projectOption?.disabled).toBe(true);
  });

  it("安装失败内联展示中文错误；成功展示文件数与作用域", async () => {
    await render();
    const requestId = "req-install-1";
    useDesktopStore.setState((state) => ({ skillStore: { ...state.skillStore, installing: { requestId, slug: "demo-skill" } } }));
    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({
        type: "skill-store-result",
        result: { kind: "install", source: "public", requestId, ok: false, error: "文件 SKILL.md 的 sha256 校验不匹配" }
      });
    });
    expect(container.textContent).toContain("sha256 校验不匹配");
    expect(useDesktopStore.getState().skillStore.installing).toBeUndefined();

    const okId = "req-install-2";
    useDesktopStore.setState((state) => ({ skillStore: { ...state.skillStore, installing: { requestId: okId, slug: "demo-skill" } } }));
    await act(async () => {
      useDesktopStore.getState().handleRuntimeMessage({
        type: "skill-store-result",
        result: {
          kind: "install", source: "public",
          requestId: okId,
          ok: true,
          outcome: { slug: "demo-skill", scope: "global", sourceId: "public", targetRoot: "D:/agent/pidesktop-skills", installDir: "D:/agent/pidesktop-skills/demo-skill", version: "1.0.0", fileCount: 3, totalBytes: 900 },
          installs: [{ slug: "demo-skill", sourceId: "public", scope: "global", version: "1.0.0", installedAt: 1, installDir: "D:/agent/pidesktop-skills/demo-skill" }]
        }
      });
    });
    expect(container.textContent).toContain("3 个文件");
    expect(container.textContent).toContain("用户全局");
  });
});

describe("applySkillStoreResult 的 requestId 认领", () => {
  it("过期的列表/详情结果整包丢弃（不污染当前查询）", () => {
    const state: SkillStoreState = { ...EMPTY, listRequestId: "new", detailRequestId: "d-new", listLoading: true };
    // 旧列表结果
    const staleList = applySkillStoreResult(state, { kind: "list", source: "public", requestId: "old", ok: true, query: { sortBy: "score", order: "desc", page: 1, pageSize: 20 }, total: 9, skills: [skill({})], installs: [] });
    expect(staleList).toEqual({});
    // 旧详情结果
    const staleDetail = applySkillStoreResult(state, { kind: "detail", source: "public", requestId: "d-old", ok: true, detail: skill({}), versions: [], files: [], totalBytes: 0, installs: [] });
    expect(staleDetail).toEqual({});
    // 当前列表结果命中
    const fresh = applySkillStoreResult(state, { kind: "list", source: "public", requestId: "new", ok: true, query: { sortBy: "score", order: "desc", page: 1, pageSize: 20 }, total: 1, skills: [skill({})], installs: [] });
    expect((fresh as { skillStore: SkillStoreState }).skillStore.listLoading).toBe(false);
    expect((fresh as { skillStore: SkillStoreState }).skillStore.listSkills).toHaveLength(1);
  });

  it("分类与热门榜结果无条件采纳（它们没有并发语义）", () => {
    const state: SkillStoreState = { ...EMPTY, categoriesLoading: true, topLoading: true };
    const withCategories = applySkillStoreResult(state, { kind: "categories", source: "public", requestId: "any", ok: true, categories: [{ key: "k", name: "名称", sortOrder: 1 }] }) as { skillStore: SkillStoreState };
    expect(withCategories.skillStore.categories).toHaveLength(1);
    expect(withCategories.skillStore.categoriesLoading).toBe(false);
    const withTop = applySkillStoreResult(state, { kind: "top", source: "public", requestId: "any", ok: true, skills: [skill({})] }) as { skillStore: SkillStoreState };
    expect(withTop.skillStore.topSkills).toHaveLength(1);
    expect(withTop.skillStore.topLoading).toBe(false);
  });

  it("卸载结果同样清 busy 并写终态反馈", () => {
    const state: SkillStoreState = { ...EMPTY, installing: { requestId: "u1", slug: "demo-skill" } };
    const next = applySkillStoreResult(state, {
      kind: "uninstall", source: "public",
      requestId: "u1",
      ok: true,
      outcome: { slug: "demo-skill", scope: "global", sourceId: "public", installDir: "D:/agent/pidesktop-skills/demo-skill", removedFiles: 4 },
      installs: []
    }) as { skillStore: SkillStoreState };
    expect(next.skillStore.installing).toBeUndefined();
    expect(next.skillStore.lastInstall?.ok).toBe(true);
    expect(next.skillStore.lastInstall?.message).toContain("4 个文件");
    expect(next.skillStore.installs).toEqual([]);
  });

  it("会话忙碌时的延迟提示进入文案", () => {
    const state: SkillStoreState = { ...EMPTY, installing: { requestId: "i1", slug: "demo-skill" } };
    const next = applySkillStoreResult(state, {
      kind: "install", source: "public",
      requestId: "i1",
      ok: true,
      outcome: { slug: "demo-skill", scope: "global", sourceId: "public", targetRoot: "D:/agent/pidesktop-skills", installDir: "D:/agent/pidesktop-skills/demo-skill", version: "1", fileCount: 1, totalBytes: 10, sessionRefreshDeferred: true },
      installs: []
    }) as { skillStore: SkillStoreState };
    expect(next.skillStore.lastInstall?.message).toContain("下次重建会话");
  });
});
