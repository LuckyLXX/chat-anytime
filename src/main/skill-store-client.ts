// SkillHub Open API 客户端（https://api.skillhub.cn，公开接口无需鉴权）。
//
// 纯逻辑模块：所有 I/O 走注入式 `fetchStore`（参照 jev-client.ts 的 defaultJevFetch），
// 单测不打网络即可覆盖退避、错误映射与形状归一化。utility 进程的全局 fetch 默认跟随
// 302 重定向（/file、/download 会 302 到带时效签名的对象存储——**不缓存/不转发
// Location**，签名过期后转发就是坏地址）。
//
// 协议口径（官方文档 + 2026-11-04 实测）：
//   GET /api/skills                       信封 {code:0,message,data:{total,skills[]}}
//   GET /api/skills/top                   信封，Top 50
//   GET /api/v1/categories                {items:[{key,name,nameEn,level,sortOrder,active}],count}
//   GET /api/v1/skills/{slug}             裸对象 {skill?…,latestVersion,owner,…}
//   GET /api/v1/skills/{slug}/versions    {slug,source,versions:[{versionId,version,changelog,createdAt}]}
//   GET /api/v1/skills/{slug}/files       {files:[{path,size,sha256}],count,version}
//   GET /api/v1/skills/{slug}/file        302 → 文件字节（单文件上限 1MB，超出 413）
//   统一错误体 {"error":"…"}；429/5xx/超时要指数退避（文档要求）。

import type { SkillStoreCategory, SkillStoreDetail, SkillStoreFile, SkillStoreQuery, SkillStoreSkill, SkillStoreVersion } from "../shared/skill-store.js";
import { SKILL_STORE_BASE_URL } from "../shared/skill-store.js";

/** 需要退避重试的 HTTP 状态：文档明确要求对 429 / 5xx / 超时做指数退避。 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
/** 单次请求超时（毫秒）。共享 API 不承诺 SLA，超时要短——失败重试比挂死好。 */
const REQUEST_TIMEOUT_MS = 12_000;
/** 退避基准（500ms → 1000ms）。 */
const BACKOFF_BASE_MS = 500;

/** 列表分页上限（API 硬限 1–100）。 */
export const SKILL_STORE_MAX_PAGE_SIZE = 100;

export type StoreFetchResponse = { status: number; json: () => Promise<unknown>; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> };

/** GET + 可选查询串（json 响应）。 */
export type StoreFetch = (url: string, signal?: AbortSignal) => Promise<StoreFetchResponse>;

export const defaultStoreFetch: StoreFetch = async (url, signal) => {
  const response = await fetch(url, {
    method: "GET",
    headers: buildStoreHeaders(),
    ...(signal ? { signal } : {})
  });
  return {
    status: response.status,
    json: () => response.json() as Promise<unknown>,
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer()
  };
};

/**
 * 建议头（文档：X-API-Key 是团队标识且「后续会要求必填」，但**敏感、只在服务端用、
 * 不要写前端代码或公开仓库**——首版不带；X-Client-User-Id 为脱敏统计头，这里不传
 * 用户标识，保持匿名）。
 */
function buildStoreHeaders(): Record<string, string> {
  return { Accept: "application/json" };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 从错误响应体抽人类可读原因：`{"error":"…"}` 是文档统一错误体，其余回落原文截断。 */
export function extractStoreError(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const candidate of [parsed.error, parsed.message]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 300);
    }
  } catch {
    // 非 JSON（网关 HTML 错误页等）——用原文。
  }
  return trimmed.slice(0, 300);
}

/** 拼查询串（空值丢弃；分页与排序键空值由调用方保证）。 */
export function buildStoreSearchPath(query: SkillStoreQuery): string {
  const params = new URLSearchParams();
  params.set("page", String(Math.max(1, Math.floor(query.page))));
  params.set("pageSize", String(Math.min(SKILL_STORE_MAX_PAGE_SIZE, Math.max(1, Math.floor(query.pageSize)))));
  params.set("sortBy", query.sortBy);
  params.set("order", query.order);
  const keyword = query.keyword?.trim();
  if (keyword) params.set("keyword", keyword);
  const category = query.category?.trim();
  if (category) params.set("category", category);
  return `/api/skills?${params.toString()}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asBool(value: unknown): boolean {
  return value === true || value === "true";
}

/** 标签数组容错：API 实测 tags 可能为 null 或字符串数组。 */
function asTagList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 12);
}

/** 子分类容错：[{key,name}]。 */
function asSubCategories(value: unknown): { key: string; name: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isPlainRecord)
    .map((item) => ({ key: asString(item.key) ?? "", name: asString(item.name) ?? "" }))
    .filter((item) => item.key && item.name)
    .slice(0, 12);
}

/** 统一错误（带 HTTP 状态供退避判定）。 */
class StoreHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** 单次 GET（含超时）；429/5xx 抛可退避错误，其它 4xx 直接抛中文可读错误。 */
async function fetchJsonOnce(path: string, fetchStore: StoreFetch): Promise<unknown> {
  const url = `${SKILL_STORE_BASE_URL}${path}`;
  let response: StoreFetchResponse;
  try {
    response = await fetchStore(url, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  } catch (error) {
    // AbortSignal.timeout 触发的是 TimeoutError DOMException；其余是 DNS/连接/TLS。
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut) throw new StoreHttpError(0, `SkillHub 请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`);
    throw new Error(`无法连接 SkillHub（${SKILL_STORE_BASE_URL}）：${error instanceof Error ? error.message : String(error)}。请检查网络后重试。`);
  }
  if (response.status >= 400) {
    const detail = extractStoreError(await response.text().catch(() => ""));
    const label = detail ? `：${detail}` : "";
    if (response.status === 404) throw new Error(`SkillHub 上没有找到对应资源（404）${label}`);
    if (response.status === 429) throw new StoreHttpError(429, `SkillHub 触发限流（429），请稍后重试${label}`);
    if (response.status >= 500) throw new StoreHttpError(response.status, `SkillHub 服务暂时不可用（HTTP ${response.status}）${label}`);
    throw new Error(`SkillHub 拒绝了请求（HTTP ${response.status}）${label}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("SkillHub 返回的不是合法 JSON。");
  }
}

/** 带 3 次指数退避的 GET（只对 429/5xx/超时重试；最后一次仍失败报「已重试 N 次」）。 */
async function fetchJson(path: string, fetchStore: StoreFetch, delay: (ms: number) => Promise<void> = sleep): Promise<unknown> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await fetchJsonOnce(path, fetchStore);
    } catch (error) {
      if (!(error instanceof StoreHttpError && RETRYABLE_STATUS.has(error.status))) throw error;
      lastError = error;
      if (attempt < MAX_ATTEMPTS - 1) {
        await delay(BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
  }
  throw new Error(`${lastError?.message ?? "SkillHub 请求失败"}（已重试 ${MAX_ATTEMPTS} 次）。`);
}

/** 信封 → data：`{code:0,data:…}`；非零 code 或缺 data 视为坏响应。 */
function unwrapEnvelope(payload: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(payload) || payload.code !== 0 || !isPlainRecord(payload.data)) {
    throw new Error(`SkillHub ${label}响应形状不符（缺少信封 data）。`);
  }
  return payload.data;
}

/** 列表项归一化：只依赖文档字段，额外字段（namespace/publisher 等）仅容错展示。 */
export function normalizeStoreSkill(raw: unknown): SkillStoreSkill | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const slug = asString(raw.slug);
  const name = asString(raw.name);
  if (!slug || !name) return undefined;
  const description = asString(raw.description) ?? "";
  const descriptionZh = asString(raw.description_zh);
  const labels = isPlainRecord(raw.labels) ? raw.labels : {};
  const namespace = isPlainRecord(raw.namespace) ? raw.namespace : {};
  return {
    slug,
    name,
    description,
    ...(descriptionZh && descriptionZh !== description ? { descriptionZh } : {}),
    ...(asString(raw.iconUrl) ? { iconUrl: asString(raw.iconUrl) } : {}),
    ...(asString(raw.ownerName) ? { ownerName: asString(raw.ownerName) } : {}),
    ...(asString(raw.category) ? { category: asString(raw.category) } : {}),
    ...(asString(raw.version) ? { version: asString(raw.version) } : {}),
    ...(asString(raw.homepage) ? { homepage: asString(raw.homepage) } : {}),
    tags: asTagList(raw.tags),
    subCategories: asSubCategories(raw.subCategories),
    downloads: asNumber(raw.downloads),
    stars: asNumber(raw.stars),
    installs: asNumber(raw.installs),
    score: asNumber(raw.score),
    requiresApiKey: asBool(labels.requires_api_key),
    ...(asString(labels.pricing_type) ? { pricingType: asString(labels.pricing_type) } : {}),
    ...(asString(namespace.canonicalName) ? { canonicalName: asString(namespace.canonicalName) } : {}),
    ...(typeof raw.updated_at === "number" ? { updatedAt: raw.updated_at } : {}),
    ...(typeof raw.created_at === "number" ? { createdAt: raw.created_at } : {})
  };
}

function normalizeSkillList(value: unknown): { skills: SkillStoreSkill[]; total: number } {
  const data = unwrapEnvelope(value, "列表");
  const list = Array.isArray(data.skills) ? data.skills : [];
  const skills = list.map(normalizeStoreSkill).filter((item): item is SkillStoreSkill => item !== undefined);
  return { skills, total: asNumber(data.total) };
}

/** 列表/搜索（信封）。 */
export async function storeListSkills(query: SkillStoreQuery, fetchStore: StoreFetch = defaultStoreFetch, delay?: (ms: number) => Promise<void>): Promise<{ skills: SkillStoreSkill[]; total: number }> {
  return normalizeSkillList(await fetchJson(buildStoreSearchPath(query), fetchStore, delay));
}

/** 热门 Top 榜（信封，固定 sortBy=downloads&order=desc&pageSize=50）。 */
export async function storeTopSkills(fetchStore: StoreFetch = defaultStoreFetch, delay?: (ms: number) => Promise<void>): Promise<SkillStoreSkill[]> {
  const data = unwrapEnvelope(await fetchJson("/api/skills/top", fetchStore, delay), "热门榜");
  const list = Array.isArray(data.skills) ? data.skills : [];
  return list.map(normalizeStoreSkill).filter((item): item is SkillStoreSkill => item !== undefined);
}

/** 分类字典（运行时拉取，不硬编码）。 */
export async function storeCategories(fetchStore: StoreFetch = defaultStoreFetch, delay?: (ms: number) => Promise<void>): Promise<SkillStoreCategory[]> {
  const payload = await fetchJson("/api/v1/categories", fetchStore, delay);
  const items = isPlainRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
  return items
    .filter(isPlainRecord)
    .map((item) => ({ key: asString(item.key) ?? "", name: asString(item.name) ?? "", ...(asString(item.nameEn) ? { nameEn: asString(item.nameEn) } : {}), sortOrder: asNumber(item.sortOrder) }))
    .filter((item) => item.key && item.name)
    .sort((left, right) => left.sortOrder - right.sortOrder);
}

/**
 * 详情归一化。实测形状（2026-11-04 真实响应）与文档口径不同，必须同时兼容：
 *   顶层 { slug, latestVersion, owner, publisher, securityReports, skill: {…} }
 *   skill 子对象里名称叫 `displayName`、描述叫 `summary`/`summary_zh`、
 *   计数在 `stats{downloads,installs,stars}`，`tags` 还是**对象**（{latest:"1.7.0"}）。
 * 列表接口却是平铺的 `name`/`description`/`tags[]`。所以这里以 `skill` 为准、顶层兜底，
 * 两套字段名都读——只认一套就是「详情页一片空白」。
 */
export function normalizeStoreDetail(raw: unknown): SkillStoreDetail {
  if (!isPlainRecord(raw)) throw new Error("SkillHub 详情响应形状不符。");
  const skill = isPlainRecord(raw.skill) ? raw.skill : raw;
  const slug = asString(skill.slug) ?? asString(raw.slug);
  if (!slug) throw new Error("SkillHub 详情响应缺少技能标识（slug）。");
  const name = asString(skill.name) ?? asString(skill.displayName) ?? slug;
  const description = asString(skill.description) ?? asString(skill.summary) ?? "";
  const descriptionZh = asString(skill.description_zh) ?? asString(skill.summary_zh);
  const stats = isPlainRecord(skill.stats) ? skill.stats : {};
  const labels = isPlainRecord(skill.labels) ? skill.labels : (isPlainRecord(raw.labels) ? raw.labels : {});
  const latest = isPlainRecord(raw.latestVersion) ? raw.latestVersion : {};
  const owner = isPlainRecord(raw.owner) ? raw.owner : {};
  const publisher = isPlainRecord(raw.publisher) ? raw.publisher : {};
  const security = isPlainRecord(raw.securityReports) ? raw.securityReports : {};
  const keen = isPlainRecord(security.keen) ? security.keen : {};
  const namespace = isPlainRecord(raw.namespace) ? raw.namespace : (isPlainRecord(skill.namespace) ? skill.namespace : {});
  return {
    slug,
    name,
    description,
    ...(descriptionZh && descriptionZh !== description ? { descriptionZh } : {}),
    ...(asString(skill.iconUrl) ? { iconUrl: asString(skill.iconUrl) } : {}),
    ...(asString(skill.ownerName) ? { ownerName: asString(skill.ownerName) } : {}),
    ...(asString(skill.category) ? { category: asString(skill.category) } : {}),
    ...(asString(latest.version) ? { version: asString(latest.version) } : asString(skill.version) ? { version: asString(skill.version) } : {}),
    ...(asString(skill.homepage) ? { homepage: asString(skill.homepage) } : {}),
    tags: asTagList(skill.tags),
    subCategories: asSubCategories(skill.subCategories),
    downloads: asNumber(stats.downloads ?? skill.downloads),
    stars: asNumber(stats.stars ?? skill.stars),
    installs: asNumber(stats.installs ?? skill.installs),
    score: asNumber(skill.score ?? raw.score),
    requiresApiKey: asBool(labels.requires_api_key),
    ...(asString(labels.pricing_type) ? { pricingType: asString(labels.pricing_type) } : {}),
    ...(asString(namespace.canonicalName) ? { canonicalName: asString(namespace.canonicalName) } : {}),
    ...(typeof skill.updatedAt === "number" ? { updatedAt: skill.updatedAt } : typeof skill.updated_at === "number" ? { updatedAt: skill.updated_at } : {}),
    ...(typeof skill.createdAt === "number" ? { createdAt: skill.createdAt } : typeof skill.created_at === "number" ? { createdAt: skill.created_at } : {}),
    ...(asString(latest.version) ? { latestVersion: { version: asString(latest.version)!, ...(asString(latest.changelog) ? { changelog: asString(latest.changelog) } : {}), ...(typeof latest.createdAt === "number" ? { createdAt: latest.createdAt } : {}) } } : {}),
    ...(asString(owner.handle) || asString(owner.displayName) ? { owner: { ...(asString(owner.handle) ? { handle: asString(owner.handle) } : {}), ...(asString(owner.displayName) ? { displayName: asString(owner.displayName) } : {}) } } : {}),
    ...(asString(publisher.name) ? { publisherName: asString(publisher.name) } : {}),
    ...(asString(keen.status) ? { securityStatus: asString(keen.status) } : {}),
    ...(asString(keen.statusText) ? { securityStatusText: asString(keen.statusText) } : {}),
    ...(asString(skill.overviewMd) ? { overviewMd: asString(skill.overviewMd)! } : {})
  };
}

export async function storeSkillDetail(slug: string, fetchStore: StoreFetch = defaultStoreFetch, delay?: (ms: number) => Promise<void>): Promise<SkillStoreDetail> {
  const trimmed = slug.trim();
  if (!trimmed || /[/\\\s]/u.test(trimmed)) throw new Error(`无效的技能标识：${slug}`);
  return normalizeStoreDetail(await fetchJson(`/api/v1/skills/${encodeURIComponent(trimmed)}`, fetchStore, delay));
}

/** 版本列表（倒序）。 */
export function normalizeStoreVersions(raw: unknown): SkillStoreVersion[] {
  if (!isPlainRecord(raw) || !Array.isArray(raw.versions)) throw new Error("SkillHub 版本响应形状不符。");
  return raw.versions
    .filter(isPlainRecord)
    .map((item) => ({ version: asString(item.version) ?? "", ...(asString(item.changelog) ? { changelog: asString(item.changelog) } : {}), ...(typeof item.createdAt === "number" ? { createdAt: item.createdAt } : {}) }))
    .filter((item) => item.version);
}

export async function storeSkillVersions(slug: string, fetchStore: StoreFetch = defaultStoreFetch, delay?: (ms: number) => Promise<void>): Promise<SkillStoreVersion[]> {
  const trimmed = slug.trim();
  if (!trimmed || /[/\\\s]/u.test(trimmed)) throw new Error(`无效的技能标识：${slug}`);
  return normalizeStoreVersions(await fetchJson(`/api/v1/skills/${encodeURIComponent(trimmed)}/versions`, fetchStore, delay));
}

/** 文件清单（安装与校验的唯一真源）。 */
export function normalizeStoreFiles(raw: unknown): { files: SkillStoreFile[]; version?: string } {
  if (!isPlainRecord(raw) || !Array.isArray(raw.files)) throw new Error("SkillHub 文件清单响应形状不符。");
  const files: SkillStoreFile[] = [];
  for (const item of raw.files) {
    if (!isPlainRecord(item)) continue;
    const path = asString(item.path);
    const sha256 = asString(item.sha256)?.toLowerCase();
    const size = asNumber(item.size);
    if (!path || !sha256 || size < 0) continue;
    files.push({ path, size, sha256 });
  }
  return { files, ...(asString(raw.version) ? { version: asString(raw.version) } : {}) };
}

export async function storeSkillFiles(slug: string, version: string | undefined, fetchStore: StoreFetch = defaultStoreFetch, delay?: (ms: number) => Promise<void>): Promise<{ files: SkillStoreFile[]; version?: string }> {
  const trimmed = slug.trim();
  if (!trimmed || /[/\\\s]/u.test(trimmed)) throw new Error(`无效的技能标识：${slug}`);
  const params = new URLSearchParams();
  if (version?.trim()) params.set("version", version.trim());
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return normalizeStoreFiles(await fetchJson(`/api/v1/skills/${encodeURIComponent(trimmed)}/files${suffix}`, fetchStore, delay));
}

/**
 * 下载单个文件字节（302 由 fetch 默认跟随；**不缓存/不转发 Location**——对象存储
 * 地址带时效签名）。调用方先用 files[].size 做上限预判，这里再校验实际字节数
 * （重定向后响应头不可靠，以清单为准）。
 */
export async function storeSkillFileBytes(slug: string, version: string | undefined, path: string, fetchStore: StoreFetch = defaultStoreFetch): Promise<Uint8Array> {
  const trimmed = slug.trim();
  if (!trimmed || /[/\\\s]/u.test(trimmed)) throw new Error(`无效的技能标识：${slug}`);
  const params = new URLSearchParams();
  params.set("path", path);
  if (version?.trim()) params.set("version", version.trim());
  const url = `${SKILL_STORE_BASE_URL}/api/v1/skills/${encodeURIComponent(trimmed)}/file?${params.toString()}`;
  let response: StoreFetchResponse;
  try {
    response = await fetchStore(url, AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2));
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    if (timedOut) throw new Error(`下载 ${path} 超时`);
    throw new Error(`下载 ${path} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 413) throw new Error(`文件 ${path} 超过单文件 1MB 上限（HTTP 413），该技能暂不支持面板安装，请改用官方 CLI 或网页安装。`);
  if (response.status >= 400) {
    const detail = extractStoreError(await response.text().catch(() => ""));
    throw new Error(`下载 ${path} 失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes;
}
