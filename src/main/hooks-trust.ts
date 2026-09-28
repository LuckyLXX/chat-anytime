import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { HookRule } from "../shared/protocol.js";

export interface HookTrustRecord {
  digest: string;
  trustedAt: string;
}

/** `writable` is runtime metadata and is never serialized. */
export interface HookTrustData {
  version: 1;
  workspaces: Record<string, Record<string, HookTrustRecord>>;
  writable: boolean;
}

function emptyTrust(writable: boolean): HookTrustData {
  return { version: 1, workspaces: {}, writable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTrustData(value: unknown): value is { version: 1; workspaces: Record<string, Record<string, HookTrustRecord>> } {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.workspaces)) return false;
  return Object.values(value.workspaces).every((workspace) => isRecord(workspace)
    && Object.values(workspace).every((record) => isRecord(record)
      && typeof record.digest === "string"
      && /^[a-f0-9]{64}$/u.test(record.digest)
      && typeof record.trustedAt === "string"
      && record.trustedAt.length > 0));
}

/** A bad or unknown store becomes an empty read-only view, never a write target. */
export function readHookTrust(filePath: string): HookTrustData {
  if (!existsSync(filePath)) return emptyTrust(true);
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (!isTrustData(parsed)) return emptyTrust(false);
    return { version: 1, workspaces: parsed.workspaces, writable: true };
  } catch {
    return emptyTrust(false);
  }
}

/** Writes only stores that were loaded successfully (or did not exist). */
export function writeHookTrust(filePath: string, data: HookTrustData): boolean {
  if (!data.writable) return false;
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify({ version: 1, workspaces: data.workspaces }, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
  return true;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

/** Hashes only execution-relevant rule fields using recursively sorted JSON keys. */
export function hookRuleDigest(rule: HookRule): string {
  const canonical = {
    action: rule.action,
    event: rule.event,
    matcher: rule.matcher,
    name: rule.name,
    timeoutMs: rule.timeoutMs,
    wait: rule.action.kind === "command" ? rule.action.wait : undefined
  };
  return createHash("sha256").update(JSON.stringify(sortJson(canonical))).digest("hex");
}

export function workspaceTrustKey(workspace: string): string {
  return resolve(workspace).replaceAll("\\", "/").toLowerCase();
}

export function evaluateHookTrust(input: {
  scope: "project" | "global";
  workspace?: string;
  rule: HookRule;
  data: HookTrustData;
}): "global" | "trusted" | "pending" {
  if (input.scope === "global") return "global";
  if (!input.workspace) return "pending";
  const record = input.data.workspaces[workspaceTrustKey(input.workspace)]?.[input.rule.name];
  return record?.digest === hookRuleDigest(input.rule) ? "trusted" : "pending";
}

export function trustRule(data: HookTrustData, key: string, rule: HookRule, trustedAt = new Date().toISOString()): HookTrustData {
  if (!data.writable) return data;
  return {
    ...data,
    workspaces: {
      ...data.workspaces,
      [key]: { ...data.workspaces[key], [rule.name]: { digest: hookRuleDigest(rule), trustedAt } }
    }
  };
}

export function revokeRule(data: HookTrustData, key: string, name: string): HookTrustData {
  if (!data.writable || !data.workspaces[key]?.[name]) return data;
  const workspace = { ...data.workspaces[key] };
  delete workspace[name];
  const workspaces = { ...data.workspaces };
  if (Object.keys(workspace).length) workspaces[key] = workspace;
  else delete workspaces[key];
  return { ...data, workspaces };
}

export function pruneTrust(data: HookTrustData, key: string, liveNames: readonly string[]): HookTrustData {
  if (!data.writable || !data.workspaces[key]) return data;
  const live = new Set(liveNames);
  const workspace = Object.fromEntries(Object.entries(data.workspaces[key]).filter(([name]) => live.has(name)));
  const workspaces = { ...data.workspaces };
  if (Object.keys(workspace).length) workspaces[key] = workspace;
  else delete workspaces[key];
  return { ...data, workspaces };
}

export function applyHookSaveTrust(data: HookTrustData, key: string, rule: HookRule, trustedAt?: string): HookTrustData {
  return trustRule(data, key, rule, trustedAt);
}
