import { describe, expect, it } from "vitest";
import { publishHeadline, publishReceipt, validatePublishInput, type GalleryToolContext } from "./runtime-gallery.js";

describe("validatePublishInput", () => {
  it("缺 path / title / kind 一律拒绝（工具参数错误要当场报，而不是静默发布空作品）", () => {
    expect(() => validatePublishInput({})).toThrow(/path/u);
    expect(() => validatePublishInput({ path: "a.html" })).toThrow(/kind/u);
    expect(() => validatePublishInput({ path: "a.html", kind: "file" })).toThrow(/title/u);
    expect(() => validatePublishInput({ path: "a.html", kind: "nope", title: "t" })).toThrow(/kind/u);
  });

  it("归一化可选字段：空白串丢弃、tags 去空", () => {
    const draft = validatePublishInput({ path: " demo.html ", kind: " file ", title: " 示例 ", entry: " ", command: "", url: "  ", description: " 说明 ", tags: [" a ", "", "b"] });
    expect(draft).toEqual({ title: "示例", kind: "file", path: "demo.html", description: "说明", tags: ["a", "b"] });
  });

  it("cover 透传：去空白，空串等于没指定（自动取图）", () => {
    expect(validatePublishInput({ path: "a.html", kind: "file", title: "t", cover: " outputs/cover.png " }).cover).toBe("outputs/cover.png");
    expect(validatePublishInput({ path: "a.html", kind: "file", title: "t", cover: "   " }).cover).toBeUndefined();
    expect(validatePublishInput({ path: "a.html", kind: "file", title: "t", cover: 42 }).cover).toBeUndefined();
  });

  it("server 类型保留 command / url（运行分流的依据）", () => {
    const draft = validatePublishInput({ path: "apps/demo", kind: "server", title: "记账工具", command: "npm run dev", url: "http://localhost:5173" });
    expect(draft.command).toBe("npm run dev");
    expect(draft.url).toBe("http://localhost:5173");
  });

  it("panel 类型同样保留 command / url（面板的本地服务：开窗前拉起、探活通过再开窗）", () => {
    const draft = validatePublishInput({
      path: "works/git-manager/index.html",
      kind: "panel",
      title: "Git 管理器",
      command: "node bridge.mjs",
      url: "http://127.0.0.1:8791/api/health",
      panel: { width: 1180, height: 780 }
    });
    expect(draft.command).toBe("node bridge.mjs");
    expect(draft.url).toBe("http://127.0.0.1:8791/api/health");
    expect(draft.panel).toEqual({ width: 1180, height: 780 });
  });

  it("server 类型保留 runMode（page 缺省不写；非法值当没写；别的类型带它就是脏数据）", () => {
    expect(validatePublishInput({ path: "apps/proxy", kind: "server", title: "反代", command: "node proxy.js", runMode: "background" }).runMode).toBe("background");
    expect(validatePublishInput({ path: "apps/web", kind: "server", title: "网页", command: "npm run dev", runMode: "page" }).runMode).toBe("page");
    expect(validatePublishInput({ path: "apps/web", kind: "server", title: "网页", runMode: "bogus" }).runMode).toBeUndefined();
    expect(validatePublishInput({ path: "a.html", kind: "file", title: "t", runMode: "background" }).runMode).toBeUndefined();
  });

  it("panel 类型保留归一化后的窗口偏好；非法 panel 丢字段而不是报错", () => {
    const draft = validatePublishInput({ path: "panels/status/index.html", kind: "panel", title: "会话状态", panel: { width: 320, height: 700, alwaysOnTop: true } });
    expect(draft.kind).toBe("panel");
    expect(draft.panel).toEqual({ width: 320, height: 700, alwaysOnTop: true });
    // 尺寸写疯了只会被夹取；整个 panel 非法（字符串）则当没写
    expect(validatePublishInput({ path: "p.html", kind: "panel", title: "t", panel: { width: 99999 } }).panel).toEqual({ width: 1600 });
    expect(validatePublishInput({ path: "p.html", kind: "panel", title: "t", panel: "big" }).panel).toBeUndefined();
  });

  it("appId 透传（「继续开发」后重新发布靠它更新同一张卡）", () => {
    expect(validatePublishInput({ appId: " g-abc123 ", path: "a.html", kind: "file", title: "t" }).appId).toBe("g-abc123");
    expect(validatePublishInput({ appId: "  ", path: "a.html", kind: "file", title: "t" }).appId).toBeUndefined();
    expect(validatePublishInput({ appId: 42, path: "a.html", kind: "file", title: "t" }).appId).toBeUndefined();
  });

  it("entry 只在 file / panel 有意义：server 传 entry 当场报错（服务没有「入口页」）", () => {
    expect(() => validatePublishInput({ path: "apps/demo", kind: "server", title: "t", entry: "index.html" })).toThrow(/不支持 entry/u);
    // file / panel 照常保留（最终解析在发布实现里做，那里才知道工作区根）
    expect(validatePublishInput({ path: "panels/status", kind: "panel", title: "t", entry: "index.html" }).entry).toBe("index.html");
    expect(validatePublishInput({ path: "designs", kind: "file", title: "t", entry: "demo.html" }).entry).toBe("demo.html");
  });

  it("panel 的本地服务字段必须成对：只给一半当场报错（不再静默丢弃）", () => {
    expect(() => validatePublishInput({ path: "p/index.html", kind: "panel", title: "t", command: "node bridge.mjs" })).toThrow(/成对/u);
    expect(() => validatePublishInput({ path: "p/index.html", kind: "panel", title: "t", url: "http://127.0.0.1:8791/api/health" })).toThrow(/成对/u);
    // 两个都不填 = 面板不依赖平台托管的本地服务，合法
    expect(() => validatePublishInput({ path: "p/index.html", kind: "panel", title: "t" })).not.toThrow();
  });
});

describe("publishReceipt（发布回执契约）", () => {
  const app = { id: "g1", title: "收纳整理原型", kind: "file" as const, workspace: "D:/ws", entry: "designs/exports/demo.html", createdAt: 1, updatedAt: 1 };

  it("回执说清新建还是更新、作品 ID、最终入口与作品墙入口", () => {
    const text = publishReceipt({ app, created: false, total: 3, coverNote: "" });
    expect(text).toContain("已更新作品「收纳整理原型」（网页）");
    expect(text).toContain("作品 ID：g1");
    expect(text).toContain("最终入口：designs/exports/demo.html");
    expect(text).toContain("原条目已就地更新");
    expect(text).toContain("现有 3 个");
    expect(text).toContain("继续开发");
    expect(text).toContain("作品墙");
  });

  it("新建与更新用不同的状态词（模型不可能把「新卡」当成「改到了原作品」）", () => {
    const created = publishReceipt({ app, created: true, total: 1 });
    expect(created).toContain("已发布新作品");
    expect(created).toContain("新增一张作品卡片");
    expect(created).not.toContain("已更新作品");
    expect(publishReceipt({ app, created: false, total: 1 })).toContain("已更新作品");
  });

  it("根目录入口有可读文案；封面与服务说明各占一行", () => {
    const text = publishReceipt({
      app: { ...app, kind: "server", entry: "." },
      created: true,
      total: 1,
      coverNote: "封面：占位封面（没拿到真实画面；把服务跑起来或给一张 cover 后重新发布可更新）。",
      serviceNote: "本地服务：未配置（面板直接打开，由面板页自己连数据源；平台不启动任何进程）。"
    });
    expect(text).toContain("最终入口：（工作区根目录）");
    expect(text).toContain("占位封面");
    expect(text).toContain("本地服务：未配置");
  });

  it("panel 回执带服务托管状态（平台托管 / 未配）——只陈述配置，不断言已启动", () => {
    const managed = publishReceipt({
      app: { ...app, kind: "panel", entry: "panels/status/index.html" },
      created: false,
      total: 2,
      serviceNote: "本地服务：已配置（command + url）——运行时探活：地址已可达就复用外部服务（平台不接管也不停它），否则由平台在后台启动，关窗时只停平台实际启动的那个进程。"
    });
    expect(managed).toContain("复用外部服务");
    expect(managed).toContain("只停平台实际启动的那个进程");
    expect(managed).not.toContain("已启动");
  });

  it("publishHeadline 与回执同一组状态词（实体 toast 不再一律说「已发布」）", () => {
    expect(publishHeadline({ title: "收纳整理原型" }, true)).toBe("已发布新作品「收纳整理原型」");
    expect(publishHeadline({ title: "收纳整理原型" }, false)).toBe("已更新作品「收纳整理原型」");
  });
});

describe("buildGalleryTools 契约", () => {
  function context(created = false): GalleryToolContext & { drafts: string[] } {
    const drafts: string[] = [];
    return {
      drafts,
      publish: async (draft) => {
        // 真实现会做 path+entry 解析并落最终入口；test stub 同样拼成最终入口，
        // 好让回执断言真正验到「最终入口」而不是两段路径里的 entry。
        const entry = draft.entry ? `${draft.path}/${draft.entry}` : draft.path;
        drafts.push(`${draft.appId ?? ""}|${draft.kind}|${entry}`);
        return {
          app: { id: "g1", title: draft.title, kind: draft.kind, workspace: "D:/ws", entry, createdAt: 1, updatedAt: 1 },
          coverNote: "",
          created
        };
      },
      list: () => []
    };
  }

  it("工具描述把 panel 的数据接口与本地服务写清楚（模型据此写面板页）", async () => {
    const { buildGalleryTools } = await import("./runtime-gallery.js");
    const tools = buildGalleryTools(context());
    const description = String(tools[0]!.description ?? "");
    expect(description).toContain("panel");
    expect(description).toContain("__pidesktop_state.json");
    // 面板可带本地服务（2026-10-11）：描述与参数字段都要把这条规则告诉模型
    expect(description).toContain("本地服务");
    expect(description).toContain("探活");
    // 2026-11-16：成对规则与「启动器命令不行」都必须写明（它们是失败率最高的两处配置错误）
    expect(description).toContain("必须成对");
    expect(description).toContain("pythonw");
    expect(description).toContain("长期运行");
    // path / entry 解析规则与 appId 更新路径（压缩版：各一句，细节在参数字段与 skill）
    expect(description).toContain("entry 指明目录内的页面");
    expect(description).toContain("带上 appId");
    expect(description).toContain("必须同工作区、同类型");
    const parameters = JSON.stringify(tools[0]!.parameters ?? {});
    expect(parameters).toContain("kind=panel：本地服务启动命令——须与 url 成对");
    expect(parameters).toContain("kind=panel：探活地址——须与 command 成对");
    expect(parameters).toContain("appId");
    expect(parameters).toContain("kind=server 禁止传");
    // 每个作品都要有封面：参数与描述都要把自动策略与 cover 告诉模型（2026-10-28）
    expect(parameters).toContain("封面图片的工作区相对路径");
    expect(description).toContain("每个作品都要有封面");
    expect(description).toContain("占位封面");
  });

  it("工具回执带更新/新建与作品 ID，且 appId 原样交给发布实现", async () => {
    const { buildGalleryTools } = await import("./runtime-gallery.js");
    const ctx = context(false);
    const tools = buildGalleryTools(ctx);
    const result = await tools[0]!.execute("t1", {
      appId: "g1",
      title: "状态面板",
      kind: "panel",
      path: "panels/status",
      entry: "index.html"
    } as never, undefined, undefined, undefined as never);
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    expect(text).toContain("已更新作品「状态面板」（面板）");
    expect(text).toContain("作品 ID：g1");
    expect(text).toContain("最终入口：panels/status/index.html");
    expect(ctx.drafts).toEqual(["g1|panel|panels/status/index.html"]);
    // details 供 UI/日志用（含新建标记）
    expect(result.details).toMatchObject({ id: "g1", kind: "panel", created: false, entry: "panels/status/index.html" });
  });

  it("只暴露一个 gallery_publish，且工具名符合 OpenAI 兼容的下划线命名", async () => {
    const { buildGalleryTools } = await import("./runtime-gallery.js");
    const tools = buildGalleryTools(context());
    expect(tools.map((tool) => tool.name)).toEqual(["gallery_publish"]);
    // 点号会被 DeepSeek 之类的 OpenAI 兼容服务拒绝（tools[].function.name 只允许 ^[a-zA-Z0-9_-]+$）
    for (const tool of tools) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/u);
  });
});
