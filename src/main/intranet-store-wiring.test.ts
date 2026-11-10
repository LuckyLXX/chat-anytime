import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 内网 Skill 商店（LanSkills）的接线契约（源码级断言）。
 *
 * 纯逻辑测试证明不了宿主真的接上了：漏掉 `source` 判别就会把内网请求打到公开商店；
 * 漏掉主进程注入 `baseUrl`，utility 读不到 settings（它没有 Electron API），页面会永远报错；
 * 漏掉 `applySkillStoreMessage` 的 source 路由，结果落进公开切片，内网页停在加载中。
 * 这些失败全是静默的，所以在这里钉住。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

const protocol = read("../shared/protocol.ts");
const sharedStore = read("../shared/skill-store.ts");
const mainIndex = read("index.ts");
const settings = read("settings.ts");
const runtime = read("pi-runtime.ts");
const client = read("skill-store-intranet-client.ts");
const store = read("../renderer/src/store.ts");
const app = read("../renderer/src/App.tsx");
const component = read("../renderer/src/IntranetSkillStoreSettings.tsx");
const demoApi = read("../renderer/src/demo-api.ts");
const styles = read("../renderer/src/styles.css");

describe("协议层", () => {
  it("source 判别 + 三个内网命令都在 shared 协议里", () => {
    expect(protocol).toContain("intranetStore?: SkillStoreIntranetSettings");
    expect(protocol).toContain('type: "skill-store.source.save"');
    expect(protocol).toContain('type: "skill-store.source.clear"');
    expect(protocol).toContain('type: "skill-store.source.test"');
    for (const type of ["skill-store.list", "skill-store.top", "skill-store.categories", "skill-store.detail", "skill-store.install", "skill-store.uninstall"]) {
      expect(protocol).toContain(`type: "${type}"; requestId: string; source: SkillStoreSource`);
    }
    expect(sharedStore).toContain('export type SkillStoreSource = "public" | "intranet"');
    expect(sharedStore).toContain("kind: \"source-test\"");
    expect(sharedStore).toContain("sourceId: SkillStoreSource");
  });
});

describe("主进程（settings + 注入）", () => {
  it("地址配置落 settings、normalizeIntranetStore 是唯一读入口", () => {
    expect(settings).toContain("export function normalizeIntranetStore(");
    expect(settings).toContain("intranetStore: normalizeIntranetStore(source.intranetStore)");
  });

  it("source.save/clear 由主进程处理并回推结果；浏览命令转发前注入 baseUrl", () => {
    expect(mainIndex).toContain("function handleIntranetStoreCommand(");
    expect(mainIndex).toContain("function enrichSkillStoreCommand(");
    expect(mainIndex).toContain("if (handleIntranetStoreCommand(command)) return;");
    expect(mainIndex).toContain("sendToRuntime(enrichSkillStoreCommand(command));");
    expect(mainIndex).toContain('case "skill-store.source.test":');
    expect(mainIndex).toContain("baseUrl: loadSettings().intranetStore?.baseUrl");
    expect(mainIndex).toContain('type: "skill-store-result"');
    // 配置命令绝不能转发给 utility（它没有这个分支）
    expect(mainIndex).not.toContain("sendToRuntime(command); // source");
  });
});

describe("utility 接线（pi-runtime）", () => {
  it("内网分支使用独立 client，命令按 source 分流并共享冷却缓存", () => {
    expect(runtime).toContain('import * as intranetSkillStoreClient from "./skill-store-intranet-client.js";');
    expect(runtime).toContain("intranetSkillStoreClient.intranetList(requireBase()");
    expect(runtime).toContain("intranetSkillStoreClient.intranetCategories(requireBase())");
    expect(runtime).toContain("intranetSkillStoreClient.intranetDetail(requireBase()");
    expect(runtime).toContain("intranetSkillStoreClient.intranetFiles(requireBase()");
    expect(runtime).toContain("intranetSkillStoreClient.intranetFileBytes(baseUrl");
    expect(runtime).toContain("cacheKey = (key: string): string => `${source}:${key}`");
    expect(runtime).toContain('case "skill-store.source.test":');
  });

  it("安装/卸载把来源写进账本，结果带 source", () => {
    expect(runtime).toContain("sourceId: source,");
    expect(runtime).toContain("sourceUrl: baseUrl");
    expect(runtime).toContain("sourceId: record.sourceId ?? \"public\"");
    expect(runtime).toContain("sourceId: source,");
    expect(runtime).toContain("result: { kind: \"install\", source, requestId");
  });
});

describe("内网 client", () => {
  it("归一化到公共类型、路径前缀与错误映射", () => {
    expect(client).toContain('export function normalizeIntranetBaseUrl(');
    expect(client).toContain('export function buildIntranetUrl(');
    expect(client).toContain('from "../shared/skill-store.js"');
    expect(client).toContain("内网商店请求超时");
    expect(client).toContain("不是合法 JSON");
    expect(client).toContain("/api/v1/ping");
    expect(client).toContain("/api/v1/skills/");
    expect(client).toContain("/files");
    expect(client).toContain("/file");
  });
});

describe("渲染端接线", () => {
  it("store 有 intranetStore 切片与按 source 路由", () => {
    expect(store).toContain("intranetStore: SkillStoreState");
    expect(store).toContain("intranetSource: IntranetStoreConnectionState");
    expect(store).toContain("export function applySkillStoreMessage(");
    expect(store).toContain('result.source === "intranet"');
    expect(store).toContain('case "skill-store-result":');
    expect(store).toContain("applySkillStoreMessage(state, message.result)");
  });

  it("App.tsx 四处注册齐全", () => {
    expect(app).toContain('"skill-store" | "intranet-store"');
    expect(app).toContain('onClick={() => setTab("intranet-store")}>内网 Skill 商店</button>');
    expect(app).toContain('tab === "intranet-store" ? <IntranetSkillStoreSettings />');
    expect(app).toContain('{ tab: "intranet-store", label: "内网 Skill 商店" }');
    expect(app).toContain('import { IntranetSkillStoreSettings } from "./IntranetSkillStoreSettings";');
  });

  it("组件命令带 source、复用共享浏览器、地址配置有契约钩子", () => {
    expect(component).toContain('data-pane="intranet-skill-store"');
    expect(component).toContain('source="intranet"');
    expect(component).toContain("showTop={false}");
    for (const control of ["intranet-store-url", "intranet-store-save", "intranet-store-test", "intranet-store-change", "intranet-store-refresh"]) {
      expect(component).toContain(`data-control="${control}"`);
    }
    expect(component).toContain('type: "skill-store.source.save"');
    expect(component).toContain('type: "skill-store.source.clear"');
    expect(component).toContain('type: "skill-store.source.test"');
  });

  it("演示环境如实降级", () => {
    expect(demoApi).toContain('case "skill-store.source.test":');
    expect(demoApi).toContain("演示环境不支持内网 Skill 商店");
    expect(demoApi).toContain("演示环境不会发起真实的内网商店请求");
  });

  it("样式块与主题契约五处镜像同步（pane 42 / control 129）", () => {
    expect(styles).toContain(".intranet-store-form");
    expect(styles).toContain(".intranet-store-help");

    const mirrors = [
      "../../AGENTS.md",
      "../../docs/theme-guide.md",
      "../../resources/skills/pidesktop-theme-creator/SKILL.md",
      "../../resources/skills/pidesktop-theme-creator/references/variables.md",
      "../../resources/skills/pidesktop-theme-creator/scripts/check_theme.py"
    ];
    for (const mirror of mirrors) {
      expect(read(mirror)).toContain("intranet-skill-store");
    }
    const skillDoc = read("../../resources/skills/pidesktop-theme-creator/SKILL.md");
    expect(skillDoc).toContain("主要区域（42）");
    expect(skillDoc).toContain("关键控件（129）");
    const checkTheme = read("../../resources/skills/pidesktop-theme-creator/scripts/check_theme.py");
    expect(checkTheme).toContain('"intranet-store-url"');
  });
});
