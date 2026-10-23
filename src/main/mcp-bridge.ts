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

import { piMcpConfigFor, readWorkspaceMcpServers, type PiMcpRegistration } from "./runtime-mcp.js";
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
   * 按磁盘上的配置重新对齐注册集（手动改 `.mcp.json` / `mcp.json` 后的热应用）：
   * 新增的注册、消失/停用的注销、同名但翻译后配置变了的才重注册。
   * 返回是否真的发生了变更（没变则调用方不必重算活动集/前缀）。
   */
  resync: () => boolean;
  /**
   * 注销本会话注册过的全部服务器。**会话销毁前必须调**：Pi 的 `dispose()` 不
   * 发 session_shutdown（只有 reload 会），MCP 扩展不会自己关连接，stdio 子进程
   * 会活着占住句柄（实测：dispose 后 10s 子进程仍在、临时目录 EBUSY）。
   */
  unregisterAll: () => void;
  registeredNames: () => string[];
}

/** Pi 内置 MCP 扩展（空 loadConfig + autoEnableCodemode 关死 + 宿主 openUrl）。 */
export function createPiMcpExtensionLayer(deps: { openExternal: (url: string) => void; onToolSetChange?: () => void }): InlineExtension {
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
  const factory = typeof extension === "function" ? extension : extension.factory;
  const meta = typeof extension === "function" ? { name: "builtin-mcp", hidden: true } : { ...extension, name: extension.name ?? "builtin-mcp", hidden: true };
  return {
    ...meta,
    // 只在这层包装：MCP 扩展注册/激活工具时通过公开 API 通知宿主，由宿主重算
    // 声明。注册要等连接完成（异步），用固定延时的「猜」会漏掉慢服务器。
    factory: (pi) => factory(deps.onToolSetChange ? observeToolSetApi(pi, deps.onToolSetChange) : pi)
  };
}

/**
 * 观察一个 ExtensionAPI 的公开工具 API：`registerTool()` / `setActiveTools()`
 * 先完成原调用，再通知宿主。只读观察，不修改参数与返回值，也不触碰 Pi 的
 * 私有注册表。用 Proxy 而不是浅拷贝：扩展拿到的其它成员保持原样（方法绑定
 * 到原对象），避免破坏 `this` 依赖。
 */
export function observeToolSetApi(pi: ExtensionAPI, onChange: () => void): ExtensionAPI {
  const overrides = new Map<PropertyKey, unknown>([
    ["registerTool", (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
      pi.registerTool(tool);
      onChange();
    }],
    ["setActiveTools", (toolNames: string[]) => {
      pi.setActiveTools(toolNames);
      onChange();
    }]
  ]);
  // 绑定后的成员按属性缓存：每次 get 都返回新函数会让「保存引用后比较」的调用方
  // 看到不同身份（Pi 内部目前不这么做，但稳定的身份是包装层的最低承诺）。
  // set/deleteProperty 同步清缓存：目标属性被覆写后不得继续返回旧值。
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(pi, {
    get(target, property) {
      if (overrides.has(property)) return overrides.get(property);
      if (bound.has(property)) return bound.get(property);
      const value = Reflect.get(target, property, target);
      const resolved = typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      bound.set(property, resolved);
      return resolved;
    },
    set(target, property, value, receiver) {
      bound.delete(property);
      return Reflect.set(target, property, value, receiver);
    },
    deleteProperty(target, property) {
      bound.delete(property);
      return Reflect.deleteProperty(target, property);
    }
  }) as ExtensionAPI;
}

/**
 * app 自有桥接扩展：工厂期读双作用域配置并逐台注册。工厂在所有扩展 bind 后、
 * session_start 触发前运行（extensionFactories 顺序在本扩展在前、Pi MCP 扩展
 * 在后），因此注册发生在 Pi MCP 扩展读取注册表之前——「extension load 期间
 * 注册的服务器在 session_start 时连接」。
 */
export function createPidesktopMcpBridge(deps: McpBridgeDeps & { onApi?: (control: McpBridgeControl | undefined) => void }): InlineExtension {
  const registered = new Set<string>();
  /**
   * 已注册服务器的翻译后配置指纹（JSON）。resync 用它区分「同名但配置变了」与
   * 「只是文件被其他工具重写」：只有前者才重注册（重注册 = 断开重连，很贵）。
   */
  const fingerprints = new Map<string, string>();

  /** 配置 → 注册载荷（三态 exposure：禁用 > codemode > direct）。 */
  const registrationFor = (server: ConfiguredMcpServer): PiMcpRegistration["config"] => {
    const exposure = deps.disabledServers().has(server.name)
      ? "hidden"
      : server.entry.exposure === "codemode"
        ? "codemode"
        : "direct";
    return piMcpConfigFor(server, exposure);
  };

  const registerOne = (pi: ExtensionAPI, server: ConfiguredMcpServer): void => {
    const config = registrationFor(server);
    pi.registerMcpServer(server.name, config as Parameters<ExtensionAPI["registerMcpServer"]>[1]);
    registered.add(server.name);
    fingerprints.set(server.name, JSON.stringify(config));
  };

  /**
   * 控制柄：捕获的 `pi`（ExtensionAPI），按会话持有。reapply 用新配置替换注册
   * （Pi 允许同名替换），remove 注销并关连接。每次工厂执行（会话装配）重建。
   */
  const buildControl = (pi: ExtensionAPI): McpBridgeControl => ({
    reapply: (name: string) => {
      const { project, global } = deps.configPaths();
      const target = readWorkspaceMcpServers(project, global).find((server) => server.name === name);
      if (target && !target.entry.disabled) {
        registerOne(pi, target);
      } else {
        // 配置没了或停用了：注销即可（unregister 关连接并移除工具）
        pi.unregisterMcpServer(name);
        registered.delete(name);
        // 指纹必须一并清掉：disabled 不进翻译后的注册载荷，留着旧指纹会让
        // 「文件里手动重新启用」被 resync 误判为「配置未变」而永不重连。
        fingerprints.delete(name);
      }
    },
    remove: (name: string) => {
      pi.unregisterMcpServer(name);
      registered.delete(name);
      fingerprints.delete(name);
    },
    resync: () => {
      let configured: ConfiguredMcpServer[];
      try {
        const { project, global } = deps.configPaths();
        configured = readWorkspaceMcpServers(project, global);
      } catch {
        // 改到一半的非法 JSON：保留现状，等下一次文件事件重试。
        return false;
      }
      let changed = false;
      const keep = new Set<string>();
      for (const server of configured) {
        if (server.entry.disabled) continue;
        keep.add(server.name);
        const next = JSON.stringify(registrationFor(server));
        if (fingerprints.get(server.name) === next) continue;
        try {
          registerOne(pi, server);
          changed = true;
        } catch (error) {
          deps.onNotify(`MCP 服务器 ${server.name} 重载失败：${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
      for (const name of [...registered]) {
        if (keep.has(name)) continue;
        try {
          pi.unregisterMcpServer(name);
        } catch {
          // 单个失败不阻断其余（热重载路径 best-effort）
        }
        registered.delete(name);
        fingerprints.delete(name);
        changed = true;
      }
      return changed;
    },
    unregisterAll: () => {
      for (const name of [...registered]) {
        try {
          pi.unregisterMcpServer(name);
        } catch {
          // 单个失败不阻断其余（销毁路径 best-effort）
        }
        registered.delete(name);
        fingerprints.delete(name);
      }
    },
    registeredNames: () => [...registered]
  });

  return {
    name: "pidesktop-mcp",
    hidden: true,
    factory(pi) {
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
      const control = buildControl(pi);
      // 控制柄必须等 record 建立之后再交付：工厂在 resourceLoader.reload() 阶段
      // 执行，彼时调用方还没有 session record（早期实现就在这一步丢掉了句柄，
      // 导致后续 save/toggle/delete/resync 全部走空）。session_start 在
      // bindExtensions() 里触发，此时 record 已就绪；服务器仍按工厂期注册，
      // 保证 Pi 的 MCP 扩展在同一个 session_start 读到配置。
      pi.on("session_start", () => {
        deps.onApi?.(control);
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
