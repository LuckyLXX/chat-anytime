// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettings, ModelOption, ProviderOption } from "../../shared/protocol";
import { GeneralSettings } from "./GeneralSettings";
import { useDesktopStore } from "./store";

/**
 * 通用页（设置页「通用」tab）的结构钩子契约 + 关键行为回归网（2026-09-23）。
 *
 * 为什么需要：本轮把这一页从 App.tsx 抽出并重排（分区卡片 + 能力总闸开关行 +
 * Jev 折叠卡 + 固定 footer），新增主题契约钩子 `data-pane="general-settings"`
 * 与 `data-control="jev-test"`（既有，jev-activation.test.ts 从 App.tsx 里找它，
 * 抽组件后迁移）与 `data-control="capability-switch"`。这里钉住：
 * ① 五张分区卡片存在（重排的核心诉求）；
 * ② Jev 默认收起、点头部展开、展开后测试连接按钮可用且不被「未启用」禁用
 *   （jev-activation.test.ts 的口径：不启用也要能测）；
 * ③ 能力总闸开关切换写入 settings store；
 * ④ 保存提交走 settings.save 且传齐全部 Pick 键（三处镜像契约的渲染端一环，
 *   settings-save-contract.test.ts 靠 App.tsx 源码断言，这里补运行时断言）。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settings: DesktopSettings = {
  version: 2,
  model: { provider: "anthropic", id: "claude-sonnet-4-6" },
  thinkingLevel: "medium",
  accessMode: "ask",
  providers: [],
  agents: [],
  currentAgentId: "default",
  appearance: { theme: "system", themePreset: "default", customCss: "", customThemes: [], showThinking: true },
  browser: { enabled: true },
  ssh: { enabled: false },
  defaultWorkspace: "D:\\Projects\\demo"
};

const models: ModelOption[] = [
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", input: ["text"], imageInput: false, configured: true },
  { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6", input: ["text"], imageInput: true, configured: true }
];
const providers: ProviderOption[] = [{ id: "anthropic", name: "Anthropic", configured: true }];

interface Handlers {
  saved: DesktopSettings[];
  cancelled: number;
  committed: DesktopSettings[];
  sends: Array<Record<string, unknown>>;
}

/**
 * 与 App.tsx 同构：通用页的 settings 来自 store（`useDesktopStore`），
 * 所以草稿写入后组件会重渲染。夹具必须走同一条链，否则受控开关的
 * 回显停在初始化值上，测试会假红/假绿。
 */
function render(overrides: { settings?: DesktopSettings; jevKeyConfigured?: boolean } = {}): Handlers {
  const handlers: Handlers = { saved: [], cancelled: 0, committed: [], sends: [] };
  vi.stubGlobal("window", {
    ...globalThis.window,
    matchMedia: vi.fn().mockReturnValue({ matches: false }),
    piDesktop: {
      send: vi.fn(async (command: Record<string, unknown>) => { handlers.sends.push(command); }),
      chooseWorkspace: vi.fn(async () => "D:\\Projects\\other")
    }
  });
  useDesktopStore.setState({ settings: overrides.settings ?? structuredClone(settings), jevTestStatus: "idle", jevTestMessage: undefined });
  function Harness(): ReturnType<typeof GeneralSettings> {
    const live = useDesktopStore((state) => state.settings);
    return (
      <GeneralSettings
        settings={live}
        models={models}
        providers={providers}
        jevKeyConfigured={overrides.jevKeyConfigured ?? false}
        onSaved={(next) => handlers.saved.push(next)}
        onDraftCommitted={(next) => handlers.committed.push(next)}
        onCancel={() => { handlers.cancelled += 1; }}
      />
    );
  }
  act(() => { root.render(<Harness />); });
  return handlers;
}

describe("通用页结构契约", () => {
  it("带 data-pane=general-settings 钩子与五张分区卡片", () => {
    render();
    const form = container.querySelector("[data-pane=\"general-settings\"]");
    expect(form).not.toBeNull();
    expect([...container.querySelectorAll(".general-card")].map((card) => card.getAttribute("aria-label"))).toEqual([
      "对话与权限", "默认工作区", "能力总闸", "Jev 快速决策", "界面"
    ]);
  });

  it("固定 footer 带「保存通用设置」提交钮与取消钮", () => {
    render();
    expect(container.querySelector(".general-settings-footer button[type=\"submit\"]")?.textContent).toContain("保存通用设置");
    expect(container.querySelector(".general-settings-footer .secondary-button")?.textContent).toContain("取消");
  });

  it("四个能力总闸各是一行开关（图标 + 名称 + 可见说明），且缺省启用语义与运行时一致", () => {
    render();
    const rows = [...container.querySelectorAll(".general-switch-row")];
    // 4 个能力总闸 + 「展示思考过程」共 5 行
    expect(rows).toHaveLength(5);
    const caps = rows.slice(0, 4).map((row) => ({
      control: row.querySelector("[data-control=\"capability-switch\"]")?.getAttribute("data-capability"),
      checked: (row.querySelector("input") as HTMLInputElement).checked,
      hint: row.querySelector("small")?.textContent
    }));
    expect(caps.map((cap) => cap.control)).toEqual(["browser", "ssh", "computer", "design"]);
    // settings.ssh.enabled === false → 关；其余缺省/显式开。说明文字必须可见。
    expect(caps.map((cap) => cap.checked)).toEqual([true, false, true, true]);
    expect(caps.every((cap) => (cap.hint ?? "").length > 5)).toBe(true);
  });
});

describe("能力总闸交互", () => {
  it("切换开关写入 { key: { enabled } }（同键覆盖、互不影响）", () => {
    const handlers = render();
    const browserSwitch = container.querySelector("[data-capability=\"browser\"]") as HTMLInputElement;
    const sshSwitch = container.querySelector("[data-capability=\"ssh\"]") as HTMLInputElement;
    act(() => { browserSwitch.click(); });
    expect(browserSwitch.checked).toBe(false);
    act(() => { sshSwitch.click(); });
    expect(sshSwitch.checked).toBe(true);
    // 全局 store 里拿实时 settings 验证写入形状（与 App.tsx 同一数据源）
    const live = useDesktopStore.getState().settings;
    expect(live.browser).toEqual({ enabled: false });
    expect(live.ssh).toEqual({ enabled: true });
    // 总闸切换不单独发命令，随「保存通用设置」整包提交
    expect(handlers.sends.filter((command) => command.type === "settings.save")).toHaveLength(0);
  });

  it("「选择文件夹」走 chooseWorkspace 并写入 defaultWorkspace 草稿", async () => {
    render();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".general-workspace-actions button")];
    await act(async () => { buttons[0]!.click(); await Promise.resolve(); });
    expect(useDesktopStore.getState().settings.defaultWorkspace).toBe("D:\\Projects\\other");
    // 「恢复默认」清掉草稿
    await act(async () => { buttons[1]!.click(); });
    expect(useDesktopStore.getState().settings.defaultWorkspace).toBeUndefined();
  });
});

describe("Jev 折叠卡", () => {
  it("默认收起（不渲染字段与测试连接钮），头部有实验性/状态徽标", () => {
    render();
    const card = container.querySelector(".general-card-jev")!;
    expect(card.querySelector(".general-card-body")).toBeNull();
    expect(card.querySelector(".general-jev-badge.experimental")?.textContent).toBe("实验性");
    expect(card.querySelector(".general-jev-toggle")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("点头部展开：五个配置字段出现，测试连接可用（不因未启用而禁用）", () => {
    render();
    act(() => { (container.querySelector(".general-jev-toggle") as HTMLButtonElement).click(); });
    const card = container.querySelector(".general-card-jev")!;
    expect(card.querySelectorAll(".general-field")).toHaveLength(5);
    const testButton = card.querySelector("[data-control=\"jev-test\"]") as HTMLButtonElement;
    expect(testButton).not.toBeNull();
    expect(testButton.disabled).toBe(false);
    expect((card.querySelector(".general-jev-switch input") as HTMLInputElement).checked).toBe(false);
  });

  it("保存 Jev 走独立的 jev.save（密钥与配置分开落位），不触发「保存通用设置」", async () => {
    const jevSettings = structuredClone(settings);
    jevSettings.jev = { enabled: true, baseUrl: "https://api.typesafe.ai/v1", model: "jev-latest", textProvider: "anthropic", textModel: "claude-sonnet-4-6", maxSteps: 30, autoPilot: true };
    const handlers = render({ settings: jevSettings });
    act(() => { (container.querySelector(".general-jev-toggle") as HTMLButtonElement).click(); });
    await act(async () => { (container.querySelector(".general-jev-footer .primary-button") as HTMLButtonElement).click(); await Promise.resolve(); });
    const sends = handlers.sends;
    expect(sends.some((command) => (command as { type: string }).type === "jev.save")).toBe(true);
    expect(sends.some((command) => (command as { type: string }).type === "settings.save")).toBe(false);
    // 已落盘 → 必须回调 onDraftCommitted 刷新父级回滚基线。否则此后「取消」
    // 会把 store 里的 jev 回滚成旧值，下次「保存通用设置」又把它写回主进程，
    // 静默抹掉刚保存的配置（2026-09-21 settings.jev 消失的同一类故障）。
    expect(handlers.committed).toHaveLength(1);
    expect(handlers.committed[0]!.jev).toEqual(jevSettings.jev);
    expect(handlers.saved).toHaveLength(0);
  });
});

describe("保存与取消", () => {
  it("提交传齐 settings.save 的全部 Pick 键并回调 onSaved", async () => {
    const handlers = render();
    await act(async () => {
      (container.querySelector(".general-settings-footer button[type=\"submit\"]") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    const payload = handlers.sends.find((command) => command.type === "settings.save") as { settings: Record<string, unknown> } | undefined;
    expect(payload).toBeDefined();
    expect(Object.keys(payload!.settings).sort()).toEqual([
      "accessMode", "appearance", "browser", "computer", "defaultWorkspace", "design", "jev", "model", "ssh", "thinkingLevel"
    ]);
    expect(handlers.saved).toHaveLength(1);
  });

  it("取消回调 onCancel（父级负责回滚基线并关闭弹窗）", () => {
    const handlers = render();
    act(() => { (container.querySelector(".general-settings-footer .secondary-button") as HTMLButtonElement).click(); });
    expect(handlers.cancelled).toBe(1);
    expect(handlers.saved).toHaveLength(0);
  });
});
