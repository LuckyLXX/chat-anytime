import { describe, expect, it } from "vitest";
import { SKILL_STORE_MAX_PAGE_SIZE, buildStoreSearchPath, defaultStoreFetch, extractStoreError, normalizeStoreDetail, normalizeStoreFiles, normalizeStoreSkill, normalizeStoreVersions, storeCategories, storeListSkills, storeSkillDetail, storeSkillFileBytes, storeSkillFiles, storeSkillVersions, storeTopSkills } from "./skill-store-client.js";
import type { StoreFetch, StoreFetchResponse } from "./skill-store-client.js";

/** 一次成功的 JSON 响应替身。 */
function jsonResponse(payload: unknown, status = 200): StoreFetchResponse {
  return { status, json: () => Promise.resolve(payload), text: () => Promise.resolve(JSON.stringify(payload)), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
}

/** 记录调用的 fetch 替身：按序返回响应。 */
function scriptedFetch(responses: (StoreFetchResponse | Error)[], calls: string[] = []): StoreFetch {
  let index = 0;
  return async (url) => {
    calls.push(url);
    const next = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  };
}

const immediateDelay = async () => undefined;

describe("buildStoreSearchPath", () => {
  it("拼装分页/排序/关键词/分类，空值丢弃", () => {
    const path = buildStoreSearchPath({ sortBy: "downloads", order: "desc", page: 2, pageSize: 20, keyword: " 搜索 ", category: " dev-programming " });
    expect(path).toContain("/api/skills?");
    expect(path).toContain("page=2");
    expect(path).toContain("pageSize=20");
    expect(path).toContain("sortBy=downloads");
    expect(path).toContain("order=desc");
    expect(path).toContain(`keyword=${encodeURIComponent("搜索")}`);
    expect(path).toContain("category=dev-programming");
  });

  it("无关键词/分类时不产生空参数，pageSize 夹在 1–100", () => {
    const path = buildStoreSearchPath({ sortBy: "score", order: "asc", page: 1, pageSize: 500 });
    expect(path).not.toContain("keyword");
    expect(path).not.toContain("category");
    expect(path).toContain(`pageSize=${SKILL_STORE_MAX_PAGE_SIZE}`);
  });
});

describe("归一化：信封 vs 裸对象", () => {
  it("storeListSkills 解信封并归一化列表项（标签/子分类/容错字段）", async () => {
    const fetchStore = scriptedFetch([
      jsonResponse({
        code: 0,
        message: "ok",
        data: {
          total: 130,
          skills: [
            {
              slug: "dev-god",
              name: "编程大神",
              description: "EN desc",
              description_zh: "中文描述",
              iconUrl: "https://example.com/icon.png",
              ownerName: "ake",
              category: "dev-programming",
              version: "1.2.4",
              tags: ["tag-a"],
              subCategories: [{ key: "dev-code-gen", name: "代码生成" }],
              downloads: 11235636,
              stars: 77,
              installs: 0,
              score: 100000,
              labels: { requires_api_key: "false", pricing_type: "free" },
              namespace: { canonicalName: "@ake/dev-god" },
              created_at: 1791402289536,
              updated_at: 1793778472784
            },
            { slug: "" /* 缺 slug → 丢弃 */ },
            "junk"
          ]
        }
      })
    ]);
    const { skills, total } = await storeListSkills({ sortBy: "downloads", order: "desc", page: 1, pageSize: 3 }, fetchStore, immediateDelay);
    expect(total).toBe(130);
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.slug).toBe("dev-god");
    expect(skill.descriptionZh).toBe("中文描述");
    expect(skill.requiresApiKey).toBe(false);
    expect(skill.pricingType).toBe("free");
    expect(skill.canonicalName).toBe("@ake/dev-god");
    expect(skill.subCategories).toEqual([{ key: "dev-code-gen", name: "代码生成" }]);
    expect(skill.updatedAt).toBe(1793778472784);
  });

  it("storeTopSkills 解信封；storeCategories 容错拉平", async () => {
    const top = await storeTopSkills(scriptedFetch([jsonResponse({ code: 0, data: { skills: [{ slug: "a", name: "A", description: "d", downloads: 1, stars: 0, installs: 0, score: 0, tags: null, subCategories: null }] } })]), immediateDelay);
    expect(top).toHaveLength(1);
    const categories = await storeCategories(scriptedFetch([jsonResponse({ count: 2, items: [{ key: "dev-programming", name: "开发编程", nameEn: "Development", level: 1, sortOrder: 30, active: true }, { key: "", name: "坏条目" }] })]), immediateDelay);
    expect(categories).toEqual([{ key: "dev-programming", name: "开发编程", nameEn: "Development", sortOrder: 30 }]);
  });

  it("坏信封（code 非 0 / 缺 data）给出中文错误", async () => {
    await expect(storeListSkills({ sortBy: "score", order: "asc", page: 1, pageSize: 10 }, scriptedFetch([jsonResponse({ code: 500, message: "boom" })]), immediateDelay)).rejects.toThrow("信封");
  });

  it("详情用真实响应形状：名称在 skill.displayName、描述在 summary、计数在 stats", () => {
    // 2026-11-04 真机探针抓到的形状（与文档口径不同，只认一套就是「详情页一片空白」）
    const detail = normalizeStoreDetail({
      contentZhAvailable: false,
      slug: "find-skills",
      latestVersion: { changelog: "SEO：description 重写", createdAt: 1792741877170, version: "1.7.0" },
      namespace: { canonicalName: "@nordic/find-skills", displayName: "南风", handle: "user_2dc8a2f8" },
      owner: { displayName: "南风", handle: "user_2dc8a2f8", image: null },
      publisher: { name: "阿客实验室", verified: true },
      securityReports: { keen: { status: "benign", statusText: "安全，无风险" } },
      skill: {
        slug: "find-skills",
        displayName: "技能发现·Find Skills",
        summary: "English summary",
        summary_zh: "不知道装什么技能？技能发现帮你找。",
        category: "ai-agent",
        iconUrl: "https://example.com/i.png",
        labels: { requires_api_key: "false" },
        tags: { latest: "1.7.0" },
        stats: { comments: 0, downloads: 1560681, installs: 75956, stars: 1810, versions: 3 },
        subCategories: [{ key: "agent-framework", name: "Agent 框架" }],
        updatedAt: 1793780413480,
        createdAt: 1772739775136
      }
    });
    expect(detail.slug).toBe("find-skills");
    expect(detail.name).toBe("技能发现·Find Skills");
    expect(detail.descriptionZh).toContain("技能发现");
    expect(detail.description).toBe("English summary");
    expect(detail.version).toBe("1.7.0");
    expect(detail.downloads).toBe(1560681);
    expect(detail.stars).toBe(1810);
    expect(detail.installs).toBe(75956);
    expect(detail.canonicalName).toBe("@nordic/find-skills");
    expect(detail.publisherName).toBe("阿客实验室");
    expect(detail.requiresApiKey).toBe(false);
    expect(detail.subCategories).toEqual([{ key: "agent-framework", name: "Agent 框架" }]);
    expect(detail.latestVersion?.version).toBe("1.7.0");
    expect(detail.securityStatusText).toBe("安全，无风险");
  });

  it("详情缺 slug 时给出明确错误（不静默返回空对象）", () => {
    expect(() => normalizeStoreDetail({ skill: { displayName: "无 slug" } })).toThrow("slug");
  });

  it("normalizeStoreDetail 读裸对象（latestVersion/owner/安全评测容错）", () => {
    const detail = normalizeStoreDetail({
      slug: "dev-god",
      name: "编程大神",
      description: "d",
      category: "dev-programming",
      downloads: 1,
      stars: 2,
      installs: 3,
      score: 4,
      tags: null,
      labels: { requires_api_key: true },
      latestVersion: { version: "1.2.4", changelog: "New version", createdAt: 1791925342870 },
      owner: { handle: "u_42bbb65f", displayName: "客叔", image: null },
      publisher: { name: "阿客实验室" },
      securityReports: { keen: { status: "benign", statusText: "安全，无风险", reportUrl: "x" } }
    });
    expect(detail.latestVersion?.version).toBe("1.2.4");
    expect(detail.owner?.displayName).toBe("客叔");
    expect(detail.publisherName).toBe("阿客实验室");
    expect(detail.requiresApiKey).toBe(true);
    expect(detail.securityStatusText).toBe("安全，无风险");
  });

  it("normalizeStoreVersions / normalizeStoreFiles 过滤坏条目", () => {
    const versions = normalizeStoreVersions({ versions: [{ version: "1.0", changelog: "c", createdAt: 1 }, { version: "" }, "junk"] });
    expect(versions).toEqual([{ version: "1.0", changelog: "c", createdAt: 1 }]);
    const files = normalizeStoreFiles({ count: 3, version: "1.0", files: [{ path: "SKILL.md", sha256: "a".repeat(64), size: 10 }, { path: "", sha256: "b".repeat(64), size: 1 }] });
    expect(files.files).toHaveLength(1);
    expect(files.version).toBe("1.0");
  });
});

describe("错误映射与退避", () => {
  it("404 → 中文错误不重试；429/503 → 重试到上限后报已重试次数", async () => {
    const calls: string[] = [];
    const delays: number[] = [];
    const delay = async (ms: number) => {
      delays.push(ms);
    };
    const notFound = scriptedFetch([jsonResponse({ error: "skill not found" }, 404)], calls);
    await expect(storeSkillDetail("missing-skill", notFound, delay)).rejects.toThrow("没有找到对应资源");
    expect(calls).toHaveLength(1);

    const rateLimited = scriptedFetch([jsonResponse({ error: "rate limited" }, 429)], calls);
    await expect(storeListSkills({ sortBy: "downloads", order: "desc", page: 1, pageSize: 3 }, rateLimited, delay)).rejects.toThrow("已重试 3 次");
    expect(calls).toHaveLength(4); // 1 次 404 + 3 次 429
    expect(delays).toEqual([500, 1000]);
  });

  it("网络错误 → 可行动的中文错误（不打网络）", async () => {
    const failing = scriptedFetch([new Error("getaddrinfo ENOTFOUND api.skillhub.cn")]);
    await expect(storeTopSkills(failing, immediateDelay)).rejects.toThrow("无法连接 SkillHub");
  });

  it("4xx 错误体里的 error 字段透传到消息", async () => {
    const badRequest = scriptedFetch([jsonResponse({ error: "invalid keyword" }, 400)]);
    await expect(storeSkillFiles("a", undefined, badRequest)).rejects.toThrow("invalid keyword");
  });
});

describe("storeSkillFileBytes", () => {
  it("413 → 明确的「含大文件、用官方 CLI」提示", async () => {
    const tooLarge = scriptedFetch([jsonResponse({ error: "file too large" }, 413)]);
    await expect(storeSkillFileBytes("a", undefined, "big.bin", tooLarge)).rejects.toThrow("官方 CLI");
  });

  it("返回字节数组（arrayBuffer 通路口径）", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const ok = scriptedFetch([{ status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve(""), arrayBuffer: () => Promise.resolve(bytes) }]);
    const data = await storeSkillFileBytes("a", "1.0", "SKILL.md", ok);
    expect([...data]).toEqual([1, 2, 3]);
  });
});

describe("defaultStoreFetch 形状", () => {
  it("向 base URL 发 GET（不打网络，仅检查函数存在与签名口径）", () => {
    expect(typeof defaultStoreFetch).toBe("function");
  });
});

describe("normalizeStoreSkill 字段容错", () => {
  it("缺 name / slug 的条目返回 undefined", () => {
    expect(normalizeStoreSkill({ slug: "a", name: "" })).toBeUndefined();
    expect(normalizeStoreSkill({ slug: "", name: "A" })).toBeUndefined();
    expect(normalizeStoreSkill("junk")).toBeUndefined();
    expect(normalizeStoreSkill(null)).toBeUndefined();
  });

  it("description_zh 与 description 相同时不重复携带", () => {
    const skill = normalizeStoreSkill({ slug: "a", name: "A", description: "same", description_zh: "same", downloads: 0, stars: 0, installs: 0, score: 0, tags: [], subCategories: [], labels: {} });
    expect(skill?.descriptionZh).toBeUndefined();
  });
});
