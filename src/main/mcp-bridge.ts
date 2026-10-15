// MCP → Pi 内置扩展的桥接层（2026-10-15 迁移）。
//
// 连接、工具注册、OAuth、生命周期全部交给 Pi 的内置 MCP 扩展
// （`createMcpExtension`，经 extensionFactories 注入、`noExtensions:true` 保持
// 不动）。本模块提供三件事：
//
// 1. `createPidesktopMcpBridge` —— app 自有内联扩展：工厂期把双作用域配置
//    （`.mcp.json` / `mcp.json`，含方言翻译）逐台 `pi.registerMcpServer` 注册。
//    所有服务器都走 extension 注册而非 loadConfig —— 这样动态增删改 =
//    register/unregister（unregister 原生关连接并移除工具），彻底告别
//    「删除/停用服务器必须整会话重建」的旧路径；mcp.json 同名优先规则也无从
//    干扰（loadConfig 恒返回空）。角色级 `mcp:<server>` overlay 禁用的服务器
//    以 `exposure:"hidden"` 注册：工具进注册表但不声明给模型（零前缀成本），
//    overlay 翻转走会话重建（与迁移前一致）。
// 2. `buildMcpUiContext` —— `bindExtensions({uiContext, mode:"rpc"})` 的宿主
//    UI 上下文：notify 收敛到回调（状态板解析 + 日志），input 限时返回
//    undefined（OAuth 回调不可达时的粘贴回退，超时放行不阻塞）。
// 3. `McpBridgeControl` —— 活跃会话的注册表控制柄：save/toggle/delete 命令
//    经 `reapply`/`remove` 热更新注册，无需触碰会话本身。
//
// PoC 依据（.pidesktop/poc-mcp/probe.mjs，2026-10-15 全过）：direct 暴露自动
// 激活；tool_call 事件可拦截（权限门兼容）；/mcp 命令零模型调用且不写会话
// JSONL；unregister 关连接；loadConfig 必须带 `errors: []`。

import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext, InlineExtension, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { piMcpConfigFor, readWorkspaceMcpServers } from "./runtime-mcp.js";
import { readConfiguredMcpServers, type ConfiguredMcpServer } from "./mcp-config.js";

/** 会话启动后等待连接的预算（毫秒）：对齐迁移前的 MCP_OP_TIMEOUT_MS = 15s。 */
export const MCP_STARTUP_WAIT_MS = 15000;
/** uiContext.input 的限时：OAuth 回调不可达时的粘贴回退窗口。超时返回 undefined 放行。 */
const UI_INPUT_TIMEOUT_MS = 90_000;

export interface McpBridgeDeps {
  /** 双作用域配置路径（项目随会话工作区变化，由 pi-runtime 的闭包提供）。 */
  configPaths: () => { project: string; global: string };
  /** 角色级 overlay 禁用的服务器名集合（`mcp:<name>` 键展开后的原始名）。 */
  disabledServers: () => ReadonlySet<string>;
  /** 服务器注册集合变化（register/unregister 后）→ 重推资源目录。 */
  onServersChange: () => void;
  /** uiContext.notify（状态板、登录结果、启动问题汇报都会走这里）。 */
  onNotify: (message: string, type: "info" | "warning" | "error") => void;
}

/**
 * 活跃会话的桥接控制柄：捕获的 `pi`（ExtensionAPI）。`reapply` 用新配置替换
 * 注册（Pi 允许同一扩展重复注册同名替换），`remove` 注销并关连接。控制柄在
 * 每次 `createSession` 时重建（onApi 回调），旧会话 park 后不再接受命令。
 */
export interface McpBridgeControl {
  reapply: (name: string) => void;
  remove: (name: string) => void;
  /**
   * 注销本会话注册过的全部服务器。**会话销毁前必须调**：Pi 的 `dispose()` 不
   * 发 session_shutdown（只有 reload 会），MCP 扩展不会自己关连接，stdio 子进程
   * 会活着占住句柄（实测：dispose 后 10s 子进程仍在、临时目录 EBUSY）。
   */
  unregisterAll: () => void;
  registeredNames: () => string[];
}

/** Pi 内置 MCP 扩展（空 loadConfig + autoEnableCodemode 关死 + 宿主 openUrl）。 */
export function createPiMcpExtensionLayer(deps: { openExternal: (url: string) => void }): InlineExtension {
  const extension = createMcpExtension({
    // loadConfig 必须带 errors: []（PoC 踩坑：缺了 /mcp 状态板抛
    // "configErrors is not iterable"、session_start 的 pending.catch 报错）。
    // 服务器一律经桥接扩展的 registerMcpServer 注册，这里恒为空。
    loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }),
    openUrl: (url) => deps.openExternal(url),
    startupWaitMs: MCP_STARTUP_WAIT_MS
  }) as unknown as InlineExtension;
  // createMcpExtension 返回 ExtensionFactory（函数形态）；InlineExtension 的
  // factory 字段是它的对象等价物。两种形态 Pi 都接受，这里统一成对象形态
  // 便于 extensionFactories 列表混排。
  if (typeof extension === "function") {
    return { name: "builtin-mcp", hidden: true, factory: extension };
  }
  return { ...extension, name: extension.name ?? "builtin-mcp", hidden: true };
}

/**
 * app 自有桥接扩展：工厂期读双作用域配置并逐台注册。工厂在所有扩展 bind 后、
 * session_start 触发前运行（extensionFactories 顺序在本扩展在前、Pi MCP 扩展
 * 在后），因此注册发生在 Pi MCP 扩展读取注册表之前——「extension load 期间
 * 注册的服务器在 session_start 时连接」。
 */
export function createPidesktopMcpBridge(deps: McpBridgeDeps & { onApi?: (control: McpBridgeControl | undefined) => void }): InlineExtension {
  let api: ExtensionAPI | undefined;
  const registered = new Set<string>();

  const registerOne = (pi: ExtensionAPI, server: ConfiguredMcpServer): void => {
    const exposure = deps.disabledServers().has(server.name) ? "hidden" : "direct";
    pi.registerMcpServer(server.name, piMcpConfigFor(server, exposure) as Parameters<ExtensionAPI["registerMcpServer"]>[1]);
    registered.add(server.name);
  };

  return {
    name: "pidesktop-mcp",
    hidden: true,
    factory(pi) {
      api = pi;
      pi.on("mcp_servers_change", () => {
        deps.onServersChange();
      });
      // 配置读失败（项目文件损坏会抛）不阻断会话启动：服务器集合留空，
      // 错误经 notify 面（configErrors 由 /mcp 状态板呈现）。
      let configured: ReturnType<typeof readConfiguredMcpServers> = [];
      try {
        configured = readWorkspaceMcpServers(deps.configPaths().project, deps.configPaths().global);
      } catch (error) {
        deps.onNotify(`MCP 配置读取失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
      for (const server of configured) {
        if (server.entry.disabled) continue; // 停用的不注册（目录里以配置投影显示 disabled）
        try {
          registerOne(pi, server);
        } catch (error) {
          deps.onNotify(`MCP 服务器 ${server.name} 注册失败：${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
      deps.onApi?.({
        reapply: (name: string) => {
          if (!api) throw new Error("MCP 桥接不可用：当前会话没有活跃的扩展上下文");
          const { project, global } = deps.configPaths();
          const target = readWorkspaceMcpServers(project, global).find((server) => server.name === name);
          if (target && !target.entry.disabled) {
            registerOne(api, target);
          } else {
            // 配置没了或停用了：注销即可（unregister 关连接并移除工具）
            api.unregisterMcpServer(name);
            registered.delete(name);
          }
        },
        remove: (name: string) => {
          if (!api) throw new Error("MCP 桥接不可用：当前会话没有活跃的扩展上下文");
          api.unregisterMcpServer(name);
          registered.delete(name);
        },
        unregisterAll: () => {
          if (!api) return;
          for (const name of [...registered]) {
            try {
              api.unregisterMcpServer(name);
            } catch {
              // 单个失败不阻断其余（销毁路径 best-effort）
            }
            registered.delete(name);
          }
        },
        registeredNames: () => [...registered]
      });
    }
  };
}

/**
 * 宿主 UI 上下文：MCP 扩展的全部交互面（notify/登录中的 input）都经这里。
 * notify 是状态通道（/mcp 状态板、登录结果、启动问题）也是日志来源；input
 * 只在 OAuth 回调不可达（浏览器到不了本机回环）时出现，限时返回 undefined
 * 表示「无粘贴输入」，让登录流程自然结束而不是永久挂起。
 *
 * 类型上 ExtensionUIContext 还有一大批 TUI 专属成员（setFooter/setHeader/
 * custom 组件工厂等），MCP 扩展在非 TUI 模式下不会调用；这里以窄对象注入、
 * 用显式 as 收口（运行时未实现的成员一旦被调用会立刻 TypeError，而不是
 * 静默错行为——比实现一堆永远走不到的桩更诚实）。
 */
export function buildMcpUiContext(deps: { onNotify: (message: string, type: "info" | "warning" | "error") => void }): ExtensionUIContext {
  const notify = (message: string, type?: "info" | "warning" | "error") => {
    deps.onNotify(message, type ?? "info");
  };
  return {
    notify,
    input: (title: string) =>
      new Promise<string | undefined>((resolve) => {
        notify(title, "info");
        // OAuth 回调不可达时的粘贴回退窗口：限时放行，不让登录流程永久挂起
        setTimeout(() => resolve(undefined), UI_INPUT_TIMEOUT_MS);
      }),
    select: async (title: string) => {
      notify(title, "info");
      return undefined;
    },
    confirm: async (title: string, message: string) => {
      notify(`${title}：${message}`, "info");
      return true;
    },
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {}
  } as unknown as ExtensionUIContext;
}
