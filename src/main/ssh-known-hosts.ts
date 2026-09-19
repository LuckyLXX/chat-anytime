import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * SSH 主机指纹库（TOFU：首次连接记录，之后变更即拒绝，防中间人）。
 * `userData/pidesktop-ssh-known-hosts.json`：`<host>:<port> → sha256 指纹`
 * 的 map，原子 tmp+rename。宽容读：损坏文件按空库处理（代价只是重新确认
 * 一次指纹，不会锁死用户）。
 */

export type KnownHosts = Record<string, string>;

export function knownHostKey(host: string, port: number): string {
  return `${host.toLowerCase()}:${port}`;
}

export interface SshKnownHostsStore {
  /** 已知指纹；未知返回 undefined。 */
  get(host: string, port: number): string | undefined;
  /** 记录指纹（TOFU 首次确认后调用）。 */
  put(host: string, port: number, fingerprint: string): void;
}

export function createSshKnownHostsStore(filePath: string): SshKnownHostsStore {
  const read = (): KnownHosts => {
    try {
      if (!existsSync(filePath)) return {};
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const result: KnownHosts = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) result[key] = value.trim();
      }
      return result;
    } catch {
      return {};
    }
  };

  let cache: KnownHosts | undefined;

  return {
    get(host: string, port: number): string | undefined {
      cache ??= read();
      return cache[knownHostKey(host, port)];
    },
    put(host: string, port: number, fingerprint: string): void {
      cache ??= read();
      cache[knownHostKey(host, port)] = fingerprint;
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, hosts: cache }, null, 2), "utf8");
      renameSync(tmp, filePath);
    }
  };
}
