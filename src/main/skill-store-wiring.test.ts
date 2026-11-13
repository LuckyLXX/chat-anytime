import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Skill 商店的接线契约（源码级断言，同 theme-import-wiring / gallery-run-wiring 的形态）。
 *
 * 为什么必须是源码断言：`skill-store-client.test.ts` 与 `skill-store-install.test.ts`
 * 全绿也证明不了**宿主真的把它们接上了**——把 pi-runtime 里的 case 删掉、把命令队列
 * 改成 await、或者装完忘了 invalidate，纯逻辑测试全都不会红，而用户看到的是
 * 「点了安装没反应」或「装完技能清单还是旧的」。
 *
 * 源码行尾在本地工作区（LF）与 CI 检出（CRLF）之间不一致：读入即归一化。
 */
const read = (relative: string): string => readFileSync(join(__dirname, relative), "utf8").replace(/\r\n/gu, "\n");

const protocol = read("../shared/protocol.ts");
const sharedStore = read("../shared/skill-store.ts");
const runtime = read("pi-runtime.ts");
const client = read("skill-store-client.ts");
const install = read("skill-store-install.ts");
const store = read("../renderer/src/store.ts");
const app = read("../renderer/src/App.tsx");
const component = read("../renderer/src/SkillStoreSettings.tsx");
/** 浏览/详情/安装 UI 已抽到共用组件（公开商店与内网商店共用，避免两份实现漂移）。 */
const browser = read("../renderer/src/components/SkillStoreBrowser.tsx");
const demoApi = read("../renderer/src/demo-api.ts");
const styles = read("../renderer/src/styles.css");

describe("协议层", () => {
  it("六个命令 + 结果推送都在 shared 协议里", () => {
    for (const type of ["skill-store.list", "skill-store.top", "skill-store.categories", "skill-store.detail", "skill-store.install", "skill-store.uninstall"]) {
      expect(protocol).toContain(`type: "${type}"`);
    }
    expect(protocol).toContain('{ type: "skill-store-result"; result: SkillStoreResult }');
    expect(sharedStore).toContain("export type SkillStoreResult =");
    expect(sharedStore).toContain('export const SKILL_STORE_BASE_URL = "https://api.skillhub.cn"');
  });

  it("结果按 kind 带 requestId（并发不串台的前提）", () => {
    expect(sharedStore).toContain("requestId: string");
    expect(sharedStore).toContain("installs: SkillStoreInstallSummary[]");
  });
});

describe("utility 接线（pi-runtime）", () => {
  it("六个命令落到 runSkillStoreCommand，且是 fire-and-forget（不 await 到命令队列）", () => {
    for (const type of ["skill-store.list", "skill-store.top", "skill-store.categories", "skill-store.detail", "skill-store.install", "skill-store.uninstall"]) {
      expect(runtime).toContain(`case "${type}":`);
    }
    expect(runtime).toContain("runSkillStoreCommand(command);");
    // 关键：不能写成 await runSkillStoreCommand(...)（安装要逐文件下载，会占死串行队列）
    expect(runtime).not.toContain("await runSkillStoreCommand");
  });

  it("安装后走完整刷新链：invalidate → syncSkills → emitResourceCatalog → 空闲重建会话", () => {
    expect(runtime).toContain("workspaceResources.invalidate();");
    expect(runtime).toContain("workspaceResources.invalidate(workspace);");
    expect(runtime).toContain("syncSkills(workspace);");
    expect(runtime).toContain("async function refreshSkillsAfterStoreChange(");
    expect(runtime).toContain("const sessionRefreshDeferred = !(await refreshSkillsAfterStoreChange(");
    // 忙碌不打断（与 refreshActiveSessionForSubagents 同款纪律）
    expect(runtime).toContain("async function refreshActiveSessionForSkills()");
    // 「忙」的唯一口径是 runActive（record.busy || session.isStreaming，2026-11-13）
    expect(runtime).toContain("if (runActive(record)) {");
    // 严禁复用 reloadRuntimeResources 的忙碌拒绝路径
    expect(runtime).not.toContain("Skill 商店" + "runResourceOperation");
  });

  it("账本快照随列表/详情/安装/卸载结果下发", () => {
    expect(runtime).toContain("function skillStoreInstalls()");
    expect(runtime).toContain("listInstallRecords(getAgentDir())");
    expect((runtime.match(/installs: skillStoreInstalls\(\)/gu) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("查询有短 TTL 缓存与在途合并，安装不缓存", () => {
    expect(runtime).toContain("SKILL_STORE_CACHE_TTL_MS = 30_000");
    expect(runtime).toContain("skillStoreInFlight");
    expect(runtime).toContain("cacheKey(`list:");
    expect(runtime).not.toContain('withSkillStoreCache("install');
  });
});

describe("纯逻辑层口径", () => {
  it("客户端只依赖 /files 清单里的 sha256（不读重定向后的响应头）", () => {
    expect(client).toContain("/api/v1/skills/");
    expect(client).toContain("/files");
    expect(client).toContain("/file?");
    expect(client).not.toContain("X-Content-SHA256");
    expect(client).toContain('import { SKILL_STORE_BASE_URL } from "../shared/skill-store.js"');
  });

  it("安装层守住 1MB / 32MB / 200 文件 / SKILL.md 四个硬界", () => {
    expect(install).toContain("export const SKILL_FILE_MAX_BYTES = 1024 * 1024");
    expect(install).toContain("export const SKILL_TOTAL_MAX_BYTES = 32 * 1024 * 1024");
    expect(install).toContain("export const SKILL_FILE_COUNT_MAX = 200");
    expect(install).toContain("export const SKILL_DOWNLOAD_CONCURRENCY = 4");
    expect(install).toContain('"missing-skill-md"');
    expect(install).toContain("文件清单缺少 SKILL.md");
  });

  it("卸载只删账本记录在案的目录（不误删手工放置的同名 skill）", () => {
    expect(install).toContain("if (!record) {");
    expect(install).toContain("没有找到");
    expect(install).toContain("realpathSync(installDir)");
  });

  it("元数据落在 agentDir、原子写", () => {
    expect(install).toContain("pideskill-store-metadata.json");
    expect(install).toContain("renameSync(tempPath, path)");
  });
});

describe("渲染端接线", () => {
  it("store 有 skillStore 状态机与 requestId 认领", () => {
    expect(store).toContain("skillStore: SkillStoreState");
    expect(store).toContain("export function applySkillStoreResult");
    expect(store).toContain('case "skill-store-result":');
    expect(store).toContain("if (result.requestId !== state.listRequestId) return {};");
    expect(store).toContain("if (result.requestId !== state.detailRequestId) return {};");
  });

  it("App.tsx 四处注册齐全（联合类型 / nav / 内容分支 / 命令面板）", () => {
    expect(app).toContain('type SettingsTab = "general" | "models" | "agents" | "subagents" | "appearance" | "resources" | "skill-store" | "intranet-store" | "im" | "hooks" | "usage" | "automation"');
    expect(app).toContain('onClick={() => setTab("skill-store")}>Skill 商店</button>');
    expect(app).toContain('tab === "skill-store" ? <SkillStoreSettings />');
    expect(app).toContain('{ tab: "skill-store", label: "Skill 商店" }');
  });

  it("共享组件发命令带 requestId + source，安装前必须二次确认", () => {
    expect(browser).toContain('type: "skill-store.list", requestId, source, query');
    expect(browser).toContain('type: "skill-store.detail", requestId, source, slug: skill.slug');
    expect(browser).toContain('type: "skill-store.install", requestId, source, slug: skill.slug, scope');
    expect(browser).toContain('type: "skill-store.uninstall", requestId, source, slug: detailInstall.slug');
    expect(browser).toContain('data-control="skill-store-confirm-install"');
    expect(browser).toContain("crypto.randomUUID()");
    // 公开 tab 必须显式声明来源（结果按 source 路由到 skillStore 切片）
    expect(component).toContain('source="public"');
  });

  it("演示环境如实降级、不伪造安装成功", () => {
    expect(demoApi).toContain('case "skill-store.install":');
    expect(demoApi).toContain("演示环境不支持 Skill 商店");
    expect(demoApi).not.toContain("ok: true, outcome:");
  });

  it("主题钩子：pane + 12 个 control 与样式类名一致", () => {
    expect(component).toContain('data-pane="skill-store"');
    expect(component).toContain('data-control="skill-store-refresh"');
    expect(component).toContain('data-control="skill-store-scope"');
    for (const control of ["skill-store-search", "skill-store-category", "skill-store-sort", "skill-store-top", "skill-store-page", "skill-store-open", "skill-store-install", "skill-store-confirm-install", "skill-store-uninstall", "skill-store-close-detail"]) {
      expect(browser).toContain(`data-control="${control}"`);
    }
    expect(styles).toContain(".skill-store-grid");
    expect(styles).toContain(".skill-store-detail");
  });

  it("搜索框是 label，但浏览条的分组规则必须排除它（否则图标与输入框被 grid 拆成两行）", () => {
    // 2026-11-04 用户截图：放大镜在上一行、placeholder 在下一行、框被撑高。
    // 根因是 `.skill-store-browse label { display: grid }`(0,1,1) 压过 `.skill-store-search`(0,1,0)。
    expect(browser).toContain('className="skill-store-search"');
    expect(styles).toContain(".skill-store-browse > label:not(.skill-store-search)");
    expect(styles).not.toContain(".skill-store-browse label {");
    // 搜索框自身与内部 input 走 (0,2,x)，不再被设置弹窗的 label/input 规则打回
    expect(styles).toContain(".skill-store-browse .skill-store-search {");
    expect(styles).toContain(".skill-store-browse .skill-store-search input {");
    expect(styles).toContain(".skill-store-browse .skill-store-search input { flex: 1 1 auto; width: auto;");
  });

  it("主题契约五处镜像都收进了 skill-store", () => {
    const mirrors = [
      "../../AGENTS.md",
      "../../docs/theme-guide.md",
      "../../resources/skills/pidesktop-theme-creator/SKILL.md",
      "../../resources/skills/pidesktop-theme-creator/references/variables.md",
      "../../resources/skills/pidesktop-theme-creator/scripts/check_theme.py"
    ];
    for (const mirror of mirrors) {
      const body = read(mirror);
      expect(body).toContain("skill-store");
    }
    // 计数也要跟着走（pane 39→40→41→42→43→44、control 104→116→124→129→138→142→146）
    const skillDoc = read("../../resources/skills/pidesktop-theme-creator/SKILL.md");
    expect(skillDoc).toContain("主要区域（44）");
    expect(skillDoc).toContain("关键控件（146）");
  });
});
