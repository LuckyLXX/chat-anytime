# Pi 仓库发布更新日报

- 目标仓库：https://github.com/earendil-works/pi
- 正文按日期分节追加（纯 Markdown，供后续比对）。
- 文件**最后一行的状态行**记录「上次已报告的版本」，格式：`日期 | tag | 发布时间`；无更新时写作 `日期 | tag | 无更新（沿用上次发布时间）`。

---

## 2026-10-06 · v1.0.4（首次运行，建立基线）

**✨ 新功能**

- `--tools` 与 `--exclude-tools` 支持 `*` 通配模式，例如 `--tools read,codemode,'mcp__radius__*'` 只保留某个 MCP 服务器的工具。
- 新增 `--no-mcp`，可在单次运行中关闭内置 MCP 支持。
- `--tools` 默认保留 MCP 工具，除非条目以 `mcp__` 开头。
- codemode：`tools.read()` 读取图片文件时返回 image block，可交给 `image()` 显示。

**🐛 修复**

- MCP OAuth 在采用 OpenID Connect 客户端注册的服务器（如 `mcp.modem.dev`）上因 `invalid_redirect_uri` 登录失败；pi 现以 native client 注册。
- MCP 会话关闭时若服务器仍在连接会提前返回，导致传输层一直挂到服务器应答或超时。
- `--tools` 误删 MCP 工具，使 `pi --tools codemode` 完全没有 MCP 服务器可用。
- system prompt 规则与 skills 提示不再点名被 `prepareLoadout` 隐藏的工具；`ToolLoadout` 新增 `getPromptGuidelines()`。
- Bedrock 在 HTTP/2 连接卡死后报 `The pending stream has been canceled` 的请求不再自动重试。
- codemode 脚本篡改内置对象（如 `Array.prototype.toJSON = ...`）导致 pi 崩溃、工具调用不结算；脚本运行前会冻结内置对象。
- 围栏代码块中的多行字符串与注释从第二行起丢失语法高亮颜色。

**⚠️ 破坏性变更**：无。

**Release**：https://github.com/earendil-works/pi/releases/tag/v1.0.4 ｜ 共 1 个新版本（首次运行）

---

## 2026-10-12 · v1.1.0（较上次已报告版本 v1.0.4 的增量）

**✨ 新功能**

- `--tools` 支持 `+name` / `-name` 条目，在默认工具选择上增减而非整体替换，例如 `pi -t +codemode,-write`。
- 程序状态上报（OSC 7501）：支持的终端与 agent 仪表盘可看到 Pi 正在工作、被对话框或登录阻塞、已完成或失败；`PI_PROGRAM_STATUS=1|0` 可覆盖自动检测。
- 新增 Claude Haiku 5.5（`anthropic/claude-haiku-5-5`），自适应思考最高 `xhigh`/`max`，Bedrock 上支持 prompt caching。
- 新增 GPT-6 Luna 作为 Decisions API 分类器模型（走 `OPENAI_API_KEY`）；codemode 的 `models.classify()` 新增 `images`，可交给支持图像的分类器判断。
- llama.cpp 0.6.0+ 服务的决策模型（Julia-1、Laya、Kev、lev、OpenJev）经 `/v1/systemone` 原生作为分类器。
- `agent_settled` 会话/扩展/JSON 事件新增 `aborted`，可区分取消与正常结束；工具渲染上下文与 `tool_execution_end` 扩展事件新增 `durationMs`，渲染上下文新增 `outputPad`。

**🐛 修复**

- MCP OAuth 登录现在每一步都能用 Esc 取消，会话关闭会中止进行中的登录，对授权服务器的请求 15 秒超时；关闭时不再为即将过期的 token 刷新白等 15 秒；`/mcp` 不再等所有服务器连上才打开，启停/重连期间保持可用。
- Bash 与 PowerShell 结果重载会话后丢失 `Took`、实时 `Took` 含挂钟步骤，现统一为记录的执行时间；托管安装不再堆积每个旧版本，`pi update` 只保留新版本及其更新来源版本。
- 独立二进制不再从启动目录加载 `.env`、`.env.local`、`.env.development`；`models.json` 的模型 `headers` 现在能覆盖 Codex 请求的 `originator` 与 `User-Agent`。
- Bedrock 上的 OpenAI 模型不再忽略 thinking level 而固定用 Bedrock 默认 reasoning effort；Anthropic 浏览器登录在 53692 端口被占用/保留时回退到空闲 loopback 端口；`server_busy` / `servers are currently busy` 与 Mistral 的 `finish_reason: "error"` 现在会重试。
- codemode：描述中 `searchTools()`、`describeTool()`、`describeNamespace()` 标注为 async（此前模型把未 await 的 promise 序列化成 `{}`）；多段输出不再粘连，多个文本项以 `==> text N/M <==` 开头，`console` 调用归入单个 `<console_output>` 块。
- Node 24.19+/26.x 下 `node --watch` 时图片被误报「could not be resized」丢弃；Termux 粘贴无效与复制失败缺 Termux:API 提示；`!` 与 RPC `bash` 输出残留颜色码碎片；全屏文本选择在会话切换/转录重建后残留；含 prompt 长度分档计费的模型（Claude Haiku 5.5、Gemini 3.1 Pro、GPT-5.4 等）会话成本低估；被组织 owner 禁用的 Radius 模型仍被列出；Herdr 中 Markdown 链接不可点击。

**⚠️ 破坏性变更**

- 无标注的 breaking change。行为变更一处：llama.cpp 决策模型在 `/v1/systemone` 下仅列为分类器，不再出现在 chat 模型列表中。

**📝 文档与杂项**

- `outputPad` 现在也作用于 `!` 命令输出、工具输出与摘要块；`pi mcp login --timeout` 改为限制整个登录过程（含对授权服务器的请求），不再只限制等待浏览器。
- 上下文上限相关失败减少：计算输出上限时按 3.5 字符/token（原 4）估算输入。

**Release**：https://github.com/earendil-works/pi/releases/tag/v1.1.0 ｜ 共 1 个新版本

---
2026-10-12 | v1.1.0 | 2026-10-07T22:26:31Z

## 2026-10-15 · v1.2.0（较上次已报告版本 v1.1.0 的增量）

**✨ 新功能**

- Per-key OpenRouter 模型列表：带 OpenRouter key 时只列出该 key 可用的 chat 模型，含该 key 的 context size、max output 与价格，以及 `models.json` 中配置的 guardrails 与 regional endpoints；列表会保存、离线可用。
- 发布配置 schema：`settings.json`、`models.json`、keybindings、themes 均可用 `$schema` 指向 `https://pi.dev/schemas/*.schema.json`，获得编辑器校验与补全。
- `PI_CLIPBOARD_OSC52=1`：本地剪贴板写入后再用 OSC 52 发送一次，多路复用器跨机接入、远端 IDE daemon 等无法探测远程会话时也能把复制内容送到远端剪贴板。
- codemode：工具声明的属性注释上以 `@` 标签展示输入约束（integer、minimum/maximum、length、pattern、default），脚本无需依赖描述重复；codemode 行显示脚本已用时间与完成后的总耗时。
- `before_agent_start` 现在也作用于 `pi.sendMessage(..., { triggerTurn: true })` 触发的运行。
- 工具定义新增 `reachesTools`（声明一次调用可能触及哪些工具，MCP 扩展据此等待所需服务器）；工具命名空间新增 `aliases`，供 codemode 的 `describeNamespace()` 与 `searchTools()` 的 `namespace` 选项匹配。
- `showHardwareCursor` 设置改为只使用终端光标，不再同时绘制 Pi 的反色光标。

**🐛 修复**

- codemode 忽略不在脚本首行的 `// @options:`，导致请求的 `timeout_ms` 不生效；现在脚本运行前直接报错。
- Mistral 流在请求超时后被中途中断（如长思考期间）；超时现在只作用于等待响应头。
- git worktree 嵌套在主仓库内时，符号链接的 `AGENTS.md` 导致项目上下文文件完全不加载。
- 大量 `text()` 调用的 codemode 脚本结束后阻塞进程数秒到数分钟（输出拼接为二次复杂度）。
- print mode（`-p`）在最终回复被模型输出上限截断时静默退出 0；现在打印部分文本、向 stderr 写警告并以 1 退出。
- `extensions`、`skills`、`prompts`、`themes` 设置的 `!pattern`、`+path`、`-path` 条目不展开 `~`，如 `!~/skills/pdf` 匹配不到任何东西。
- 带 resources 的 MCP 服务器在列完所有 resource 前注册不了工具；Pi 连接时不再列举 resources，`/mcp` 与 `pi mcp list` 改为标记该服务器提供 resources。
- Windows 上前一个锁目录仍在删除时读写 `auth.json` 报 `EPERM`；现在先短暂重试再报错。
- OpenRouter 路由模型（如 `openrouter/auto`）显示 -$1,000,000/1M tokens 的成本；负占位价格归 0。
- Anthropic 请求因 strict tool set 被拒（语法体积、工具数或 union 限制）而失败；现在用非 strict 的优先工具重试一次。
- "The upstream provider returned an error" 未按瞬时 provider 错误重试。
- 聚焦的全屏浮层挡住转录区的鼠标滚轮滚动。
- 终端颜色回复碎片把 hex 值泄漏进 prompt 并打开外部编辑器。
- Herdr 内联图片自 1.1.0 起不渲染。
- 键位名称含 shift 符号（如 `+`、`ctrl++`）在 Kitty 键盘协议或 modifyOtherKeys 下不匹配。
- 自定义编辑器中的 compaction 状态指示器使用默认 muted 颜色，未像工作指示器那样跟随编辑器边框或 thinking-level 颜色。
- MCP OAuth 刷新期间被取消或超时的工具调用，在刷新完成后仍被发送给服务器。
- MCP OAuth 登录接受带 `iss` 参数但无法校验（未发现授权服务器元数据）的授权响应；现在以 issuer mismatch 失败。
- Node 24/26 下 `node --watch` 运行时 codemode 报 bridge broken 错误。
- MCP 服务器返回非对象 structured content（数组、`null` 或原始值，MCP 2026-07-28 允许）时工具调用失败。

**⚠️ 破坏性变更**

- 发布生成的配置 schema 于 `https://pi.dev/schemas/*.schema.json`；theme schema 移到 `https://pi.dev/schemas/theme.schema.json`，且启动时加载的主题现在与后续 reload 走相同 schema 校验。需更新 theme 的 `$schema` 引用、在 `vars` 下定义可复用颜色、移除不支持的元数据。
- `before_agent_start` 现在也对空闲时由 `pi.sendMessage(..., { triggerTurn: true })` 触发的运行触发；`BeforeAgentStartEvent` 变为按 `messageType` 的 union——`"user"` 事件带 `prompt` 与 `images`，`"custom"` 事件带起始 `message` 且无 `prompt`。只应处理用户提示的 handler 必须检查 `event.messageType === "user"`。
- 运行启动期间会话即计为忙（含 `before_agent_start` handler 执行中）：`ctx.isIdle()` 为 false，`pi.sendMessage()` 排队进正在启动的运行而非另起一次并报 "Agent is already processing"，`pi.sendUserMessage()` 必须带 `deliverAs`，此时请求的中止会在运行启动后生效。
- `pi mcp list --json` 对有 resources 的服务器改为报告 `resources: true`，不再输出 `resources` 与 `resourceTemplates` 计数。

**📝 文档与杂项**

- `serializeConversation()`（compaction、分支摘要、bug report）省略 thinking blocks，避免摘要请求比其所摘要的上下文更大而失败。
- codemode 对 MCP 工具的声明改为写明结果类型（`content`、`structuredContent`、`isError`），不再引用未定义的 `CallToolResult<T>`；codemode 描述不再包含共享 MCP 类型。
- 移除未发布的实验性 server/client/plugin 栈（`src/experimental`、`src/cli/experimental`）及其仅源码的 `./client`、`./experimental/plugin` 导出；`@earendil-works/pi-client`、`@earendil-works/pi-protocol`、`@earendil-works/pi-server` 包随之删除、不再发布。
- 移除对 `@earendil-works/chord` 的依赖。
- `pi mcp login --help` 与 CLI 文档此前把 `--timeout` 写成只限制等待浏览器，实际限制整个登录过程，文档已更正。

**Release**：https://github.com/earendil-works/pi/releases/tag/v1.2.0 ｜ 共 1 个新版本

---
2026-10-15 | v1.2.0 | 2026-10-12T23:03:53Z

## 2026-10-19 · v1.3.0（较上次已报告版本 v1.2.0 的增量）

**✨ 新功能**

- 新增 `sessionShareDestination` 设置，`/share` 上传目标可选 `auto`、`gist`、`radius`。
- OpenAI GPT-6（API key）在会话中切换 thinking level 不再破坏 prompt cache。
- 切换模型时丢弃此前模型产生的 thinking blocks，而不再作为纯文本发给新模型，避免新模型把旧推理当成自己的回复。
- 恢复的会话保留会话中激活的工具，`--tools +name`/`-name` 叠加在它们之上（除非用 `--tools`、`--no-tools`、`--no-builtin-tools` 显式指定）。

**🐛 修复**

- `kimi-coding` 改用官方 Kimi Code 客户端所用的 OpenAI Chat Completions 协议（`https://api.kimi.com/coding/v1`），会话中途新增工具不再使 prompt cache 失效。
- `--model` 在多 provider 都匹配时按目录顺序选 provider；现在优先有凭据的 provider，否则报出歧义；`--models` / `enabledModels` 为每个 provider 各加一份并警告。
- codemode：中断或超时不再等待 Bun 上不可中断的内置调用返回；同时在两个会话间把存活 worker 限制为两个，且计入已取消但未退出的 worker。
- 工具调用参数含非法 `\u` 转义（如 `\usepackage`）时丢字段；最终参数为畸形 JSON 时不再静默只跑已解析字段，而是校验失败并把原始参数回给模型。
- Anthropic / Bedrock 的错误 tool result 含图片时报 400；图片改在该回合 tool results 之后发送，模型仍能看到。
- OpenCode Zen / Go 迁到 `opencode.ai/inference` 端点修 Gemini 404；OpenCode Go MiniMax M2.7 改用 Anthropic Messages API。
- 自动重试未覆盖 `Unable to forward upstream stream` 与 `The service is temporarily unavailable`（后者还导致 compaction 首次即失败）。
- `openai-codex/gpt-6.1-sol` 上下文窗口 272K → 500K；Claude Haiku 5.5 / Opus 5 补上 `off` thinking level；Xiaomi MiMo 去掉会 400 的 `minimal`，只留 `off` 与 `high`。
- 扩展的 `ctx.ui.custom({ overlay: true })` 调用 `done()` 时关掉最顶层浮层而非自己的浮层。
- Nix：provider 切换 API 时构建失败（模型目录 pin 改为按最新发布目录刷新）、包内 Node 抢占 `PATH` 首位导致 bash 工具不用用户的 `node`、安装检查仍期待 chord 与 esbuild。

**⚠️ 破坏性变更**

- `kimi-coding` provider 协议改为 OpenAI Chat Completions；`models.json` 中对它的 base URL 覆盖现在必须带 `/v1`。

**📝 文档与杂项**

- 内部 Pi 依赖固定到确切发布版本，防止全新安装混入不兼容包。
- `read` 的 line-range 标签在数字字符串或 null 参数下的显示错误（TUI、会话树、HTML 导出）已修。

**Release**：https://github.com/earendil-works/pi/releases/tag/v1.3.0 ｜ 共 1 个新版本

---
2026-10-19 | v1.3.0 | 2026-10-15T19:17:33Z

---
2026-10-20 | v1.3.0 | 无更新（沿用上次发布时间 2026-10-15T19:17:33Z）

## 2026-10-22 · v1.4.0（较上次已报告版本 v1.3.0 的增量）

**✨ 新功能**

- codemode `models.classify()` 接受 `images`：TypeSafe 的 Jev 与 Cloudflare 的 Clef，适用于 `typesafe`、`cloudflare-workers-ai`、OpenRouter；Workers AI 新增 Clef Omni 与 Jev 1.14。
- 新增由 `models.json` schema 生成的 Models Configuration 参考文档，覆盖全部 provider、model、model override 与 compatibility 字段。
- compaction 与分支摘要不再用固定输出上限，改用模型输出上限，长推理不再因 "generation hit the token cap" 失败；`compaction.reserveTokens` 只控制何时开始压缩。
- codemode 在 worker 全忙时排队等待（最多 60 秒）而非立即失败；`PI_CODEMODE_MAX_WORKERS` 可提高默认 2 个 worker 的上限。
- 支持 Rex 终端：OSC 8 超链接、truecolor、内联图片。
- `minimax` / `minimax-cn` 新增 `MiniMax-M3.1-Flash`（thinking 从 low 到 max）。
- provider 级 `compat` 也作用于 classifier 模型，新增 System One 字段 `imageInput` 与 `sendImageOptInHeader`；扩展的 classifier 模型同样接受 `compat`。

**🐛 修复**

- `pi update` 在 `managed-install.json` 带 UTF-8 BOM（Windows PowerShell 5.1 重写所致）时报 "Managed install marker is missing or invalid"。
- `mcp.json` 带 BOM 无法解析，导致其中所有 MCP 服务器被跳过、`pi mcp add`/`pi mcp remove` 失败。
- pi 未走常规终端清理就退出时残留 mouse-tracking、focus-reporting、Kitty keyboard 与 alternate-screen 模式，刷屏 shell 提示符。
- 交互模式并发扩展对话框（`select`/`confirm`/`input`/`editor` 与内联 `custom()`）：第二个对话框替换第一个且首个 Promise 永不 settle；关闭可见对话框后重新显示上一个。
- 响应在输出上限被截断后恢复的会话：截断的 tool call 被丢弃但 tool results 保留，导致之后每次请求都被 provider 拒绝。
- `grep` 遵循 `RIPGREP_CONFIG_PATH`，`--fixed-strings` 等选项会静默把正则搜索变成字面搜索；工具改用 `rg --no-config`。
- Windows shell 检测拒绝可运行的 Microsoft Store shell 别名；Windows 不装在 `C:\Windows` 时找不到 `PATH` 外的 PowerShell 与旧版 WSL `bash.exe`（现检查 `%ProgramFiles%\PowerShell\7`、`%SystemRoot%\System32\WindowsPowerShell\v1.0`、`%SystemRoot%`）。
- GitHub Copilot 大请求体（如多图）返回 HTTP 413 `failed to parse request` 时不压缩重试。
- `openai-codex` 提供对 ChatGPT 账户必然失败的 `gpt-5.5` 与 `gpt-5.3-codex-spark`。
- 仅含空白的工具输出（如 bash 的裸 `\r\n`）让 OpenAI Completions、OpenAI Responses、Google 请求 400。
- 自动重试未覆盖更多网关上游失败、Codex CLI 代理转发的 `stream disconnected before completion`、Google Vertex OAuth token 刷新的瞬时失败；也不再因 request id 或字节数里的数字误判重试。
- OpenAI Responses 模型在移除工具后每次 deferred tool load 都丢 prompt cache。
- 未闭合的 `$$` 显示数学块吞掉/破坏其后所有 Markdown 表格。
- Markdown 粗体与斜体在 CJK 标点旁不渲染（HTML 导出显示字面星号）。
- `@` 文件补全对含 `[`、`(` 等正则元字符的查询返回空结果。
- `/compact <instructions>` 在压缩切分的回合起始做摘要时忽略指令；切分回合是上次压缩后唯一新内容时指令被完全忽略。
- 恢复会话与 `/tree` 导航后扩展工具未激活（分支记录工具早于其注册）；现在分支从未增删的扩展工具默认激活，除非注册时 `defaultActive: false`。
- extensions 通过导入 `@earendil-works/pi-ai/models`（如 `clampThinkingLevel`）加载失败，现已通过扩展加载器别名与虚拟模块暴露该子路径。
- Cloudflare Workers AI classifier 定价：Clef Flash 每百万输入 token $0.038、Jev $0.042，不再把 Jev 标为免费。
- Linux 上在 pi 内复制文本后 Ctrl+Z 挂起，再回 shell 粘贴会卡住：负责供剪贴板的后台 `wl-copy`/`xclip`/`xsel` 被连带挂起。
- `models.schema.json` 缺 provider 与 model 字段描述，编辑器无提示。

**⚠️ 破坏性变更**

- `generateSummary()` 与 `generateSummaryWithUsage()` 忽略 `reserveTokens` 参数；摘要请求改用模型输出上限。
- 扩展的 `before_provider_headers` handler 不再看到 OpenRouter、NVIDIA NIM、OpenCode 的归因头（返回 `null` 仍可移除）；Cloudflare 请求改发 pi 的详细 `User-Agent`，OpenCode 请求在开启归因时发 `x-opencode-client`。
- 默认模型调整：GitHub Copilot `gpt-5.4`（已退役）→ `gpt-6.1-sol`；NVIDIA → `nvidia/nemotron-3.5-super-vl-120b-a12b`；Xiaomi 与 Xiaomi Token Plan → `mimo-v2.6-pro`。

**📝 文档与杂项**

- `xai` 的 Grok 4.3 与 4.5 新增 `xhigh` thinking level。
- Sign in with ChatGPT：ChatGPT Business 工作区用量上限错误不再重试，直接提示用户联系工作区管理员提高上限。

**Release**：https://github.com/earendil-works/pi/releases/tag/v1.4.0 ｜ 共 1 个新版本

---
2026-10-22 | v1.4.0 | 2026-10-21T22:49:48Z

---
2026-10-24 | v1.4.0 | 无更新（沿用上次发布时间 2026-10-21T22:49:48Z）

---
2026-10-25 | v1.4.0 | 无更新（沿用上次发布时间 2026-10-21T22:49:48Z）

---
2026-10-28 | v1.4.0 | 无更新（沿用上次发布时间 2026-10-21T22:49:48Z）

---
2026-10-29 | v1.4.0 | 无更新（沿用上次发布时间 2026-10-21T22:49:48Z）
