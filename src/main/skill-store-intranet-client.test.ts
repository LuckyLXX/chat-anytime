import { describe, expect, it } from "vitest";
import {
  buildIntranetUrl,
  intranetCategories,
  intranetDetail,
  intranetFileBytes,
  intranetFiles,
  intranetList,
  intranetPing,
  normalizeIntranetBaseUrl,
  type IntranetFetch,
  type IntranetFetchResponse
} from "./skill-store-intranet-client.js";

interface Reply {
  status?: number;
  body?: unknown;
  text?: string;
  bytes?: Uint8Array;
  error?: Error;
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function scriptedFetch(replies: Reply[]): { fetchImpl: IntranetFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: IntranetFetch = async (url) => {
    calls.push(url);
    const reply = replies.shift();
    if (!reply) throw new Error(`unexpected fetch: ${url}`);
    if (reply.error) throw reply.error;
    const response: IntranetFetchResponse = {
      status: reply.status ?? 200,
      json: async () => reply.body,
      text: async () => reply.text ?? JSON.stringify(reply.body ?? {}),
      arrayBuffer: async () => (reply.bytes ? bytesBuffer(reply.bytes) : new ArrayBuffer(0))
    };
    return response;
  };
  return { fetchImpl, calls };
}

const BASE = "http://skills.corp.local:8080";

describe("normalizeIntranetBaseUrl", () => {
  it("接受 http/https，保留路径前缀，去掉尾部斜杠", () => {
    expect(normalizeIntranetBaseUrl("http://skills.corp.local:8080")).toBe(BASE);
    expect(normalizeIntranetBaseUrl("  https://corp.local/store///  ")).toBe("https://corp.local/store");
    expect(normalizeIntranetBaseUrl("http://127.0.0.1:8788")).toBe("http://127.0.0.1:8788");
  });

  it("拒绝空值、无协议、非法协议与带查询串的地址", () => {
    expect(() => normalizeIntranetBaseUrl("")).toThrow(/请填写/);
    expect(() => normalizeIntranetBaseUrl("skills.corp.local:8080")).toThrow(/http/);
    expect(() => normalizeIntranetBaseUrl("ftp://corp.local")).toThrow(/http/);
    expect(() => normalizeIntranetBaseUrl("http://corp.local/store?x=1")).toThrow(/查询参数/);
  });
});

describe("buildIntranetUrl", () => {
  it("拼接路径前缀并序列化查询参数（空值丢弃）", () => {
    expect(buildIntranetUrl("http://corp.local/store", "/api/v1/skills", { page: 2, keyword: undefined })).toBe(
      "http://corp.local/store/api/v1/skills?page=2"
    );
    expect(buildIntranetUrl("http://corp.local", "api/v1/skills/demo/file", { path: "SKILL.md", version: "1.0.0" })).toBe(
      "http://corp.local/api/v1/skills/demo/file?path=SKILL.md&version=1.0.0"
    );
  });
});

describe("intranetList", () => {
  it("归一化技能条目并把排序键映射到服务端支持的维度", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        body: {
          ok: true,
          data: {
            total: 1,
            page: 1,
            pageSize: 20,
            skills: [
              {
                slug: "code-review",
                name: "代码审查",
                description: "检查代码",
                category: "dev",
                tags: ["review"],
                version: "1.2.0",
                fileCount: 3,
                totalBytes: 900,
                versionCount: 4,
                createdAt: 1,
                updatedAt: 2
              }
            ]
          }
        }
      }
    ]);
    const result = await intranetList(BASE, { sortBy: "score", order: "desc", page: 1, pageSize: 20 }, fetchImpl);
    expect(result.total).toBe(1);
    expect(result.skills[0]).toMatchObject({
      slug: "code-review",
      name: "代码审查",
      description: "检查代码",
      category: "dev",
      tags: ["review"],
      version: "1.2.0",
      requiresApiKey: false,
      downloads: 0,
      updatedAt: 2
    });
    // score 是公开商店的排序键，内网商店退回最近更新
    expect(calls[0]).toContain("sortBy=updated_at");
    expect(calls[0]).toContain("page=1");
    expect(calls[0]).toContain("pageSize=20");
  });

  it("name 排序原样透传", async () => {
    const { fetchImpl, calls } = scriptedFetch([{ body: { ok: true, data: { total: 0, skills: [] } } }]);
    await intranetList(BASE, { sortBy: "name", order: "asc", page: 1, pageSize: 10 }, fetchImpl);
    expect(calls[0]).toContain("sortBy=name");
    expect(calls[0]).toContain("order=asc");
  });
});

describe("intranetCategories", () => {
  it("映射分类并根据顺序号排序", async () => {
    const { fetchImpl } = scriptedFetch([
      { body: { ok: true, data: { items: [{ key: "ops", name: "运维", count: 2 }, { key: "dev", name: "开发", count: 1 }] } } }
    ]);
    const categories = await intranetCategories(BASE, fetchImpl);
    expect(categories.map((item) => item.key)).toEqual(["ops", "dev"]);
    expect(categories[0]?.sortOrder).toBe(0);
  });
});

describe("intranetDetail", () => {
  const detailBody = {
    ok: true,
    data: {
      skill: {
        slug: "demo",
        name: "演示",
        description: "d",
        category: "dev",
        tags: [],
        version: "1.0.1",
        fileCount: 2,
        totalBytes: 12,
        versionCount: 2,
        createdAt: 1,
        updatedAt: 2,
        manifest: [
          { path: "SKILL.md", size: 10, sha256: "a".repeat(64) },
          { path: "scripts/a.py", size: 2, sha256: "b".repeat(64) }
        ],
        versions: [
          { id: "v2", version: "1.0.1", changelog: "修复", createdAt: 2, fileCount: 2, totalBytes: 12, active: true },
          { id: "v1", version: "1.0.0", changelog: "", createdAt: 1, fileCount: 2, totalBytes: 12, active: false }
        ]
      }
    }
  };

  it("一次拿到详情、版本、文件清单与 SKILL.md 预览", async () => {
    const { fetchImpl } = scriptedFetch([{ body: detailBody }, { bytes: new TextEncoder().encode("# 演示\n") }]);
    const result = await intranetDetail(BASE, "demo", undefined, fetchImpl);
    expect(result.detail.slug).toBe("demo");
    expect(result.detail.latestVersion).toMatchObject({ version: "1.0.1", changelog: "修复" });
    expect(result.versions.map((item) => item.version)).toEqual(["1.0.1", "1.0.0"]);
    expect(result.files.map((item) => item.path)).toEqual(["SKILL.md", "scripts/a.py"]);
    expect(result.totalBytes).toBe(12);
    expect(result.readme).toBe("# 演示\n");
  });

  it("清单里没有 SKILL.md 时不发文件请求", async () => {
    const body = structuredClone(detailBody);
    body.data.skill.manifest = [{ path: "README.md", size: 10, sha256: "a".repeat(64) }];
    const { fetchImpl, calls } = scriptedFetch([{ body }]);
    const result = await intranetDetail(BASE, "demo", undefined, fetchImpl);
    expect(result.readme).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe("intranetFiles / intranetFileBytes", () => {
  it("files 返回合计体积；file 返回原始字节", async () => {
    const files = await intranetFiles(
      BASE,
      "demo",
      "1.0.0",
      scriptedFetch([
        {
          body: {
            ok: true,
            data: {
              version: "1.0.0",
              files: [
                { path: "SKILL.md", size: 4, sha256: "a".repeat(64) },
                { path: "x.bin", size: 2, sha256: "b".repeat(64) }
              ]
            }
          }
        }
      ]).fetchImpl
    );
    expect(files.version).toBe("1.0.0");
    expect(files.totalBytes).toBe(6);

    const bytes = await intranetFileBytes(BASE, "demo", "1.0.0", "SKILL.md", scriptedFetch([{ bytes: new Uint8Array([1, 2, 3]) }]).fetchImpl);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it("413 给面板安装口径的中文提示", async () => {
    const { fetchImpl } = scriptedFetch([{ status: 413, text: '{"ok":false,"error":{"message":"超过单文件上限"}}' }]);
    await expect(intranetFileBytes(BASE, "demo", "1.0.0", "big.bin", fetchImpl)).rejects.toThrow(/单文件上限/);
  });
});

describe("intranetPing", () => {
  it("返回版本、技能数与上限", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        body: {
          ok: true,
          data: {
            name: "内网技能库",
            version: "0.1.0",
            skillCount: 7,
            baseUrl: BASE,
            limits: { maxFileBytes: 1048576, maxTotalBytes: 33554432, maxFiles: 200, maxVersionsPerSkill: 20 }
          }
        }
      }
    ]);
    const ping = await intranetPing(BASE, fetchImpl);
    expect(ping).toMatchObject({ name: "内网技能库", version: "0.1.0", skillCount: 7 });
    expect(ping.limits?.maxFileBytes).toBe(1048576);
  });
});

describe("错误映射", () => {
  it("服务端 {ok:false} 的中文原因原样透出", async () => {
    const { fetchImpl } = scriptedFetch([{ body: { ok: false, error: { code: "skill_not_found", message: "技能 demo 不存在" } } }]);
    await expect(intranetPing(BASE, fetchImpl)).rejects.toThrow("技能 demo 不存在");
  });

  it("404 / 5xx / 非 JSON / 超时 / 连接失败", async () => {
    await expect(intranetFiles(BASE, "nope", undefined, scriptedFetch([{ status: 404, text: "" }]).fetchImpl)).rejects.toThrow(/没有找到/);
    await expect(intranetPing(BASE, scriptedFetch([{ status: 503, text: "busy" }]).fetchImpl)).rejects.toThrow(/暂时不可用/);

    const nonJson = scriptedFetch([
      {
        body: undefined,
        text: "<html>proxy</html>"
      }
    ]);
    // json() 返回 undefined 会被当成形状不符；这里改造成「非 JSON」场景
    const brokenFetch: IntranetFetch = async () => ({
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
      text: async () => "<html>proxy</html>",
      arrayBuffer: async () => new ArrayBuffer(0)
    });
    await expect(intranetPing(BASE, brokenFetch)).rejects.toThrow(/不是合法 JSON/);
    void nonJson;

    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    await expect(intranetPing(BASE, scriptedFetch([{ error: timeout }]).fetchImpl)).rejects.toThrow(/超时/);

    await expect(intranetPing(BASE, scriptedFetch([{ error: new Error("getaddrinfo ENOTFOUND") }]).fetchImpl)).rejects.toThrow(/无法连接内网商店/);
  });
});
