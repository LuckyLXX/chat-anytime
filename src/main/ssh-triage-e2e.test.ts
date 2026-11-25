import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, Server } from "ssh2";
import { expect, it, vi } from "vitest";
import { SshConnectionManager, fingerprintOfHostKey, type SshClientLike } from "./ssh-connections.js";
import { createSshHostStore } from "./ssh-host-store.js";
import { createSshKnownHostsStore } from "./ssh-known-hosts.js";
import { makeTestHostKey } from "./ssh-test-host-key.js";
import { createSshTriageManager } from "./ssh-triage.js";

it("collects real exec output without PTY, retains a disconnected host's evidence, and ignores untrusted hosts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ssh-triage-e2e-"));
  const key = makeTestHostKey();
  let ptyCount = 0;
  const commands: string[] = [];
  const clients = new Set<{ end(): void }>();
  const server = new Server({ hostKeys: [key.private] }, (client) => {
    clients.add(client);
    client.on("close", () => { clients.delete(client); });
    client.on("error", () => {});
    let disconnect = false;
    client.on("authentication", (context) => {
      disconnect = context.username === "disconnect";
      if (context.method === "password" && context.password === "test-only") context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (_ok, reject) => { ptyCount += 1; reject?.(); });
        session.on("exec", (ok, _reject, info) => {
          commands.push(info.command);
          const channel = ok();
          if (disconnect) {
            channel.write("service started before interruption\n", () => client.end());
          } else {
            channel.write("ActiveState=active\nSubState=running\n");
            channel.stderr.write("fixture diagnostic\n");
            channel.exit(0);
            channel.end();
          }
        });
      });
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as {port: number}).port;
    const hostStore = createSshHostStore({ filePath: join(dir, "hosts.json"), crypto: { encrypt: (plain) => ({ secret: `enc:${plain}`, insecure: false }), decrypt: (value) => value.slice(4), isAvailable: () => true } });
    const healthy = hostStore.save({ name: "healthy", host: "127.0.0.1", port, username: "healthy" }, "test-only");
    const lost = hostStore.save({ name: "lost", host: "127.0.0.1", port, username: "disconnect" }, "test-only");
    const unknown = hostStore.save({ name: "unknown", host: "127.0.0.1", port: port === 65535 ? port - 1 : port + 1, username: "healthy" }, "test-only");
    const knownHosts = createSshKnownHostsStore(join(dir, "known.json"));
    knownHosts.put(healthy.host, port, fingerprintOfHostKey(key.public));
    const reveal = vi.fn();
    const manager = new SshConnectionManager({ createClient: () => new Client() as unknown as SshClientLike, hostStore, knownHosts, publish: vi.fn(), reveal });
    const triage = createSshTriageManager({ dir: join(dir, "triage"), hostStore, exec: manager.runBackgroundCommand.bind(manager), checkTimeoutMs: 8_000 });
    try {
      const start = await triage.handle({ type: "triage.start", hostIds: [healthy.id, lost.id, unknown.id], checks: [{ kind: "service", unit: "test-api.service" }] });
      if (start.kind !== "triage-batch") throw new Error("missing batch");
      await vi.waitFor(async () => {
        const result = await triage.handle({ type: "triage.detail", batchId: start.batch.id, hostId: lost.id });
        expect(result).toMatchObject({ detail: { summary: { status: "finished" }, hosts: [{ status: "passed" }, { status: "interrupted", checks: [{ failure: "disconnected", output: expect.stringContaining("before interruption") }] }, { status: "error", checks: [{ failure: "fingerprint-unknown" }] }] } });
      }, { timeout: 8_000 });
      const result = await triage.handle({ type: "triage.detail", batchId: start.batch.id, hostId: healthy.id });
      expect(result).toMatchObject({ detail: { hosts: [{ checks: [{ exitCode: 0, output: expect.stringContaining("fixture diagnostic") }] }, expect.any(Object), expect.any(Object)] } });
      expect(commands.every((command) => command.includes("systemctl show"))).toBe(true);
      expect(commands).toHaveLength(2);
      expect(ptyCount).toBe(0);
      expect(reveal).not.toHaveBeenCalled();
    } finally { triage.dispose(); }
  } finally {
    for (const client of clients) client.end();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 12_000);
