# Project Conventions

> **定位**：跨模块硬约束一览 + 「细节去哪找」索引。这里只收「一句话能说清、违背就会坏」的约定。
> 单模块实现细节在长期记忆（项目库 `workspace/.pidesktop/memory/`）与 `docs/`；历史取证在 `docs/迭代记录/` 与 git。
> 开工顺序：扫「硬约束」→ 按末尾索引打开对应记忆主题 → 再看代码与测试。

## 1. 分层与进程边界

- Pi 运行时对象只能经 `src/shared/protocol.ts` 暴露；渲染端只消费 desktop protocol。
- 主进程只管原生生命周期、对话框、持久化、进程监管；**Pi 会话与工具执行一律在 utility 进程**，绝不在渲染端或主进程跑。
- 能力簇（`src/main/runtime-*.ts`）是「显式输入的纯构建器」；会话生命周期与命令分发留在 `pi-runtime.ts`。
- Pi 只当 Agent 运行时核心用：第三方扩展的加载/审批/绑定/子代理 CLI shim 已移除，**不要重新引入**。只保留 app 自有 inline extension：权限门、工具审计、钩子解释器、计划模式播报、checkpoint 快照、MCP 桥（`pidesktop-mcp` + Pi 内置 `createMcpExtension`，`noExtensions: true`）。
- 自建能力（MCP / Skill / Subagent / Question / Todo / Memory / Vision / Computer / Design / Automation / Gallery / Team）都在 utility 进程，以 `customTools` + 必要的系统提示注入交给 Pi；不要在渲染端或主进程实现。

## 2. 设置与持久化

- `settings.save` 字段有**四处无编译期关联的镜像**：`src/shared/protocol.ts` 的 `Pick`、渲染端每个 `settings.save` 字面量、主进程 `index.ts` 的 `updateSettings` switch、utility `pi-runtime.ts` 的同一 switch。漏渲染端最狠——主进程 `normalizeX(undefined)` 会把该项**静默抹掉**；`settings-save-contract.test.ts` 钉住四处。
- settings 持久化是**分层 + 脏标记**（`settings-store.ts` + `index.ts`），绝不回到「每条命令 stringify 整文件」；分层口径见记忆「PiDesktop settings 存储分层与写入纪律」。
- 新增字段必须在 `migrateSettings` 里读回（漏读 = 下一次无关写入把它删掉）。
- 每个模型的 `contextWindow`/`maxTokens` 是用户可改的（设置页铅笔），必须覆盖目录/模板值，并沿着每条「模型交接到会话」的路径生效（切模型、新建会话、恢复会话、子代理 transformModel）。
- provider 密钥只留进程内，除非将来有专门的安全存储设计；唯一例外是 MCP OAuth 凭据（Pi 的 `<agentDir>/mcp-auth.json` 明文，刷新令牌需跨重启）。

## 3. 会话与回合口径

- `agent_end` 只是 Pi 的底层 run 边界；用户可见的「回合是否在跑」只有一个来源：`runActive(record) = record.busy || record.session.isStreaming`。清 `busy` / 定稿回合 / 写「已完成」`completedAt` **只在 `agent_settled` 分支**做。
- 中止判定只读 Pi 的 `stopReason === "aborted"`，不匹配 SDK 的英文 abort 文案；被中止的回合按中性样式渲染，不算失败。
- 侧栏圆点 `runStatus`（活状态，激活即清）与 `completedAt`/`completedOutcome`（持久，顶部「已完成」分区）**正交**；写终态只能走 `setTerminalRunStatus` 一处。
- 多会话：`liveSessions` 里每条 `SessionRuntimeRecord` 持有自己的 session/busy/status/executions/customTools；切话题是 park 不是销毁，只有同 id 重建、`session.delete`、空闲 LRU 才 dispose。
- 快照帧三处镜像（utility 发帧 / main 缓存 bootstrap / renderer 应用）：`revision` 是**跨会话全局**发帧序号，`state.patch` 只对**当前** active 会话且必须连号；切回旧会话走 `state.resume.patch`，基线令牌只能是该会话基线的精确 `baseRevision`（**不许**用 `revision === current + 1` 判基线）；基线缺失/令牌不符/补丁越界只发 `state.recover` 换 `state.recovery` 定向全量，**绝不**退回全体 `state.sync`（那会让所有会话基线一起作废）。三进程共用 `src/shared/session-baseline-cache.ts` 的有界 LRU（6 个会话），各自实现一份就会淘汰错位。pane 通道的 `session.state`/`paneRevision` 与 active 基线互不复用。
- 会话 JSONL 在有首条 assistant 消息前不存在，任何延迟刷新都必须靠 `backfillUnpersistedSessions` 补行，否则刚建的空话题会从侧栏消失。
- 单实例锁只在 `app.isPackaged` 开启（dev 与安装版要能并行），第二个实例必须 `app.exit(0)` 而不是 `app.quit()`。

## 4. 面向模型的接口（前缀成本就是硬约束）

- **缓存纪律**：动态状态绝不进系统提示词、绝不每轮整块重写；每回合尾部注入只允许「逐字节稳定」的短文本。教学一律落**回执/对话尾部**，不写进工具 description。
- 工具注入四策略：常驻（browser / gallery / automation）· 按模型能力（vision）· 会话开关 + 总闸（computer / design / team / jev）· 只注册未激活。新增能力先照这张表选，会话级开关按「九步清单」落，漏一条就静默失效。
- `ask_question` 的形态按 **options 数量**判（≥2 即选择题），不要看模型填没填 `type`；归一化只准丢「模型没说清楚」的数据。
- 记忆双库归属：项目知识 / 踩坑 / 架构事实写**项目库**（`<workspace>/.pidesktop/memory/`，谁被派进来都能读）；用户偏好与协作纪律写**助手库**（`agent_scoped: true`）。快照预算 1400 + 600 = 2000，一次会话冻结一次。
- 自定义斜杠命令双作用域（项目 `<workspace>/.pidesktop-commands/` 覆盖全局 `<agentDir>/pidesktop-commands/`）；命令名禁用 `:`，否则会和 `/skill:` 前缀撞车。
- `todo_write` 单 owner 全量替换；`verify` 命令只在非 completed→completed 时执行；状态只经工具参数出现在会话尾部。
- 大结果不塞上下文：超限落盘（screenshots / eval 各保留最近 20），回执给路径与摘要。
- 所有输出围栏必须带语言标注（bash / powershell / text / …）；**不要开自动语言识别**，零误判优先。

## 5. Div 气泡与输出契约

- 气泡**就是整条最终回复**：正文 / 清单 / 表格 / 代码 / 结论全在气泡内，气泡外不写任何 Markdown；气泡内不出现 ``` 围栏，改用 `<pre><code class="language-x">`。
- `divMode` 是 per-assistant（off / auto / always）：静态规范走 `systemPromptOverride` **最后一条**，always 模式再加一行每回合尾部提醒（字节稳定）；提示块 token 预算由测试钉住。合规问题先查提示位置，别改解析器。
- 静态配色规范要求卡片成对定义背景与正文色（正文 ≥4.5:1、次要 ≥3:1），并优先引用主题变量。
- 完整 HTML/SVG 文档只允许在沙箱 Artifact 预览里渲染。

## 6. 工具管线硬事实

- 工具审计写 `tool-audit.jsonl`（按体积轮转），失败只告警，**绝不让审计打断回合**；MCP 调用按服务器 `timeout`（默认 120s）设上限。
- bash/powershell 定义被同名 customTool 包装（`shellKill`）：面板的「停止此命令」只 abort 单次调用并让 agent 继续，**不许**升级成 `session.abort`。
- 内置工具按 agent 名字过滤启用；**新工具默认 OFF**（升级不能改变既有 agent 的工具集与请求前缀）。
- 钩子：事件里的 `agent_end` 指的是 **`agent_settled`**；钩子输出只能经 `additionalContext` 落到对话尾部，绝不进系统提示词与工具 schema；项目级钩子按内容指纹信任，规则改动即回待批。

## 7. 能力簇要点

**MCP** — Pi 内置 MCP 扩展 + `pidesktop-mcp` 桥：`extensionFactories` 一对工厂、`loadConfig` 返回空表且 `errors: []`（缺它会抛 configErrors）、`autoEnableCodemode: false`。增删改全热应用，不重建会话；工具名与激活集按 Pi 规则，只读 `getActiveToolNames()`；dispose 必须**先** `unregisterAll()` 再 `session.dispose()`。状态与 OAuth 走会话绑定的 uiContext，**不许另造临时 uiContext 抓通知**。曝光三态 disabled > codemode > direct，只把 `codemode` 写盘。

**Skill** — 来源有序（低→高）：`~/.agents/skills` → 内置 `resources/skills/` → 全局 → 项目；**内置目录直读、绝不复制**。商店：清单是唯一事实源，全部校验通过才原子落盘（不写半套），覆盖先备份、卸载只认账本；装完必须 invalidate → syncSkills → emitResourceCatalog → 重建会话（会话忙只告警）。

**Subagent** — `subagent` 必填且只匹配自定义定义，不许回落 `role`、不许编名字；空输出是 `isError`。内置只允许改「执行模型 + 思考等级」（一个 override 文件两张表）；只读/可写分工与 `browserTools` 见 `resources/subagents/`。子代理默认没有 hooks / 审计 / checkpoint / MCP。

**Computer use** — 三条不变量：`PrintWindow` 必须 `PW_RENDERFULLCONTENT`（返回值不是成功判据）；点击回执要三信号（命中 / 像素变化 / 前台），「无变化」只是告警；坐标不在目标窗口上就拒绝点击，键盘注入前必须过 `ForegroundGuard`。会话级开关默认 OFF，总闸只是下架闸。改了先跑 `resources/skills/computer-use/test/selfcheck.py`。

**Memory** — 双库布局与读取口径见 §4；`memory_read` 默认只给要点+目录（>6000 字符）、`section="*"` 才全文；`memory_append` 不要求先读全文。细节 → 记忆「PiDesktop 记忆系统 v3」。

**SSH** — 分层：ssh2 客户端在主进程、14 个 `ssh_*` 工具在 utility 走 RPC。硬事实：完成检测用 OSC 633 标记且**必须是字符级状态机**（远端 readline 会把回显折行并重复边界字符，行正则永远匹配不上）；`client.setNoDelay(true)` 必须显式开；resize 是 `setWindow(rows, cols, …)` 的 ssh2 口径；exec 通道**必须排水**，否则 `close` 永远不来；SFTP 上传在 OPEN 回调前不读流、超时是 idle 预算且先 `stat` 核对远端大小；密码永不进 AI transcript。细节 → 记忆「PiDesktop SSH 指纹信任与主机建管（AI 侧）」。

**IM 通道** — 飞书长连接与自定义通道共用一套网关，只按 kind 选适配器；会话标题 `<通道名> · <对方>`、IM 会话强制关 Div 气泡（飞书卡片不渲染 HTML）；密钥只在 credentials.json（safeStorage）。自定义通道可勾「放行所有 peerId」（`allowAny`，鉴权交给上游脚本；默认仍是 deny-first——空白名单 = 不服务任何人，飞书分支净化时丢弃该字段）。IM 新建会话的模型按**会话归属角色**的 `defaultModel` 解析（`pickNewSessionModel`，不读全局激活角色；旧实现读 `currentAgent` 导致通道指定的角色用错默认模型）。细节 → 记忆「PiDesktop 飞书 IM 通道（长连接 P1）实现事实」。

**Vision** — 图片永远留在会话 transcript；无图片输入能力的模型在传输层剥离图片 + 尾部 hint 引导 `recognize_images`；`settings.providers[].models[].imageInput` 覆盖目录元数据，是唯一判据。工具 schema 字节稳定。

**Design Studio** — 文档是 JSON 节点树（`designs/<name>.design.json`），op 批量原子、未知 patch 键整批报错。8 个工具 ≈1.5K token，只在「会话设计模式 + 总闸」双开时激活（随 `session.new` 继承，自动化与计划移交不继承）。质量闸口与风格指南注入都走尾部。细节 → 记忆「PiDesktop 设计模式（Design Studio）」。

**Plan mode / Checkpoint** — 计划模式是软模式（不过滤工具、不改权限轴），`exit_plan_mode` 常驻，批准后归档 `<workspace>/docs/plans/`；四个出口语义固定：批准实施 / 移交新会话 / 保留文档不实施 / 不批准（带意见）。Checkpoint 是**用户动作、单文件粒度**，只快照已存在的目标文件，不走 AI 权限门、不回卷会话。细节 → 记忆「PiDesktop 计划模式与交付回滚」。

**Automation** — agent 级原子 JSON + 5 字段 cron（无 vixie dom/dow OR）；一次 fire = 新建后台会话（`workspace` 跟任务、`model` 三级回落，无人值守默认 full）。`runs.jsonl` 四态含 `skipped`：中性结局、不写 `task.lastRun`、不弹 toast。工具名用下划线（OpenAI 兼容端点按 `^[a-zA-Z0-9_-]+$` 校验）。

**Gallery** — 发布是显式动作，绝不扫目录自动登记；列表全局，存 `<agentDir>/pidesktop-gallery`，**不要**塞进 settings.json。服务型作品的服务跑在**主进程后台进程**（不是终端标签）：同 appId + 同命令复用、地址已可达则不自启、停止杀进程树、`before-quit` 全回收、面板作品关窗即停；`runMode` page/background。每个作品都要有封面。细节 → 记忆「PiDesktop 作品墙与服务进程（Gallery）」。

**Team** — 只有 Lead 能 spawn / interrupt / reassign；任务用全量快照 CAS。活动通知只让快照失效，**不许唤醒 `team_wait`**。

## 8. 渲染端与预览

- 会话区只有一个 `ConversationPane`（单窗与分屏共用），绝不另写第二个 composer。
- 流式渲染按「冻结 chunk + 活动尾」分块，**不许回退到单一增长前缀**（实测比不冻结更慢）；memo 生效的前提是调用方传稳定 `useCallback`。
- 长会话时间线与长 Markdown 预览都是「高度保留占位 + 观察者挂载」：占位必须保留 `.message` 与 `data-turn-key`；**观察者创建后必须重放已注册元素**（历史「历史轮次像被删了」就是漏了这步）；块一旦挂载不再卸载；Ctrl/Cmd+F 与全选要全量挂载。
- 内置浏览器是原生 `WebContentsView`，会盖住 DOM：任何全屏 DOM 覆盖层都要注册 `useOverlayLayer`，会话内对话框走 `--chat-overlay-*` 收窄而不是隐层。CORS 放宽只对面板窗口生效，`webSecurity` 保持 true。Jev 快速决策默认关（关闭时零前缀成本），无效决策绝不执行任何动作。
- 预览页走 loopback 静态服务（随机端口）；面板作品走 `pidesktop-file://w-<id>`（每作品固定 origin，否则 localStorage/IndexedDB 每次重启都丢）。
- 终端是真 PTY（主进程 node-pty + xterm.js，唯一宿主 `XtermView`），用户输入绕过权限门；Nerd Font 必须在字体链最前且必须是 `Mono` 变体。

## 9. 工程纪律

- 交付前必须 `npm test` + `npm run build` 全绿；打包与发布由 GitHub Actions 出（推 `vX.Y.Z` tag 或 `workflow_dispatch`），不发本地包。
- `@earendil-works/*` 三个依赖与 `overrides`（含 `pi-tui`、`pi-mcp`/`pi-codemode`）必须**同一版本整体移动**；版本断言从 `package-lock.json` 推导，不硬编码。
- Pi 的 `cacheWarming` 强制 OFF（`withCacheWarmingOff`）：无人值守会话不能让 Pi 自己花 token 保活缓存。
- 偏好聚焦改动：不顺手重构无关代码，不把 ChatAnyTime 插件运行时搬进本仓。
- 文档纪律：新约定只往本文件加一句话级硬约束；单模块细节进长期记忆，历史进迭代记录。本文件体积上限 28KB（约 7k token，一次读完），超了先删再写。
- 写记忆的门槛（系统提示词的记忆治理块同口径）：只写「读代码看不出来、且下次会做错事」的东西——关键决策点（选了什么/否决了什么/为什么）、关键实测点、用户口径、会坏的坑、外部平台硬事实、流程关键步骤；代码复述与改动流水不进记忆。整理口径见记忆「长期记忆组织约定」与「PiDesktop 记忆系统 v3」。

## 10. 主题契约与主题资产（五处镜像，勿单边修改）

- 主题资产（图片/字体）是 `<agentDir>/pidesktop-themes/<scope>/` 下的**真文件**，经 `pidesktop-file://theme/…` 提供；内联 `<style>` 没有自己的样式表 URL，所以相对 `url()` 永远解析不出来（不要再把资源塞成 base64 或 blob:）。单文件 ≤8MB、单主题 ≤32MB、CSS ≤512KB，超限**中止且什么都不写**（不写半套）；迁移必须先写文件、逐个验大小、全部成功才剥掉内联 base64。

- Theme system: custom theme CSS is applied verbatim (only legacy alias mapping and mode-selector rescoping, `src/renderer/src/lib/theme-presets.ts`). The stable theme-hook contract for structural themes is: `data-pane` on major regions (sidebar / topbar / workspace / work-area / conversation / timeline / composer / `composer-status-stack` / task-panel / memory-panel / preview / terminal / ssh / ssh-files / question-panel / settings-dialog / permission-dialog / landing / turn-minimap / markdown-outline / design / design-toolbar / design-tools / design-canvas / design-layers / design-inspector / `gallery-menu` / `gallery-wall` / `gallery-services` / `automation-settings` / `automation-dialog` / `automation-panel` / `automation-center` / `workflow-center` / `workflow-list` / `workflow-main` / `workflow-canvas` / `workflow-inspector` / `workflow-runs` / `workflow-run-details` / `workflow-run-strip` / `memory-center` / `agent-settings` / `general-settings` / model-settings / resource-settings / skill-store / intranet-skill-store / im-channel-settings / appearance-settings / subagent-settings / hooks-settings / usage-settings), `data-role` on message articles (user / assistant / extension — 只有这三个在契约内；界面里另有同属性名的内部标记如 Jev 测试结果行 / 自动化徽标 / 墓碑提示 / 用量摘要，不在契约内、检查器会拒), `data-control` on key controls (new-session / settings / workspace-open / preview-toggle / task-panel-toggle / memory-toggle / memory-layer-filter / memory-center-open / memory-center-open-nav / memory-center-close / memory-center-refresh / memory-center-save / memory-center-archive / memory-center-delete / send / stop / attach / queue-edit / queue-send-now / queue-remove / access-mode / plan-toggle / model-select / thinking-select / thinking-expand / context-usage / browser-pick / browser-download-toggle / copy / edit / regenerate / share / automation-open / automation-runs-tab / automation-run / automation-toggle / automation-panel-close / automation-panel-manage / automation-center-back / automation-sessions-toggle / automation-stop / workflow-center-open / workflow-center-close / workflow-view-edit / workflow-view-runs / workflow-refresh / workflow-open / workflow-create / workflow-create-blank / workflow-copy / workflow-name / workflow-save / workflow-delete / workflow-delete-confirm / workflow-delete-cancel / workflow-dirty-save / workflow-dirty-discard / workflow-dirty-cancel / workflow-run / workflow-run-start / workflow-run-cancel / workflow-run-input / workflow-run-open / workflow-run-details / workflow-run-dismiss / workflow-run-close / workflow-run-stop / workflow-run-execution / workflow-run-content-artifact / workflow-run-content-transcript / workflow-runs-refresh / workflow-runs-more / workflow-stop / workflow-pending-locate / workflow-node-add / workflow-connect / workflow-edge-delete / workflow-node-delete / workflow-node-kind / workflow-node-source / workflow-node-subagent / workflow-node-thinking / workflow-node-tools-inherit / workflow-node-tool / workflow-node-access / workflow-node-execution / workflow-node-artifact-load / workflow-node-run-details / workflow-rework-toggle / workflow-rework-entry / workflow-rework-gate / workflow-rework-attempts / workflow-inspector-workflow-tab / preview-outline-toggle / ssh-open / ssh-host-create / ssh-host-save / ssh-host-delete / ssh-host-connect / ssh-host-test / ssh-trust-fingerprint / ssh-password-submit / ssh-password-cancel / ssh-group-create / ssh-group-save / ssh-files-toggle / ssh-upload / ssh-download / ssh-transfer-cancel / pane-maximize / pane-close / computer-toggle / design-toggle / design-send-ai / design-export / design-undo / design-redo / design-tool-select / design-tool-frame / design-tool-rect / design-tool-text / design-layer-lock / gallery-toggle / gallery-publish / gallery-run / gallery-develop / gallery-open-wall / `gallery-reveal` / `gallery-remove` / `gallery-data` / `gallery-data-clear` / gallery-service-open / gallery-service-log / gallery-service-restart / gallery-service-stop / `agent-new` / `agent-save` / `jev-test` / `capability-switch` / `jev-expand` / model-provider-add / model-provider-delete / model-save / model-refresh / model-add / model-thinking-levels / model-thinking-panel / resource-reload / skill-store-refresh / skill-store-scope / skill-store-search / skill-store-category / skill-store-sort / skill-store-top / skill-store-page / skill-store-open / skill-store-install / skill-store-confirm-install / skill-store-uninstall / skill-store-close-detail / intranet-store-url / intranet-store-save / intranet-store-test / intranet-store-change / intranet-store-refresh / im-channel-enable / im-feishu-enabled / im-feishu-appid / im-feishu-secret / im-feishu-allowfrom / im-feishu-access / im-feishu-workspace / im-feishu-save / im-feishu-test / im-custom-add / im-custom-enabled / im-custom-save / im-custom-delete / im-feishu-agent / im-custom-agent / im-custom-token-generate / im-custom-token-reveal / im-custom-token-copy / im-custom-allow-any / mcp-add / mcp-save / command-add / command-save / appearance-import-css / appearance-import-theme / appearance-clear-css / appearance-save-theme / appearance-save / subagent-add / subagent-save / subagent-browser-tools / hooks-enable / hooks-add / hooks-save / hooks-trust / hooks-run-log / hooks-template / settings-version / usage-agent-filter), row hooks on sidebar list rows (`data-row-kind` workspace/session/agent + boolean `data-row-active` / `data-row-expanded`), node hooks on timeline segments (`data-node-kind` thinking/tool-call/text + `data-node-state` running/completed/error/aborted), composer sub-region hooks (`data-composer-zone` queue/attachments/error/input/footer/popup/plan/stats/status-stack/workflow/team — `status-stack` is the shared container of the plan / team / workflow strips; `workflow` is the run strip's zone; the `popup` zone is absolute-positioned; themes must not change its `position`; `stats` is the dsh-style session performance line rendered OUTSIDE the composer card, absolutely positioned in the timeline's `--composer-space` breathing gap just above the composer — it carries a live `~N tok/s` streaming group (accent-colored, fed by `SpeedStats.live`, refreshed on the throttled `message_update` frames) ahead of the cumulative groups, hides when the question panel is up, and the `context-usage` control is a button opening a `popup`-zone context breakdown card), boolean `data-ui-*` state attributes on `<html>` (settings-open / workspace-open / chat-empty / generating / preview-open / preview-fullscreen / permission-pending / question-pending / attachments / split-open / design-open / session-multiselect) plus value-carrying states `data-ui-sidebar-view` (topics/files/archived), `data-ui-density` (compact/comfortable/relaxed), `data-ui-radius` (square/small/medium/round), `data-ui-motion` (off — the user-disabled interface-motion switch; styles.css shuts down all transitions/animations, themes need not respond) and boolean `data-ui-sidebar-collapsed` (sidebar folded to the icon rail), and viewport decoration layers declared as `--pi-layer-<name>` (above wallpaper, below UI) / `--pi-overlay-<name>` (above UI, below dialogs) background-shorthand variables that the shell renders as `pointer-events:none` divs carrying `data-theme-layer` / `data-layer-kind` attributes (`collectThemeLayers`; both the variables and the element attributes are public API). Public layout/panel tokens: `--layout-sidebar-width` (sidebar column width — themes offset art with it instead of hardcoding), `--layout-sidebar-collapsed-width` (collapsed rail width, 48px — themes offset art against the rail too), `--panel-bg-sidebar/topbar/composer/dialog/preview` (each defaults to `var(--panel-bg)`; the var() resolves at use point, so mode blocks only need to override `--panel-bg`). Wallpaper-mode base rules are (0,2,0) specificity — themes win with equal-specificity attribute selectors, no `html` prefix. These attributes, variables and tokens are public theme API — do not rename or remove them without a migration note. Under split view `conversation`/`timeline`/`composer`/`question-panel` render once per pane; `data-pane-active` marks the focused pane's conversation region and the root `data-ui-generating`/`chat-empty`/`attachments` booleans reflect the focused pane (see the split-view migration note in `docs/theme-guide.md`). Themes own every color token; the only renderer-side overrides are the wallpaper/bubble/panel-opacity sliders and the interface-tuning layer (`data-ui-density`/`data-ui-radius` → `--ui-density-scale`/`--ui-control-radius`/`--ui-container-radius`, defaults equal current visuals; themes may override the tokens or ignore the attributes). Theme assets (images/fonts referenced by a relative `url()`) are real files under `<agentDir>/pidesktop-themes/<scope>/`, served through `pidesktop-file://theme/…` (见本节上方的主题资产条目) — only over-limit migration leftovers are still data URLs. Authoring guide: `docs/theme-guide.md`; the BUNDLED `pidesktop-theme-creator` skill (`resources/skills/pidesktop-theme-creator/`, shipped with the installer since 2026-10-03) validates hook names via `scripts/check_theme.py`. **The hook/token contract has FIVE mirrors that must move together**: this `AGENTS.md` bullet, `docs/theme-guide.md`, the skill's `SKILL.md`, its `references/variables.md`, and its `scripts/check_theme.py` — they now all live INSIDE this repo (the skill used to be a user-shared dir at `~/.agents/skills/`, removed 2026-10-03).

（本节是主题钩子与变量的**公开契约**。改动必须同步其余四处：`docs/theme-guide.md`、`resources/skills/pidesktop-theme-creator/SKILL.md`、其 `references/variables.md`、`scripts/check_theme.py`；另有 4 个 wiring 测试断言全部五处含新钩子名。）

## 11. 细节去哪找（长期记忆 · 项目库）

| 想知道什么 | 先读记忆主题 |
| --- | --- |
| 浏览器自动化 / 预览 / 下载 / Jev | PiDesktop 内置浏览器事实与对策 |
| 面板作品 origin / 数据入口 / CORS 边界 | PiDesktop 面板作品 origin 与数据事实 |
| 作品墙 / 服务看板 / 封面 / 跨工作区继续开发 | PiDesktop 作品墙与服务进程（Gallery） |
| 设计模式（Design Studio） | PiDesktop 设计模式（Design Studio） |
| 计划模式 / 交付产物回滚 | PiDesktop 计划模式与交付回滚 |
| 中止 / 失败 / 结局判定口径 | PiDesktop 中止语义与结局判定 |
| 会话摘要索引 / 全文搜索 / 时间线 / 流式 / Markdown 预览性能 | PiDesktop 性能事实与基线 |
| 设置分层 / 写盘 / 脏标记 / 展示类开关落位 | PiDesktop settings 存储分层与写入纪律 |
| 记忆系统（双库 / 分层索引 / 预算） | PiDesktop 记忆系统 v3 |
| 工具注入策略 / schema / 子代理委派 | PiDesktop 面向模型的接口纪律 |
| MCP 迁移 / OAuth 凭据 | PiDesktop MCP OAuth 凭据与并发刷新事实 |
| SSH 指纹 / 主机建管 / SFTP | PiDesktop SSH 指纹信任与主机建管（AI 侧） |
| 自动化定时任务模块 | PiDesktop 自动化定时任务模块 |
| 飞书 / 自定义 IM 通道 | PiDesktop 飞书 IM 通道（长连接 P1）实现事实 |
| 主题创作硬约束与实测 | PiDesktop 主题创作要点（2026-09-27/28 实测） |
| 模块入口 / 磁盘布局 / 资源生效链路 | PiDesktop 仓库导航 |
| 真机探针 / 反向验证 / 三层验证 | PiDesktop 验证与探针方法论 |
| 发布 / 打包 / 冒烟 / 体积基线 | PiDesktop 发布流程 |
| 活跃踩坑、未修项、可复用纪律 | PiDesktop 踩坑记录 |
| 并行会话下的提交纪律 / CRLF | PiDesktop 混合工作区提交纪律 |

专题文档：主题创作 `docs/theme-guide.md`；桌面控制 `resources/skills/computer-use/SKILL.md` + `test/selfcheck.py`；发布检查 `.github/scripts/verify-package.cjs`；历史与取证 `docs/迭代记录.md`（含沉淀索引）与 `docs/迭代记录/YYYY-MM.md`；方案与设计稿 `docs/plans/`。
