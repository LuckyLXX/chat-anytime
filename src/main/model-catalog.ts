import type { ModelOption, ProviderSettings } from "../shared/protocol.js";

export interface CatalogAuthStatus {
  configured: boolean;
  source?: string;
}

/**
 * Environment variables are inherited by Electron and are not an explicit
 * model configuration in PiDesktop. Keep them out of the desktop catalog so
 * a host shell cannot silently add an entire provider's model list.
 */
export function isDesktopConfiguredProvider(auth: CatalogAuthStatus | undefined): boolean {
  return auth?.configured === true && auth.source !== "environment";
}

/** 目录模型的最小输入形状（与 Pi `ModelRuntime.getModels()` 的条目对齐）。 */
export interface CatalogModelInput {
  provider: string;
  id: string;
  name: string;
  input: ("text" | "image")[];
}

/**
 * 构建推送给渲染端的模型目录：不剔除被禁用的模型，而是逐条标注 enabled。
 *
 * 历史教训（2026-08-24）：旧实现直接 filter 掉 settings.providers 里
 * enabled === false 的模型——顶栏模型选择器因此正确地只显示启用的模型，
 * 但设置对话框「可用模型」列表也从这份目录构建，导致筛选保存后重进设置页
 * 目录只剩上次启用的几个（搜索框因 length ≤ 8 消失、其余模型不可见）。
 * 现在目录永远完整，勾选状态随条目下发；选择器类消费方自行过滤
 * enabled !== false。未出现在 settings.providers 的服务商/模型视为启用，
 * 不写 enabled 字段（协议缺省即启用）。
 */
export function buildCatalogModels(models: readonly CatalogModelInput[], providers: ProviderSettings[] | undefined, configuredProviders: ReadonlySet<string>): ModelOption[] {
  return models.map((model) => {
    const stored = providers?.find((provider) => provider.id === model.provider)?.models.find((item) => item.id === model.id);
    return {
      provider: model.provider,
      id: model.id,
      name: model.name,
      configured: configuredProviders.has(model.provider),
      input: model.input,
      imageInput: model.input.includes("image"),
      ...(stored ? { enabled: stored.enabled !== false } : {})
    };
  });
}
