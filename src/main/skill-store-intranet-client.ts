// 内网 Skill 商店（LanSkills）客户端。
//
// 纯逻辑模块：所有 I/O 走注入式 `intranetFetch`（参照 skill-store-client.ts 的形态），
// 单测不打网络即可覆盖归一化、错误映射与 URL 拼接。utility 进程使用全局 fetch（内网直连）。
//
// 协议口径见 lanskills 仓库 `docs/API.md`：
//   GET /api/v1/ping                       {ok:true,data:{name,version,skillCount,limits,baseUrl}}
//   GET /api/v1/skills?page&pageSize&keyword&category&sortBy&order
//   GET /api/v1/categories                 {items:[{key,name,count}]}
//   GET /api/v1/skills/{slug}?version=      {skill:{…, manifest, versions}}
//   GET /api/v1/skills/{slug}/files?version= {version,files:[{path,size,sha256}],totalBytes}
//   GET /api/v1/skills/{slug}/file?path=&version=  原始字节（响应头 X-Content-SHA256）
// 错误统一 {ok:false,error:{code,message}}。

import type {
  SkillStoreCategory,
  SkillStoreDetail,
  SkillStoreFile,
  SkillStoreQuery,
  SkillStoreSkill,
  SkillStoreVersion
} from "../shared/skill-store.js";

/** 单次请求超时（毫秒）。内网服务，失败重试比挂死好。 */
const REQUEST_TIMEOUT_MS = 12_000;
/** 下载单文件超时。 */
const DOWNLOAD_TIMEOUT_MS = 24_000;
/** SKILL.md 预览上限（解码后字节）。 */
const README_PREVIEW_MAX_BYTES = 64 * 1024;

export type IntranetFetchResponse = {
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type IntranetFetch = (url: string, signal: AbortSignal) => Promise<IntranetFetchResponse>;

export const defaultIntranetFetch: IntranetFetch = async (url, signal) => {
  const response = await fetch(url, { method: "GET", headers: { Accept: "application/json" }, signal });
  return {
    status: response.status,
    json: () => response.json() as Promise<unknown>,
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer()
  };
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 32);
}

/**
 * 校验并规范化内网商店地址：只允许 http/https 绝对地址，保留路径前缀，去掉尾部斜杠。
 * 非法地址抛中文错误（设置页直接展示）。
 */
export function normalizeIntranetBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("请填写内网商店地址，例如 http://skills.corp.local:8080");
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("内网商店地址必须以 http:// 或 https:// 开头");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`内网商店地址不合法：${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("内网商店地址只支持 http/https");
  if (!parsed.hostname) throw new Error("内网商店地址缺少主机名");
  if (parsed.search || parsed.hash) throw new Error("内网商店地址不要带查询参数或锚点");
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** base 可能带路径前缀（http://corp.local/store），path 以 / 开头。 */
export function buildIntranetUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${trimmedBase}${trimmedPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

class StoreHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function timeoutName(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function messageFromBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const error = isPlainRecord(parsed.error) ? parsed.error : undefined;
    const candidate = error ? error.message : parsed.message;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 300);
  } catch {
    // 非 JSON（网关错误页等）——用原文
  }
  return trimmed.slice(0, 300);
}

function mapHttpError(status: number, body: string, label: string): StoreHttpError {
  const detail = messageFromBody(body);
  const suffix = detail ? `：${detail}` : "";
  if (status === 404) return new StoreHttpError(404, `内网商店上没有找到${label}（404）${suffix}`);
  if (status === 413) return new StoreHttpError(413, `内网商店拒绝了请求（413，内容超限）${suffix}`);
  if (status === 409) return new StoreHttpError(409, `内网商店拒绝了请求（409）${suffix}`);
  if (status === 429) return new StoreHttpError(429, `内网商店触发限流（429），请稍后重试${suffix}`);
  if (status >= 500) return new StoreHttpError(status, `内网商店服务暂时不可用（HTTP ${status}）${suffix}`);
  return new StoreHttpError(status, `内网商店拒绝了请求（HTTP ${status}）${suffix}`);
}

/**
 * 单次 GET → `{ok:true,data}` 的 data。
 * 不用 `response.json()` 的 try/catch 掩盖服务端业务错误：先看状态码，再看信封。
 */
async function getJson(
  base: string,
  path: string,
  label: string,
  fetchImpl: IntranetFetch,
  query?: Record<string, string | number | undefined>
): Promise<unknown> {
  const url = buildIntranetUrl(base, path, query);
  let response: IntranetFetchResponse;
  try {
    response = await fetchImpl(url, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  } catch (error) {
    if (timeoutName(error)) throw new Error(`内网商店请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）：${url}`);
    throw new Error(`无法连接内网商店（${base}）：${error instanceof Error ? error.message : String(error)}。请检查地址与网络后重试。`);
  }
  if (response.status >= 400) throw mapHttpError(response.status, await response.text().catch(() => ""), label);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("内网商店返回的不是合法 JSON（地址可能指向了别的服务或反向代理错误页）。");
  }
  if (!isPlainRecord(payload) || payload.ok !== true) {
    const error = isPlainRecord(payload) && isPlainRecord(payload.error) ? payload.error : undefined;
    const message = error && typeof error.message === "string" ? error.message : "内网商店响应形状不符（缺少 ok/data）";
    throw new Error(message);
  }
  return payload.data;
}

export interface IntranetPingResult {
  name: string;
  version: string;
  skillCount: number;
  baseUrl?: string;
  limits?: { maxFileBytes?: number; maxTotalBytes?: number; maxFiles?: number; maxVersionsPerSkill?: number };
}

export async function intranetPing(base: string, fetchImpl: IntranetFetch = defaultIntranetFetch): Promise<IntranetPingResult> {
  const data = await getJson(base, "/api/v1/ping", "服务信息", fetchImpl);
  if (!isPlainRecord(data)) throw new Error("内网商店 ping 响应形状不符");
  const limits = isPlainRecord(data.limits) ? data.limits : {};
  return {
    name: asString(data.name) ?? "内网商店",
    version: asString(data.version) ?? "",
    skillCount: asNumber(data.skillCount),
    ...(asString(data.baseUrl) ? { baseUrl: asString(data.baseUrl) } : {}),
    limits: {
      ...(typeof limits.maxFileBytes === "number" ? { maxFileBytes: limits.maxFileBytes } : {}),
      ...(typeof limits.maxTotalBytes === "number" ? { maxTotalBytes: limits.maxTotalBytes } : {}),
      ...(typeof limits.maxFiles === "number" ? { maxFiles: limits.maxFiles } : {}),
      ...(typeof limits.maxVersionsPerSkill === "number" ? { maxVersionsPerSkill: limits.maxVersionsPerSkill } : {})
    }
  };
}

/** 内网商店的技能条目 → 与公开商店共用的 SkillStoreSkill。 */
export function normalizeIntranetSkill(raw: unknown): SkillStoreSkill | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const slug = asString(raw.slug);
  const name = asString(raw.name);
  if (!slug || !name) return undefined;
  return {
    slug,
    name,
    description: asString(raw.description) ?? "",
    ...(asString(raw.category) ? { category: asString(raw.category) } : {}),
    ...(asString(raw.version) ? { version: asString(raw.version) } : {}),
    tags: asStringArray(raw.tags),
    subCategories: [],
    downloads: 0,
    stars: 0,
    installs: 0,
    score: 0,
    requiresApiKey: false,
    ...(typeof raw.updatedAt === "number" ? { updatedAt: raw.updatedAt } : {}),
    ...(typeof raw.createdAt === "number" ? { createdAt: raw.createdAt } : {})
  };
}

const SORT_MAP: Record<string, string> = {
  updated_at: "updated_at",
  created_at: "created_at",
  name: "name",
  // 公开商店专有的排序键在内网商店没有对应维度：退回最近更新（UI 不会发这些值）
  score: "updated_at",
  downloads: "updated_at",
  stars: "updated_at",
  installs: "updated_at"
};

export async function intranetList(
  base: string,
  query: SkillStoreQuery,
  fetchImpl: IntranetFetch = defaultIntranetFetch
): Promise<{ skills: SkillStoreSkill[]; total: number }> {
  const data = await getJson(base, "/api/v1/skills", "技能列表", fetchImpl, {
    page: Math.max(1, Math.floor(query.page)),
    pageSize: Math.min(100, Math.max(1, Math.floor(query.pageSize))),
    keyword: query.keyword?.trim(),
    category: query.category?.trim(),
    sortBy: SORT_MAP[query.sortBy] ?? "updated_at",
    order: query.order === "asc" ? "asc" : "desc"
  });
  if (!isPlainRecord(data)) throw new Error("内网商店列表响应形状不符");
  const list = Array.isArray(data.skills) ? data.skills : [];
  return {
    skills: list.map(normalizeIntranetSkill).filter((item): item is SkillStoreSkill => item !== undefined),
    total: asNumber(data.total)
  };
}

export async function intranetCategories(base: string, fetchImpl: IntranetFetch = defaultIntranetFetch): Promise<SkillStoreCategory[]> {
  const data = await getJson(base, "/api/v1/categories", "分类字典", fetchImpl);
  const items = isPlainRecord(data) && Array.isArray(data.items) ? data.items : [];
  return items
    .filter(isPlainRecord)
    .map((item, index) => ({
      key: asString(item.key) ?? "",
      name: asString(item.name) ?? "",
      sortOrder: typeof item.sortOrder === "number" ? item.sortOrder : index
    }))
    .filter((item) => item.key && item.name);
}

/** 内网商店详情：一次拿到技能、版本历史与文件清单（与公开商店的 detail 结果同形）。 */
export async function intranetDetail(
  base: string,
  slug: string,
  version: string | undefined,
  fetchImpl: IntranetFetch = defaultIntranetFetch
): Promise<{ detail: SkillStoreDetail; versions: SkillStoreVersion[]; files: SkillStoreFile[]; totalBytes: number; readme?: string }> {
  const data = await getJson(base, `/api/v1/skills/${encodeURIComponent(slug)}`, "技能详情", fetchImpl, { version });
  if (!isPlainRecord(data) || !isPlainRecord(data.skill)) throw new Error("内网商店详情响应形状不符");
  const skill = data.skill;
  const baseSkill = normalizeIntranetSkill(skill);
  if (!baseSkill) throw new Error("内网商店详情缺少技能标识（slug）");

  const versionsRaw = Array.isArray(skill.versions) ? skill.versions : [];
  const versions: SkillStoreVersion[] = versionsRaw
    .filter(isPlainRecord)
    .map((item) => ({
      version: asString(item.version) ?? "",
      ...(asString(item.changelog) ? { changelog: asString(item.changelog) } : {}),
      ...(typeof item.createdAt === "number" ? { createdAt: item.createdAt } : {})
    }))
    .filter((item) => item.version);

  const filesRaw = Array.isArray(skill.manifest) ? skill.manifest : [];
  const files: SkillStoreFile[] = filesRaw
    .filter(isPlainRecord)
    .map((item) => ({ path: asString(item.path) ?? "", size: asNumber(item.size), sha256: asString(item.sha256) ?? "" }))
    .filter((item) => item.path && item.sha256);

  const activeVersion = versions.find((item) => item.version === baseSkill.version);
  const detail: SkillStoreDetail = {
    ...baseSkill,
    ...(baseSkill.version
      ? {
          latestVersion: {
            version: baseSkill.version,
            ...(activeVersion?.changelog ? { changelog: activeVersion.changelog } : {}),
            ...(activeVersion?.createdAt ? { createdAt: activeVersion.createdAt } : {})
          }
        }
      : {})
  };

  // SKILL.md 预览尽力而为：失败不阻断详情（与公开商店同口径）。
  let readme: string | undefined;
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (skillMd && skillMd.size <= README_PREVIEW_MAX_BYTES) {
    try {
      const bytes = await intranetFileBytes(base, slug, version ?? baseSkill.version, "SKILL.md", fetchImpl);
      if (bytes.byteLength <= README_PREVIEW_MAX_BYTES) readme = new TextDecoder().decode(bytes);
    } catch {
      // 忽略：详情本身可用
    }
  }

  return {
    detail,
    versions,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    ...(readme !== undefined ? { readme } : {})
  };
}

export async function intranetFiles(
  base: string,
  slug: string,
  version: string | undefined,
  fetchImpl: IntranetFetch = defaultIntranetFetch
): Promise<{ version?: string; files: SkillStoreFile[]; totalBytes: number }> {
  const data = await getJson(base, `/api/v1/skills/${encodeURIComponent(slug)}/files`, "文件清单", fetchImpl, { version });
  if (!isPlainRecord(data) || !Array.isArray(data.files)) throw new Error("内网商店文件清单响应形状不符");
  const files: SkillStoreFile[] = data.files
    .filter(isPlainRecord)
    .map((item) => ({ path: asString(item.path) ?? "", size: asNumber(item.size), sha256: asString(item.sha256) ?? "" }))
    .filter((item) => item.path && item.sha256);
  return {
    ...(asString(data.version) ? { version: asString(data.version) } : {}),
    files,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0)
  };
}

/** 下载单个文件字节。调用方先用 files[].size 做上限预判，这里不再信任响应头。 */
export async function intranetFileBytes(
  base: string,
  slug: string,
  version: string | undefined,
  path: string,
  fetchImpl: IntranetFetch = defaultIntranetFetch
): Promise<Uint8Array> {
  const url = buildIntranetUrl(base, `/api/v1/skills/${encodeURIComponent(slug)}/file`, { path, version });
  let response: IntranetFetchResponse;
  try {
    response = await fetchImpl(url, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS));
  } catch (error) {
    if (timeoutName(error)) throw new Error(`下载 ${path} 超时（${DOWNLOAD_TIMEOUT_MS / 1000} 秒）`);
    throw new Error(`下载 ${path} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 413) throw new Error(`文件 ${path} 超过内网商店的单文件上限（HTTP 413），该技能暂不支持面板安装。`);
  if (response.status >= 400) throw mapHttpError(response.status, await response.text().catch(() => ""), `文件 ${path}`);
  return new Uint8Array(await response.arrayBuffer());
}
