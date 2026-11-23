import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeCodexCliSettings } from "../shared/codex.js";
import { defaultSettings, migrateSettings } from "./settings.js";
import { diffSettings } from "./settings-store.js";
import { normalizeCodexCliConfig } from "./runtime-codex.js";

/**
 * D 阶段（设置页 / 保存 / 连接测试 / 看板标识）的接线契约。
 *
 * 这份配置走的是**独立命令**（`codex.settings.save` / `codex.connection.test`），所以
 * `settings-save-contract.test.ts` 的三处镜像网盯不住它，必须单独钉：
 *
 * - `migrateSettings` 是唯一读入口：漏读 → 下一次任意设置写入把它从磁盘抹掉；
 * - 主进程 `updateSettings` 的分支漏写 → 保存即丢（重启回默认）；
 * - utility 侧漏写内存镜像 → 本次进程有效、重启回退；
 * - 渲染端必须 import shared 的类型，**不能** import main 的 runtime-codex（那份带 Node 依赖）；
 * - 看板靠 `member.backend` 标来源，store 的等值比较漏了它 → 来源标识停在旧值。
 *
 * `pi-runtime.ts` / `index.ts` 依赖 Electron，单测无法 import，所以这两处用源码断言。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8").replace(/\r\n?/g, "\n");

const protocolSource = read("../shared/protocol.ts");
const sharedCodexSource = read("../shared/codex.ts");
const indexSource = read("index.ts");
const runtimeSource = read("pi-runtime.ts");
const settingsSource = read("settings.ts");
const subagentSettingsSource = read("../renderer/src/SubagentSettings.tsx");
const demoApiSource = read("../renderer/src/demo-api.ts");
const storeSource = read("../renderer/src/store.ts");
const boardPartsSource = read("../renderer/src/components/TeamBoardParts.tsx");

/** 取某个 `case "x": {` 分支的源码（按缩进切到下一个 `case "`）。 */
function caseBody(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `找不到分支 ${marker}`).toBeGreaterThan(-1);
  const rest = source.slice(start + marker.length);
  const next = rest.search(/\n {4}case "/u);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("codex settings: 配置在四处之间往返", () => {
  it("settings.ts 的 migrateSettings 读回 codex（漏读 = 下次任意写入就删掉它）", () => {
    const saved = { enabled: true, access: "workspace-write", executable: "C:\\tools\\codex.exe" } as const;
    const migrated = migrateSettings({ codex: saved }).settings;
    expect(migrated.codex).toEqual(saved);
    // 坏值不阻断启动，只退回「没有这份配置」。
    expect(migrateSettings({ codex: "yes" }).settings.codex).toBeUndefined();
    expect(migrateSettings({}).settings.codex).toBeUndefined();
    // 幂等：把迁移结果再迁一次不能丢（persistSettings 写回的就是这份内存副本）。
    expect(migrateSettings(migrated).settings.codex).toEqual(saved);
  });

  it("默认设置显式列出 codex 键（settings-store 的脏字段夹具契约）", () => {
    expect(Object.keys(defaultSettings())).toContain("codex");
    expect(defaultSettings().codex).toBeUndefined();
  });

  it("只改 codex 的写入必须被判成脏（否则保存后重启即丢）", () => {
    const previous = defaultSettings();
    const next = { ...previous, codex: { enabled: true, access: "read-only" } as const };
    expect(diffSettings(previous, next)).toEqual({ small: true, assets: false });
  });

  it("归一化只有一份实现：runtime-codex 的 normalizeCodexCliConfig 转调 shared", () => {
    const samples: unknown[] = [undefined, null, "x", [], {}, { enabled: true }, { enabled: "yes", access: "danger-full-access" }, { enabled: true, access: "workspace-write", executable: " /usr/local/bin/codex " }];
    for (const sample of samples) expect(normalizeCodexCliConfig(sample)).toEqual(normalizeCodexCliSettings(sample));
    expect(settingsSource).toMatch(/import \{ normalizeCodexCliSettings \} from "\.\.\/shared\/codex\.js";/u);
    expect(settingsSource).toMatch(/codex: normalizeCodexCliSettings\(source\.codex\),/u);
  });

  it("shared/codex.ts 不带 Node/Electron 依赖（渲染端可以直接 import）", () => {
    expect(sharedCodexSource).not.toMatch(/from "node:|from "electron|require\(/u);
    expect(subagentSettingsSource).toMatch(/from "\.\.\/\.\.\/shared\/codex"/u);
    expect(subagentSettingsSource).not.toMatch(/from "\.\.\/\.\.\/\.\.\/main\//u);
  });
});

describe("codex settings: 独立命令与回执", () => {
  it("protocol 声明独立命令、草稿测试与带 requestId 的回执", () => {
    expect(protocolSource).toMatch(/\| \{ type: "codex\.settings\.save"; codex: CodexCliSettings \}/u);
    expect(protocolSource).toMatch(/\| \{ type: "codex\.connection\.test"; requestId: string; codex\?: CodexCliSettings \}/u);
    expect(protocolSource).toMatch(/\| \(\{ type: "codex-test-result"; requestId: string \} & CodexConnectionTestResult\)/u);
    expect(protocolSource).toMatch(/codex\?: CodexCliSettings;/u);
    // 不进 settings.save 的 Pick：日常保存其它设置不能碰这份配置。
    const pick = protocolSource.match(/type: "settings\.save"; settings: Pick<DesktopSettings,([^>]+)>/u)?.[1] ?? "";
    expect(pick).not.toMatch(/codex/u);
  });

  it("主进程 updateSettings 落盘（归一化后）且镜像在独立分支里", () => {
    const body = caseBody(indexSource, 'case "codex.settings.save":');
    expect(body).toMatch(/settings\.codex = normalizeCodexCliSettings\(command\.codex\);/u);
    // 不能在 settings.save 的镜像分支里顺手写 codex（会被一次无关保存抹掉）。
    expect(caseBody(indexSource, 'case "settings.save":')).not.toMatch(/settings\.codex/u);
    // 落盘后必须回推权威 settings（渲染端关闭设置弹窗的回滚基线不能把刚存的 codex 冲掉）。
    expect(indexSource).toMatch(/command\.type === "settings\.save" \|\| command\.type === "codex\.settings\.save"/u);
  });

  it("utility 镜像配置，并复用 probeCodexConnection 做只握手测试", () => {
    const saveBody = caseBody(runtimeSource, 'case "codex.settings.save":');
    expect(saveBody).toMatch(/const next = normalizeCodexCliConfig\(command\.codex\);/u);
    expect(saveBody).toMatch(/if \(settings\) settings\.codex = next;/u);
    const testBody = caseBody(runtimeSource, 'case "codex.connection.test":');
    expect(testBody).toMatch(/await probeCodexConnection\(\{/u);
    expect(testBody).toMatch(/requestId: command\.requestId,/u);
    // 探测不写配置（测试命令是只读动作）。
    expect(testBody).not.toMatch(/settings\.codex\s*=/u);
    // 配置来自表单草稿，未保存也能测；缺失时回落已保存配置。
    expect(testBody).toMatch(/normalizeCodexCliConfig\(command\.codex\) \?\? readCodexCliConfig\(\)/u);
  });

  it("渲染端发两条命令，回执按 requestId 归位", () => {
    expect(subagentSettingsSource).toMatch(/type: "codex\.settings\.save", codex/u);
    expect(subagentSettingsSource).toMatch(/type: "codex\.connection\.test", requestId, codex/u);
    expect(subagentSettingsSource).toMatch(/data-codex-test/u);
    expect(subagentSettingsSource).toMatch(/data-codex-enable/u);
    expect(storeSource).toMatch(/case "codex-test-result": \{/u);
    expect(storeSource).toMatch(/get\(\)\.codexTestRequestId !== message\.requestId/u);
  });

  it("demo 环境如实拒绝真实探测（不假装成功）", () => {
    expect(demoApiSource).toMatch(/case "codex\.settings\.save":/u);
    expect(demoApiSource).toMatch(/case "codex\.connection\.test":/u);
    expect(demoApiSource).toMatch(/requestId: command\.requestId,/u);
    expect(demoApiSource).toMatch(/演示环境不会拉起真实的 Codex 进程/u);
  });
});

describe("codex 来源在看板上的标识", () => {
  it("成员快照比较带上 backend（漏了它就是「来源标识停在旧值」）", () => {
    expect(storeSource).toMatch(/&& left\.backend === right\.backend/u);
  });

  it("成员行与详情都渲染 Codex 来源标签", () => {
    expect(boardPartsSource.match(/member\.backend === "codex"/u)?.length).toBe(1);
    expect(boardPartsSource.match(/selected\.backend === "codex"/u)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(boardPartsSource).toMatch(/team-member-backend/u);
  });
});
