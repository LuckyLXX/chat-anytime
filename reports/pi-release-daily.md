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
