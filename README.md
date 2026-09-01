# ChatAnyTime

ChatAnyTime 是一个面向项目开发的桌面 AI 客户端。它以 Pi 的执行、会话和工具能力为底座，重新实现桌面交互，并延续 ChatAnyTime 的富内容渲染理念。

## 当前能力

- 选择本地项目目录，并恢复或新建 Pi 会话
- 使用简体中文桌面界面
- 在输入区快捷切换已配置模型和思考级别
- 配置多个 OpenAI 兼容中转站，拉取上游模型并覆盖图片输入能力
- 创建、复制、归档 Agent，并按 Agent 与工作区隔离会话
- 通过回形针、粘贴和拖拽添加图片或工作区项目文件
- 使用 Pi 的 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls` 工具
- 流式展示回答、思考过程、工具执行状态和文件 Diff
- 渲染 Markdown、GFM、代码高亮、KaTeX、Mermaid
- 在隔离的 iframe 中预览完整 HTML/SVG Artifact
- 对命令执行、文件写入、工作区外访问进行权限确认
- 内置隔离浏览器预览，支持 `browser_*` 自动化工具（导航/点击/输入/截图/求值等，经权限门控）
- 用户终端面板（主进程 node-pty + xterm.js，独立于 AI 的 bash 工具）
- 计划模式：先产出计划、经显式审批后实施，批准的计划自动留档 `docs/plans/`
- Checkpoint 回滚：AI 改动文件前即时快照，交付物可一键恢复到回复前状态
- 外观引擎：密度/圆角运行时调节；主题导入系统（CSS + 资产目录），自带三套主题
- 自定义斜杠命令（模板驱动的 `md` 模板，支持参数展开）
- 自动化定时任务：cron 调度后台无人值守运行
- 用户钩子：`session_start` / `tool_call` / `agent_end` 等事件驱动通知、HTTP 回调或命令拦截
- 长期记忆：按助手隔离的 markdown 主题库，跨会话检索
- 子代理执行过程可视化：侧边栏以嵌套事件流呈现委派子任务的进展

## 架构

```text
Electron main
├── 窗口、目录选择和设置持久化
├── Renderer IPC
└── Pi Runtime utilityProcess 生命周期

Pi Runtime utility process
├── @earendil-works/pi-coding-agent 0.84.4
├── AgentSession / SessionManager / ModelRuntime
├── Pi 原生项目工具
├── 权限扩展
└── 稳定的 RuntimeMessage / RuntimeSnapshot 输出

React renderer
├── 项目、会话和模型界面
├── 消息流与工具时间线
├── Activity / Changes 面板
└── 富内容与 Artifact 渲染
```

主进程与 React 界面之间的稳定协议位于 `src/shared/protocol.ts`。React 不直接依赖 Pi 的运行时对象，因此后续升级 Pi 或替换桌面壳时，不需要同时重写渲染层。

## 环境与启动

依赖安装要求 Node.js `>=22.19.0`。Electron 43 自带的 Node 运行时满足 Pi `0.84.4` 的运行要求。

```powershell
npm install
npm run dev
```

构建和测试：

```powershell
npm test
npm run build
```

生成可直接运行的 Windows 目录：

```powershell
npm run package:win
```

生成后运行 `dist\win-unpacked\ChatAnyTime.exe`。

## 模型鉴权

应用通过 Pi 的 `ModelRuntime` 读取 Pi 已支持的 Provider 和现有鉴权来源。API Key 由主进程使用 Electron `safeStorage` 加密到 `userData/credentials.json`，应用启动时解密后仅注入 Pi 运行进程；界面只显示“已配置”，不会回显密钥内容。首次启动时会迁移旧版 `customProviderApiKey`，加密校验失败则保留旧数据并只在内存中使用。

自定义中转站使用 OpenAI Chat Completions 兼容协议，接口地址填写 API 根地址，例如 `https://proxy.example.com/v1`，不要填写具体的 `/chat/completions` 路径。重新打开设置时，API Key 留空即可继续使用已保存的密钥。

## 权限模型

- `bash`：每个命令作用域需要确认
- `edit` / `write`：写入工作区内文件时需要确认
- 工作区外路径：所有工具都需要单独确认
- `Allow for session` 仅授权相同的 `tool:risk` 组合，不会让普通写入授权自动覆盖工作区外写入
- HTML/SVG Artifact 在无同源权限的 sandbox iframe 中运行，无法直接访问桌面 API
- 浏览器自动化：`browser_navigate` 与写模式的 `browser_eval` 携带 `browse` 风险走同一权限闸口；其余页面内操作视为可信
- 用户钩子的 `command` 动作是用户自写的终端级信任配置，绕过 AI 权限闸口执行（超时与进程树清理受控），上下文只经 stdin/环境变量进入

## 与 Pi 及原插件的关系

- Pi `0.82.1` 仅作为 Agent 运行时核心使用：模型、AgentSession、会话持久化、上下文管理、内置工具（read/bash/edit/write/grep/find/ls）
- 已移除 Pi 的「扩展接入」能力（第三方扩展加载/批准/绑定、`pi-mcp-adapter`、子代理 CLI shim、扩展 UI 桥），只保留应用自有的工具调用权限拦截 hook
- MCP、Skill、子代理、Todo 均为自研实现：MCP 由内置 `@modelcontextprotocol/sdk` 客户端直连并把每个工具包装成 Pi `customTool`；Skill 通过扫描 `SKILL.md` 目录并注入系统提示；子代理用 `delegate_agent` 创建同进程子会话；Todo 用会话维度的本地 JSON 存储
- 本项目沿用 ChatAnyTime 品牌与核心渲染、交互理念，没有复制原插件运行时或旧代码
- Pi 原仓库和 ChatAnyTime 原插件仓库均不属于本项目，也不会被本项目构建修改

## 能力管理

打开「设置 → 技能与工具」即可管理自研能力：

- **MCP Server**：支持 stdio/HTTP，配置写入项目 `.mcp.json` 或全局 `mcp.json`，启用/停用/删除，状态与工具数实时显示
- **Skill**：把 `<slug>/SKILL.md` 放到全局 `pidesktop-skills/` 或项目 `.pidesktop-skills/` 即可被发现，勾选启用后注入系统提示，用 `/skill:<name>` 调用
- **Todo**：本地待办清单（AI 任务），按会话维度存储（每个会话一份，切换会话自动跟随）。dsh 式单一所有者语义：助手通过 `todo_write` 整表替换维护清单（状态只随工具调用追加在对话尾部，不破坏提示词前缀缓存）；聊天窗口右上角的悬浮「任务」面板（可折叠/关闭）只读实时展示
- **子代理**：助手可通过 `delegate_agent` 把独立子任务委派给子代理（单层，权限走同一审批闸口）；设置页可自定义子智能体（系统提示/模型/工具集，全局或项目作用域）
- **浏览器与终端**：预览面板提供隔离标签页；浏览器自动化工具经权限门控，终端是用户自己输入的真实 PTY
- **计划模式**：会话级协作开关，AI 先出计划、你审阅「批准计划」后实施，批准的计划留档 `docs/plans/`
- **Checkpoint**：AI 每次写文件前的快照 + 交付物行内「回滚」按钮，单文件粒度恢复
- **外观**：密度（compact/comfortable/relaxed）与圆角（square/small/medium/round）运行时调节；主题可导出/导入（CSS + 资产目录，含明暗双模式语义变量）
- **自定义命令**：`.pidesktop-commands/` 下的 `md` 模板（项目/全局双作用域），`/名字 参数` 直接调用
- **自动化任务**：设置页「自动化任务」tab 或让 AI 用 `automation.create` 创建 cron 定时任务，后台无人值守执行
- **钩子**：设置页「钩子」tab 管理规则，事件可触发桌面通知、HTTP POST、命令拦截/执行
- **长期记忆**：`memory_write/read/list/search/delete` 工具维护按助手隔离的主题库，记忆面板可治理开关

软记忆：以上能力均为应用自研实现，不依赖 Pi 的扩展接入层。

## 当前限制

- 暂不支持 Git 工作树管理
- MCP 配置变更后需重建会话才能让新工具生效（会话历史保留）；stdio 类型 MCP 子进程在应用退出时未做优雅关闭，极少数情况下可能残留
- 子代理目前以工具调用结果内联展示，尚未在侧栏以嵌套会话形式呈现
- HTML/SVG Artifact 只提供隔离预览，不提供桌面能力桥接
- Windows 目前输出解压目录，尚未生成安装程序、自动更新、代码签名和可执行文件资源定制
- `@earendil-works/pi-coding-agent@0.84.4` 发布包的 shrinkwrap 固定了 `undici` 与 `brace-expansion` 的旧版本；截至本版，`npm audit --omit=dev` 会报告若干关联风险。根项目 override 无法可靠替换它们，需等待 Pi 上游发布更新依赖的版本，或以后改为可审计的 Pi 源码构建流程

## 开源协议

本项目以 [MIT License](LICENSE) 开源。欢迎提交 Issue 与 Pull Request；架构约束与开发约定见 `AGENTS.md`，主题 API 见 `docs/theme-guide.md`。
