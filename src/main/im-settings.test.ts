import { describe, expect, it } from "vitest";
import { defaultSettings, migrateSettings, normalizeIm } from "./settings";
import { parseImSettings } from "../shared/im";
import type { DesktopSettings, ImSettings } from "../shared/protocol";

/**
 * `settings.im` 的读写往返回归网。
 *
 * 这个文件存在的唯一理由是本仓库反复踩过的坑：**migrateSettings 是唯一读入口**，
 * 漏读一个字段 = 磁盘上有、内存里没有，而 persistSettings 会把整个内存副本写回
 * 文件 —— 下一次任意设置写入（session.new / agent.select / workspace.open…）就把
 * 它从磁盘抹掉，用户只会发现「通道配置重启就没了」。
 */

describe("normalizeIm", () => {
  it("delegates to the shared parser (single source of truth)", () => {
    const raw = { enabled: true, channels: [{ id: "feishu", kind: "feishu", enabled: true, appId: "cli_1", allowFrom: ["ou_1"] }] };
    expect(normalizeIm(raw)).toEqual(parseImSettings(raw));
    expect(normalizeIm(raw)?.channels[0]?.accessMode).toBe("workspace");
  });

  it("drops the field entirely when nothing is configured", () => {
    expect(normalizeIm(undefined)).toBeUndefined();
    expect(normalizeIm({ enabled: false, channels: [] })).toBeUndefined();
  });
});

describe("migrateSettings ↔ settings.im", () => {
  it("reads im back on migrate (write→read round trip)", () => {
    const im: ImSettings = {
      enabled: true,
      channels: [{
        id: "feishu",
        kind: "feishu",
        enabled: true,
        label: "值班",
        appId: "cli_1",
        appSecretConfigured: true,
        domain: "open.larksuite.com",
        allowFrom: ["ou_1", "ou_2"],
        accessMode: "workspace",
        workspace: "D:/ws",
        agentId: "agent-1",
        approvalTimeoutMs: 120_000,
        ack: false
      }]
    };
    const migrated = migrateSettings({ version: 2, im }).settings;
    expect(migrated.im).toEqual(im);
    // 「写—读—再写」幂等：第二次迁移不会因为归一化把字段弄丢。
    expect(migrateSettings(JSON.parse(JSON.stringify(migrated))).settings.im).toEqual(im);
  });

  it("keeps other settings intact when im is present (no accidental reset)", () => {
    const base: DesktopSettings = defaultSettings();
    const migrated = migrateSettings({
      ...JSON.parse(JSON.stringify(base)),
      accessMode: "full",
      im: { enabled: true, channels: [{ id: "feishu", kind: "feishu", enabled: true, appId: "cli_1" }] }
    }).settings;
    expect(migrated.accessMode).toBe("full");
    expect(migrated.im?.enabled).toBe(true);
    expect(migrated.agents).toHaveLength(base.agents.length);
  });

  it("does not invent the field when absent (settings.json stays clean)", () => {
    const migrated = migrateSettings({ version: 2 }).settings;
    expect(migrated.im).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(migrated, "im")).toBe(true);
  });

  it("drops a corrupted im block instead of failing the whole settings load", () => {
    const migrated = migrateSettings({ version: 2, im: { enabled: "yes", channels: "nope" } }).settings;
    expect(migrated.im).toBeUndefined();
  });
});
