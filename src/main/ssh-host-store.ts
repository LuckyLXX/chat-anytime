import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { SshHostDraft, SshHostSummary } from "../shared/protocol.js";

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
  secret: string;
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
  get(id: string): StoredSshHost | undefined;
  /** 解密密码；主机不存在或从未保存过密码时返回 undefined。 */
  passwordOf(id: string): string | undefined;
  /** 新建（无 id）或更新；password 为 undefined/空 = 保留原密码。 */
  save(draft: SshHostDraft, password?: string): SshHostSummary;
  remove(id: string): boolean;
}

interface SshHostFile {
  version: 1;
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
    secret
  };
}

function readFile(filePath: string): StoredSshHost[] {
  try {
    if (!existsSync(filePath)) return [];
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { hosts?: unknown }).hosts)) return [];
    return ((parsed as { hosts: unknown[] }).hosts)
      .map(normalizeHost)
      .filter((item): item is StoredSshHost => item !== undefined);
  } catch {
    return [];
  }
}

function writeFile(filePath: string, hosts: StoredSshHost[]): void {
  const payload: SshHostFile = { version: 1, hosts };
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
  let hosts = readFile(deps.filePath);

  const persist = (): void => {
    writeFile(deps.filePath, hosts);
  };

  return {
    list(): SshHostSummary[] {
      const insecure = !deps.crypto.isAvailable();
      return hosts.map((item) => toSummary(item, insecure));
    },
    get(id: string): StoredSshHost | undefined {
      return hosts.find((item) => item.id === id);
    },
    passwordOf(id: string): string | undefined {
      const stored = hosts.find((item) => item.id === id);
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
      const existing = draft.id ? hosts.find((item) => item.id === draft.id) : undefined;
      if (existing) {
        existing.name = trimmed.name;
        existing.host = trimmed.host;
        existing.port = port;
        existing.username = trimmed.username;
        if (passwordToStore !== undefined) existing.secret = deps.crypto.encrypt(passwordToStore).secret;
        persist();
        return toSummary(existing, !deps.crypto.isAvailable());
      }
      const stored: StoredSshHost = {
        id: `ssh-${randomUUID().slice(0, 8)}`,
        ...trimmed,
        port,
        secret: passwordToStore !== undefined ? deps.crypto.encrypt(passwordToStore).secret : ""
      };
      hosts.push(stored);
      persist();
      return toSummary(stored, !deps.crypto.isAvailable());
    },
    remove(id: string): boolean {
      const index = hosts.findIndex((item) => item.id === id);
      if (index < 0) return false;
      hosts.splice(index, 1);
      persist();
      return true;
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
