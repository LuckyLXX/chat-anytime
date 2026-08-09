import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { configurePiCliShim, ELECTRON_RUN_AS_NODE_ENV, PI_CLI_BROKER_ENV, PI_CLI_SHIM_ENV, PiCliHostBroker, requestPiCliHostConfig, requestPiCliRun } from "./pi-cli-compat.js";

const originalBroker = process.env[PI_CLI_BROKER_ENV];
const originalShim = process.env[PI_CLI_SHIM_ENV];
const originalElectronRunAsNode = process.env[ELECTRON_RUN_AS_NODE_ENV];
const originalArgv1 = process.argv[1];

afterEach(() => {
  if (originalBroker === undefined) delete process.env[PI_CLI_BROKER_ENV];
  else process.env[PI_CLI_BROKER_ENV] = originalBroker;
  if (originalShim === undefined) delete process.env[PI_CLI_SHIM_ENV];
  else process.env[PI_CLI_SHIM_ENV] = originalShim;
  if (originalElectronRunAsNode === undefined) delete process.env[ELECTRON_RUN_AS_NODE_ENV];
  else process.env[ELECTRON_RUN_AS_NODE_ENV] = originalElectronRunAsNode;
  if (originalArgv1 === undefined) process.argv.splice(1, 1);
  else process.argv[1] = originalArgv1;
});

describe("PiCliHostBroker", () => {
  it("serves runtime config over an authenticated loopback channel", async () => {
    const broker = new PiCliHostBroker(() => ({
      agentDir: "C:/Users/test/.pi/agent",
      model: { provider: "test", id: "model" },
      thinkingLevel: "low",
      accessMode: "ask",
      providers: [{ id: "test", name: "Test", baseUrl: "https://example.test/v1", models: [] }],
      apiKeys: { test: "secret" }
    }));

    await broker.start();
    Object.assign(process.env, broker.environment());
    expect(process.env[PI_CLI_SHIM_ENV]).toBe("1");
    expect(process.env[PI_CLI_BROKER_ENV]).not.toContain("secret");
    await expect(requestPiCliHostConfig()).resolves.toMatchObject({
      model: { provider: "test", id: "model" },
      apiKeys: { test: "secret" }
    });
    broker.dispose();
  });

  it("streams CLI events through the utility-process broker", async () => {
    const broker = new PiCliHostBroker(
      () => ({
        agentDir: "C:/Users/test/.pi/agent",
        thinkingLevel: "low",
        accessMode: "ask",
        providers: [],
        apiKeys: {}
      }),
      undefined,
      async (request, emit) => {
        expect(request.argv).toContain("--mode");
        emit({ type: "message_end", message: { role: "assistant", content: [] } });
        return 7;
      }
    );

    await broker.start();
    Object.assign(process.env, broker.environment());
    const events: unknown[] = [];
    await expect(requestPiCliRun({ argv: ["--mode", "json", "-p", "task"], cwd: "C:/workspace" }, (event) => events.push(event))).resolves.toBe(7);
    expect(events).toHaveLength(1);
    broker.dispose();
  });

  it("creates a package-shaped launcher for the official subagent CLI resolver", async () => {
    const broker = new PiCliHostBroker(() => ({
      agentDir: "C:/Users/test/.pi/agent",
      thinkingLevel: "low",
      accessMode: "ask",
      providers: [],
      apiKeys: {}
    }));
    const sourceDir = await mkdtemp(join(tmpdir(), "pidesktop-pi-cli-source-"));
    const sourcePath = join(sourceDir, "pi-cli-host.js");
    await writeFile(sourcePath, "export {};", "utf8");

    await broker.start();
    configurePiCliShim(sourcePath, broker);

    const launchPath = process.argv[1]!;
    expect(launchPath).not.toBe(sourcePath);
    expect(await readFile(join(dirname(launchPath), "package.json"), "utf8")).toContain("@earendil-works/pi-coding-agent");
    expect(await readFile(launchPath, "utf8")).toContain(pathToFileURL(sourcePath).href);
    expect(process.env[ELECTRON_RUN_AS_NODE_ENV]).toBe("1");

    broker.dispose();
    await Promise.all([
      rm(sourceDir, { recursive: true, force: true }),
      rm(dirname(launchPath), { recursive: true, force: true })
    ]);
  });
});
