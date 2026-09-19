import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { SshGroupSummary, SshHostDraft, SshHostSummary } from "../shared/protocol.js";

/**
 * SSH 主机配置存储：`userData/pidesktop-ssh-hosts.json`，原子 tmp+rename。
 * 密码经注入的加密器处理（safeStorage DPAPI，见 index.ts 装配），存盘形状
 * `enc:<base64>`（加密）/ `plain:<base64>`（加密不可用时的明文降级，UI 需
 * 警告）。密码永不离开主进程：对外只暴露 SshHostSummary（hasPassword），
 * 明文仅在连接发起时经 passwordOf 解密给 ssh2。纯逻辑 + 注入依赖，可单测。
 */

export interface StoredSshHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  /** 所属分组（不存在于 groups 表时读取侧回退为未分组）。 */
  groupId?: string;
  secret: string;
}

export interface StoredSshGroup {
  id: string;
  name: string;
}

/** 加密器抽象：实现方决定 safeStorage 是否可用与降级策略。 */
export interface SshHostCrypto {
  encrypt(plain: string): { secret: string; insecure: boolean };
  decrypt(secret: string): string;
  /** 当前存储是否为明文降级（决定 UI 警告位）。 */
  isAvailable(): boolean;
}

export interface SshHostStore {
  list(): SshHostSummary[];
  listGroups(): SshGroupSummary[];
  get(id: string): StoredSshHost | undefined;
  /** 解密密码；主机不存在或从未保存过密码时返回 undefined。 */
  passwordOf(id: string): string | undefined;
  /** 新建（无 id）或更新；password 为 undefined/空 = 保留原密码。 */
  save(draft: SshHostDraft, password?: string): SshHostSummary;
  remove(id: string): boolean;
  /** 新建（无 id）或重命名分组。 */
  saveGroup(draft: { id?: string; name: string }): SshGroupSummary;
  /** 删除分组：组内主机回落未分组（不删主机/密码）；返回受影响主机数，-1 = 分组不存在。 */
  removeGroup(id: string): number;
}

interface SshHostFile {
  version: number;
  /** v2 起存在；v1 文件缺省为空数组（全部主机归入未分组）。 */
  groups?: StoredSshGroup[];
  hosts: StoredSshHost[];
}

export const SSH_DEFAULT_PORT = 22;
const SECRET_PREFIX_ENCRYPTED = "enc:";
const SECRET_PREFIX_PLAIN = "plain:";

function normalizePort(value: unknown): number {
  const port = typeof value === "number" ? Math.round(value) : Number.NaN;
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  return SSH_DEFAULT_PORT;
}

/** 读取归一化：损坏条目跳过，绝不因单条脏数据丢掉整个清单。 */
function normalizeHost(value: unknown): StoredSshHost | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  const username = typeof raw.username === "string" ? raw.username.trim() : "";
  const secret = typeof raw.secret === "string" && raw.secret ? raw.secret : "";
  if (!id || !host || !username) return undefined;
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `${username}@${host}`,
    host,
    port: normalizePort(raw.port),
    username,
    ...(typeof raw.groupId === "string" && raw.groupId.trim() ? { groupId: raw.groupId.trim() } : {}),
    secret
  };
}

function normalizeGroup(value: unknown): StoredSshGroup | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "";
  if (!id || !name) return undefined;
  return { id, name };
}

interface SshHostFileData {
  hosts: StoredSshHost[];
  groups: StoredSshGroup[];
}

function readFile(filePath: string): SshHostFileData {
  try {
    if (!existsSync(filePath)) return { hosts: [], groups: [] };
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { hosts?: unknown }).hosts)) {
      return { hosts: [], groups: [] };
    }
    const groups = Array.isArray((parsed as { groups?: unknown }).groups)
      ? ((parsed as { groups: unknown[] }).groups).map(normalizeGroup).filter((item): item is StoredSshGroup => item !== undefined)
      : []; // v1 文件没有 groups：全部主机归入未分组
    return {
      hosts: ((parsed as { hosts: unknown[] }).hosts).map(normalizeHost).filter((item): item is StoredSshHost => item !== undefined),
      groups
    };
  } catch {
    return { hosts: [], groups: [] };
  }
}

function writeFile(filePath: string, data: SshHostFileData): void {
  const payload: SshHostFile = { version: 2, groups: data.groups, hosts: data.hosts };
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmp, filePath);
}

function toSummary(stored: StoredSshHost, insecure: boolean): SshHostSummary {
  return {
    id: stored.id,
    name: stored.name,
    host: stored.host,
    port: stored.port,
    username: stored.username,
    ...(stored.groupId ? { groupId: stored.groupId } : {}),
    hasPassword: stored.secret.length > 0,
    ...(insecure && stored.secret.length > 0 ? { credentialInsecure: true } : {})
  };
}

/** 校验并归一化草稿字段；返回错误消息（中文，直接进 UI）或 undefined。 */
export function validateHostDraft(draft: SshHostDraft): string | undefined {
  if (!draft.name.trim()) return "名称不能为空";
  if (!draft.host.trim()) return "主机地址不能为空";
  if (/\s/.test(draft.host.trim())) return "主机地址不能包含空格";
  if (!draft.username.trim()) return "用户名不能为空";
  if (draft.port !== undefined && !(Math.round(draft.port) >= 1 && Math.round(draft.port) <= 65535)) {
    return "端口必须在 1–65535 之间";
  }
  return undefined;
}

export function createSshHostStore(deps: { filePath: string; crypto: SshHostCrypto }): SshHostStore {
  let data = readFile(deps.filePath);
  const hosts = (): StoredSshHost[] => data.hosts;
  const groups = (): StoredSshGroup[] => data.groups;

  const persist = (): void => {
    writeFile(deps.filePath, data);
  };

  const validGroupId = (groupId: string | undefined): string | undefined => {
    if (!groupId || !groupId.trim()) return undefined;
    return groups().some((group) => group.id === groupId) ? groupId : undefined;
  };

  return {
    list(): SshHostSummary[] {
      const insecure = !deps.crypto.isAvailable();
      return hosts().map((item) => toSummary(item, insecure));
    },
    listGroups(): SshGroupSummary[] {
      return groups().map((group) => ({ id: group.id, name: group.name }));
    },
    get(id: string): StoredSshHost | undefined {
      return hosts().find((item) => item.id === id);
    },
    passwordOf(id: string): string | undefined {
      const stored = hosts().find((item) => item.id === id);
      if (!stored || !stored.secret) return undefined;
      const plain = deps.crypto.decrypt(stored.secret);
      return plain || undefined;
    },
    save(draft: SshHostDraft, password?: string): SshHostSummary {
      const port = normalizePort(draft.port);
      const trimmed = {
        name: draft.name.trim(),
        host: draft.host.trim(),
        username: draft.username.trim()
      };
      const passwordToStore = password !== undefined && password.length > 0 ? password : undefined;
      const existing = draft.id ? hosts().find((item) => item.id === draft.id) : undefined;
      if (existing) {
        existing.name = trimmed.name;
        existing.host = trimmed.host;
        existing.port = port;
        existing.username = trimmed.username;
        // 分组改为显式字段：草稿带空串=移出分组；缺省=保留原值；无效 id 归未分组。
        if (draft.groupId !== undefined) existing.groupId = validGroupId(draft.groupId);
        if (passwordToStore !== undefined) existing.secret = deps.crypto.encrypt(passwordToStore).secret;
        persist();
        return toSummary(existing, !deps.crypto.isAvailable());
      }
      const stored: StoredSshHost = {
        id: `ssh-${randomUUID().slice(0, 8)}`,
        ...trimmed,
        port,
        ...(validGroupId(draft.groupId) ? { groupId: validGroupId(draft.groupId)! } : {}),
        secret: passwordToStore !== undefined ? deps.crypto.encrypt(passwordToStore).secret : ""
      };
      data.hosts.push(stored);
      persist();
      return toSummary(stored, !deps.crypto.isAvailable());
    },
    remove(id: string): boolean {
      const index = data.hosts.findIndex((item) => item.id === id);
      if (index < 0) return false;
      data.hosts.splice(index, 1);
      persist();
      return true;
    },
    saveGroup(draft: { id?: string; name: string }): SshGroupSummary {
      const name = draft.name.trim();
      if (!name) throw new Error("分组名称不能为空");
      const duplicate = groups().find((group) => group.name === name && group.id !== draft.id);
      if (duplicate) throw new Error(`已存在同名分组「${name}」`);
      const existing = draft.id ? groups().find((group) => group.id === draft.id) : undefined;
      if (existing) {
        existing.name = name;
        persist();
        return { id: existing.id, name };
      }
      const group: StoredSshGroup = { id: `grp-${randomUUID().slice(0, 8)}`, name };
      data.groups.push(group);
      persist();
      return { id: group.id, name: group.name };
    },
    removeGroup(id: string): number {
      const index = groups().findIndex((group) => group.id === id);
      if (index < 0) return -1;
      data.groups.splice(index, 1);
      // 组内主机回落未分组（不删主机与密码）。
      let moved = 0;
      for (const item of data.hosts) {
        if (item.groupId === id) {
          delete item.groupId;
          moved += 1;
        }
      }
      persist();
      return moved;
    }
  };
}

/** base64 编解码（加密器实现与测试共享）。 */
export function encodeSecret(plain: string): string {
  return Buffer.from(plain, "utf8").toString("base64");
}

export function decodeSecret(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

export const SECRET_ENCODINGS = {
  encrypted: SECRET_PREFIX_ENCRYPTED,
  plain: SECRET_PREFIX_PLAIN
} as const;
