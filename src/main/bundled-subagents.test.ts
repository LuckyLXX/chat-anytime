import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readBundledSubagents } from "./subagents-store.js";
import { normalizeSubagent } from "./subagents-store.js";

/**
 * 内置子智能体资产契约。这些路径是发行契约：electron-builder 的 extraResources 把
 * `resources/subagents` 原样发成 `<安装目录>/subagents`，主进程（resolveBundledSubagentsDir）
 * 与运行时（readBundledSubagents）都按它定位。改名/搬家必须同步三处。
 *
 * 与 skills 的契约测试同款纪律：锁住「装包后必需存在的东西」，避免默认安装出现空清单。
 */
describe("bundled subagent assets (repo contract)", () => {
  const repoRoot = resolve(__dirname, "../..");
  const subagentsRoot = join(repoRoot, "resources", "subagents");
  const expected = ["code-reviewer", "explorer", "general-purpose"];

  it("ships exactly the three built-in definitions, one json file each", () => {
    expect(existsSync(subagentsRoot), "resources/subagents 缺失").toBe(true);
    const files = readdirSync(subagentsRoot).filter((name) => name.endsWith(".json")).sort();
    expect(files).toEqual(expected.map((id) => `${id}.json`).sort());
  });

  it("parses every built-in definition and forces the bundled scope", () => {
    const list = readBundledSubagents(subagentsRoot);
    expect(list.map((entry) => entry.id).sort()).toEqual([...expected].sort());
    for (const entry of list) {
      // 定义文件里不写 scope：由 readBundledSubagents 标定，避免资产声明与运行时判定不一致。
      expect(entry.scope).toBe("bundled");
      expect(entry.builtin).toBe(true);
      expect(entry.systemPrompt.length, `${entry.id} 的系统提示词过短`).toBeGreaterThan(200);
      expect(entry.description.length, `${entry.id} 缺少描述`).toBeGreaterThan(10);
    }
  });

  it("keeps the tool sets role-differentiated (审查/探索只读，通用可写)", () => {
    const byId = new Map(readBundledSubagents(subagentsRoot).map((entry) => [entry.id, entry]));
    for (const id of ["code-reviewer", "explorer"]) {
      const tools = byId.get(id)!.tools;
      expect(tools === "inherit" ? undefined : tools, `${id} 必须显式限权（只读）`).toBeTruthy();
      if (tools !== "inherit") {
        // 只读子智能体的价值就在于「查得到、改不了」；放开写权限会让审查者顺手改代码。
        expect(tools.edit, `${id} 不应有 edit`).toBe(false);
        expect(tools.write, `${id} 不应有 write`).toBe(false);
        expect(tools.read, `${id} 应有 read`).toBe(true);
      }
    }
    const general = byId.get("general-purpose")!.tools;
    expect(general === "inherit" ? undefined : general.edit).toBe(true);
  });

  it("declares no execution model by default (user picks it)", () => {
    // 内置定义不应绑定具体模型：不同用户配置的服务商完全不同，写死会让默认安装直接报
    // 「子代理模型不可用」。执行模型由用户在设置页选择（覆盖表持久化）。
    for (const entry of readBundledSubagents(subagentsRoot)) {
      expect(entry.model, `${entry.id} 不应内置模型`).toBeUndefined();
    }
  });

  it("normalizes to definitions the delegate path accepts as-is", () => {
    // 资产文件是手写的 JSON，必须经 normalizeSubagent 后仍然合法（缺 tools/scope 时
    // 会被补默认值，写错的键会被丢掉）——这条挡住「手改资产导致运行时报错」。
    for (const name of readdirSync(subagentsRoot).filter((item) => item.endsWith(".json"))) {
      const parsed = JSON.parse(readFileSync(join(subagentsRoot, name), "utf8")) as unknown;
      expect(() => normalizeSubagent(parsed)).not.toThrow();
      expect(normalizeSubagent(parsed).id).toBe(name.replace(/\.json$/u, ""));
    }
  });

  it("packages resources/subagents via extraResources", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      build: { extraResources: { from: string; to?: string }[] };
    };
    const entry = pkg.build.extraResources.find((item) => item.from === "resources/subagents");
    expect(entry, "extraResources 里缺 resources/subagents 条目").toBeTruthy();
    // to 决定打包后的目录名，resolveBundledSubagentsDir 的 packaged 分支按 "subagents" 解析。
    expect(entry!.to).toBe("subagents");
  });
});
