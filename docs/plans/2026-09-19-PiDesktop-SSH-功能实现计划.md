# PiDesktop SSH 功能实现计划

## 背景与目标

PiDesktop 需要内建 SSH 客户端能力：

1. **侧边栏新增 SSH 入口**，配置主机（host/port/username/密码）后可人工连接云服务器，获得与 SSH 客户端一致的完整终端体验（xterm.js 渲染）。
2. **AI 可直接操作同一 SSH 终端**：通过 `ssh_*` 工具向已连接的 shell 写入命令，命令与输出实时回显在终端窗口（用户明确要求可见）。

### 用户已确认的决策（2026-09-19）

- **凭据存储**：`safeStorage`（DPAPI）加密；不可用时降级并警告。
- **AI 权限**：新增 `ssh` 风险轴，workspace 模式逐次确认（权限卡已有 `allow-session`「本会话允许」，即为「保留的自动放行选项」），full 模式放行，read-only 拒绝。
- **范围**：人工终端 + AI 工具一次做完。
- **认证**：v1 仅密码认证。

### 可复用的既有资产（探索结论）

- **本地终端已存在**：`src/main/terminal-pty.ts`（node-pty 在主进程 + `TerminalManager` 纯逻辑注入依赖模式 + scrollback 重放 + 10ms/64KB 批量 flush + `terminal:data:<id>` 推送）与渲染端 `components/TerminalPanel.tsx`（xterm.js）。SSH 连接管理**完全同构**，通道换成 ssh2 的 shell channel。
- **utility→main RPC 模式已存在**：browser-automation 的 `browser-automation.request`（绕过串行命令队列）/ `.result` + 120s 超时（`pi-runtime.ts:365-393`、`index.ts:283`）。AI 的 SSH 工具照抄此桥接。
- **侧边栏入口模式**：`automation-nav-button`（App.tsx:2438 展开 / :2458 折叠 rail），SSH 同构。
- **preview 面板多 tab**：`PreviewTarget` 联合类型（ArtifactPreview.tsx:17-26）+ `openPreviewTarget`；「+」菜单已有 浏览器/终端/文件 入口。

## 架构设计

```
渲染端(沙箱)                      主进程(Electron)                utility(Pi 会话)
SshPanel(主机管理 tab)             ssh-host-store.ts               runtime-ssh.ts
SshTerminalPanel(xterm.js)  ⇄IPC  ssh-connections.ts          ⇄RPC  ssh_* customTools
  ssh:command / ssh:data:<id>     (ssh2 Client + shell channel)   ssh-automation.request/.result
                                  safeStorage 加解密              (照抄 browser-automation 桥)
```

- **ssh2 连接放主进程**：对齐 node-pty/CDP 控制器先例（连接承载 `webContents.send` 推送，safeStorage 仅主进程可用，utility 无 Electron API）。
- **AI 与人工共享同一 shell channel**：AI 写入的命令经远端 PTY 回显，天然满足「实时显示在窗口」；命令完成检测用不可打印 marker（OSC 转义序列，如 `ESC ] 633 ;pi-ssh;<seq>;$? BEL`），普通命令输出不会伪造命中。
- **连接生命周期归 tab 所有**（与本地终端一致）：关闭 tab 断开；**切换工作区不断开**（SSH 与 workspace 无关，区别于本地终端的 kill 逻辑）；AI `ssh_connect` 时若无对应 tab，主进程推 `ssh:reveal` 让渲染端自动开 tab（参照 browser `automation-started` 揭示）；会话 dispose **不**释放连接。上限 5 条（对齐 `TERMINAL_MAX_COUNT`）。
- **工具激活策略**：browser 模式——常驻注册+激活，execute 实时读 `settings.ssh.enabled` 总闸（缺省启用；SSH 是用户核心诉求，开箱即用）。

## 实施步骤

### 第 1 步：依赖与共享协议
- `package.json`：新增 `ssh2 ^1.16`（纯 JS，不装可选原生依赖；构建后需确认无需 asarUnpack——`npmRebuild:false` 下 cpu-features 装不上会自动跳过）。
- `src/shared/protocol.ts`：
  - `SshHostSummary {id,name,host,port,username,hasPassword,lastConnectedAt?}`（**密码永不回传渲染端**）；
  - `SshCommand`：`connect{terminalId,hostId,cols,rows}` / `input` / `resize` / `kill` / `host.save{id?,name,host,port,username,password?}` / `host.delete{id}`；
  - `SshEventData`：`data/exit/error`（terminal 同构）+ `SshTabReveal{terminalId,hostId,hostName}`；
  - `SshSettings {enabled?}`（缺省启用）→ `DesktopSettings.ssh?`；
  - `SshAutomationRequest`（aiConnect/aiExec/aiWrite/aiRead/aiClose/hosts）与 `SshAutomationResult`；
  - `DesktopApi` 增 `ssh(command)` / `onSshData(terminalId,cb)` / `onSshReveal(cb)`。
- `src/renderer/src/demo-api.ts` 同步 mock（npm run demo 可用）。

### 第 2 步：主进程
- `src/main/ssh-host-store.ts`（新，纯逻辑）：主机 CRUD，原子写 `userData/pidesktop-ssh-hosts.json`；密码字段 `safeStorage.encryptString` 存 base64（`isEncryptionAvailable()` false → 明文标记 `plain:` 前缀 + `insecure:true` 让 UI 警告）。
- `src/main/ssh-known-hosts.ts`（新，小）：TOFU 指纹库 `pidesktop-ssh-known-hosts.json`（`host:port → sha256 fingerprint`）。
- `src/main/ssh-connections.ts`（新，核心）：`SshConnectionManager`——注入 ssh2 工厂/publish/凭据读取，可单测：
  - `handle(SshCommand)` 分发（TerminalManager 形状）；
  - 连接：hostkey TOFU（未记录→`error` 事件带 fingerprint 供面板确认后写入；已记录且变更→拒绝，防中间人）→ password 认证 → `shell({term:"xterm-256color",cols,rows})`；
  - scrollback 200KB + 10ms/64KB flush（对齐 TerminalManager 常量）+ 重连重放 + resize；
  - AI 通道：`aiExec(terminalId,command,timeout)`（写 `command\r` + marker 探测 → resolve `{output(去ANSI,截8KB),exitCode}`；超时返回已收输出+超时标注，**不杀连接**）、`aiWrite`、`aiRead(tailChars)`。
- `src/main/index.ts`：装配——ssh2 适配器、`ipcMain.handle("ssh:command")`、`ssh:data:<id>` 推送、`ssh:reveal` 推送、`ssh-automation.request` → manager → 回 `.result`（browser 同构）、`disposeAll`。

### 第 3 步：渲染端 UI
- `components/SshPanel.tsx`（新，`data-pane="ssh"`）：主机列表（状态点：未连接/连接中/已连接/错误）+ 新建/编辑表单（密码栏占位「不修改请留空」）+ 删除 + 连接按钮；指纹确认卡（首连显示 `sha256:...` + 信任并连接）。
- `components/SshTerminalPanel.tsx`（新）：照 TerminalPanel 改造——`ssh:command` 通道 + `onSshData` + 断线态/重连；复用 `TERMINAL_FONT_FAMILY` 与主题联动逻辑。
- `App.tsx` + `components/ArtifactPreview.tsx`：
  - `PreviewTarget` 增 `{type:"ssh"}`（主机管理）与 `{type:"ssh-terminal",terminalId,hostId,hostName}`；
  - 侧边栏 `ssh-nav-button`（`data-control="ssh-open"`，展开+rail 两处）打开主机 tab；preview「+」菜单加「SSH 连接」；
  - tab 关闭 → `kill`；workspace 切换过滤只杀 terminal **不杀** ssh-terminal；
  - `onSshReveal` → 自动创建并激活 tab（AI 发起的连接可见）。
- `styles.css` 样式；主题钩子同步五处镜像（AGENTS.md / docs/theme-guide.md / pidesktop-theme-creator SKILL.md / references/variables.md / check_theme.py）：`data-pane: ssh`，`data-control: ssh-open/ssh-host-save/ssh-host-delete/ssh-host-connect/ssh-trust-fingerprint`。
- 设置页「通用」tab 增 SSH 总闸开关（browser/computer 同款）。

### 第 4 步：AI 工具（utility 进程）
- `src/main/runtime-ssh.ts`（新）：`buildSshTools`，6 个 customTools：
  - `ssh_hosts`（列出配置与连接状态）、`ssh_connect{host?}`（按名称/唯一前缀匹配，无参列出）、`ssh_exec{command,timeoutSeconds?}`（默认 60s，1–600s）、`ssh_write{data}`（交互输入如密码提示/y-n）、`ssh_read{tailChars?}`（默认 4KB）、`ssh_close`；
  - 长任务教学放首次回执（design/todo 的 prompt-diet 纪律）：建议 `nohup ... &` + `ssh_read` 轮询；
  - 输出注入防护：剥 ANSI、工具结果标注「不可信的远端输出」。
- `pi-runtime.ts`：`record.sshTools` 接入 `buildRecordTools`/`toolNamesFor`/customTools 数组（browser 全部同步点）；`ssh-automation.request/.result` RPC（照 browser：绕过串行队列 + 120s 超时，aiExec 超时由工具内 timeoutSeconds 先行控制）；`settings.save` 镜像带 `ssh`。
- `src/main/permissions.ts`：`ssh_connect/ssh_exec/ssh_write/ssh_close` → 风险 `"ssh"`；`permissionAction` 矩阵增 `ssh`：read-only→deny、workspace→ask（权限卡勾「本会话允许」即自动放行）、full→allow；`ssh_hosts/ssh_read` 免门（只读观察）。
- `src/main/runtime-permissions.ts`：`ssh_exec` 摘要 `在 <host> 执行：<command 截断>`。
- `src/shared/locale.ts`：6 个工具中文名。
- 主机指纹未记录时 `ssh_connect` 报错并提示「需先在 SSH 面板人工连接一次以确认服务器指纹」（AI 不能绕过 TOFU）。

### 第 5 步：测试
- `ssh-host-store.test.ts`：CRUD/原子写/加解密降级。
- `ssh-connections.test.ts`（fake ssh2 factory 注入）：connect/auth 失败/hostkey 首次与变更/marker 检测与 exit code/超时不杀连接/scrollback 重放/flush 上限/AI 与人工并发写。
- `runtime-ssh.test.ts`：schema 校验/未连接错误/超时边界。
- `permissions.test.ts`：`ssh` 轴三模式矩阵。
- 协议与 locale 的镜像断言（若有既有契约测试则同步）。

## 验证方式
1. `npm test` + `npm run build` 全绿。
2. `npm run dev` 手动冒烟：配置主机→连接→人工操作（vim/htop 等全屏程序）→ AI 在 full 模式发 `ssh_exec`，肉眼确认命令与输出实时回显在窗口 → workspace 模式弹权限卡（allow-session 生效）→ tab 关闭断开 → 重连指纹不再询问 → 应用重启后主机与密码仍可用。
3. `npm run package:win` 打包冒烟：确认 ssh2 纯 JS 在 asar 内可用（无原生依赖需求）。

## 风险与假设
- **ssh2 兼容性**：ssh2 1.16 纯 JS 支持 Node 22/Electron 43；可选原生依赖（cpu-features）在 `npmRebuild:false` 下装不上即跳过，加密走 Node 内置 crypto——风险低，打包冒烟兜底。
- **safeStorage 不可用**（Linux 无 keyring 等）：降级明文 + 设置页警告（不阻塞功能）。
- **人为 Ctrl+C 打断 AI 命令** → marker 永不出现 → 60s 超时返回部分输出并标注「可能被中断」；可接受的 v1 边界。
- **服务器拒绝 PTY 分配**：`shell()` 失败 → 明确报错（不支持无 PTY 模式，因交互回显是核心诉求）。
- **工具前缀成本**：6 个工具约 1K tokens/请求，采用 browser 常驻+总闸模式（用户核心诉求是开箱即用）；若实测成本敏感，后续可降级为会话开关（不影响本期）。
- **AI 无法绕过 TOFU**：未确认指纹的主机，AI 连接直接报错。
