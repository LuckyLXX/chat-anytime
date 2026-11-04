/**
 * Skill 商店（SkillHub Open API）的共享协议层。
 *
 * 三方共用：渲染端（设置页组件 + store 状态）、utility（skill-store-client 的
 * 归一化输出 + skill-store-install 的安装计划）、测试。字段口径来自官方
 * https://skillhub.cn 的 Open API 文档与 2026-11-04 实测（/api/skills、
 * /api/v1/skills/{slug}、/versions、/files、/file、/api/v1/categories）。
 *
 * 只依赖文档字段；实测响应里的 namespace/publisher/securityReports 等**未文档化
 * 字段仅作容错展示**（canonicalName 参与冲突判定，见 install 模块）。
 */

/** 商店 API 基地址（公开接口，无需鉴权）。 */
export const SKILL_STORE_BASE_URL = "https://api.skillhub.cn";

/** 安装作用域：用户全局 `<agentDir>/pidesktop-skills/` 或项目 `<workspace>/.pidesktop-skills/`。 */
export type SkillStoreScope = "global" | "project";

/** 列表/搜索的排序键（/api/skills 的 sortBy）。 */
export type SkillStoreSort = "updated_at" | "downloads" | "stars" | "installs" | "score";

/** 渲染端发起的浏览查询（列表 + 筛选 + 分页）。 */
export interface SkillStoreQuery {
  keyword?: string;
  category?: string;
  sortBy: SkillStoreSort;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
}

/** 列表/详情共用的技能条目（列表字段的归一化形状）。 */
export interface SkillStoreSkill {
  slug: string;
  name: string;
  description: string;
  /** 中文描述（列表优先展示；缺失回落 description）。 */
  descriptionZh?: string;
  iconUrl?: string;
  ownerName?: string;
  category?: string;
  version?: string;
  homepage?: string;
  tags: string[];
  subCategories: { key: string; name: string }[];
  downloads: number;
  stars: number;
  installs: number;
  score: number;
  /** true = 标注「需要 API Key」。 */
  requiresApiKey: boolean;
  /** pricing_type（"paid" 等首版只透传展示）。 */
  pricingType?: string;
  /** 未文档化字段容错读取：`@owner/slug` 形态的规范名（安装冲突判定用）。 */
  canonicalName?: string;
  updatedAt?: number;
  createdAt?: number;
}

/** 分类字典项（/api/v1/categories 的 items，运行时拉取不硬编码）。 */
export interface SkillStoreCategory {
  key: string;
  name: string;
  nameEn?: string;
  sortOrder: number;
}

/** 详情（/api/v1/skills/{slug} 的归一化形状，附加列表字段便于直渲染）。 */
export interface SkillStoreDetail extends SkillStoreSkill {
  latestVersion?: { version: string; changelog?: string; createdAt?: number };
  owner?: { handle?: string; displayName?: string };
  publisherName?: string;
  /** 安全评测（实测字段，可选展示）。 */
  securityStatus?: string;
  securityStatusText?: string;
  /** 详情接口自带的长介绍（markdown，实测字段）；无 SKILL.md 预览时作兜底展示。 */
  overviewMd?: string;
}

/** 版本条目（/versions 的 versions[]，倒序）。 */
export interface SkillStoreVersion {
  version: string;
  changelog?: string;
  createdAt?: number;
}

/** 安装文件清单项（/files 的 files[]，安装与校验的唯一真源）。 */
export interface SkillStoreFile {
  path: string;
  size: number;
  sha256: string;
}

/** 安装结果（skill-store-result ok=true 且 kind=install 时 data 的形状）。 */
export interface SkillStoreInstallOutcome {
  slug: string;
  scope: SkillStoreScope;
  /** 安装目标根目录（绝对路径）。 */
  targetRoot: string;
  /** 安装目录（绝对路径 = targetRoot/slug）。 */
  installDir: string;
  version: string;
  /** 落盘文件数。 */
  fileCount: number;
  /** 落盘总字节数。 */
  totalBytes: number;
  /** 覆盖旧安装时给出（已备份为 <slug>.bak-<时间戳>）。 */
  replaced?: boolean;
  /** 会话忙碌时未重建：新技能下次重建会话后对模型可见。 */
  sessionRefreshDeferred?: boolean;
}

/** 卸载结果。 */
export interface SkillStoreUninstallOutcome {
  slug: string;
  scope: SkillStoreScope;
  installDir: string;
  removedFiles: number;
  /** 会话忙碌时未重建：清单已更新，但模型侧的要下次重建会话后消失。 */
  sessionRefreshDeferred?: boolean;
}

/** 安装账本快照（渲染端「已安装 / 有更新」徒标用；不含 files 明细）。 */
export interface SkillStoreInstallSummary {
  slug: string;
  scope: SkillStoreScope;
  version: string;
  installedAt: number;
  /** 安装目录绝对路径（定位/诊断用）。 */
  installDir: string;
}

/** utility → 渲染端的结果推送（RuntimeMessage "skill-store-result" 的 data）。
 *  列表/详情/安装/卸载都顺带一份账本快照：渲染端不需要额外请求就能算出安装态。 */
export type SkillStoreResult =
  | { kind: "list"; requestId: string; ok: true; query: SkillStoreQuery; total: number; skills: SkillStoreSkill[]; installs: SkillStoreInstallSummary[] }
  | { kind: "list"; requestId: string; ok: false; error: string }
  | { kind: "top"; requestId: string; ok: true; skills: SkillStoreSkill[] }
  | { kind: "top"; requestId: string; ok: false; error: string }
  | { kind: "categories"; requestId: string; ok: true; categories: SkillStoreCategory[] }
  | { kind: "categories"; requestId: string; ok: false; error: string }
  | { kind: "detail"; requestId: string; ok: true; detail: SkillStoreDetail; versions: SkillStoreVersion[]; files: SkillStoreFile[]; totalBytes: number; readme?: string; installs: SkillStoreInstallSummary[] }
  | { kind: "detail"; requestId: string; ok: false; error: string }
  | { kind: "install"; requestId: string; ok: true; outcome: SkillStoreInstallOutcome; installs: SkillStoreInstallSummary[] }
  | { kind: "install"; requestId: string; ok: false; error: string }
  | { kind: "uninstall"; requestId: string; ok: true; outcome: SkillStoreUninstallOutcome; installs: SkillStoreInstallSummary[] }
  | { kind: "uninstall"; requestId: string; ok: false; error: string };

/** utility 内部的命令形状（RuntimeCommand 联合成员，此处仅供客户端函数复用参数形状）。 */
export type SkillStoreCommand =
  | { type: "skill-store.list"; requestId: string; query: SkillStoreQuery }
  | { type: "skill-store.top"; requestId: string }
  | { type: "skill-store.categories"; requestId: string }
  | { type: "skill-store.detail"; requestId: string; slug: string; version?: string }
  | { type: "skill-store.install"; requestId: string; slug: string; scope: SkillStoreScope; version?: string; confirmReplace?: boolean }
  | { type: "skill-store.uninstall"; requestId: string; slug: string; scope: SkillStoreScope };
