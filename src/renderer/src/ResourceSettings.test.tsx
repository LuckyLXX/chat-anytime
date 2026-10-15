// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfigDraft, McpServerSummary, ResourceCatalog, RuntimeCommand } from "../../shared/protocol";
import { ResourceSettings } from "./ResourceSettings";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * MCP 表单的命令载荷回归网（新增字段最容易静默丢失的地方：
 * 表单 → RuntimeCommand 这一段没有类型约束之外的护栏，字段名写错就白填）。
 * 覆盖 2026-10-15 新增的 OAuth 高级选项与每服务器 timeout：
 * ① 新增 HTTP 服务器时把预注册客户端等字段装进 mcp.server.save；
 * ② 编辑已有服务器时回填并随 original 一起提交（含 callbackPort 的数字往返）。
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function serverSummary(partial: Partial<McpServerSummary>): McpServerSummary {
  return {
    name: "exa",
    scope: "global",
    transport: "http",
    url: "https://mcp.example/mcp",
    auth: "none",
    status: "connected",
    toolCount: 3,
    disabled: false,
    ...partial
  };
}

async function render(servers: McpServerSummary[]): Promise<void> {
  const resources = { mcpServers: servers, skills: [], commands: [], diagnostics: [] } as unknown as ResourceCatalog;
  await act(async () => {
    root.render(<ResourceSettings resources={resources} />);
  });
}

function inputByLabel(label: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const labels = [...container.querySelectorAll("label")];
  const match = labels.find((element) => element.textContent?.startsWith(label));
  if (!match) throw new Error(`找不到标签为「${label}」的表单项`);
  const field = match.querySelector("input, textarea, select");
  if (!field) throw new Error(`「${label}」没有输入控件`);
  return field as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}

function setValue(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

describe("ResourceSettings 的 MCP 表单载荷", () => {
  it("新增 HTTP 服务器：OAuth 高级选项与 timeout 进入 mcp.server.save", async () => {
    const send = vi.fn(async (_command: RuntimeCommand) => undefined);
    vi.stubGlobal("window", { ...globalThis.window, piDesktop: { send } });
    await render([]);

    // 展开添加表单 → 切到 HTTP
    const addButton = container.querySelector('[data-control="mcp-add"]') as HTMLButtonElement;
    await act(async () => addButton.click());
    setValue(inputByLabel("名称") as HTMLInputElement, "ent");
    setValue(inputByLabel("连接方式") as HTMLSelectElement, "http");
    setValue(inputByLabel("服务器地址") as HTMLInputElement, "https://ent.example/mcp");
    setValue(inputByLabel("认证") as HTMLSelectElement, "oauth");
    setValue(inputByLabel("超时") as HTMLInputElement, "300");

    // 展开 OAuth 高级选项并填写
    const advanced = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("OAuth 高级选项")) as HTMLButtonElement;
    expect(advanced).toBeTruthy();
    await act(async () => advanced.click());
    setValue(inputByLabel("客户端 ID") as HTMLInputElement, "cid");
    setValue(inputByLabel("客户端密钥") as HTMLInputElement, "${SECRET}");
    setValue(inputByLabel("回调地址") as HTMLInputElement, "http://127.0.0.1:1456/callback");
    setValue(inputByLabel("回调端口") as HTMLInputElement, "1456");
    setValue(inputByLabel("授权范围") as HTMLInputElement, "read write");
    setValue(inputByLabel("客户端注册") as HTMLSelectElement, "cimd");
    setValue(inputByLabel("授权服务器元数据") as HTMLInputElement, "https://as.example/.well-known");

    const submit = container.querySelector('[data-control="mcp-save"]') as HTMLButtonElement;
    await act(async () => submit.click());
    await act(async () => {});

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]![0];
    if (command.type !== "mcp.server.save") throw new Error("应为 mcp.server.save");
    expect(command.type).toBe("mcp.server.save");
    expect(command.server as unknown as Record<string, unknown>).toMatchObject({
      name: "ent",
      scope: "project",
      transport: "http",
      url: "https://ent.example/mcp",
      auth: "oauth",
      timeout: 300,
      oauth: {
        clientId: "cid",
        clientSecret: "${SECRET}",
        callbackUrl: "http://127.0.0.1:1456/callback",
        callbackPort: 1456,
        scope: "read write",
        clientRegistration: "cimd",
        authServerMetadataUrl: "https://as.example/.well-known"
      }
    });
    expect(command.original).toBeUndefined();
  });

  it("编辑已有服务器：高级字段回填并随 original 提交；留空字段不下发", async () => {
    const send = vi.fn(async (_command: RuntimeCommand) => undefined);
    vi.stubGlobal("window", { ...globalThis.window, piDesktop: { send } });
    await render([
      serverSummary({
        name: "ent",
        oauth: { clientId: "cid", callbackPort: 1456, scope: "read" },
        timeout: 300
      })
    ]);

    const editButton = container.querySelector('[aria-label="编辑 MCP ent"]') as HTMLButtonElement;
    await act(async () => editButton.click());

    // 回填断言：高级块自动展开，字段带出已存值
    expect(inputByLabel("客户端 ID")).toHaveProperty("value", "cid");
    expect(inputByLabel("回调端口")).toHaveProperty("value", "1456");
    expect(inputByLabel("授权范围")).toHaveProperty("value", "read");
    expect(inputByLabel("超时")).toHaveProperty("value", "300");

    // 清空「授权范围」→ 提交时不应再下发 scope
    setValue(inputByLabel("授权范围") as HTMLInputElement, "");
    const submit = container.querySelector('[data-control="mcp-save"]') as HTMLButtonElement;
    await act(async () => submit.click());
    await act(async () => {});

    const command = send.mock.calls[0]![0] as { type: string; server: Record<string, unknown>; original: unknown };
    expect(command.type).toBe("mcp.server.save");
    expect(command.original).toEqual({ name: "ent", scope: "global" });
    expect(command.server).toMatchObject({ timeout: 300, oauth: { clientId: "cid", callbackPort: 1456 } });
    expect((command.server.oauth as Record<string, unknown>).scope).toBeUndefined();
  });

  it("Bearer 环境变量模式：不下发 oauth 高级字段（OAuth 判定不会生效）", async () => {
    const send = vi.fn(async (_command: RuntimeCommand) => undefined);
    vi.stubGlobal("window", { ...globalThis.window, piDesktop: { send } });
    await render([]);
    const addButton = container.querySelector('[data-control="mcp-add"]') as HTMLButtonElement;
    await act(async () => addButton.click());
    setValue(inputByLabel("名称") as HTMLInputElement, "gw");
    setValue(inputByLabel("连接方式") as HTMLSelectElement, "http");
    setValue(inputByLabel("服务器地址") as HTMLInputElement, "https://gw.example/mcp");
    setValue(inputByLabel("认证") as HTMLSelectElement, "bearer-env");
    setValue(inputByLabel("Token 环境变量") as HTMLInputElement, "GW_TOKEN");
    const submit = container.querySelector('[data-control="mcp-save"]') as HTMLButtonElement;
    await act(async () => submit.click());
    await act(async () => {});
    const command = send.mock.calls[0]![0];
    if (command.type !== "mcp.server.save") throw new Error("应为 mcp.server.save");
    const server = command.server as McpServerConfigDraft;
    expect(server.oauth).toBeUndefined();
    expect(server.bearerTokenEnv).toBe("GW_TOKEN");
    // Bearer 模式下「OAuth 高级选项」按钮不出现
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("OAuth 高级选项"))).toBe(false);
  });
});
