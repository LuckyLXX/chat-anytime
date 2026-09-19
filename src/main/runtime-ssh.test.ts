import { describe, expect, it } from "vitest";
import type { SshAutomationRequest, SshAutomationResult } from "../shared/protocol.js";
import { buildSshTools, dataFromLiteral } from "./runtime-ssh.js";

function createHarness(options: { enabled?: boolean; result?: SshAutomationResult } = {}) {
  const requests: SshAutomationRequest[] = [];
  const tools = buildSshTools({
    request: async (request) => {
      requests.push(request);
      return options.result ?? { ok: true, data: { kind: "write", written: 1 } };
    },
    enabled: () => options.enabled !== false
  });
  return { tools, requests };
}

function toolByName(tools: ReturnType<typeof buildSshTools>, name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("buildSshTools", () => {
  it("exposes the six ssh_* tools with stable names", () => {
    const { tools } = createHarness();
    expect(tools.map((tool) => tool.name)).toEqual(["ssh_hosts", "ssh_connect", "ssh_exec", "ssh_write", "ssh_read", "ssh_close"]);
  });

  it("honors the live master switch on every tool", async () => {
    const { tools } = createHarness({ enabled: false });
    const payloads: Record<string, unknown> = {
      ssh_hosts: {},
      ssh_connect: { host: "prod" },
      ssh_exec: { command: "uptime" },
      ssh_write: { data: "y" },
      ssh_read: {},
      ssh_close: {}
    };
    for (const tool of tools) {
      await expect(tool.execute("id", payloads[tool.name] as never, undefined, undefined, undefined as never)).rejects.toThrow("已在设置中停用");
    }
  });

  it("rejects empty exec commands before any RPC", async () => {
    const { tools, requests } = createHarness();
    const tool = toolByName(tools, "ssh_exec");
    await expect(tool.execute("id", { command: "   " }, undefined, undefined, undefined as never)).rejects.toThrow("请提供要执行的命令");
    expect(requests).toHaveLength(0);
  });

  it("forwards exec with the timeout translated to milliseconds", async () => {
    const { tools, requests } = createHarness({
      result: { ok: true, data: { kind: "exec", output: "ok", exitCode: 0 } }
    });
    const tool = toolByName(tools, "ssh_exec");
    const result = await tool.execute("id", { command: "uptime", timeoutSeconds: 90 }, undefined, undefined, undefined as never);
    expect(requests).toEqual([{ op: "exec", command: "uptime", timeoutMs: 90_000 }]);
    expect(JSON.stringify(result)).toContain("退出码：0");
  });

  it("renders timed-out execs with guidance instead of a failure", async () => {
    const { tools } = createHarness({
      result: { ok: true, data: { kind: "exec", output: "partial", exitCode: null, timedOut: true } }
    });
    const tool = toolByName(tools, "ssh_exec");
    const result = await tool.execute("id", { command: "sleep 999" }, undefined, undefined, undefined as never);
    const text = JSON.stringify(result);
    expect(text).toContain("超时");
    expect(text).toContain("ssh_read");
  });

  it("surfaces RPC errors verbatim", async () => {
    const { tools } = createHarness({ result: { ok: false, error: "当前会话尚未建立 SSH 连接" } });
    const tool = toolByName(tools, "ssh_read");
    await expect(tool.execute("id", {}, undefined, undefined, undefined as never)).rejects.toThrow("尚未建立 SSH 连接");
  });

  it("interprets literal escapes for interactive write (Ctrl-C / newlines)", () => {
    expect(dataFromLiteral("\\x03")).toBe("\x03");
    expect(dataFromLiteral("y\\n")).toBe("y\n");
    expect(dataFromLiteral("a\\rb\\n")).toBe("a\rb\n");
    expect(dataFromLiteral("C:\\\\path")).toBe("C:\\path");
  });
});
