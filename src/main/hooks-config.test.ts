import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookRule } from "../shared/protocol.js";
import { hookActionPreview, readConfiguredHooks, removeHookConfig, setHookDisabled, upsertHookConfig, validateHookRule } from "./hooks-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryConfig(name = ".pidesktop-hooks.json"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-desktop-hooks-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

const notifyRule: HookRule = { name: "跑完通知", event: "turn_end", action: { kind: "notify" } };
const blockRule: HookRule = { name: "git防火墙", event: "tool_call", matcher: "bash", action: { kind: "block", deny: ["git\\s+push.*--force"] } };

describe("hooks config", () => {
  it("creates a hooks array entry and preserves unrelated top-level keys", async () => {
    const path = await temporaryConfig();
    await writeFile(path, '{\n  // 注释保留吗？\n  "custom": { "x": 1 },\n  "hooks": []\n}\n', "utf8");
    upsertHookConfig(path, blockRule);

    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.custom).toEqual({ x: 1 });
    expect(parsed.hooks).toEqual([blockRule]);
  });

  it("replaces by name and keeps the disabled flag across edits", async () => {
    const path = await temporaryConfig();
    upsertHookConfig(path, notifyRule);
    upsertHookConfig(path, blockRule);
    setHookDisabled(path, "跑完通知", true);

    upsertHookConfig(path, { ...notifyRule, action: { kind: "notify", title: "完成" } });
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.hooks).toHaveLength(2);
    expect(parsed.hooks.find((item: { name: string }) => item.name === "跑完通知")).toMatchObject({ disabled: true, action: { kind: "notify", title: "完成" } });
  });

  it("merges project + global with project taking precedence by name", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-desktop-hooks-proj-"));
    const globalDir = await mkdtemp(join(tmpdir(), "pi-desktop-hooks-glob-"));
    temporaryDirectories.push(projectDir, globalDir);
    const projectPath = join(projectDir, ".pidesktop-hooks.json");
    const globalPath = join(globalDir, "pidesktop-hooks.json");
    upsertHookConfig(globalPath, notifyRule);
    upsertHookConfig(globalPath, { name: "环境准备", event: "session_start", action: { kind: "command", command: "npm install" } });
    upsertHookConfig(projectPath, { ...notifyRule, action: { kind: "notify", title: "项目版" } });

    const hooks = readConfiguredHooks(projectPath, globalPath);
    expect(hooks.map((hook) => hook.name)).toEqual(["环境准备", "跑完通知"]);
    expect(hooks.find((hook) => hook.name === "跑完通知")).toMatchObject({ scope: "project", rule: { action: { kind: "notify", title: "项目版" } } });
    expect(hooks.find((hook) => hook.name === "环境准备")?.scope).toBe("global");
  });

  it("skips a corrupt scope instead of blocking the other", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "pi-desktop-hooks-proj-"));
    const globalDir = await mkdtemp(join(tmpdir(), "pi-desktop-hooks-glob-"));
    temporaryDirectories.push(projectDir, globalDir);
    const projectPath = join(projectDir, ".pidesktop-hooks.json");
    await writeFile(projectPath, "{ broken json", "utf8");
    upsertHookConfig(join(globalDir, "pidesktop-hooks.json"), notifyRule);

    const hooks = readConfiguredHooks(projectPath, join(globalDir, "pidesktop-hooks.json"));
    expect(hooks.map((hook) => hook.name)).toEqual(["跑完通知"]);
  });

  it("removes and toggles rules", async () => {
    const path = await temporaryConfig();
    upsertHookConfig(path, notifyRule);
    upsertHookConfig(path, blockRule);

    expect(setHookDisabled(path, "git防火墙", true)).toBe(true);
    expect(readConfiguredHooks(path, path).find((hook) => hook.name === "git防火墙")?.rule.disabled).toBe(true);
    expect(setHookDisabled(path, "missing", true)).toBe(false);

    expect(removeHookConfig(path, "跑完通知")).toBe(true);
    expect(removeHookConfig(path, "跑完通知")).toBe(false);
    expect(readConfiguredHooks(path, path)).toHaveLength(1);
  });

  it("rejects invalid rules with Chinese errors", () => {
    expect(() => validateHookRule({ ...notifyRule, name: " " })).toThrow("名称不能为空");
    expect(() => validateHookRule({ ...notifyRule, event: "message_end" as HookRule["event"] })).toThrow("事件无效");
    expect(() => validateHookRule({ ...blockRule, matcher: "(" })).toThrow("正则");
    expect(() => validateHookRule({ ...blockRule, action: { kind: "block", deny: ["("] } })).toThrow("正则");
    expect(() => validateHookRule({ name: "x", event: "turn_end", action: { kind: "block", deny: ["a"] } })).toThrow("只能挂在 tool_call");
    expect(() => validateHookRule({ ...notifyRule, action: { kind: "http", url: "ftp://x" } })).toThrow("http/https");
    expect(() => validateHookRule({ ...notifyRule, action: { kind: "command", command: "" } })).toThrow("不能为空");
    expect(() => validateHookRule({ name: "x", event: "tool_call", action: { kind: "command", command: "echo", blocking: true }, timeoutMs: 500 })).toThrow("超时");
    expect(() => validateHookRule({ ...notifyRule, matcher: "(" } as HookRule)).toThrow("工具事件");
    expect(() => validateHookRule({ ...notifyRule, matcher: "bash" } as HookRule)).toThrow("工具事件");
  });

  it("previews actions for the panel list", () => {
    expect(hookActionPreview({ kind: "notify" })).toBe("桌面通知");
    expect(hookActionPreview({ kind: "notify", title: "完成啦" })).toBe("完成啦");
    expect(hookActionPreview({ kind: "http", url: "https://api.example.com/x" })).toBe("https://api.example.com/x");
    expect(hookActionPreview({ kind: "block", deny: ["a", "b"] })).toBe("拦截 2 条规则");
    expect(hookActionPreview({ kind: "command", command: "npm test" })).toBe("npm test");
  });
});
