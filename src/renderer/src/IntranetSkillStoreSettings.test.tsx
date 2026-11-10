// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeCommand, SkillStoreResult, SkillStoreSkill } from "../../shared/protocol";
import { IntranetSkillStoreSettings } from "./IntranetSkillStoreSettings";
import { useDesktopStore, type SkillStoreState } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 内网 Skill 商店页的回归网。钉住四类静默失效：
 * ① 地址配置命令（baseUrl 传对、结果回灌、非法地址错误内联）；
 * ② 浏览命令必须带 `source: "intranet"`（漏了会打到公开商店）；
 * ③ 结果按 source 路由到 intranetStore 切片（漏了页面永远停在加载中）；
 * ④ 账本同源过滤（异源同名技能不能显示「已安装」，安装会因冲突被拒）。
 */

const BASE = "http://skills.corp.local:8080";

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

function skill(partial: Partial<SkillStoreSkill> = {}): SkillStoreSkill {
  return {
    slug: "inner-demo",
    name: "内网演示",
    description: "intranet demo",
    tags: [],
    subCategories: [],
    downloads: 0,
    stars: 0,
    installs: 0,
    score: 0,
    requiresApiKey: false,
    version: "1.0.0",
    category: "dev",
    ...partial
  };
}

let container: HTMLDivElement;
let root: Root;
let sent: RuntimeCommand[];

function mountState(overrides: { config?: { baseUrl: string; name?: string } } = {}): void {
  useDesktopStore.setState({
    intranetStore: { ...EMPTY },
    intranetSource: { saving: false, ...(overrides.config ? { config: overrides.config } : {}) },
    snapshot: { ...useDesktopStore.getState().snapshot, workspace: "D:/ws" }
  });
}

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
  mountState();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(<IntranetSkillStoreSettings />);
  });
}

function byControl(control: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`[data-control="${control}"]`)];
}

async function dispatch(result: SkillStoreResult): Promise<void> {
  await act(async () => {
    useDesktopStore.getState().handleRuntimeMessage({ type: "skill-store-result", result });
  });
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("内网 Skill 商店页", () => {
  it("未配置时只渲染地址配置卡，不发浏览命令", async () => {
    await render();
    expect(container.querySelector('[data-pane="intranet-skill-store"]')).toBeTruthy();
    for (const control of ["intranet-store-url", "intranet-store-save"]) {
      expect(byControl(control).length).toBeGreaterThan(0);
    }
    expect(sent).toHaveLength(0);
  });

  it("保存地址：命令带 baseUrl；回推配置后进入浏览并拉列表（source=intranet）", async () => {
    await render();
    const input = byControl("intranet-store-url")[0] as HTMLInputElement;
    await act(async () => {
      setInput(input, BASE);
    });
    await act(async () => {
      byControl("intranet-store-save")[0]!.click();
    });
    const save = sent.find((command) => command.type === "skill-store.source.save") as Extract<RuntimeCommand, { type: "skill-store.source.save" }>;
    expect(save.baseUrl).toBe(BASE);

    await dispatch({ kind: "source", requestId: save.requestId, ok: true, config: { baseUrl: BASE, name: "平台组技能库" } });
    expect(container.textContent).toContain(BASE);

    const list = sent.find((command) => command.type === "skill-store.list") as Extract<RuntimeCommand, { type: "skill-store.list" }>;
    expect(list).toBeTruthy();
    expect(list.source).toBe("intranet");
    expect(list.query.page).toBe(1);
    expect(list.query.pageSize).toBe(20);
    expect(list.query.sortBy).toBe("updated_at");
    const categories = sent.find((command) => command.type === "skill-store.categories") as Extract<RuntimeCommand, { type: "skill-store.categories" }>;
    expect(categories.source).toBe("intranet");
  });

  it("地址非法：错误内联展示，不进入浏览", async () => {
    await render();
    await dispatch({ kind: "source", requestId: "bad", ok: false, error: "内网商店地址不合法" });
    expect(container.querySelector(".skill-store-error")?.textContent).toContain("不合法");
    expect(sent.some((command) => command.type === "skill-store.list")).toBe(false);
  });

  it("测试连接：发 source.test（地址由主进程注入）并展示延迟/技能数", async () => {
    mountState({ config: { baseUrl: BASE } });
    await render();
    await act(async () => {
      byControl("intranet-store-test")[0]!.click();
    });
    const test = sent.find((command) => command.type === "skill-store.source.test") as Extract<RuntimeCommand, { type: "skill-store.source.test" }>;
    expect(test.requestId.length).toBeGreaterThan(0);

    await dispatch({ kind: "source-test", requestId: test.requestId, ok: true, message: "已连接 内网技能库 v0.1.0 · 7 个技能", latencyMs: 12, version: "0.1.0", skillCount: 7 });
    expect(container.textContent).toContain("已连接");
    expect(container.textContent).toContain("12ms");
  });

  it("浏览、详情与安装都带 source=intranet，安装前必须二次确认", async () => {
    mountState({ config: { baseUrl: BASE } });
    await render();
    const listRequestId = useDesktopStore.getState().intranetStore.listRequestId ?? "";
    expect(listRequestId.length).toBeGreaterThan(0);

    await dispatch({
      kind: "list",
      source: "intranet",
      requestId: listRequestId,
      ok: true,
      query: { sortBy: "updated_at", order: "desc", page: 1, pageSize: 20 },
      total: 1,
      skills: [skill()],
      installs: []
    });
    const card = container.querySelector<HTMLElement>('[data-skill-slug="inner-demo"]');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("内网演示");

    await act(async () => {
      card!.click();
    });
    const detail = sent.find((command) => command.type === "skill-store.detail") as Extract<RuntimeCommand, { type: "skill-store.detail" }>;
    expect(detail.source).toBe("intranet");

    await dispatch({
      kind: "detail",
      source: "intranet",
      requestId: useDesktopStore.getState().intranetStore.detailRequestId ?? "",
      ok: true,
      detail: { ...skill(), latestVersion: { version: "1.0.0", changelog: "首个版本" } },
      versions: [{ version: "1.0.0" }],
      files: [{ path: "SKILL.md", size: 120, sha256: "a".repeat(64) }],
      totalBytes: 120,
      installs: []
    });

    await act(async () => {
      byControl("skill-store-install")[0]!.click();
    });
    expect(container.querySelector('[aria-label="安装确认"]')).toBeTruthy();
    expect(sent.filter((command) => command.type === "skill-store.install")).toHaveLength(0);

    await act(async () => {
      byControl("skill-store-confirm-install")[0]!.click();
    });
    const install = sent.find((command) => command.type === "skill-store.install") as Extract<RuntimeCommand, { type: "skill-store.install" }>;
    expect(install.slug).toBe("inner-demo");
    expect(install.scope).toBe("global");
    expect(install.source).toBe("intranet");
  });

  it("账本只认同源：异源同名安装不显示「已安装」并给出冲突提示", async () => {
    mountState({ config: { baseUrl: BASE } });
    await render();
    const listRequestId = useDesktopStore.getState().intranetStore.listRequestId ?? "";
    const publicInstall = { slug: "inner-demo", scope: "global" as const, version: "1.0.0", installedAt: 1, installDir: "D:/agent/pidesktop-skills/inner-demo", sourceId: "public" as const };
    await dispatch({
      kind: "list",
      source: "intranet",
      requestId: listRequestId,
      ok: true,
      query: { sortBy: "updated_at", order: "desc", page: 1, pageSize: 20 },
      total: 1,
      skills: [skill()],
      installs: [publicInstall]
    });
    expect(container.textContent).not.toContain("已安装");

    await act(async () => {
      container.querySelector<HTMLElement>('[data-skill-slug="inner-demo"]')!.click();
    });
    await dispatch({
      kind: "detail",
      source: "intranet",
      requestId: useDesktopStore.getState().intranetStore.detailRequestId ?? "",
      ok: true,
      detail: { ...skill() },
      versions: [{ version: "1.0.0" }],
      files: [{ path: "SKILL.md", size: 1, sha256: "a".repeat(64) }],
      totalBytes: 1,
      installs: [publicInstall]
    });
    expect(container.textContent).toContain("已由「公开 SkillHub」安装");
  });

  it("无工作区时项目作用域禁用", async () => {
    mountState({ config: { baseUrl: BASE } });
    useDesktopStore.setState({ snapshot: { ...useDesktopStore.getState().snapshot, workspace: undefined } });
    await render();
    const select = byControl("skill-store-scope")[0] as HTMLSelectElement;
    expect([...select.options].find((option) => option.value === "project")?.disabled).toBe(true);
  });

  it("更改地址回到配置态并保留旧地址", async () => {
    mountState({ config: { baseUrl: BASE } });
    await render();
    await act(async () => {
      byControl("intranet-store-change")[0]!.click();
    });
    expect((byControl("intranet-store-url")[0] as HTMLInputElement).value).toBe(BASE);
    expect(container.textContent).toContain("保存并连接");
  });
});
