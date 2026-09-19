import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSshHostStore, validateHostDraft, type SshHostCrypto } from "./ssh-host-store.js";

function tempFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "pidesktop-ssh-")), name);
}

/** 加密器 fake：base64 直存，标记 secure（测试不依赖 safeStorage）。 */
function secureCrypto(): SshHostCrypto {
  return {
    encrypt: (plain) => ({ secret: `enc:${Buffer.from(plain, "utf8").toString("base64")}`, insecure: false }),
    decrypt: (secret) => (secret.startsWith("enc:") ? Buffer.from(secret.slice(4), "base64").toString("utf8") : ""),
    isAvailable: () => true
  };
}

function insecureCrypto(): SshHostCrypto {
  return {
    encrypt: (plain) => ({ secret: `plain:${Buffer.from(plain, "utf8").toString("base64")}`, insecure: true }),
    decrypt: (secret) => (secret.startsWith("plain:") ? Buffer.from(secret.slice(6), "base64").toString("utf8") : ""),
    isAvailable: () => false
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ssh host store", () => {
  it("creates, lists, and keeps passwords out of summaries", () => {
    const filePath = tempFile("hosts.json");
    dirs.push(join(filePath, ".."));
    const store = createSshHostStore({ filePath, crypto: secureCrypto() });
    const saved = store.save({ name: "生产", host: "10.0.0.8", username: "root", port: 2222 }, "s3cret");
    expect(saved.hasPassword).toBe(true);
    expect(saved.credentialInsecure).toBeUndefined();
    const summary = JSON.stringify(store.list());
    expect(summary).not.toContain("s3cret");
    expect(store.passwordOf(saved.id)).toBe("s3cret");
  });

  it("round-trips through disk (atomic write) and survives reopen", () => {
    const filePath = tempFile("hosts.json");
    dirs.push(join(filePath, ".."));
    const first = createSshHostStore({ filePath, crypto: secureCrypto() });
    const saved = first.save({ name: "web", host: "web.example.com", username: "ubuntu" }, "pw1");
    const second = createSshHostStore({ filePath, crypto: secureCrypto() });
    expect(second.list().map((host) => host.id)).toEqual([saved.id]);
    expect(second.passwordOf(saved.id)).toBe("pw1");
    // 磁盘形状：密码是加密前缀，不落明文。
    const raw = readFileSync(filePath, "utf8");
    expect(raw).not.toContain("pw1");
    expect(raw).toContain("enc:");
  });

  it("keeps the old password when save omits it; overwrite when provided", () => {
    const store = createSshHostStore({ filePath: tempFile("hosts.json"), crypto: secureCrypto() });
    const saved = store.save({ name: "a", host: "1.2.3.4", username: "root" }, "old");
    store.save({ id: saved.id, name: "a2", host: "1.2.3.4", username: "root" });
    expect(store.passwordOf(saved.id)).toBe("old");
    expect(store.list()[0]!.name).toBe("a2");
    store.save({ id: saved.id, name: "a2", host: "1.2.3.4", username: "root" }, "new");
    expect(store.passwordOf(saved.id)).toBe("new");
  });

  it("flags insecure plaintext fallback through credentialInsecure", () => {
    const store = createSshHostStore({ filePath: tempFile("hosts.json"), crypto: insecureCrypto() });
    const saved = store.save({ name: "a", host: "1.2.3.4", username: "root" }, "plainpw");
    expect(saved.credentialInsecure).toBe(true);
    expect(store.passwordOf(saved.id)).toBe("plainpw");
  });

  it("deletes hosts and reports misses", () => {
    const store = createSshHostStore({ filePath: tempFile("hosts.json"), crypto: secureCrypto() });
    const saved = store.save({ name: "a", host: "1.2.3.4", username: "root" }, "pw");
    expect(store.remove(saved.id)).toBe(true);
    expect(store.remove(saved.id)).toBe(false);
    expect(store.list()).toHaveLength(0);
    expect(store.passwordOf(saved.id)).toBeUndefined();
  });

  it("skips corrupt entries instead of losing the whole list", () => {
    const filePath = tempFile("hosts.json");
    dirs.push(join(filePath, ".."));
    const store = createSshHostStore({ filePath, crypto: secureCrypto() });
    const good = store.save({ name: "good", host: "1.1.1.1", username: "root" }, "pw");
    // 手工注入一条损坏条目 + 一条缺主机地址的条目。
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { hosts: unknown[] };
    parsed.hosts.push({ id: "bad", name: "bad" }, null);
    writeFileSync(filePath, JSON.stringify(parsed), "utf8");
    const reopened = createSshHostStore({ filePath, crypto: secureCrypto() });
    expect(reopened.list().map((host) => host.id)).toEqual([good.id]);
  });
});

describe("validateHostDraft", () => {
  it("requires name/host/username and a sane port", () => {
    expect(validateHostDraft({ name: "a", host: "1.2.3.4", username: "root" })).toBeUndefined();
    expect(validateHostDraft({ name: "", host: "1.2.3.4", username: "root" })).toContain("名称");
    expect(validateHostDraft({ name: "a", host: "has space", username: "root" })).toContain("空格");
    expect(validateHostDraft({ name: "a", host: "1.2.3.4", username: "" })).toContain("用户名");
    expect(validateHostDraft({ name: "a", host: "1.2.3.4", username: "root", port: 70000 })).toContain("端口");
  });
});
