import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Jev 通路接入的源码回归网。
 *
 * 为什么用源码断言而不是跑运行时：`pi-runtime.ts` 是 utility 进程入口（顶层依赖
 * `process.parentPort`），单测里无法 import；而下面两件事一旦写错，表现都是
 * **静默**的——没有报错、没有任何测试会红：
 *
 * 1. `toolNamesFor` 若不按总闸判断，`browser_jev_run` 会在开关关闭时照样进入
 *    每次请求的前缀（内网用户白付一份描述成本）；
 * 2. `recordCustomTools` / `buildRecordTools` 若不展开 `jevTools`，
 *    开关打开后模型根本看不到这个工具（注册 ≠ 激活，注册是激活的前提）。
 *
 * 同类先例：`gallery-activation.test.ts`（同款理由与写法）。
 */

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pi-runtime.ts"), "utf8");

function functionBody(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `找不到 ${signature}（重命名了？此测试需要同步更新）`).toBeGreaterThan(-1);
  const bodyStart = source.indexOf("{", start + signature.length);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error(`${signature} 的函数体没闭合`);
}

describe("Jev 工具的激活与注册（源码回归网）", () => {
  it("browser_jev_run 只在 settings.jev.enabled === true 时进入活动集", () => {
    const body = functionBody("function toolNamesFor(");
    // 条件形状可能是单行三元或跨行三元，所以跨空白匹配：守卫 + 真分支 + 空回退三件套
    // 缺一都意味着「开关关了照样付前缀成本」或「开了永远拿不到工具」。
    expect(body).toMatch(/record\.jevGlobalEnabled\(\)[\s\S]{0,40}\?[\s\S]{0,200}record\.jevTools\.map\(/u);
    expect(body).toMatch(/record\.jevTools\.map\(\(tool\) => tool\.name\)[\s\S]{0,40}:\s*\[\]/u);
  });

  it("缺省关闭的语义写在读取处（=== true 而不是 !== false）", () => {
    // 与 browser/ssh/computer 的「缺省启用」相反：漂移成 !== false 会让所有部署
    // 默认打开一个内网拿不到的能力。
    expect(source).toContain("jevGlobalEnabled: () => settings?.jev?.enabled === true");
  });

  it("注册集包含 jevTools（注册是激活的前提；漏了则开关打开也不可见）", () => {
    expect(functionBody("function buildRecordTools(")).toContain("...record.jevTools");
    expect(source).toContain("...galleryTools, ...jevTools]");
  });

  it("三项总闸翻转都会重算活动集（settings.save 与 jev.save 两条路径）", () => {
    // settings.save 路径
    expect(source).toContain("const jevSwitchChanged = (settings.jev?.enabled === true) !== (command.settings.jev?.enabled === true);");
    expect(source).toContain("if (designSwitchChanged || computerSwitchChanged || jevSwitchChanged) reconcileActiveTools(activeRuntime);");
    // jev.save 路径（设置页的「保存 Jev 设置」按钮走这条）
    expect(source).toContain("if (switchChanged) for (const record of liveSessions.values()) reconcileActiveTools(record);");
  });

  it("工具走既有 browser RPC，不新开一条主进程通道", () => {
    const start = source.indexOf("const jevTools = runtimeJev.buildJevTools({");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf("\n  });", start));
    expect(block).toContain('request: (op) => requestBrowserAutomation(recordSessionId, op)');
    // 密钥只从内存镜像读（credentials.json 经 initialize 下发），绝不进 settings。
    expect(block).toContain("apiKeys[JEV_CREDENTIAL_ID]");
  });
});

/**
 * 「测试连接」的接线纪律。
 *
 * 这一条有一个很容易写错的点：探测**必须不要求先启用 Jev**。若它复用了工具那套
 * `requireSettings`（`!jev?.enabled` 就抛），用户就会卡在「不启用不能测、不测不敢
 * 启用」的死循环里；而这件事在类型与运行时都不报错，只有用起来才会发现。
 */
describe("Jev 测试连接的接线（源码回归网）", () => {
  it("jev.test 分支不读 enabled、也不写任何配置", () => {
    const start = source.indexOf('case "jev.test"');
    expect(start, "pi-runtime.ts 缺少 jev.test 分支").toBeGreaterThan(-1);
    const rest = source.slice(start);
    const next = rest.search(/\n {4}case "/u);
    const body = next === -1 ? rest : rest.slice(0, next);
    // 不能走 requireSettings（它会因 enabled !== true 而抛）；也不能落盘配置。
    expect(body).not.toContain("requireSettings");
    expect(body).not.toMatch(/settings\.jev\s*=/u);
    expect(body).toContain("runtimeJev.probeJev");
  });

  it("探测用的密钥以命令草稿优先、其次已保存值（ak 镜像）", () => {
    const start = source.indexOf('case "jev.test"');
    const rest = source.slice(start);
    const next = rest.search(/\n {4}case "/u);
    const body = next === -1 ? rest : rest.slice(0, next);
    expect(body).toContain("command.apiKey?.trim() || apiKeys[JEV_CREDENTIAL_ID]?.trim()");
  });

  it("主进程补发已保存的密钥，且不落盘用户填的草稿密钥", () => {
    const indexSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
    const start = indexSource.indexOf('case "jev.test"');
    expect(start, "index.ts 缺少 jev.test 分支").toBeGreaterThan(-1);
    const rest = indexSource.slice(start);
    const next = rest.search(/\n {4}case "/u);
    const body = next === -1 ? rest : rest.slice(0, next);
    // 已保存的密钥在 main 侧手里（utility 只拿镜像），草稿为空时要补进去。
    expect(body).toContain("credentialsCache[JEV_CREDENTIAL_ID]");
    // 测试连接绝不写凭据：用户可能只是试一下。
    expect(body).not.toContain("saveCredential");
  });

  it("渲染端设置页有测试连接入口，且不因「未启用」而禁用", () => {
    // 入口在通用页组件里（2026-09-23 从 App.tsx 抽出为 GeneralSettings.tsx）；
    // App.tsx 仍须引用该组件（防两处都删）。
    const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../renderer/src/App.tsx"), "utf8");
    expect(app).toContain('from "./GeneralSettings"');
    const settingsPage = app + readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../renderer/src/GeneralSettings.tsx"), "utf8");
    expect(settingsPage).toContain('data-control="jev-test"');
    expect(settingsPage).toContain('type: "jev.test"');
    // 禁用条件只能与「正在测试」有关；不能带上 jevEnabled / jevKeyConfigured，
    // 否则又回到「不启用/没存密钥就不能测」。
    const button = settingsPage.slice(settingsPage.indexOf('data-control="jev-test"'));
    const end = button.indexOf("</button>");
    const tag = button.slice(0, end);
    expect(tag).not.toContain("jevEnabled");
    expect(tag).not.toContain("jevKeyConfigured");
  });
});
