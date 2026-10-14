import { describe, expect, it } from "vitest";
import type { SshAutomationRequest, SshAutomationResult } from "../shared/protocol.js";
import { buildSshTools, dataFromLiteral, TRANSFER_OUTER_TIMEOUT_MS } from "./runtime-ssh.js";

function createHarness(options: { enabled?: boolean; result?: SshAutomationResult } = {}) {
  const requests: Array<{ request: SshAutomationRequest; timeoutMs: number | undefined }> = [];
  const tools = buildSshTools({
    request: async (request, timeoutMs) => {
      requests.push({ request, timeoutMs });
      return options.result ?? { ok: true, data: { kind: "write", written: 1 } };
    },
    enabled: () => options.enabled !== false,
    resolveUploadFile: (relativePath) => {
      if (relativePath.startsWith("/") || relativePath.includes("..")) throw new Error(`上传文件必须位于当前工作区内：${relativePath}`);
      return `/ws/${relativePath}`;
    },
    downloadDir: () => "/ws/.pidesktop/downloads",
    relativeDownloadPath: (absolutePath) => absolutePath.replace(/^\/ws\//u, "")
  });
  return { tools, requests };
}

function toolByName(tools: ReturnType<typeof buildSshTools>, name: string) {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe("buildSshTools", () => {
  it("exposes the eleven ssh_* tools with stable names", () => {
    const { tools } = createHarness();
    expect(tools.map((tool) => tool.name)).toEqual(["ssh_hosts", "ssh_host_save", "ssh_host_delete", "ssh_connect", "ssh_trust_fingerprint", "ssh_exec", "ssh_write", "ssh_read", "ssh_close", "ssh_upload", "ssh_download"]);
  });

  it("honors the live master switch on every tool", async () => {
    const { tools } = createHarness({ enabled: false });
    const payloads: Record<string, unknown> = {
      ssh_hosts: {},
      ssh_host_save: { name: "prod", address: "10.0.0.8", username: "root" },
      ssh_host_delete: { host: "prod" },
      ssh_connect: { host: "prod" },
      ssh_trust_fingerprint: { host: "prod" },
      ssh_exec: { command: "uptime" },
      ssh_write: { data: "y" },
      ssh_read: {},
      ssh_close: {},
      ssh_upload: { localPath: "a.txt", remoteDir: "/root" },
      ssh_download: { remotePath: "/root/a.txt" }
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
    expect(requests).toEqual([{ request: { op: "exec", command: "uptime", timeoutMs: 90_000 }, timeoutMs: undefined }]);
    expect(JSON.stringify(result)).toContain("退出码：0");
  });

  it("rejects an out-of-workspace upload path without any RPC", async () => {
    const { tools, requests } = createHarness();
    const tool = toolByName(tools, "ssh_upload");
    await expect(tool.execute("id", { localPath: "/etc/passwd", remoteDir: "/root" }, undefined, undefined, undefined as never)).rejects.toThrow("工作区内");
    expect(requests).toHaveLength(0);
  });

  it("resolves the upload path and passes the idle budget through, with a generous outer watchdog", async () => {
    const { tools, requests } = createHarness({
      result: { ok: true, data: { kind: "upload", remotePath: "/root/app.zip", name: "app.zip", bytes: 42 } }
    });
    const tool = toolByName(tools, "ssh_upload");
    const result = await tool.execute("id", { localPath: "dist/app.zip", remoteDir: "/root", timeoutSeconds: 120 }, undefined, undefined, undefined as never);
    // timeoutMs 进请求（= 主进程的空闲预算）；外层看门狗固定宽于主进程自己的总时长上限，
    // 不能跟着工具参数缩（否则「进度正常但慢」的大文件会被外层先掐断）。
    expect(requests).toEqual([{
      request: { op: "upload", localPath: "/ws/dist/app.zip", remoteDir: "/root", timeoutMs: 120_000 },
      timeoutMs: TRANSFER_OUTER_TIMEOUT_MS
    }]);
    expect(JSON.stringify(result)).toContain("/root/app.zip");
  });

  it("tells the model when an upload was completed by the remote-size check", async () => {
    // 降级完成（最后一个确认没回来、按远端大小核对为完整）必须进回执，不能被当成正常路径。
    const { tools } = createHarness({
      result: { ok: true, data: { kind: "upload", remotePath: "/root/a.txt", name: "a.txt", bytes: 3, note: "已按远端文件大小核对为完整" } }
    });
    const tool = toolByName(tools, "ssh_upload");
    const result = await tool.execute("id", { localPath: "a.txt", remoteDir: "/root" }, undefined, undefined, undefined as never);
    expect(JSON.stringify(result)).toContain("已按远端文件大小核对为完整");
  });

  it("mentions the auto-rename when the remote name changed", async () => {
    const { tools } = createHarness({
      result: { ok: true, data: { kind: "upload", remotePath: "/root/a-1.txt", name: "a-1.txt", bytes: 3 } }
    });
    const tool = toolByName(tools, "ssh_upload");
    const result = await tool.execute("id", { localPath: "a.txt", remoteDir: "/root" }, undefined, undefined, undefined as never);
    expect(JSON.stringify(result)).toContain("自动改名");
  });

  it("reports the workspace-relative path after a download", async () => {
    const { tools, requests } = createHarness({
      result: { ok: true, data: { kind: "download", localPath: "/ws/.pidesktop/downloads/app.log", name: "app.log", bytes: 7 } }
    });
    const tool = toolByName(tools, "ssh_download");
    const result = await tool.execute("id", { remotePath: "/var/log/app.log" }, undefined, undefined, undefined as never);
    expect(requests).toEqual([{ request: { op: "download", remotePath: "/var/log/app.log", localDir: "/ws/.pidesktop/downloads" }, timeoutMs: TRANSFER_OUTER_TIMEOUT_MS }]);
    expect(JSON.stringify(result)).toContain(".pidesktop/downloads/app.log");
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

  it("forwards a host save without a password and tells the model to ask for one", async () => {
    const { tools, requests } = createHarness({
      result: { ok: true, data: { kind: "host-saved", host: { id: "ssh-1", name: "staging", host: "10.0.0.9", port: 2222, username: "deploy", hasPassword: false } } }
    });
    const tool = toolByName(tools, "ssh_host_save");
    const result = await tool.execute("id", { name: "staging", address: "10.0.0.9", username: "deploy", port: 2222, groupName: "生产环境" }, undefined, undefined, undefined as never);
    expect(requests).toEqual([{
      request: { op: "host-save", draft: { name: "staging", host: "10.0.0.9", username: "deploy", port: 2222, groupName: "生产环境" } },
      timeoutMs: undefined
    }]);
    // 无密码是刻意的：回执必须直接告诉模型「要请用户补录密码」。
    expect(JSON.stringify(result)).toContain("补录密码");
  });

  it("passes target through when editing a host, and validates required fields first", async () => {
    const { tools, requests } = createHarness({
      result: { ok: true, data: { kind: "host-saved", host: { id: "ssh-1", name: "prod-2", host: "10.0.0.8", port: 22, username: "root", hasPassword: true } } }
    });
    const tool = toolByName(tools, "ssh_host_save");
    await expect(tool.execute("id", { name: "  ", address: "10.0.0.8", username: "root" }, undefined, undefined, undefined as never)).rejects.toThrow("主机显示名");
    await expect(tool.execute("id", { name: "prod", address: "", username: "root" }, undefined, undefined, undefined as never)).rejects.toThrow("主机地址");
    await expect(tool.execute("id", { name: "prod", address: "10.0.0.8", username: " " }, undefined, undefined, undefined as never)).rejects.toThrow("登录用户名");
    expect(requests).toHaveLength(0);
    const result = await tool.execute("id", { name: "prod-2", address: "10.0.0.8", username: "root", target: "prod" }, undefined, undefined, undefined as never);
    expect(requests[0]!.request).toEqual({ op: "host-save", draft: { name: "prod-2", host: "10.0.0.8", username: "root" }, target: "prod" });
    // 已有密码的主机不再重复提醒。
    expect(JSON.stringify(result)).not.toContain("补录密码");
  });

  it("forwards fingerprint trust and renders both the first-time and idempotent receipts", async () => {
    const first = createHarness({
      result: { ok: true, data: { kind: "trust-host", hostName: "prod", host: "10.0.0.8", fingerprint: "SHA256:abc", alreadyTrusted: false } }
    });
    const tool = toolByName(first.tools, "ssh_trust_fingerprint");
    const result = await tool.execute("id", { host: "prod" }, undefined, undefined, undefined as never);
    expect(first.requests[0]!.request).toEqual({ op: "trust-host", host: "prod" });
    expect(JSON.stringify(result)).toContain("SHA256:abc");
    // 重复信任要能看出「本来就在库里」，否则模型会以为刚写了新指纹。
    const again = createHarness({
      result: { ok: true, data: { kind: "trust-host", hostName: "prod", host: "10.0.0.8", fingerprint: "SHA256:abc", alreadyTrusted: true } }
    });
    const againResult = await toolByName(again.tools, "ssh_trust_fingerprint").execute("id", { host: "prod", fingerprint: "SHA256:abc" }, undefined, undefined, undefined as never);
    expect(again.requests[0]!.request).toEqual({ op: "trust-host", host: "prod", fingerprint: "SHA256:abc" });
    expect(JSON.stringify(againResult)).toContain("已在信任列表");
  });

  it("rejects an empty host name before any RPC for trust and delete", async () => {
    const { tools, requests } = createHarness();
    await expect(toolByName(tools, "ssh_trust_fingerprint").execute("id", { host: "  " }, undefined, undefined, undefined as never)).rejects.toThrow("主机名称");
    await expect(toolByName(tools, "ssh_host_delete").execute("id", {}, undefined, undefined, undefined as never)).rejects.toThrow("主机名称");
    expect(requests).toHaveLength(0);
  });

  it("forwards host deletion and names the removed host in the receipt", async () => {
    const { tools, requests } = createHarness({
      result: { ok: true, data: { kind: "host-deleted", hostName: "prod" } }
    });
    const result = await toolByName(tools, "ssh_host_delete").execute("id", { host: "prod" }, undefined, undefined, undefined as never);
    expect(requests[0]!.request).toEqual({ op: "host-delete", host: "prod" });
    expect(JSON.stringify(result)).toContain("prod");
  });
});
