import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sshEndpointKey } from "../shared/ssh-triage.js";
import { createSshHostStore } from "./ssh-host-store.js";
import { buildCheckPlan, createSshTriageManager, type SshTriageExec } from "./ssh-triage.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(exec: SshTriageExec, hostConcurrency = 2) {
  const dir = mkdtempSync(join(tmpdir(), "pi-ssh-triage-"));
  dirs.push(dir);
  const hostStore = createSshHostStore({ filePath: join(dir, "hosts.json"), crypto: { encrypt: (secret) => ({ secret, insecure: false }), decrypt: (secret) => secret, isAvailable: () => true } });
  const hosts = Array.from({ length: 3 }, (_, index) => hostStore.save({ name: `node-${index}`, host: `192.0.2.${index + 2}`, username: "ops" }, undefined));
  const open = () => createSshTriageManager({ dir: join(dir, "triage"), hostStore, exec, hostConcurrency });
  return { hostStore, hosts, open, manager: open() };
}
const ok = { ok: true, exitCode: 0, stdout: "ActiveState=active\n", stderr: "" } as const;
const service = { kind: "service", unit: "test-api.service" } as const;

it("limits concurrent host collection and verifies the endpoint again before a queued host runs", async () => {
  const releases: Array<() => void> = [];
  const exec = vi.fn<SshTriageExec>(() => new Promise((resolve) => releases.push(() => resolve(ok))));
  const { manager, hosts, hostStore } = harness(exec);
  const last = hosts[2]!;
  const result = await manager.handle({ type: "triage.start", hostIds: hosts.map((host) => host.id), checks: [service] });
  if (result.kind !== "triage-batch") throw new Error("missing batch");
  expect(exec).toHaveBeenCalledTimes(2);
  hostStore.save({ ...last, host: "192.0.2.99" }, undefined);
  releases.forEach((release) => release());
  await vi.waitFor(async () => {
    const detail = await manager.handle({ type: "triage.detail", batchId: result.batch.id });
    expect(detail).toMatchObject({ detail: { summary: { status: "finished" }, hosts: [{ status: "passed" }, { status: "passed" }, { status: "error", endpointChanged: true, checks: [{ failure: "endpoint-changed" }] }] } });
  });
  expect(exec).toHaveBeenCalledTimes(2);
  manager.dispose();
});

it("restores a partial log and records pending work as unexecuted after reopening", async () => {
  const exec = vi.fn<SshTriageExec>(async (_id, _command, options) => {
    options?.onChunk?.("有一段日志\n", "stdout");
    return new Promise((resolve) => options?.signal?.addEventListener("abort", () => resolve({ ok: false, failure: "stopped", message: "stopped", exitCode: null, stdout: "有一段日志\n", stderr: "" })));
  });
  const { manager, hosts, open } = harness(exec, 1);
  const result = await manager.handle({ type: "triage.start", hostIds: hosts.map((host) => host.id), checks: [service, { kind: "disk", path: "/" }] });
  if (result.kind !== "triage-batch") throw new Error("missing batch");
  manager.dispose();
  const restarted = open();
  const detail = await restarted.handle({ type: "triage.detail", batchId: result.batch.id, hostId: hosts[0]!.id });
  expect(detail).toMatchObject({ detail: { summary: { status: "interrupted" }, hosts: [{ status: "interrupted", checks: [{ output: "有一段日志\n", status: "error" }, { status: "skipped" }] }, { status: "not-run" }, { status: "not-run" }] } });
  expect(exec).toHaveBeenCalledTimes(1);
  restarted.dispose();
});

it("persists host directories and manual summaries and detects a stale revision", async () => {
  const { manager, hosts, open } = harness(async () => ok);
  const host = hosts[0]!;
  const command = { type: "triage.card.save", hostId: host.id, endpoint: sshEndpointKey(host), revision: 0, directories: [{ id: "app", label: "应用", path: "/srv/test-api" }], summaries: [{ id: "issue", title: "启动失败", body: "补齐配置后恢复", createdAt: 1, updatedAt: 1 }] } as const;
  const writable = { ...command, directories: [...command.directories], summaries: [...command.summaries] };
  expect(await manager.handle(writable)).toMatchObject({ kind: "triage-card-saved" });
  expect(await manager.handle(writable)).toMatchObject({ kind: "triage-card-conflict" });
  manager.dispose();
  const restarted = open();
  expect(await restarted.handle({ type: "triage.card.get", hostId: host.id })).toMatchObject({ kind: "triage-card", view: { card: { directories: command.directories, summaries: command.summaries } } });
  restarted.dispose();
});

it("distinguishes service failure, unreadable journal and empty recent logs", () => {
  expect(buildCheckPlan(service).interpret({ ...ok, stdout: "ActiveState=failed\nLoadState=loaded\n" })).toMatchObject({ status: "fail" });
  const journal = buildCheckPlan({ kind: "journal", unit: "test-api.service" });
  expect(journal.interpret({ ...ok, stdout: "", stderr: "Permission denied", exitCode: 1 })).toMatchObject({ status: "error", failure: "permission" });
  expect(journal.interpret({ ...ok, stdout: "-- No entries --\n" })).toMatchObject({ status: "pass" });
  expect(journal.interpret({ ...ok, stdout: "2026-11-25T14:32 app: configuration missing" })).toMatchObject({ status: "fail" });
});
