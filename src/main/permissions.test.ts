import { describe, expect, it } from "vitest";
import { pathLeavesWorkspace, permissionAction, permissionNeedsApproval, permissionScope, toolRisk } from "./permissions.js";

describe("desktop tool permissions", () => {
  const workspace = "D:\\projects\\sample";

  it("allows read-only paths inside the selected workspace", () => {
    expect(pathLeavesWorkspace(workspace, "src/index.ts")).toBe(false);
    expect(toolRisk(workspace, "read", { path: "src/index.ts" })).toBeUndefined();
  });

  it("requires approval for paths outside the selected workspace", () => {
    expect(pathLeavesWorkspace(workspace, "..\\secrets.txt")).toBe(true);
    expect(toolRisk(workspace, "read", { path: "..\\secrets.txt" })).toBe("outside-workspace");
  });

  it("separates ordinary write approval from outside-workspace approval", () => {
    const writeScope = permissionScope("write", toolRisk(workspace, "write", { path: "src/new.ts" })!);
    const outsideScope = permissionScope("write", toolRisk(workspace, "write", { path: "..\\new.ts" })!);
    expect(writeScope).toBe("write:write");
    expect(outsideScope).toBe("write:outside-workspace");
    expect(writeScope).not.toBe(outsideScope);
  });

  it("requires approval for every command scope", () => {
    expect(toolRisk(workspace, "bash", { command: "npm test" })).toBe("command");
    expect(toolRisk(workspace, "powershell", { command: "Remove-Item -Recurse build" })).toBe("command");
  });

  it("keeps the default mode asking for every risky operation", () => {
    expect(permissionNeedsApproval("ask", "bash", "command")).toBe(true);
    expect(permissionNeedsApproval("ask", "write", "write")).toBe(true);
    expect(permissionNeedsApproval("ask", "read", "outside-workspace")).toBe(true);
  });

  it("automatically allows workspace file writes but still asks for commands and outside paths", () => {
    expect(permissionAction("workspace", "write", "write")).toBe("allow");
    expect(permissionAction("workspace", "bash", "command")).toBe("ask");
    expect(permissionAction("workspace", "read", "outside-workspace")).toBe("ask");
  });

  it("treats ssh_* as remote-irreversible: deny read-only, ask in workspace, allow in full", () => {
    // 云服务器命令无 checkpoint 可回滚，workspace 模式不自动放行；权限卡的
    // allow-session 是保留的自动放行路径。
    expect(toolRisk(undefined, "ssh_exec", { command: "rm -rf /tmp/x" })).toBe("ssh");
    expect(toolRisk(undefined, "ssh_connect", { host: "prod" })).toBe("ssh");
    expect(toolRisk(undefined, "ssh_write", { data: "y\n" })).toBe("ssh");
    expect(toolRisk(undefined, "ssh_close", {})).toBe("ssh");
    // 文件传输同轴：下载是把不可信远端字节落进本地盘，与 exec 同级待确认。
    expect(toolRisk(undefined, "ssh_upload", { localPath: "a.txt", remoteDir: "/root" })).toBe("ssh");
    expect(toolRisk(undefined, "ssh_download", { remotePath: "/var/log/app.log" })).toBe("ssh");
    expect(toolRisk(undefined, "ssh_hosts", {})).toBeUndefined();
    expect(toolRisk(undefined, "ssh_read", {})).toBeUndefined();
    expect(permissionAction("read-only", "ssh_exec", "ssh")).toBe("deny");
    expect(permissionAction("workspace", "ssh_exec", "ssh")).toBe("ask");
    expect(permissionAction("full", "ssh_exec", "ssh")).toBe("allow");
    expect(permissionNeedsApproval("workspace", "ssh_exec", "ssh")).toBe(true);
    expect(permissionAction("read-only", "ssh_upload", "ssh")).toBe("deny");
    expect(permissionAction("read-only", "ssh_download", "ssh")).toBe("deny");
    expect(permissionAction("workspace", "ssh_download", "ssh")).toBe("ask");
    expect(permissionAction("full", "ssh_upload", "ssh")).toBe("allow");
  });

  it("blocks mutating tools in read-only mode", () => {
    expect(permissionAction("read-only", "write", "write")).toBe("deny");
    expect(permissionAction("read-only", "edit", "write")).toBe("deny");
    expect(permissionAction("read-only", "bash", "command")).toBe("deny");
    expect(permissionAction("read-only", "read", "outside-workspace")).toBe("ask");
  });

  it("does not request approval in full access mode", () => {
    expect(permissionNeedsApproval("full", "bash", "command")).toBe(false);
    expect(permissionNeedsApproval("full", "write", "write")).toBe(false);
    expect(permissionNeedsApproval("full", "read", "outside-workspace")).toBe(false);
  });

  it("treats MCP calls as command-risk operations", () => {
    expect(toolRisk(workspace, "mcp", { tool: "search" })).toBe("command");
    expect(toolRisk(workspace, "server_docs_search", {})).toBe("command");
    expect(permissionAction("read-only", "mcp", "command")).toBe("deny");
    expect(permissionNeedsApproval("ask", "mcp", "command")).toBe(true);
  });

  it("gates design doc writes as write-risk (workspace mode auto-allows)", () => {
    expect(toolRisk(workspace, "design_update", { ops: [] })).toBe("write");
    expect(toolRisk(workspace, "design_export", { path: "designs/exports/a.html" })).toBe("write");
    // design_set_guide 也是真实落盘（改文档 guide 字段 + 推进 revision），与 update 同门。
    expect(toolRisk(workspace, "design_set_guide", { name: "ai-product-dark" })).toBe("write");
    expect(permissionAction("read-only", "design_set_guide", "write")).toBe("deny");
    // 免门：读取/列表/新建绑定类操作。
    expect(toolRisk(workspace, "design_list", {})).toBeUndefined();
    expect(toolRisk(workspace, "design_guides", { brief: "咖啡 App" })).toBeUndefined();
    expect(toolRisk(workspace, "design_create", { name: "登录页" })).toBeUndefined();
    expect(toolRisk(workspace, "design_open", { name: "登录页" })).toBeUndefined();
    expect(toolRisk(workspace, "design_read", {})).toBeUndefined();
    expect(permissionAction("workspace", "design_update", "write")).toBe("allow");
    expect(permissionAction("ask", "design_update", "write")).toBe("ask");
    expect(permissionAction("read-only", "design_update", "write")).toBe("deny");
  });

  it("gates browser navigation through the browse risk", () => {
    expect(toolRisk(workspace, "browser_navigate", { url: "https://example.com" })).toBe("browse");
    expect(toolRisk(workspace, "browser_snapshot", {})).toBeUndefined();
    expect(toolRisk(workspace, "browser_click", { ref: "@e1" })).toBeUndefined();
    expect(permissionAction("ask", "browser_navigate", "browse")).toBe("ask");
    expect(permissionAction("read-only", "browser_navigate", "browse")).toBe("deny");
    expect(permissionAction("full", "browser_navigate", "browse")).toBe("allow");
    // 工作区模式不覆盖网络动作：仍需询问。
    expect(permissionAction("workspace", "browser_navigate", "browse")).toBe("ask");
  });

  it("gates write-mode browser eval but lets read-mode eval through", () => {
    expect(toolRisk(workspace, "browser_eval", { expression: "document.title", mode: "read" })).toBeUndefined();
    expect(toolRisk(workspace, "browser_eval", { expression: "document.body.remove()", mode: "write" })).toBe("browse");
    expect(permissionAction("read-only", "browser_eval", "browse")).toBe("deny");
    expect(permissionNeedsApproval("ask", "browser_eval", "browse")).toBe(true);
  });

  it("leaves browser_save_image ungated, same as browser_screenshot", () => {
    // 两者都是「AI 把看到的内容落到 .pidesktop/ 下的观察产物」：写盘目标是自动化
    // 标签页的下载目录（网页自己触发的下载也不走权限门），不写用户工作区文件。
    // 这条钉住口径，防止日后被“加门”成相对 browser_screenshot 的不一致行为。
    expect(toolRisk(workspace, "browser_save_image", { selector: "img.hero" })).toBeUndefined();
    expect(toolRisk(workspace, "browser_save_image", { url: "https://example.com/a.png" })).toBeUndefined();
    expect(toolRisk(workspace, "browser_screenshot", { selector: "img.hero" })).toBeUndefined();
  });
});
