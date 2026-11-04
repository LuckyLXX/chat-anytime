import { describe, expect, it } from "vitest";
import type { ModelOption, ProviderOption } from "../../../shared/protocol";
import { MODEL_MENU_GAP, MODEL_MENU_PANEL_WIDTH, activeModelName, modelMenuPlacement, providerMenuEntries } from "./model-menu";

const providers: ProviderOption[] = [
  { id: "openrouter", name: "OpenRouter", configured: true },
  { id: "anthropic", name: "Anthropic", configured: true }
];

function model(provider: string, id: string, name = id): ModelOption {
  return { provider, id, name, configured: true, input: ["text"], imageInput: false };
}

const models: ModelOption[] = [
  model("anthropic", "claude-sonnet", "Claude Sonnet"),
  model("openrouter", "or-a", "OR A"),
  model("anthropic", "claude-opus", "Claude Opus")
];

describe("providerMenuEntries", () => {
  it("按目录首次出现顺序分组，同一供应商的模型保持目录顺序", () => {
    const entries = providerMenuEntries(models, providers, "");
    expect(entries.map((entry) => entry.provider)).toEqual(["anthropic", "openrouter"]);
    expect(entries[0]!.models.map((item) => item.id)).toEqual(["claude-sonnet", "claude-opus"]);
    expect(entries[1]!.models.map((item) => item.id)).toEqual(["or-a"]);
  });

  it("供应商展示名取目录，缺失时回退 id", () => {
    expect(providerMenuEntries(models, providers, "")[0]!.providerName).toBe("Anthropic");
    expect(providerMenuEntries(models, [], "")[1]!.providerName).toBe("openrouter");
  });

  it("当前值只点亮它所在的供应商（已停用/不存在的值一个都不点亮）", () => {
    expect(providerMenuEntries(models, providers, "anthropic/claude-opus").map((entry) => entry.active)).toEqual([true, false]);
    expect(providerMenuEntries(models, providers, "openrouter/or-a").map((entry) => entry.active)).toEqual([false, true]);
    expect(providerMenuEntries(models, providers, "gone/nope").map((entry) => entry.active)).toEqual([false, false]);
    expect(providerMenuEntries(models, providers, "").map((entry) => entry.active)).toEqual([false, false]);
  });

  it("空目录返回空数组（菜单据此显示引导文案）", () => {
    expect(providerMenuEntries([], providers, "")).toEqual([]);
  });
});

describe("activeModelName", () => {
  it("取该供应商下当前模型的展示名，不在该供应商时 undefined", () => {
    const [anthropic, openrouter] = providerMenuEntries(models, providers, "anthropic/claude-opus");
    expect(activeModelName(anthropic!, "anthropic/claude-opus")).toBe("Claude Opus");
    expect(activeModelName(openrouter!, "anthropic/claude-opus")).toBeUndefined();
  });
});

describe("modelMenuPlacement", () => {
  const base = { popoverLeft: 700, popoverRight: 940, boundsLeft: 0, boundsRight: 1400, panelWidth: 300 };

  it("右侧够宽时向右展开", () => {
    expect(modelMenuPlacement(base)).toBe("right");
  });

  it("右侧放不下时翻到左侧（弹层贴着右缘的常见情形）", () => {
    expect(modelMenuPlacement({ ...base, popoverRight: 1200 })).toBe("left");
    // 右侧连半个面板都没有，但左边宽敞
    expect(modelMenuPlacement({ ...base, popoverLeft: 1100, popoverRight: 1340 })).toBe("left");
  });

  it("两侧都放不下（分屏窄格）退化成单列", () => {
    // 会话格只有 520px 宽、弹层居中：左右各 ~140px，都塞不进 300px 面板
    expect(modelMenuPlacement({ popoverLeft: 200, popoverRight: 340, boundsLeft: 0, boundsRight: 520, panelWidth: 300 })).toBe("compact");
  });

  it("恰好等于间距 + 留白时仍算放得下（边界不抖）", () => {
    const need = 300 + MODEL_MENU_GAP + 8;
    expect(modelMenuPlacement({ ...base, boundsRight: 940 + need })).toBe("right");
    expect(modelMenuPlacement({ ...base, boundsRight: 940 + need - 1 })).toBe("left");
  });

  it("量不到面板宽度（未布局）按 CSS 默认宽算，不会误判成放得下", () => {
    expect(MODEL_MENU_PANEL_WIDTH).toBe(300);
    expect(modelMenuPlacement({ ...base, panelWidth: 0, boundsRight: 940 + 200 })).toBe("left");
  });
});
