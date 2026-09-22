import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `settings.save` 的**三处镜像契约**回归网。
 *
 * 为什么必须有这个文件：`settings.save` 的载荷是 `Pick<DesktopSettings, …>`（protocol
 * 声明「必须传哪些字段」），而真正落盘的是三处独立代码——渲染端提交、主进程
 * `updateSettings` 镜像、utility `pi-runtime` 镜像。三者之间没有类型约束互相兜底
 * （渲染端可以少传、镜像可以漏写），且**故障全是静默的**：
 *
 * - 渲染端少传一个键 → 主进程拿到 `undefined`。若那一处的镜像写成
 *   `settings.x = normalizeX(command.settings.x)`，`undefined` 会被归一成 `undefined`
 *   → **该配置被一次无关的「保存通用设置」抹掉**（2026-09-21 Jev 就是这样丢的：
 *   `credentials.json` 里密钥还在，`settings.json` 里 `jev` 字段没了）。
 * - 镜像漏写一个键 → 「保存后重启即丢」（ssh 在 2026-09 中过一次）。
 *
 * 两个既有先例都在同一个坑里摔过，所以这里把三处一次性钉住：Pick 的每个键都必须
 * 出现在渲染端载荷里、也必须出现在两个镜像里。新增设置字段时这个测试会红，而不是
 * 等用户发现配置莫名消失。
 *
 * 用源码断言而不是运行时：`pi-runtime.ts` 是 utility 进程入口（顶层依赖
 * `process.parentPort`），单测里无法 import；`index.ts` 同理依赖 Electron。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(join(here, relative), "utf8");

const protocolSource = read("../shared/protocol.ts");
const indexSource = read("index.ts");
const runtimeSource = read("pi-runtime.ts");
const appSource = read("../renderer/src/App.tsx");
/** 「保存通用设置」的提交逻辑在通用页组件里（2026-09-23 从 App.tsx 抽出）。 */
const generalSettingsSource = read("../renderer/src/GeneralSettings.tsx");

/** 取出 `settings.save` 命令的 `Pick<DesktopSettings, …>` 键集合。 */
function pickKeys(): string[] {
  const match = protocolSource.match(/type: "settings\.save"; settings: Pick<DesktopSettings,([^>]+)>/u);
  expect(match, "找不到 settings.save 的 Pick 声明（重命名了？此测试需要同步更新）").not.toBeNull();
  return [...match![1]!.matchAll(/"([A-Za-z0-9_]+)"/gu)].map((entry) => entry[1]!);
}

/**
 * 取出设置页「保存通用设置」的载荷键集合。
 * 载荷长这样：`{ type: "settings.save", settings: { model: nextSettings.model, … } }`。
 * 提交逻辑在通用页组件 GeneralSettings.tsx（从 App.tsx 抽出后渲染端源 = 两者拼接）。
 */
function rendererPayloadKeys(): string[] {
  const source = appSource + generalSettingsSource;
  const marker = source.indexOf('type: "settings.save"');
  expect(marker, "渲染端没有提交 settings.save（此测试需要同步更新）").toBeGreaterThan(-1);
  const open = source.indexOf("settings: {", marker);
  expect(open, "找不到渲染端 settings.save 的载荷对象字面量").toBeGreaterThan(-1);
  const body = source.slice(open, source.indexOf("}", open));
  return [...body.matchAll(/(?:^|[{,\s])([A-Za-z0-9_]+)\s*:/gu)].map((entry) => entry[1]!);
}

/**
 * 取出某一层镜像**真正赋值**的键：`settings.<key> = …`。
 *
 * 不能用 `command.settings.<key>` 来判「这一层处理了这个字段」——分支里还有读同一个
 * 字段做比较的代码（例如 `command.settings.jev?.enabled` 判断总闸是否翻转），
 * 按读法匹配会让「赋值那行被删掉」依旧满分（已在反向验证里实测：删掉
 * `settings.jev = …` 一行，旧写法仍全绿）。判据必须是**写**，不是读。
 *
 * 分支边界按缩进切（下一个顶格 `case "`），不按 `break;`——`pi-runtime.ts` 的
 * 分支开头就有一句 `if (!settings) break;` 守卫，按 break 切会得到一个空块，
 * 于是这个测试会假装通过（自己骗自己比不写还糟）。
 */
function mirrorKeys(source: string, label: string): string[] {
  const start = source.indexOf('case "settings.save"');
  expect(start, `${label} 找不到 settings.save 分支`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\n {4}case "/u);
  const body = next === -1 ? rest : rest.slice(0, next);
  return [...new Set([...body.matchAll(/\bsettings\.([A-Za-z0-9_]+)\s*=/gu)].map((entry) => entry[1]!))];
}

describe("settings.save 的三处镜像契约", () => {
  const keys = pickKeys();

  it("Pick 声明的字段数量非零（守卫测试本身的解析）", () => {
    expect(keys.length).toBeGreaterThan(5);
    // jev 是 2026-09-21 的受害者；它必须在这个集合里，否则下面的断言没有意义。
    expect(keys).toContain("jev");
  });

  it("渲染端「保存通用设置」必须传齐 Pick 里的每一个键", () => {
    // 少传一个键 = 主进程按 undefined 覆盖那一项配置。jev 就是这么被抹掉的：
    // 密钥留在 credentials.json，配置从 settings.json 消失，且没有任何提示。
    const payload = rendererPayloadKeys();
    const missing = keys.filter((key) => !payload.includes(key));
    expect(missing, `渲染端 settings.save 载荷缺少：${missing.join(", ")}`).toEqual([]);
  });

  it("主进程 updateSettings 必须镜像 Pick 里的每一个键", () => {
    const mirrored = mirrorKeys(indexSource, "index.ts");
    const missing = keys.filter((key) => !mirrored.includes(key));
    expect(missing, `index.ts 的 settings.save 分支没有镜像：${missing.join(", ")}`).toEqual([]);
  });

  it("utility 侧 pi-runtime 必须镜像 Pick 里的每一个键", () => {
    // 漏一个键的表现是「保存后本次进程生效、重启即回退」——镜像只在内存里。
    const mirrored = mirrorKeys(runtimeSource, "pi-runtime.ts");
    const missing = keys.filter((key) => !mirrored.includes(key));
    expect(missing, `pi-runtime.ts 的 settings.save 分支没有镜像：${missing.join(", ")}`).toEqual([]);
  });

  it("镜像里出现 Pick 之外的键时也报出来（说明 Pick 该补，而不是被静默忽略）", () => {
    // 反向守卫：镜像多写了一个 Pick 里没有的键，意味着那个字段的更新路径不完整
    // （类型上不合法但运行时照跑），要么补进 Pick，要么删掉这行。
    for (const [source, label] of [[indexSource, "index.ts"], [runtimeSource, "pi-runtime.ts"]] as const) {
      const extra = mirrorKeys(source, label).filter((key) => !keys.includes(key));
      expect(extra, `${label} 镜像了 Pick 之外的键：${extra.join(", ")}`).toEqual([]);
    }
  });
});
