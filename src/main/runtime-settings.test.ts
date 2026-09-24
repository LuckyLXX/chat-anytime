import { readFile, readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { withCacheWarmingOff } from "./runtime-settings.js";

// Pi 0.86.0 起 cacheWarming 缺省 "streaming"（长工具运行期间发真实请求保温缓存，
// 花真实 token）。PiDesktop 无人值守的自动化任务不该背这份隐性开销，且从未提供
// 保温配置 UI——升级到 0.87.x 时把应用侧会话一律读作 "off"（见 runtime-settings.ts）。
// 注意：Pi 的 SettingsManager 写盘是异步队列（writeQueue），断言文件内容前必须
// await flush()——这是探针实测（同步读时目录还是空的）。
// 回归网断言：
//   1) 包装后 getCacheWarmingMode 恒为 "off"（哪怕底层 settings.json 写了别的值）；
//   2) 透传的写路径确实写进 Pi 的 settings.json（证明 Proxy 没拦错方法、没丢写）；
//   3) 我们自己从不在包过的 manager 上调 setCacheWarmingMode（那会替用户改上游
//      全局配置）；万一将来误调，写入仍会落到文件——所以覆盖的意义是「读」侧封死。

const temporaryDirectories: string[] = [];
afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((dir) => import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true })))
  );
});

async function makeAgentRoot(): Promise<{ root: string; agentDir: string; proj: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-desktop-cache-warming-"));
  temporaryDirectories.push(root);
  const agentDir = join(root, "agent");
  const proj = join(root, "proj");
  await import("node:fs/promises").then((fs) => fs.mkdir(agentDir, { recursive: true }));
  await import("node:fs/promises").then((fs) => fs.mkdir(proj, { recursive: true }));
  return { root, agentDir, proj };
}

async function readGlobalSettings(agentDir: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(agentDir, "settings.json"), "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("withCacheWarmingOff (real SettingsManager)", () => {
  it("is actually wired into both session-creation sites", () => {
    // 包装器本身写对了不代表接线也对：把调用点改回裸 SettingsManager.create()
    // 时上面的行为断言仍然全绿，而保温缺省 "streaming" 会默默回来。这个文件
    // 就是新增的外部依赖，改名也会让下面的断言失败。
    const mainDir = dirname(fileURLToPath(import.meta.url));
    const sites = ["pi-runtime.ts", "subagent.ts"].map((file) => ({
      file,
      source: readFileSync(join(mainDir, file), "utf8")
    }));
    for (const { file, source } of sites) {
      const wrapped = source.match(/withCacheWarmingOff\(SettingsManager\.create\(/g) ?? [];
      const bare = source.match(/SettingsManager\.create\(/g) ?? [];
      expect(wrapped.length, `${file} 应恰好包装一次 SettingsManager.create`).toBe(1);
      expect(bare.length, `${file} 存在未包装的 SettingsManager.create`).toBe(wrapped.length);
    }
  });

  it("reads cache warming as off regardless of the stored value", async () => {
    const { agentDir, proj } = await makeAgentRoot();
    // 底层（未包装）manager：上游缺省 "streaming"，再写成 "idle" 证明文件里确有非 off 值。
    const bare = SettingsManager.create(proj, agentDir);
    expect(bare.getCacheWarmingMode()).toBe("streaming");
    bare.setCacheWarmingMode("idle");
    await bare.flush();
    expect(await readGlobalSettings(agentDir)).toMatchObject({ cacheWarming: "idle" });

    // 同一目录上包一层新 manager：读侧恒 off，且不回写覆盖文件里的值。
    const wrapped = withCacheWarmingOff(SettingsManager.create(proj, agentDir));
    expect(wrapped.getCacheWarmingMode()).toBe("off");
    await wrapped.flush();
    expect(await readGlobalSettings(agentDir)).toMatchObject({ cacheWarming: "idle" });
  });

  it("keeps wrapped managers from writing a cacheWarming field of their own", async () => {
    const { agentDir, proj } = await makeAgentRoot();
    const wrapped = withCacheWarmingOff(SettingsManager.create(proj, agentDir));
    // 只动一个与保温无关的字段（会走 markModified + save 落盘链）：
    // settings.json 落盘但没有 cacheWarming 字段（写侧未被包装层触发）。
    wrapped.setLastChangelogVersion("0.87.1");
    await wrapped.flush();
    expect(await readGlobalSettings(agentDir)).not.toHaveProperty("cacheWarming");
  });

  it("passes every other member through untouched", async () => {
    const { agentDir, proj } = await makeAgentRoot();
    const wrapped = withCacheWarmingOff(SettingsManager.create(proj, agentDir));
    // 抽查两个与缓存保温无关的读写对：写入后读回一致、文件里也真有该字段
    // ——Proxy 透传没拦错方法、方法绑定回了原对象（否则写不到文件上）。
    wrapped.setLastChangelogVersion("0.87.1");
    expect(wrapped.getLastChangelogVersion()).toBe("0.87.1");
    wrapped.setProjectTrusted(true);
    expect(wrapped.isProjectTrusted()).toBe(true);
    await wrapped.flush();
    expect(await readGlobalSettings(agentDir)).toMatchObject({ lastChangelogVersion: "0.87.1" });
    expect((await readdir(agentDir)).sort()).toEqual(["settings.json"]);
  });
});
