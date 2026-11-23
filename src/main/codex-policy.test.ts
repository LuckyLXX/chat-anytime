import { describe, expect, it } from "vitest";
import {
  buildCodexServerArgs,
  CODEX_HARDENING_CONFIG,
  decideCodexWindowsSandboxReadiness,
  inspectCodexEffectiveConfig,
  isCodexWindowsPlatform,
  readCodexWindowsSandboxReadiness,
  codexMcpDisableArgs,
  codexMcpServerNamesFromToml,
  codexWorkspaceWriteSandbox,
  decideCodexServerRequest,
  isCodexApprovalMethod,
  resolveCodexTurnPolicy,
  assertCodexTurnPolicy
} from "./codex-policy.js";

/**
 * C 阶段的权限边界（纯函数）：逐轮裁决、下发前的沙箱自检、服务端请求的方法对应拒绝、
 * 以及启动参数里的配置加固。这些点漏一个就是「看板显示只读、实际写满了工作区」。
 */

const WORKSPACE = "D:\\temp\\ws";

describe("resolveCodexTurnPolicy", () => {
  it("defaults to a network-less readOnly sandbox with approvalPolicy never", () => {
    const result = resolveCodexTurnPolicy({ access: "read-only", leadMode: "full", workspace: WORKSPACE });
    expect(result.access).toBe("read-only");
    expect(result.requiresRoundApproval).toBe(false);
    expect(result.policy).toEqual({
      cwd: WORKSPACE,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      approvalPolicy: "never"
    });
  });

  it("keeps a read-only Lead session read-only even when the config allows writes", () => {
    const result = resolveCodexTurnPolicy({ access: "workspace-write", leadMode: "read-only", workspace: WORKSPACE });
    expect(result.access).toBe("read-only");
    expect(result.requiresRoundApproval).toBe(false);
    expect(result.note).toContain("Lead 会话是只读模式");
  });

  it("requires the one-round confirmation in ask mode", () => {
    const result = resolveCodexTurnPolicy({ access: "workspace-write", leadMode: "ask", workspace: WORKSPACE });
    expect(result.access).toBe("workspace-write");
    expect(result.requiresRoundApproval).toBe(true);
    expect(result.policy.sandboxPolicy).toEqual(codexWorkspaceWriteSandbox(WORKSPACE));
  });

  it("grants workspace writes without a card in workspace/full mode", () => {
    for (const leadMode of ["workspace", "full"] as const) {
      const result = resolveCodexTurnPolicy({ access: "workspace-write", leadMode, workspace: WORKSPACE });
      expect(result.access).toBe("workspace-write");
      expect(result.requiresRoundApproval).toBe(false);
    }
  });

  it("limits writable roots to the workspace and excludes implicit temp dirs", () => {
    const sandbox = codexWorkspaceWriteSandbox(WORKSPACE);
    expect(sandbox).toEqual({
      type: "workspaceWrite",
      writableRoots: [WORKSPACE],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true
    });
  });
});

describe("assertCodexTurnPolicy", () => {
  const ok = resolveCodexTurnPolicy({ access: "workspace-write", leadMode: "full", workspace: WORKSPACE }).policy;

  it("accepts the policies this module builds", () => {
    expect(() => assertCodexTurnPolicy(ok, { access: "workspace-write", workspace: WORKSPACE })).not.toThrow();
    const readOnly = resolveCodexTurnPolicy({ access: "read-only", leadMode: "full", workspace: WORKSPACE }).policy;
    expect(() => assertCodexTurnPolicy(readOnly, { access: "read-only", workspace: WORKSPACE })).not.toThrow();
  });

  it("rejects any attempt to widen the side-effect boundary", () => {
    const widened = (patch: Partial<typeof ok>): void => {
      const policy = { ...ok, ...patch };
      expect(() => assertCodexTurnPolicy(policy, { access: "workspace-write", workspace: WORKSPACE })).toThrow();
    };
    // Codex 自己申请审批 = 允许它用 PiDesktop 的授权换更大的沙箱。
    widened({ approvalPolicy: "on-request" });
    // 写入根被塞进工作区之外。
    widened({ sandboxPolicy: { type: "workspaceWrite", writableRoots: [WORKSPACE, "C:\\Windows"], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } });
    // 网络打开。
    widened({ sandboxPolicy: { ...codexWorkspaceWriteSandbox(WORKSPACE), networkAccess: true } as never });
    // 隐式临时目录没排除。
    widened({ sandboxPolicy: { type: "workspaceWrite", writableRoots: [WORKSPACE], networkAccess: false } as never });
    // cwd 不在工作区。
    widened({ cwd: "C:\\Windows" });
  });

  it("rejects a workspaceWrite sandbox for a read-only turn", () => {
    expect(() => assertCodexTurnPolicy(ok, { access: "read-only", workspace: WORKSPACE })).toThrow(/readOnly/u);
    const readOnly = resolveCodexTurnPolicy({ access: "read-only", leadMode: "full", workspace: WORKSPACE }).policy;
    expect(() => assertCodexTurnPolicy({ ...readOnly, sandboxPolicy: { ...readOnly.sandboxPolicy, networkAccess: true } as never }, { access: "read-only", workspace: WORKSPACE })).toThrow(/网络/u);
  });
});

describe("buildCodexServerArgs", () => {
  it("disables user hooks, plugins, apps and notify", () => {
    const args = buildCodexServerArgs();
    expect(args[0]).toBe("app-server");
    const configs = args.slice(1).filter((_, index) => index % 2 === 1);
    expect(configs).toEqual([
      "features.hooks=false",
      "features.plugins=false",
      "features.apps=false",
      "notify=[]"
    ]);
    // 每一对都是 `-c <key=value>`，不拼 shell、不带空格拼串。
    for (let index = 1; index < args.length; index += 2) expect(args[index]).toBe("-c");
    expect(args.join("\n")).not.toMatch(/[;&|`$]/u);
  });

  it("keeps the hardening list the single source of truth", () => {
    expect(CODEX_HARDENING_CONFIG.length).toBe(4);
    expect(buildCodexServerArgs(["model=\"o3\""])).toEqual([
      "app-server",
      ...CODEX_HARDENING_CONFIG.flatMap((entry) => ["-c", entry]),
      "-c",
      "model=\"o3\""
    ]);
  });
});

describe("user MCP server hardening", () => {
  it("reads server names from the user config's table headers only", () => {
    const toml = [
      'model = "gpt-5"',
      "[mcp_servers.node_repl]",
      'command = "node"',
      "[mcp_servers.node_repl.env]",
      'FOO = "bar"',
      '[mcp_servers."my server"]',
      "enabled = true",
      "[tui]",
      "screen_reader_detection_done = true"
    ].join("\n");
    expect(codexMcpServerNamesFromToml(toml)).toEqual(["node_repl", "my server"]);
    expect(codexMcpServerNamesFromToml("")).toEqual([]);
  });

  it("builds one disable switch per server (整表覆盖实测无效，只能逐名关)", () => {
    expect(codexMcpDisableArgs(["a", "b"])).toEqual([
      "mcp_servers.a.enabled=false",
      "mcp_servers.b.enabled=false"
    ]);
    expect(buildCodexServerArgs(codexMcpDisableArgs(["a"]))).toEqual([
      "app-server", "-c", "features.hooks=false", "-c", "features.plugins=false", "-c", "features.apps=false", "-c", "notify=[]", "-c", "mcp_servers.a.enabled=false"
    ]);
  });
});

describe("decideCodexServerRequest", () => {
  it("declines command / file-change approvals with the protocol's own vocabulary", () => {
    expect(decideCodexServerRequest({ id: 1, method: "item/commandExecution/requestApproval", params: {} }, { workspace: WORKSPACE }))
      .toEqual({ kind: "result", result: { decision: "decline" } });
    expect(decideCodexServerRequest({ id: 2, method: "item/fileChange/requestApproval", params: {} }, { workspace: WORKSPACE }))
      .toEqual({ kind: "result", result: { decision: "decline" } });
    // 旧版方法用 ReviewDecision 词表（denied）。
    expect(decideCodexServerRequest({ id: 3, method: "execCommandApproval", params: {} }, { workspace: WORKSPACE }))
      .toEqual({ kind: "result", result: { decision: "denied" } });
    expect(decideCodexServerRequest({ id: 4, method: "applyPatchApproval", params: {} }, { workspace: WORKSPACE }))
      .toEqual({ kind: "result", result: { decision: "denied" } });
  });

  it("refuses permission escalation with an RPC error that names the boundary", () => {
    const decision = decideCodexServerRequest({ id: 5, method: "item/permissions/requestApproval", params: {} }, { workspace: WORKSPACE });
    expect(decision.kind).toBe("error");
    if (decision.kind !== "error") throw new Error("unreachable");
    expect(decision.message).toContain(WORKSPACE);
  });

  it("always answers — every unknown request is an explicit error, never a hang", () => {
    for (const method of [
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
      "item/tool/call",
      "account/chatgptAuthTokens/refresh",
      "attestation/generate",
      "something/brand-new"
    ]) {
      const decision = decideCodexServerRequest({ id: method, method, params: {} }, { workspace: WORKSPACE });
      expect(decision.kind).toBe("error");
      if (decision.kind !== "error") throw new Error("unreachable");
      expect(decision.message).toContain(method);
    }
  });

  it("knows which methods are approval requests", () => {
    expect(isCodexApprovalMethod("item/commandExecution/requestApproval")).toBe(true);
    expect(isCodexApprovalMethod("item/permissions/requestApproval")).toBe(false);
  });
});

describe("Windows 沙箱就绪（真实握手口径）", () => {
  it("reads the readiness enum and only accepts ready", () => {
    expect(readCodexWindowsSandboxReadiness({ status: "ready" })).toBe("ready");
    expect(readCodexWindowsSandboxReadiness({ status: "notConfigured" })).toBe("notConfigured");
    expect(readCodexWindowsSandboxReadiness({ status: "updateRequired" })).toBe("updateRequired");
    expect(readCodexWindowsSandboxReadiness({ status: "somethingElse" })).toBe("unknown");
    expect(readCodexWindowsSandboxReadiness(null)).toBe("unknown");
    expect(decideCodexWindowsSandboxReadiness({ readiness: "ready" })).toEqual({ ok: true });
    for (const readiness of ["notConfigured", "updateRequired", "unknown"] as const) {
      const decision = decideCodexWindowsSandboxReadiness({ readiness });
      expect(decision.ok).toBe(false);
      expect(decision.reason).toContain("只读与工作区写入");
    }
  });

  it("fails closed when the CLI does not support the readiness call", () => {
    const decision = decideCodexWindowsSandboxReadiness({ error: "Codex 请求失败（windowsSandbox/readiness）：method not found" });
    expect(decision.ok).toBe(false);
    expect(decision.reason).toContain("windowsSandbox/readiness 调用失败");
    expect(decision.reason).toContain("两种访问级别都被拦下");
  });

  it("detects Windows from either platform family or OS spelling", () => {
    expect(isCodexWindowsPlatform({ platformFamily: "windows", platformOs: "win32" })).toBe(true);
    expect(isCodexWindowsPlatform({ platformFamily: "unix", platformOs: "win32" })).toBe(true);
    expect(isCodexWindowsPlatform({ platformFamily: "unix", platformOs: "linux" })).toBe(false);
    expect(isCodexWindowsPlatform({})).toBe(false);
  });
});

describe("生效配置隔离检查（config/read）", () => {
  const hardened = { config: { features: { hooks: false, apps: false, plugins: false }, mcp_servers: {}, notify: [] } };

  it("accepts the hardened effective config", () => {
    expect(inspectCodexEffectiveConfig(hardened)).toEqual({ ok: true, enabledMcpServers: [] });
    // mcp_servers / notify 缺省 = 没有配置，也算干净。
    expect(inspectCodexEffectiveConfig({ config: { features: { hooks: false, apps: false, plugins: false } } })).toMatchObject({ ok: true });
  });

  it("fails closed on extensions, MCP servers or notify that are still effective", () => {
    const hooks = inspectCodexEffectiveConfig({ config: { ...hardened.config, features: { hooks: true, apps: false, plugins: false } } });
    expect(hooks.ok).toBe(false);
    expect(hooks.reason).toContain("hooks");

    const missingFeature = inspectCodexEffectiveConfig({ config: { ...hardened.config, features: { hooks: false, apps: false } } });
    expect(missingFeature.ok).toBe(false);

    const mcp = inspectCodexEffectiveConfig({
      config: {
        ...hardened.config,
        mcp_servers: { allowed: { enabled: false }, leaked: { command: "node", enabled: true }, implied: { command: "node" } }
      }
    });
    expect(mcp.ok).toBe(false);
    expect(mcp.enabledMcpServers).toEqual(["implied", "leaked"]);

    const notify = inspectCodexEffectiveConfig({ config: { ...hardened.config, notify: ["node", "notify.js"] } });
    expect(notify.ok).toBe(false);
    expect(notify.reason).toContain("notify");
  });

  it("fails closed when the effective config cannot be proven (missing config/features)", () => {
    expect(inspectCodexEffectiveConfig(undefined).ok).toBe(false);
    expect(inspectCodexEffectiveConfig({}).reason).toContain("缺少 config");
    expect(inspectCodexEffectiveConfig({ config: {} }).reason).toContain("features");
    // features 形状不对（非表）也算证明不了。
    expect(inspectCodexEffectiveConfig({ config: { features: [] } }).ok).toBe(false);
  });
});
